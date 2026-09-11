import { iterateChatFrames } from "../../copilot/backend.js";
import {
  normalizeChatStreamFailure,
  upstreamStreamEventFailure,
} from "../../copilot/failures.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import {
  createStreamExecutionResponse,
  withByteIdleDeadlines,
  type StreamExecutionEmission,
} from "../../gateway/stream_execution.js";
import type { UpstreamByteStream } from "../../copilot/upstream_types.js";
import type { ChatStreamFrame } from "../chat_completions/types.js";
import { readThroughFirstSemanticChatFrame } from "../chat_completions/stream_semantics.js";
import { anthropicStopReason, anthropicUsage } from "./bridge.js";
import { asRecord, normalizeToolId, wireToJson } from "./common.js";
import { encodeAnthropicSse, type AnthropicEvent } from "./wire.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

type AnthropicTerminal = Readonly<
  | { readonly kind: "success"; readonly usage: ObservedUsage }
  | { readonly kind: "failure"; readonly error: unknown }
>;

export async function createAnthropicStreamResponse(input: {
  readonly upstream: UpstreamByteStream;
  readonly model: string;
  readonly createUuid: () => string;
  readonly scope: Readonly<RequestScope>;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly onTerminal?: (result: AnthropicTerminal) => void;
}): Promise<Response> {
  const timedUpstream = {
    ...input.upstream,
    bytes: withByteIdleDeadlines(
      input.upstream.bytes,
      input.scope.signal,
      input.scope.config.timeouts.firstByteMs,
      input.scope.config.timeouts.streamIdleMs,
    ),
  };
  const frames = iterateChatFrames(timedUpstream);
  return await createStreamExecutionResponse({
    upstream: input.upstream,
    emissions: anthropicEmissions(frames, input),
    signal: input.scope.signal,
    deliverySignal: input.scope.deliverySignal,
    headers: { ...STREAM_HEADERS, "request-id": input.scope.requestId },
    firstEmissionTimeoutMs: input.scope.config.timeouts.firstByteMs,
    normalizeFailure: (error) => normalizeChatStreamFailure(error, input.scope.signal),
    onTerminal: (result) => result.kind === "success"
      ? observeTerminal(input.onTerminal, { kind: "success", usage: result.value })
      : observeTerminal(input.onTerminal, { kind: "failure", error: result.error }),
  });
}

async function* anthropicEmissions(
  frames: AsyncGenerator<ChatStreamFrame>,
  input: Parameters<typeof createAnthropicStreamResponse>[0],
): AsyncIterable<StreamExecutionEmission<ObservedUsage>> {
  const converter = new AnthropicStreamConverter(input.model, input.createUuid);
  const firstFrames = await readThroughFirstSemanticChatFrame(
    frames,
    input.scope.signal,
    input.scope.config.timeouts.firstByteMs,
  );
  if (firstFrames.at(-1)?.kind === "error") {
    throw upstreamStreamEventFailure();
  }
  let observedUsage: ObservedUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
  try {
    for (const event of converter.start()) {
      yield { kind: "wire", bytes: encodeAnthropicSse(event) };
    }
    const pending = [...firstFrames];
    for (;;) {
      const next = pending.length === 0
        ? await frames.next()
        : { done: false as const, value: pending.shift() as ChatStreamFrame };
      if (next.done === true) {
        throw new GatewayFailureError({
          kind: "upstream_stream_truncated",
          source: "parser",
          phase: "stream",
        });
      }
      const frame = next.value;
      if (frame.kind === "chunk") {
        const chunk = wireToJson(frame.chunk.payload);
        if (input.onTerminal !== undefined) {
          observedUsage = mergeObservedUsage(observedUsage, chunk);
        }
        const events = measureEvents(input.performanceObserver, () => converter.consume(chunk));
        for (const event of events) {
          yield {
            kind: "wire",
            bytes: measureEvents(input.performanceObserver, () => encodeAnthropicSse(event)),
          };
        }
      } else if (frame.kind === "done") {
        for (const event of converter.finish()) {
          yield { kind: "wire", bytes: encodeAnthropicSse(event) };
        }
        yield {
          kind: "terminal",
          outcome: { kind: "success", value: observedUsage },
          writerMode: "close",
        };
        return;
      } else {
        yield {
          kind: "terminal",
          outcome: { kind: "failure", error: upstreamStreamEventFailure() },
          writerMode: "close",
        };
        return;
      }
    }
  } finally {
    await frames.return(undefined);
  }
}


