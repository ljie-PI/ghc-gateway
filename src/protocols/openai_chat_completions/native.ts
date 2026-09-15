import {
  normalizeChatCompletionsStreamFailure,
  upstreamStreamEventFailure,
} from "../../copilot/failures.js";
import type { UpstreamByteStream } from "../../copilot/upstream_types.js";
import {
  failureFromSignal,
  GatewayFailureError,
} from "../../gateway/failures.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import {
  createStreamExecutionResponse,
  withByteIdleDeadlines,
  type StreamExecutionEmission,
} from "../../gateway/stream_execution.js";
import { SseDecodeError } from "../../serialization/sse.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import type { SemanticUsage } from "../conversion/types.js";
import {
  encodeOpenaiChatCompletionsDone,
  encodeOpenaiChatCompletionsSseChunk,
} from "./wire.js";

const DEFAULT_EVENT_LIMIT = 4 * 1024 * 1024;

export interface ChatCompletionsChunk {
  readonly payload: WireJson;
}

export type ChatCompletionsStreamFrame =
  | { readonly kind: "chunk"; readonly chunk: ChatCompletionsChunk }
  | { readonly kind: "error"; readonly value: WireJson | string }
  | { readonly kind: "done" };

// Retain raw snapshots: outputTokens alone cannot distinguish a nested subset
// from a separately billed Chat reasoning counter on a later partial update.
export interface ChatCompletionsUsageCounters {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly detailedReasoningTokens?: number | undefined;
  readonly separateReasoningTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

export function mergeChatCompletionsUsageCounters(
  current: Readonly<ChatCompletionsUsageCounters>,
  update: Readonly<ChatCompletionsUsageCounters>,
): ChatCompletionsUsageCounters {
  return {
    promptTokens: update.promptTokens ?? current.promptTokens,
    completionTokens: update.completionTokens ?? current.completionTokens,
    detailedReasoningTokens: update.detailedReasoningTokens ?? current.detailedReasoningTokens,
    separateReasoningTokens: update.separateReasoningTokens ?? current.separateReasoningTokens,
    cacheReadTokens: update.cacheReadTokens ?? current.cacheReadTokens,
    cacheWriteTokens: update.cacheWriteTokens ?? current.cacheWriteTokens,
  };
}

export function chatCompletionsUsageFromCounters(
  counters: Readonly<ChatCompletionsUsageCounters>,
): SemanticUsage {
  const separateReasoning = counters.detailedReasoningTokens === undefined
    ? counters.separateReasoningTokens ?? 0
    : 0;
  return {
    inputTokens: counters.promptTokens ?? 0,
    outputTokens: (counters.completionTokens ?? 0) + separateReasoning,
    cacheReadTokens: counters.cacheReadTokens ?? 0,
    cacheWriteTokens: counters.cacheWriteTokens ?? 0,
    reasoningTokens: counters.detailedReasoningTokens ?? separateReasoning,
  };
}

export function validatedNativeChatCompletionsBody(
  body: Uint8Array,
  maxBytes: number,
): WireJsonObject {
  try {
    const payload = parseWireJson(body, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(payload)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return payload;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

export function nativeChatCompletionsUsage(value: WireJson): SemanticUsage {
  return chatCompletionsUsageFromCounters(usageObservationFromPayload(value));
}

export async function createNativeChatCompletionsStreamResponse(input: {
  readonly upstream: UpstreamByteStream;
  readonly scope: Readonly<RequestScope>;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly onUsage: (usage: Readonly<SemanticUsage>) => void;
  readonly onTerminal: (result: Readonly<
    | { readonly kind: "success"; readonly usage: SemanticUsage }
    | { readonly kind: "failure"; readonly error: unknown }
  >) => void;
}): Promise<Response> {
  const frames = parseOpenaiChatCompletionsSse(withByteIdleDeadlines(
    input.upstream.bytes,
    input.scope.signal,
    input.scope.config.timeouts.firstByteMs,
    input.scope.config.timeouts.streamIdleMs,
  ), input.scope.config.limits.sseEventBytes);
  return await createStreamExecutionResponse({
    upstream: input.upstream,
    emissions: nativeChatCompletionsEmissions(frames, input),
    signal: input.scope.signal,
    deliverySignal: input.scope.deliverySignal,
    status: input.upstream.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-request-id": input.scope.requestId,
    },
    firstEmissionTimeoutMs: input.scope.config.timeouts.firstByteMs,
    normalizeFailure: (error) => normalizeChatCompletionsStreamFailure(error, input.scope.signal),
    presentPostCommitFailure: (error) => new Error("upstream stream error", { cause: error }),
    onTerminal: (result) => result.kind === "success"
      ? input.onTerminal({
        kind: "success",
        usage: chatCompletionsUsageFromCounters(result.value),
      })
      : input.onTerminal({ kind: "failure", error: result.error }),
  });
}

export async function* parseOpenaiChatCompletionsSse(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes = DEFAULT_EVENT_LIMIT,
  measureEvent?: (<T>(work: () => T) => T) | undefined,
): AsyncGenerator<ChatCompletionsStreamFrame> {
  let lineBytes: number[] = [];
  let pendingCr = false;
  let eventLines: string[] = [];
  let eventBytes = 0;
  let terminal = false;
  let lineMayStartWithBom = true;

  const finishLine = function* (): Generator<ChatCompletionsStreamFrame> {
    if (lineBytes.length === 0) {
      lineMayStartWithBom = false;
      const frame = measureEvent === undefined
        ? parseEvent(eventLines)
        : measureEvent(() => parseEvent(eventLines));
      eventLines = [];
      eventBytes = 0;
      if (frame !== undefined) {
        yield frame;
        if (frame.kind === "done" || frame.kind === "error") {
          terminal = true;
        }
      }
      return;
    }
    eventLines.push(decodeLine(lineBytes, lineMayStartWithBom));
    lineMayStartWithBom = false;
    lineBytes = [];
  };

  const pushByte = function* (byte: number): Generator<ChatCompletionsStreamFrame> {
    if (pendingCr) {
      pendingCr = false;
      if (byte === 0x0a) {
        countEventByte();
        yield* finishLine();
        return;
      }
      yield* finishLine();
      if (terminal) {
        return;
      }
    }
    countEventByte();
    if (byte === 0x0d) {
      pendingCr = true;
      return;
    }
    if (byte === 0x0a) {
      yield* finishLine();
      return;
    }
    lineBytes.push(byte);
  };

  const countEventByte = (): void => {
    eventBytes += 1;
    if (eventBytes > eventLimitBytes) {
      throw new SseDecodeError("event_too_large", "SSE event exceeds limit");
    }
  };

  for await (const part of bytes) {
    for (const byte of part) {
      yield* pushByte(byte);
      if (terminal) {
        return;
      }
    }
  }
  if (pendingCr) {
    yield* finishLine();
  }
  if (lineBytes.length > 0 || eventLines.length > 0 || !terminal) {
    throw new SseDecodeError("truncated", "truncated SSE stream");
  }
}

async function* nativeChatCompletionsEmissions(
  frames: AsyncGenerator<ChatCompletionsStreamFrame>,
  input: Parameters<typeof createNativeChatCompletionsStreamResponse>[0],
): AsyncIterable<StreamExecutionEmission<ChatCompletionsUsageCounters>> {
  const firstFrames = await readThroughFirstSemanticChatCompletionsFrame(
    frames,
    input.scope.signal,
    input.scope.config.timeouts.firstByteMs,
  );
  if (firstFrames.at(-1)?.kind === "error") {
    throw upstreamStreamEventFailure();
  }
  const pending = [...firstFrames];
  let usage: ChatCompletionsUsageCounters = {};
  try {
    for (;;) {
      const next = pending.length === 0
        ? await frames.next()
        : { done: false as const, value: pending.shift() as ChatCompletionsStreamFrame };
      if (next.done === true) {
        throw new GatewayFailureError({
          kind: "upstream_stream_truncated",
          source: "parser",
          phase: "stream",
        });
      }
      const frame = next.value;
      if (frame.kind === "chunk") {
        const bytes = measure(input.performanceObserver, () => {
          usage = mergeChatCompletionsUsageCounters(usage, usageObservationFromPayload(frame.chunk.payload));
          input.onUsage(chatCompletionsUsageFromCounters(usage));
          return encodeOpenaiChatCompletionsSseChunk(frame.chunk.payload);
        });
        yield { kind: "wire", bytes };
      } else if (frame.kind === "done") {
        yield {
          kind: "wire",
          bytes: measure(input.performanceObserver, encodeOpenaiChatCompletionsDone),
        };
        yield {
          kind: "terminal",
          outcome: { kind: "success", value: usage },
          writerMode: "close",
        };
        return;
      } else {
        throw upstreamStreamEventFailure();
      }
    }
  } finally {
    await frames.return(undefined);
  }
}

async function readThroughFirstSemanticChatCompletionsFrame(
  frames: AsyncIterator<ChatCompletionsStreamFrame>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<readonly ChatCompletionsStreamFrame[]> {
  if (signal.aborted) {
    throw new GatewayFailureError(failureFromSignal(signal, {
      source: "parser",
      phase: "stream",
    }));
  }
  const buffered: ChatCompletionsStreamFrame[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const semantic = (async () => {
    for (;;) {
      const next = await frames.next();
      if (next.done === true) {
        throw new GatewayFailureError({
          kind: "upstream_stream_truncated",
          source: "parser",
          phase: "stream",
        });
      }
      buffered.push(next.value);
      if (next.value.kind !== "chunk" || isSemanticChatCompletionsChunk(next.value.chunk)) {
        return buffered;
      }
    }
  })();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GatewayFailureError({
      kind: "upstream_timeout",
      source: "parser",
      phase: "stream",
    })), timeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new GatewayFailureError(failureFromSignal(signal, {
      source: "parser",
      phase: "stream",
    })));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([semantic, timeout, aborted]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function isSemanticChatCompletionsChunk(chunk: Readonly<ChatCompletionsChunk>): boolean {
  if (!isWireJsonObject(chunk.payload)) {
    return false;
  }
  const choices = memberValues(chunk.payload, "choices")[0];
  if (!isWireJsonArray(choices)) {
    return false;
  }
  return choices.items.some((choice) => {
    if (!isWireJsonObject(choice)) {
      throw new GatewayFailureError({
        kind: "invalid_upstream_response",
        source: "parser",
        phase: "stream",
      });
    }
    const delta = memberValues(choice, "delta")[0];
    const message = memberValues(choice, "message")[0];
    const finishReason = memberValues(choice, "finish_reason")[0];
    return (isWireJsonObject(delta) && delta.members.length > 0)
      || (isWireJsonObject(message) && message.members.length > 0)
      || (finishReason !== undefined && finishReason !== null);
  });
}

function decodeLine(bytes: readonly number[], stripInitialBom: boolean): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    if (stripInitialBom && text.startsWith("\uFEFF")) {
      return text.slice(1);
    }
    return text;
  } catch (error: unknown) {
    throw new SseDecodeError("invalid_utf8", "invalid UTF-8 in SSE line", { cause: error });
  }
}

function parseEvent(lines: readonly string[]): ChatCompletionsStreamFrame | undefined {
  const dataLines: string[] = [];
  let eventName = "message";
  for (const raw of lines) {
    if (raw.length === 0 || raw.startsWith(":")) {
      continue;
    }
    const separator = raw.indexOf(":");
    const name = separator === -1 ? raw : raw.slice(0, separator);
    const value = separator === -1 ? "" : raw.slice(separator + 1).replace(/^ /u, "");
    if (name === "event") {
      eventName = value;
      continue;
    }
    if (name === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return { kind: "done" };
  }
  if (eventName === "error") {
    return { kind: "error", value: data };
  }
  try {
    const jsonBytes = new TextEncoder().encode(data);
    const payload = parseWireJson(jsonBytes, {
      maxBytes: Math.max(jsonBytes.byteLength, 1),
      maxDepth: 64,
    });
    if (!isWireJsonObject(payload)) {
      return { kind: "error", value: data };
    }
    if (memberValues(payload, "error").length > 0 || !isValidChatCompletionsChunk(payload)) {
      return { kind: "error", value: payload };
    }
    return { kind: "chunk", chunk: { payload } };
  } catch (_error) {
    return { kind: "error", value: data };
  }
}

function isValidChatCompletionsChunk(payload: Parameters<typeof memberValues>[0]): boolean {
  const choices = memberValues(payload, "choices");
  return choices.length === 1 && isWireJsonArray(choices[0]);
}

function usageObservationFromPayload(value: WireJson): ChatCompletionsUsageCounters {
  if (!isWireJsonObject(value)) {
    return {};
  }
  const usage = memberValues(value, "usage")[0];
  if (memberValues(value, "usage").length !== 1 || !isWireJsonObject(usage)) {
    return {};
  }
  const details = singleMemberValue(usage, "prompt_tokens_details");
  const completionDetails = singleMemberValue(usage, "completion_tokens_details");
  const detailedReasoningTokens = isWireJsonObject(completionDetails)
    ? nonnegativeInteger(singleMemberValue(completionDetails, "reasoning_tokens"))
    : undefined;
  return {
    promptTokens: nonnegativeInteger(singleMemberValue(usage, "prompt_tokens")),
    completionTokens: nonnegativeInteger(singleMemberValue(usage, "completion_tokens")),
    detailedReasoningTokens,
    separateReasoningTokens: detailedReasoningTokens === undefined
      ? nonnegativeInteger(singleMemberValue(usage, "reasoning_tokens"))
      : undefined,
    cacheReadTokens: (isWireJsonObject(details)
      ? nonnegativeInteger(singleMemberValue(details, "cached_tokens"))
      : undefined) ?? nonnegativeInteger(singleMemberValue(usage, "cache_read_input_tokens")),
    cacheWriteTokens: (isWireJsonObject(details)
      ? nonnegativeInteger(singleMemberValue(details, "cache_write_tokens"))
      : undefined) ?? nonnegativeInteger(singleMemberValue(usage, "cache_creation_input_tokens")),
  };
}

function singleMemberValue(object: WireJsonObject, key: string): WireJson | undefined {
  const values = memberValues(object, key);
  return values.length === 1 ? values[0] : undefined;
}

function nonnegativeInteger(value: WireJson | undefined): number | undefined {
  if (value === undefined || typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "number") {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return undefined;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function measure<T>(observer: ProtocolPerformanceObserver | undefined, work: () => T): T {
  return observer === undefined ? work() : observer.measure("event", work);
}