function measureEvents<T>(observer: ProtocolPerformanceObserver | undefined, work: () => T): T {
  return observer === undefined ? work() : observer.measure("event", work);
}

interface ObservedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
}

function mergeObservedUsage(current: ObservedUsage, chunk: unknown): ObservedUsage {
  const object = asRecord(chunk);
  if (object?.usage === undefined) {
    return current;
  }
  const usage = anthropicUsage(object.usage);
  return {
    inputTokens: observedInteger(usage.input_tokens) ?? current.inputTokens,
    outputTokens: observedInteger(usage.output_tokens) ?? current.outputTokens,
    cacheTokens: observedInteger(usage.cache_read_input_tokens) === undefined
      && observedInteger(usage.cache_creation_input_tokens) === undefined
      ? current.cacheTokens
      : (observedInteger(usage.cache_read_input_tokens) ?? 0) + (observedInteger(usage.cache_creation_input_tokens) ?? 0),
  };
}

function observedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function observeTerminal(
  observer: Parameters<typeof createAnthropicStreamResponse>[0]["onTerminal"],
  result: Parameters<NonNullable<Parameters<typeof createAnthropicStreamResponse>[0]["onTerminal"]>>[0],
): void {
  try {
    observer?.(result);
  } catch (_error: unknown) {
    // Observability cannot alter the stream lifecycle or bytes.
  }
}
class AnthropicStreamConverter {
  private active: { type: "text" | "thinking" | "tool"; index: number; name?: string } | undefined;
  private nextIndex = 0;
  private pendingFinish: { stopReason: "end_turn" | "max_tokens" | "tool_use"; usage: Record<string, unknown> } | undefined;
  private stopped = false;

  constructor(
    private readonly model: string,
    private readonly createUuid: () => string,
  ) {}

  start(): AnthropicEvent[] {
    return [{
      type: "message_start",
      message: {
        id: `msg_${this.createUuid()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }];
  }

  consume(chunk: unknown): AnthropicEvent[] {
    if (this.stopped) {
      return [];
    }
    const object = asRecord(chunk);
    if (object === undefined) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    const usage = anthropicUsage(object.usage);
    const choices = Array.isArray(object.choices) ? object.choices : [];
    if (choices.length === 0) {
      if (object.usage !== undefined && this.pendingFinish !== undefined) {
        this.pendingFinish = { ...this.pendingFinish, usage };
        return this.flushFinish();
      }
      return [];
    }

    const events: AnthropicEvent[] = [];
    let lastToolDelta: Record<string, unknown> | undefined;
    for (const choiceValue of choices) {
      const choice = asRecord(choiceValue);
      if (choice === undefined) {
        continue;
      }
      const delta = asRecord(choice.delta);
      if (delta !== undefined) {
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined;
        if (toolCalls === undefined) {
          events.push(...this.consumeDelta(delta));
        } else {
          const withoutToolCalls = { ...delta };
          delete withoutToolCalls.tool_calls;
          events.push(...this.consumeDelta(withoutToolCalls));
          lastToolDelta = { tool_calls: toolCalls };
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        this.pendingFinish = {
          stopReason: anthropicStopReason(choice.finish_reason),
          usage: object.usage === undefined ? { input_tokens: 0, output_tokens: 0 } : usage,
        };
      }
    }
    if (lastToolDelta !== undefined) {
      events.push(...this.consumeDelta(lastToolDelta));
    }
    return events;
  }

  finish(): AnthropicEvent[] {
    if (this.stopped) {
      return [];
    }
    if (this.pendingFinish !== undefined) {
      return this.flushFinish();
    }
    const events = this.closeActive();
    events.push({ type: "message_stop" });
    this.stopped = true;
    return events;
  }

  private consumeDelta(delta: Record<string, unknown>): AnthropicEvent[] {
    const events: AnthropicEvent[] = [];
    events.push(...this.consumeThinkingBlocks(delta.thinking_blocks));
    const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (thinking.length > 0) {
      events.push(...this.openBlock("thinking"));
      events.push({ type: "content_block_delta", index: this.activeIndex(), delta: { type: "thinking_delta", thinking } });
    }
    const content = typeof delta.content === "string" ? delta.content : "";
    if (content.length > 0) {
      events.push(...this.openBlock("text"));
      events.push({ type: "content_block_delta", index: this.activeIndex(), delta: { type: "text_delta", text: content } });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const callValue of delta.tool_calls) {
        const call = asRecord(callValue);
        if (call === undefined) {
          continue;
        }
        const fn = asRecord(call.function);
        const rawName = typeof fn?.name === "string" ? fn.name : undefined;
        if (rawName !== undefined) {
          const rawId = typeof call.id === "string" ? call.id : this.createUuid();
          events.push(...this.openToolBlock(rawName, rawId));
        }
        const args = typeof fn?.arguments === "string" ? fn.arguments : "";
        if (args.length > 0) {
          if (this.active?.type !== "tool") {
            events.push(...this.openToolBlock("", this.createUuid()));
          }
          events.push({
            type: "content_block_delta",
            index: this.activeIndex(),
            delta: { type: "input_json_delta", partial_json: args },
          });
        }
      }
    }
    return events;
  }

  private consumeThinkingBlocks(value: unknown): AnthropicEvent[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const events: AnthropicEvent[] = [];
    for (const item of value) {
      const block = asRecord(item);
      if (block?.type !== "thinking") {
        continue;
      }
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      const signature = typeof block.signature === "string" ? block.signature : "";
      if (thinking.length === 0 && signature.length === 0) {
        continue;
      }
      events.push(...this.openThinkingBlock(thinking, signature));
      if (signature.length > 0) {
        events.push({
          type: "content_block_delta",
          index: this.activeIndex(),
          delta: { type: "signature_delta", signature },
        });
        continue;
      }
      if (thinking.length > 0) {
        events.push({
          type: "content_block_delta",
          index: this.activeIndex(),
          delta: { type: "thinking_delta", thinking },
        });
      }
    }
    return events;
  }

  private openBlock(type: "text" | "thinking"): AnthropicEvent[] {
    if (this.active?.type === type) {
      return [];
    }
    const events = this.closeActive();
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.active = { type, index };
    events.push({
      type: "content_block_start",
      index,
      content_block: type === "text"
        ? { type: "text", text: "" }
        : { type: "thinking", thinking: "", signature: "" },
    });
    return events;
  }

  private openThinkingBlock(thinking: string, signature: string): AnthropicEvent[] {
    const events = this.closeActive();
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.active = { type: "thinking", index };
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking, signature },
    });
    return events;
  }

  private openToolBlock(name: string, rawId: string): AnthropicEvent[] {
    if (this.active?.type === "tool" && this.active.name === name) {
      return [];
    }
    const events = this.closeActive();
    const index = this.nextIndex;
    this.nextIndex += 1;
    const normalized = normalizeToolId(rawId);
    const block: Record<string, unknown> = {
      type: "tool_use",
      id: normalized.id,
      name,
      input: {},
    };
    if (normalized.signature !== undefined) {
      block.provider_specific_fields = { signature: normalized.signature };
    }
    this.active = { type: "tool", index, name };
    events.push({ type: "content_block_start", index, content_block: block });
    return events;
  }

  private closeActive(): AnthropicEvent[] {
    if (this.active === undefined) {
      return [];
    }
    const event = { type: "content_block_stop", index: this.active.index };
    this.active = undefined;
    return [event];
  }

  private flushFinish(): AnthropicEvent[] {
    if (this.pendingFinish === undefined) {
      return [];
    }
    const events: AnthropicEvent[] = [];
    if (this.active === undefined && this.nextIndex === 0) {
      events.push(...this.openBlock("text"));
    }
    events.push(...this.closeActive());
    events.push({
      type: "message_delta",
      delta: { stop_reason: this.pendingFinish.stopReason },
      usage: this.pendingFinish.usage,
    });
    events.push({ type: "message_stop" });
    this.stopped = true;
    return events;
  }

  private activeIndex(): number {
    if (this.active === undefined) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return this.active.index;
  }
}
