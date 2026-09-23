import { GatewayFailureError } from "../../gateway/failures.js";
import { encodeAnthropicMessagesSseEvent } from "../anthropic_messages/wire.js";
import { encodeOpenaiChatCompletionsDone, encodeOpenaiChatCompletionsSseChunk } from "../openai_chat_completions/wire.js";
import { encodeOpenaiResponsesSseEvent } from "../openai_responses/wire.js";
import { SemanticItemLedger } from "./ledger.js";
import type { RequestDiagnostics } from "../../telemetry/diagnostics.js";
import { diagnosticObjectShape, diagnosticShape } from "./diagnostics.js";
import { decodeProtocolStream } from "./stream_decoders.js";
import type {
  ConversionDegradationRule,
  ConvertedStreamEmission,
  InferenceProtocol,
  SemanticResponse,
  SemanticResponseItem,
  SemanticStreamEvent,
  SemanticUsage,
  ReasoningCarrierConversionContext,
} from "./types.js";
import { wireArray, wireNumber, wireObject } from "./wire.js";
import { managedConvertedResponseId } from "./ids.js";
import type { SemanticReasoningItem } from "./types.js";
import {
  responseMessageKey,
  responseMessagePartKey,
  responseMessagePartPosition,
  responseOutputIndex,
  responseReasoningKey,
  responseToolKey,
} from "./stream_keys.js";

export interface StreamConversionContext {
  readonly diagnostics?: RequestDiagnostics | undefined;
  readonly source: InferenceProtocol;
  readonly target: InferenceProtocol;
  readonly model: string;
  readonly eventLimitBytes: number;
  readonly accumulatorBytes: number;
  readonly createUuid: () => string;
  readonly nowUnixSeconds: () => number;
  readonly previousResponseId?: string | null | undefined;
  readonly degradations?: readonly ConversionDegradationRule[];
  readonly measureEvent?: (<T>(work: () => T) => T) | undefined;
  readonly flushEventMeasurement?: (() => void) | undefined;
  readonly carrier?: ReasoningCarrierConversionContext | undefined;
}

const ZERO_USAGE: SemanticUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

export async function* convertProtocolStream(
  bytes: AsyncIterable<Uint8Array>,
  context: Readonly<StreamConversionContext>,
): AsyncIterable<ConvertedStreamEmission> {
  const ledger = new SemanticItemLedger(context.accumulatorBytes);
  const emitter = createEmitter(context);
  let usage = ZERO_USAGE;
  let started = false;
  let terminal = false;

  for (const ruleId of context.degradations ?? []) {
    yield { kind: "degradation", ruleId };
  }

  for await (const event of decodeProtocolStream(
    context.source,
    bytes,
    context.eventLimitBytes,
    context.accumulatorBytes,
    context.measureEvent,
    context.diagnostics,
  )) {
    try {
      if (event.kind === "usage") {
        usage = event.usage;
        yield { kind: "usage", usage };
        continue;
      }
      if (event.kind === "message_start") {
        yield* measuredEvent(context, () => {
          ledger.startMessage(event.key);
          return emitter.messageStart(event.key);
        });
        continue;
      }
      if (!started && startsSemanticOutput(event)) {
        started = true;
        yield { kind: "first_semantic" };
        yield* measuredEvent(context, () => emitter.start());
        yield* measuredEvent(context, () => emitter.activateReserved());
      }
      if (event.kind === "semantic_progress") {
        continue;
      }
      if (event.kind === "reasoning_start") {
        measuredWork(context, () => ledger.startReasoning(
          event.key,
          event.itemId,
          event.messagesState,
          event.opaqueState,
        ));
        continue;
      }
      if (event.kind === "reasoning_delta") {
        if (event.delta.length === 0) continue;
        yield* measuredEvent(context, () => {
          ledger.appendReasoning(event);
          return started ? emitter.reasoningDelta(event) : [];
        });
        continue;
      }
      if (event.kind === "reasoning_snapshot") {
        yield* measuredEvent(context, () => {
          const suffix = reconcileSnapshot(ledger.reasoningValue(event.partKey), event.text);
          if (suffix.length === 0) return [];
          ledger.appendReasoning({ ...event, delta: suffix });
          return started ? emitter.reasoningDelta({ ...event, kind: "reasoning_delta", delta: suffix }) : [];
        });
        continue;
      }
      if (event.kind === "reasoning_done") {
        yield* measuredEvent(context, () => emitter.reasoningDone(ledger.finishReasoning(event.key, event.status)));
        continue;
      }
      if (event.kind === "text_delta") {
        yield* measuredEvent(context, () => {
          ledger.appendText(event.key, event.delta, event.orderKey);
          return started
            ? emitter.textDelta(event.key, event.delta, event.orderKey)
            : emitter.reserveMessage(event.orderKey ?? event.key, "text");
        });
        continue;
      }
      if (event.kind === "text_done") {
        yield* measuredEvent(context, () => {
          const first = ledger.observeText(event.key, event.orderKey);
          const suffix = reconcileSnapshot(ledger.textValue(event.key), event.text);
          if (suffix.length > 0) {
            ledger.appendText(event.key, suffix, event.orderKey);
            return started ? emitter.textDelta(event.key, suffix, event.orderKey) : [];
          }
          if (!first) {
            return [];
          }
          return started
            ? emitter.textDelta(event.key, "", event.orderKey)
            : emitter.reserveMessage(event.orderKey ?? event.key, "text");
        });
        continue;
      }
      if (event.kind === "refusal_delta") {
        yield* measuredEvent(context, () => {
          ledger.appendRefusal(event.key, event.delta, event.orderKey);
          return started
            ? emitter.refusalDelta(event.key, event.delta, event.orderKey)
            : emitter.reserveMessage(event.orderKey ?? event.key, "refusal");
        });
        continue;
      }
      if (event.kind === "refusal_done") {
        yield* measuredEvent(context, () => {
          const first = ledger.observeRefusal(event.key, event.orderKey);
          const suffix = reconcileSnapshot(ledger.refusalValue(event.key), event.refusal);
          if (suffix.length > 0) {
            ledger.appendRefusal(event.key, suffix, event.orderKey);
            return started ? emitter.refusalDelta(event.key, suffix, event.orderKey) : [];
          }
          if (!first) {
            return [];
          }
          return started
            ? emitter.refusalDelta(event.key, "", event.orderKey)
            : emitter.reserveMessage(event.orderKey ?? event.key, "refusal");
        });
        continue;
      }
      if (event.kind === "content_done") {
        yield* measuredEvent(context, () => {
          ledger.finishContent(event.key);
          return emitter.contentDone(event.orderKey, event.contentIndex);
        });
        continue;
      }
      if (event.kind === "item_done") {
        yield* measuredEvent(context, () => {
          if (event.itemType === "message") {
            ledger.finishMessage(responseMessageKey(event.outputIndex));
          }
          return emitter.itemDone(event.outputIndex);
        });
        continue;
      }
      if (event.kind === "tool_start") {
        yield* measuredEvent(context, () => {
          ledger.startTool(event);
          return emitter.toolStart(event.key, event.callId, event.name, event.itemId);
        });
        continue;
      }
      if (event.kind === "tool_arguments_delta") {
        yield* measuredEvent(context, () => {
          ledger.appendToolArguments(event.key, event.delta);
          return emitter.toolArgumentsDelta(event.key, event.delta);
        });
        continue;
      }
      if (event.kind === "tool_done") {
        yield* measuredEvent(context, () => (function* (): Iterable<ConvertedStreamEmission> {
          const suffix = ledger.finishTool(event.key, event.argumentsJson, event.completed === true);
          if (suffix.length > 0) {
            yield* emitter.toolArgumentsDelta(event.key, suffix);
          }
          if (context.target === "messages" && event.completed !== false) {
            yield* emitter.toolDone(event.key, ledger.tool(event.key).argumentsJson);
          }
        })());
        continue;
      }
      if (event.kind === "terminal") {
        if (terminal) {
          invalid();
        }
        terminal = true;
        if (event.status === "completed") {
          measuredWork(context, () => ledger.finishOpenTools());
          for (const key of ledger.toolKeys()) {
            yield* measuredEvent(context, () => emitter.toolDone(key, ledger.tool(key).argumentsJson));
          }
        }
        for (const reasoning of measuredWork(context, () => ledger.finishOpenReasoning(event.status))) {
          yield* measuredEvent(context, () => emitter.reasoningDone(reasoning));
        }
        const items = measuredWork(context, () => ledger.items(event.status));
        yield* measuredEvent(context, () => emitter.finish(event, usage, items));
        yield { kind: "terminal", terminal: event.status };
        return;
      }
    } finally {
      context.flushEventMeasurement?.();
    }
  }
  invalid();
}

function startsSemanticOutput(event: SemanticStreamEvent): boolean {
  if (event.kind === "semantic_progress" || event.kind === "tool_start" || event.kind === "tool_done") {
    return true;
  }
  if (event.kind === "text_delta" || event.kind === "tool_arguments_delta") {
    return event.delta.length > 0;
  }
  if (event.kind === "reasoning_delta") {
    return event.delta.length > 0;
  }
  if (event.kind === "reasoning_snapshot") {
    return event.text.length > 0;
  }
  if (event.kind === "text_done") {
    return event.text.length > 0;
  }
  if (event.kind === "refusal_delta") {
    return event.delta.length > 0;
  }
  if (event.kind === "refusal_done") {
    return event.refusal.length > 0;
  }
  return event.kind === "terminal";
}

function measuredEvent(
  context: Readonly<StreamConversionContext>,
  work: () => Iterable<ConvertedStreamEmission>,
): readonly ConvertedStreamEmission[] {
  return measuredWork(context, () => [...work()]);
}

function measuredWork<T>(context: Readonly<StreamConversionContext>, work: () => T): T {
  return context.measureEvent === undefined ? work() : context.measureEvent(work);
}

interface StreamEmitter {
  start(): Iterable<ConvertedStreamEmission>;
  activateReserved(): Iterable<ConvertedStreamEmission>;
  messageStart(key: string): Iterable<ConvertedStreamEmission>;
  reserveMessage(key: string, kind: "text" | "refusal"): Iterable<ConvertedStreamEmission>;
  contentDone(orderKey: string, contentIndex: number): Iterable<ConvertedStreamEmission>;
  itemDone(outputIndex: number): Iterable<ConvertedStreamEmission>;
  reasoningDelta(event: Extract<SemanticStreamEvent, { readonly kind: "reasoning_delta" }>): Iterable<ConvertedStreamEmission>;
  reasoningDone(item: Extract<SemanticResponseItem, { readonly type: "reasoning" }>): Iterable<ConvertedStreamEmission>;
  textDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission>;
  refusalDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission>;
  toolStart(key: string, callId: string, name: string, itemId?: string): Iterable<ConvertedStreamEmission>;
  toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission>;
  toolDone(key: string, argumentsJson: string): Iterable<ConvertedStreamEmission>;
  finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
    items: readonly SemanticResponseItem[],
  ): Iterable<ConvertedStreamEmission>;
}

function createEmitter(context: Readonly<StreamConversionContext>): StreamEmitter {
  if (context.target === "chat") {
    return new ChatEmitter(context);
  }
  if (context.target === "messages") {
    return new MessagesEmitter(context);
  }
  return new ResponsesEmitter(context);
}

class ChatEmitter implements StreamEmitter {
  private readonly id: string;
  private readonly created: number;
  private readonly sourceResponses: boolean;
  private roleSent = false;
  private readonly toolIndexes = new Map<string, number>();
  private readonly streamedToolArguments = new Map<string, string>();
  private readonly pendingTools = new Map<string, {
    readonly callId: string;
    readonly name: string;
    argumentsJson: string;
  }>();
  private readonly streamedContent = new Map<string, { text: string; refusal: string }>();
  private readonly streamedReasoning = new Map<string, string>();
  private readonly pendingReasoning = new Map<string, Extract<SemanticResponseItem, { readonly type: "reasoning" }>>();
  private readonly pendingContent = new Map<string, {
    readonly orderKey: string;
    readonly kind: "text" | "refusal";
    delta: string;
  }>();
  private readonly responseFrontier = new ResponseEmissionFrontier();
  private readonly carrierTokens = new Map<string, string>();
  private readonly emittedReasoningItems = new Set<string>();

  constructor(private readonly context: Readonly<StreamConversionContext>) {
    this.id = `chatcmpl_${context.createUuid()}`;
    this.created = context.nowUnixSeconds();
    this.sourceResponses = context.source === "responses";
  }

  *start(): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      yield this.chunk(wireObject([["role", "assistant"]]));
      this.roleSent = true;
    }
  }

  *activateReserved(): Iterable<ConvertedStreamEmission> {}

  *messageStart(_key: string): Iterable<ConvertedStreamEmission> {}

  *reserveMessage(_key: string, _kind: "text" | "refusal"): Iterable<ConvertedStreamEmission> {}

  *contentDone(orderKey: string, contentIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.markContentDone(orderKey, contentIndex);
    yield* this.drainReadyContent();
  }

  *itemDone(outputIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.markItemDone(outputIndex);
    yield* this.drainReadyContent();
  }

  *reasoningDelta(event: Extract<SemanticStreamEvent, { readonly kind: "reasoning_delta" }>): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      return;
    }
    yield* this.emitReasoningDelta(event.partKey, event.delta);
  }

  reasoningDone(item: Extract<SemanticResponseItem, { readonly type: "reasoning" }>): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      if (item.key === undefined || this.pendingReasoning.has(item.key)) invalid();
      this.pendingReasoning.set(item.key, item);
    }
    return [];
  }

  *textDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      if (!this.responseFrontier.allowsContent(key, orderKey)) {
        this.queueContent(key, orderKey, "text", delta);
        return;
      }
    }
    yield this.chunk(wireObject([
      ...(!this.roleSent ? [["role", "assistant"] as const] : []),
      ["content", delta],
    ]));
    this.roleSent = true;
    if (this.sourceResponses) {
      this.recordStreamed(key, "text", delta);
    }
  }

  *refusalDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      if (!this.responseFrontier.allowsContent(key, orderKey)) {
        this.queueContent(key, orderKey, "refusal", delta);
        return;
      }
    }
    yield this.chunk(wireObject([
      ...(!this.roleSent ? [["role", "assistant"] as const] : []),
      ["refusal", delta],
    ]));
    this.roleSent = true;
    if (this.sourceResponses) {
      this.recordStreamed(key, "refusal", delta);
    }
  }

  *toolStart(key: string, callId: string, name: string): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      if (!this.responseFrontier.allowsItem(key)) {
        this.pendingTools.set(key, { callId, name, argumentsJson: "" });
        return;
      }
    }
    yield* this.emitToolStart(key, callId, name);
  }

  *toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    const pending = this.pendingTools.get(key);
    if (pending !== undefined) {
      pending.argumentsJson += delta;
      return;
    }
    const index = this.toolIndexes.get(key);
    if (index === undefined) {
      if (this.sourceResponses) {
        return;
      }
      invalid();
    }
    yield this.chunk(wireObject([
      ["tool_calls", wireArray([wireObject([
        ["index", wireNumber(index)],
        ["function", wireObject([["arguments", delta]])],
      ])])],
    ]));
    this.streamedToolArguments.set(key, `${this.streamedToolArguments.get(key) ?? ""}${delta}`);
  }

  *toolDone(_key: string, _argumentsJson: string): Iterable<ConvertedStreamEmission> {}

  *finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
    items: readonly SemanticResponseItem[],
  ): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      yield* this.emitBufferedResponseItems(
        items,
        terminal.status === "completed" && items.some((item) => item.type === "tool_call"),
      );
    }
    if (!this.roleSent) {
      yield this.chunk(wireObject([["role", "assistant"], ["content", ""]]));
      this.roleSent = true;
    }
    yield this.chunk(wireObject([]), chatFinish(terminal.finishReason));
    yield {
      kind: "wire",
      bytes: encodeOpenaiChatCompletionsSseChunk(wireObject([
        ["id", this.id],
        ["object", "chat.completion.chunk"],
        ["created", wireNumber(this.created)],
        ["model", this.context.model],
        ["choices", wireArray([])],
        ["usage", chatUsage(usage)],
      ])),
    };
    yield { kind: "wire", bytes: encodeOpenaiChatCompletionsDone() };
  }

  private *emitBufferedResponseItems(
    items: readonly SemanticResponseItem[],
    allowCarriers = true,
  ): Iterable<ConvertedStreamEmission> {
    for (const item of items) {
      if (item.type === "reasoning") {
        yield* this.emitReasoningItem(item, allowCarriers);
        continue;
      }
      if (item.type === "message") {
        for (let partIndex = 0; partIndex < item.content.length; partIndex += 1) {
          const part = item.content[partIndex];
          if (part === undefined) {
            continue;
          }
          const key = item.contentKeys?.[partIndex] ?? item.key ?? "";
          const streamed = this.streamedContent.get(key)?.[part.type] ?? "";
          if (!part.text.startsWith(streamed)) {
            invalid();
          }
          const remaining = part.text.slice(streamed.length);
          if (remaining.length === 0) {
            continue;
          }
          yield this.chunk(wireObject([
            [part.type === "refusal" ? "refusal" : "content", remaining],
          ]));
        }
        continue;
      }
      if (item.key !== undefined && this.toolIndexes.has(item.key)) {
        const streamed = this.streamedToolArguments.get(item.key) ?? "";
        if (!item.argumentsJson.startsWith(streamed)) {
          invalid();
        }
        const remaining = item.argumentsJson.slice(streamed.length);
        if (remaining.length > 0) {
          yield this.chunk(wireObject([
            ["tool_calls", wireArray([wireObject([
              ["index", wireNumber(this.toolIndexes.get(item.key) as number)],
              ["function", wireObject([["arguments", remaining]])],
            ])])],
          ]));
        }
        continue;
      }
      const index = this.toolIndexes.size;
      this.toolIndexes.set(item.key ?? `tool:${index}`, index);
      yield this.chunk(wireObject([
        ["tool_calls", wireArray([wireObject([
          ["index", wireNumber(index)],
          ["id", item.callId],
          ["type", "function"],
          ["function", wireObject([["name", item.name], ["arguments", item.argumentsJson]])],
        ])])],
      ]));
    }
  }

  private recordStreamed(key: string, kind: "text" | "refusal", delta: string): void {
    const current = this.streamedContent.get(key) ?? { text: "", refusal: "" };
    current[kind] += delta;
    this.streamedContent.set(key, current);
  }

  private queueContent(
    key: string,
    orderKey: string | undefined,
    kind: "text" | "refusal",
    delta: string,
  ): void {
    if (orderKey === undefined) {
      invalid();
    }
    const pending = this.pendingContent.get(key);
    if (pending !== undefined) {
      if (pending.orderKey !== orderKey || pending.kind !== kind) {
        invalid();
      }
      pending.delta += delta;
      return;
    }
    this.pendingContent.set(key, { orderKey, kind, delta });
  }

  private *drainReadyContent(): Iterable<ConvertedStreamEmission> {
    for (;;) {
      const reasoningKey = responseReasoningKey(this.responseFrontier.currentItemIndex());
      const reasoning = this.pendingReasoning.get(reasoningKey);
      if (
        reasoning?.opaqueState?.kind === "responses_item"
        && this.context.carrier !== undefined
        && this.responseFrontier.itemDoneAtFrontier()
      ) {
        return;
      }
      if (reasoning !== undefined) {
        this.pendingReasoning.delete(reasoningKey);
        yield* this.emitReasoningItem(reasoning, false);
      }
      const toolKey = responseToolKey(this.responseFrontier.currentItemIndex());
      const readyTool = this.pendingTools.get(toolKey);
      if (readyTool !== undefined) {
        this.pendingTools.delete(toolKey);
        yield* this.emitToolStart(toolKey, readyTool.callId, readyTool.name);
        if (readyTool.argumentsJson.length > 0) {
          yield* this.toolArgumentsDelta(toolKey, readyTool.argumentsJson);
        }
      }
      const contentIndex = this.responseFrontier.currentContentIndex();
      const textKey = responseMessagePartKey(this.responseFrontier.currentItemIndex(), contentIndex, "text");
      const refusalKey = responseMessagePartKey(this.responseFrontier.currentItemIndex(), contentIndex, "refusal");
      const key = this.pendingContent.has(textKey) ? textKey : this.pendingContent.has(refusalKey) ? refusalKey : undefined;
      if (key !== undefined) {
        const pending = this.pendingContent.get(key) as {
          readonly orderKey: string;
          readonly kind: "text" | "refusal";
          delta: string;
        };
        this.pendingContent.delete(key);
        yield this.chunk(wireObject([
          [pending.kind === "refusal" ? "refusal" : "content", pending.delta],
        ]));
        this.recordStreamed(key, pending.kind, pending.delta);
      }
      const orderKey = this.responseFrontier.currentItemOrderKey();
      if (this.responseFrontier.contentDoneAtFrontier(orderKey)) {
        this.responseFrontier.advanceContent(orderKey);
        continue;
      }
      if (this.responseFrontier.itemDoneAtFrontier()) {
        this.responseFrontier.advanceItem();
        continue;
      }
      return;
    }
  }

  private *emitToolStart(
    key: string,
    callId: string,
    name: string,
  ): Iterable<ConvertedStreamEmission> {
    const index = this.toolIndexes.size;
    this.toolIndexes.set(key, index);
    this.streamedToolArguments.set(key, "");
    yield this.chunk(wireObject([
      ...(!this.roleSent ? [["role", "assistant"] as const] : []),
      ["tool_calls", wireArray([wireObject([
        ["index", wireNumber(index)],
        ["id", callId],
        ["type", "function"],
        ["function", wireObject([["name", name], ["arguments", ""]])],
      ])])],
    ]));
    this.roleSent = true;
  }

  private *emitReasoningItem(
    item: Extract<SemanticResponseItem, { readonly type: "reasoning" }>,
    allowCarrier = true,
  ): Iterable<ConvertedStreamEmission> {
    for (const part of item.parts) {
      const key = part.key ?? `${item.key ?? "reasoning"}:${part.presentation}:${part.index}`;
      const streamed = this.streamedReasoning.get(key) ?? "";
      if (!part.text.startsWith(streamed)) invalid();
      const remaining = part.text.slice(streamed.length);
      if (remaining.length > 0) yield* this.emitReasoningDelta(key, remaining);
    }
    const identity = item.key ?? item.itemId;
    if (
      allowCarrier
      && identity !== undefined
      && !this.emittedReasoningItems.has(identity)
      && this.context.carrier !== undefined
      && item.opaqueState?.kind === "responses_item"
    ) {
      const token = this.carrierToken(item, "chat");
      const state = replaceEncryptedContent(item.opaqueState.item, token);
      yield this.chunk(wireObject([["reasoning_items", wireArray([state])]]));
      this.emittedReasoningItems.add(identity);
    }
  }

  private carrierToken(
    item: SemanticReasoningItem,
    wireProtocol: "chat",
  ): string {
    const key = item.key ?? item.itemId;
    if (key === undefined) invalid();
    const existing = this.carrierTokens.get(key);
    if (existing !== undefined) return existing;
    const created = createStreamCarrier(item, this.context, wireProtocol);
    this.carrierTokens.set(key, created);
    return created;
  }

  private *emitReasoningDelta(partKey: string, delta: string): Iterable<ConvertedStreamEmission> {
    yield this.chunk(wireObject([
      ...(!this.roleSent ? [["role", "assistant"] as const] : []),
      ["reasoning_content", delta],
    ]));
    this.roleSent = true;
    this.streamedReasoning.set(partKey, `${this.streamedReasoning.get(partKey) ?? ""}${delta}`);
  }

  private chunk(delta: ReturnType<typeof wireObject>, finish?: string): ConvertedStreamEmission {
    const payload = wireObject([
      ["id", this.id],
      ["object", "chat.completion.chunk"],
      ["created", wireNumber(this.created)],
      ["model", this.context.model],
      ["choices", wireArray([wireObject([
        ["index", wireNumber(0)],
        ["delta", delta],
        ["finish_reason", finish ?? null],
      ])])],
    ]);
    this.context.diagnostics?.shape("client_output", () => diagnosticShape(payload));
    return {
      kind: "wire",
      bytes: encodeOpenaiChatCompletionsSseChunk(payload),
    };
  }
}

class MessagesEmitter implements StreamEmitter {
  private readonly id: string;
  private nextIndex = 0;
  private activeText: { readonly key: string; readonly index: number } | undefined;
  private bufferedBytes = 0;
  private bufferAfterTool = false;
  private firstMessageKey: string | undefined;
  private readonly responseFrontier = new ResponseEmissionFrontier();
  private readonly emittedResponseTools = new Set<string>();
  private readonly pendingContent = new Map<string, {
    readonly orderKey: string;
    readonly kind: "text" | "refusal";
    delta: string;
  }>();
  private readonly streamedContent = new Map<string, { text: string; refusal: string }>();
  private readonly pendingReasoning = new Map<string, Extract<SemanticResponseItem, { readonly type: "reasoning" }>>();
  private readonly emittedReasoning = new Set<string>();
  private readonly carrierTokens = new Map<string, string>();
  private readonly tools = new Map<string, {
    readonly callId: string;
    readonly name: string;
    argumentsJson: string;
    done: boolean;
    streamIndex?: number | undefined;
    closed: boolean;
    itemEnded: boolean;
  }>();

  constructor(private readonly context: Readonly<StreamConversionContext>) {
    this.id = `msg_${context.createUuid()}`;
  }

  *start(): Iterable<ConvertedStreamEmission> {
    yield this.event({
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        content: [],
        model: this.context.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens_details: null,
        },
      },
    });
  }

  *activateReserved(): Iterable<ConvertedStreamEmission> {}

  messageStart(key: string): Iterable<ConvertedStreamEmission> {
    this.firstMessageKey ??= key;
    return [];
  }

  reserveMessage(key: string, _kind: "text" | "refusal"): Iterable<ConvertedStreamEmission> {
    this.firstMessageKey ??= key;
    return [];
  }

  *contentDone(orderKey: string, contentIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.markContentDone(orderKey, contentIndex);
    yield* this.drainReadyContent();
  }

  *itemDone(outputIndex: number): Iterable<ConvertedStreamEmission> {
    const tool = this.tools.get(responseToolKey(outputIndex));
    if (tool !== undefined) {
      tool.itemEnded = true;
      if (tool.streamIndex !== undefined && !tool.closed) {
        tool.closed = true;
        yield this.event({ type: "content_block_stop", index: tool.streamIndex });
      }
    }
    this.responseFrontier.markItemDone(outputIndex);
    yield* this.drainReadyContent();
  }

  *reasoningDelta(_event: Extract<SemanticStreamEvent, { readonly kind: "reasoning_delta" }>): Iterable<ConvertedStreamEmission> {}

  *reasoningDone(item: Extract<SemanticResponseItem, { readonly type: "reasoning" }>): Iterable<ConvertedStreamEmission> {
    if (item.key === undefined) return;
    if (this.context.source === "responses") {
      this.pendingReasoning.set(item.key, item);
      return;
    }
    if (item.messagesState === undefined) return;
    yield* this.emitReasoning(item);
  }

  *textDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    const messageKey = orderKey ?? key;
    this.firstMessageKey ??= messageKey;
    if (
      this.context.source === "responses"
        ? !this.responseFrontier.allowsContent(key, orderKey)
        : this.bufferAfterTool || messageKey !== this.firstMessageKey
    ) {
      if (this.context.source === "responses") {
        this.queueContent(key, orderKey, "text", delta);
      }
      return;
    }
    yield* this.emitLiveText(key, delta);
    this.recordStreamed(key, "text", delta);
  }

  *refusalDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    const messageKey = orderKey ?? key;
    this.firstMessageKey ??= messageKey;
    if (
      this.context.source === "responses"
        ? !this.responseFrontier.allowsContent(key, orderKey)
        : this.bufferAfterTool || messageKey !== this.firstMessageKey
    ) {
      if (this.context.source === "responses") {
        this.queueContent(key, orderKey, "refusal", delta);
      }
      return;
    }
    yield* this.emitLiveText(`refusal:${key}`, delta);
    this.recordStreamed(key, "refusal", delta);
  }

  *toolStart(key: string, callId: string, name: string): Iterable<ConvertedStreamEmission> {
    yield* this.closeActiveText();
    if (this.tools.has(key)) {
      invalid();
    }
    this.bufferAfterTool = true;
    const tool = { callId, name, argumentsJson: "", done: false, closed: false, itemEnded: false };
    this.tools.set(key, tool);
    if (this.context.source === "responses" && this.responseFrontier.allowsItem(key)) {
      yield* this.emitTool(key, tool);
    }
  }

  *toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    const tool = this.tools.get(key);
    if (tool === undefined || tool.done) {
      invalid();
    }
    this.bufferedBytes += new TextEncoder().encode(delta).byteLength;
    if (this.bufferedBytes > this.context.accumulatorBytes) {
      invalid();
    }
    tool.argumentsJson += delta;
    if (this.context.source === "responses" && tool.streamIndex !== undefined) {
      yield this.event({
        type: "content_block_delta",
        index: tool.streamIndex,
        delta: { type: "input_json_delta", partial_json: delta },
      });
    }
  }

  *toolDone(key: string, argumentsJson: string): Iterable<ConvertedStreamEmission> {
    yield* this.closeActiveText();
    const tool = this.tools.get(key);
    if (tool === undefined || tool.done) {
      return;
    }
    if (argumentsJson !== tool.argumentsJson) {
      invalid();
    }
    tool.done = true;
    if (
      this.context.source === "responses"
      && tool.streamIndex !== undefined
      && !tool.closed
    ) {
      tool.closed = true;
      yield this.event({ type: "content_block_stop", index: tool.streamIndex });
    }
  }

  *finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
    items: readonly SemanticResponseItem[],
  ): Iterable<ConvertedStreamEmission> {
    yield* this.closeActiveText();
    yield* this.closeOpenTools();
    yield* this.emitBufferedItems(
      items,
      terminal.status === "completed" && items.some((item) => item.type === "tool_call"),
    );
    yield* this.closeOpenTools();
    yield this.event({
      type: "message_delta",
      delta: {
        stop_reason: messagesFinish(terminal.finishReason),
      },
      usage: messagesUsage(usage),
    });
    yield this.event({ type: "message_stop" });
  }

  private *closeActiveText(): Iterable<ConvertedStreamEmission> {
    if (this.activeText === undefined) {
      return;
    }
    yield this.event({ type: "content_block_stop", index: this.activeText.index });
    this.activeText = undefined;
  }

  private *emitBufferedItems(
    items: readonly SemanticResponseItem[],
    allowCarriers: boolean,
  ): Iterable<ConvertedStreamEmission> {
    for (const item of items) {
      if (item.type === "reasoning") {
        if (item.messagesState !== undefined || item.opaqueState?.kind === "responses_item") {
          yield* this.emitReasoning(item, allowCarriers);
        }
        continue;
      }
      if (item.type === "message") {
        for (let partIndex = 0; partIndex < item.content.length; partIndex += 1) {
          const part = item.content[partIndex];
          if (part === undefined) {
            continue;
          }
          const contentKey = item.contentKeys?.[partIndex] ?? item.key;
          const streamed = contentKey === undefined
            ? ""
            : this.streamedContent.get(contentKey)?.[part.type] ?? "";
          if (!part.text.startsWith(streamed)) {
            invalid();
          }
          const remaining = part.text.slice(streamed.length);
          if (remaining.length === 0) {
            continue;
          }
          const index = this.nextIndex++;
          yield this.event({
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
          yield this.event({
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: remaining },
          });
          yield this.event({ type: "content_block_stop", index });
        }
        continue;
      }
      const tool = item.key === undefined ? undefined : this.tools.get(item.key);
      if (tool === undefined) {
        invalid();
      }
      if (item.key !== undefined && this.emittedResponseTools.has(item.key)) {
        continue;
      }
      yield* this.emitTool(item.key ?? `tool:${this.nextIndex}`, tool, true);
    }
  }

  private *emitLiveText(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    if (this.activeText?.key !== key) {
      yield* this.closeActiveText();
      const index = this.nextIndex++;
      this.activeText = { key, index };
      yield this.event({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
    }
    yield this.event({
      type: "content_block_delta",
      index: this.activeText.index,
      delta: { type: "text_delta", text: delta },
    });
  }

  private *emitReasoning(
    item: Extract<SemanticResponseItem, { readonly type: "reasoning" }>,
    allowCarrier = true,
  ): Iterable<ConvertedStreamEmission> {
    if (item.key === undefined || this.emittedReasoning.has(item.key)) return;
    if (
      item.messagesState === undefined
      && (!allowCarrier || this.context.carrier === undefined || item.opaqueState?.kind !== "responses_item")
    ) return;
    yield* this.closeActiveText();
    if (allowCarrier && this.context.carrier !== undefined && item.opaqueState?.kind === "responses_item") {
      const index = this.nextIndex++;
      let token = this.carrierTokens.get(item.key);
      if (token === undefined) {
        token = createStreamCarrier(item, this.context, "messages");
        this.carrierTokens.set(item.key, token);
      }
      const visible = item.parts.map((part) => part.text).join("");
      yield this.event({
        type: "content_block_start",
        index,
        content_block: visible.length === 0
          ? { type: "redacted_thinking", data: token }
          : { type: "thinking", thinking: visible, signature: token },
      });
      yield this.event({ type: "content_block_stop", index });
      this.emittedReasoning.add(item.key);
      return;
    }
    if (item.messagesState === undefined) return;
    const index = this.nextIndex++;
    if (item.messagesState.type === "redacted_thinking") {
      yield this.event({
        type: "content_block_start",
        index,
        content_block: { type: "redacted_thinking", data: item.messagesState.data },
      });
      yield this.event({ type: "content_block_stop", index });
      this.emittedReasoning.add(item.key);
      return;
    }
    const thinking = item.messagesState.thinking;
    const visible = item.parts.map((part) => part.text).join("");
    if (visible.length > 0 && visible !== thinking) invalid();
    yield this.event({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    if (thinking.length > 0) {
      yield this.event({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking },
      });
    }
    yield this.event({
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: item.messagesState.signature },
    });
    yield this.event({ type: "content_block_stop", index });
    this.emittedReasoning.add(item.key);
  }

  private recordStreamed(key: string, kind: "text" | "refusal", delta: string): void {
    const current = this.streamedContent.get(key) ?? { text: "", refusal: "" };
    current[kind] += delta;
    this.streamedContent.set(key, current);
  }

  private queueContent(
    key: string,
    orderKey: string | undefined,
    kind: "text" | "refusal",
    delta: string,
  ): void {
    if (orderKey === undefined) {
      invalid();
    }
    const pending = this.pendingContent.get(key);
    if (pending !== undefined) {
      if (pending.orderKey !== orderKey || pending.kind !== kind) {
        invalid();
      }
      pending.delta += delta;
      return;
    }
    this.pendingContent.set(key, { orderKey, kind, delta });
  }

  private *drainReadyContent(): Iterable<ConvertedStreamEmission> {
    for (;;) {
      const reasoningKey = responseReasoningKey(this.responseFrontier.currentItemIndex());
      const reasoning = this.pendingReasoning.get(reasoningKey);
      if (
        reasoning?.opaqueState?.kind === "responses_item"
        && this.context.carrier !== undefined
        && this.responseFrontier.itemDoneAtFrontier()
      ) {
        return;
      }
      if (reasoning !== undefined) {
        if (reasoning.messagesState !== undefined) {
          this.pendingReasoning.delete(reasoningKey);
          yield* this.emitReasoning(reasoning, false);
        }
      }
      const toolKey = responseToolKey(this.responseFrontier.currentItemIndex());
      const tool = this.tools.get(toolKey);
      if (tool !== undefined && !this.emittedResponseTools.has(toolKey)) {
        yield* this.emitTool(toolKey, tool);
      }
      const contentIndex = this.responseFrontier.currentContentIndex();
      const textKey = responseMessagePartKey(this.responseFrontier.currentItemIndex(), contentIndex, "text");
      const refusalKey = responseMessagePartKey(this.responseFrontier.currentItemIndex(), contentIndex, "refusal");
      const key = this.pendingContent.has(textKey) ? textKey : this.pendingContent.has(refusalKey) ? refusalKey : undefined;
      if (key !== undefined) {
        const pending = this.pendingContent.get(key) as {
          readonly orderKey: string;
          readonly kind: "text" | "refusal";
          delta: string;
        };
        this.pendingContent.delete(key);
        yield* this.emitLiveText(pending.kind === "refusal" ? `refusal:${key}` : key, pending.delta);
        this.recordStreamed(key, pending.kind, pending.delta);
      }
      const orderKey = this.responseFrontier.currentItemOrderKey();
      if (this.responseFrontier.contentDoneAtFrontier(orderKey)) {
        this.responseFrontier.advanceContent(orderKey);
        continue;
      }
      if (this.responseFrontier.itemDoneAtFrontier()) {
        this.pendingReasoning.delete(reasoningKey);
        this.responseFrontier.advanceItem();
        continue;
      }
      return;
    }
  }

  private *emitTool(key: string, tool: {
    readonly callId: string;
    readonly name: string;
    readonly argumentsJson: string;
    streamIndex?: number | undefined;
    readonly done: boolean;
    closed: boolean;
    readonly itemEnded: boolean;
  }, close = false): Iterable<ConvertedStreamEmission> {
    if (tool.streamIndex !== undefined) {
      return;
    }
    yield* this.closeActiveText();
    const index = this.nextIndex++;
    tool.streamIndex = index;
    this.emittedResponseTools.add(key);
    yield this.event({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: tool.callId, name: tool.name, input: {} },
    });
    if (tool.argumentsJson.length > 0) {
      yield this.event({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: tool.argumentsJson },
      });
    }
    if ((tool.done || tool.itemEnded || close) && !tool.closed) {
      tool.closed = true;
      yield this.event({ type: "content_block_stop", index });
    }
  }

  private *closeOpenTools(): Iterable<ConvertedStreamEmission> {
    for (const tool of this.tools.values()) {
      if (tool.streamIndex === undefined || tool.closed) {
        continue;
      }
      tool.closed = true;
      yield this.event({ type: "content_block_stop", index: tool.streamIndex });
    }
  }

  private event(value: Record<string, unknown>): ConvertedStreamEmission {
    this.context.diagnostics?.shape("client_output", () => diagnosticObjectShape(value));
    return {
      kind: "wire",
      bytes: encodeAnthropicMessagesSseEvent(value as { readonly type: string; readonly [key: string]: unknown }),
    };
  }
}

class ResponsesEmitter implements StreamEmitter {
  private readonly responseId: string;
  private readonly createdAt: number;
  private sequence = 0;
  private nextOutputIndex = 0;
  private readonly messages = new Map<string, {
    readonly id: string;
    readonly outputIndex: number;
    itemAdded: boolean;
    nextContentIndex: number;
    textIndex?: number;
    refusalIndex?: number;
  }>();
  private readonly tools = new Map<string, {
    readonly itemId: string;
    readonly callId: string;
    readonly name: string;
    readonly outputIndex: number;
    done: boolean;
  }>();
  private readonly reasoning = new Map<string, {
    readonly id: string;
    readonly outputIndex: number;
    itemAdded: boolean;
    done: boolean;
    readonly parts: Map<string, {
      readonly presentation: "summary" | "content";
      readonly index: number;
      text: string;
      started: boolean;
    }>;
    carrierToken?: string | undefined;
  }>();
  private readonly completed = new Map<number, ReturnType<typeof wireObject>>();

  constructor(private readonly context: Readonly<StreamConversionContext>) {
    this.responseId = managedConvertedResponseId(context.source, context.model, context.createUuid());
    this.createdAt = context.nowUnixSeconds();
  }

  *start(): Iterable<ConvertedStreamEmission> {
    yield {
      kind: "checkpoint",
      intent: { responseId: this.responseId, output: [], state: "route_only" },
    };
    yield this.responseEvent("response.created", "in_progress", []);
    yield this.responseEvent("response.in_progress", "in_progress", []);
  }

  *activateReserved(): Iterable<ConvertedStreamEmission> {
    for (const message of [...this.messages.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
      if (message.itemAdded) {
        continue;
      }
      message.itemAdded = true;
      yield this.itemEvent(
        "response.output_item.added",
        message.outputIndex,
        responseMessage(message, "in_progress", "", ""),
      );
      if (message.textIndex !== undefined) {
        yield this.contentEvent("response.content_part.added", message, message.textIndex, outputText(""));
      }
      if (message.refusalIndex !== undefined) {
        yield this.contentEvent("response.content_part.added", message, message.refusalIndex, refusal(""));
      }
    }
  }

  *messageStart(_key: string): Iterable<ConvertedStreamEmission> {}

  reserveMessage(key: string, kind: "text" | "refusal"): Iterable<ConvertedStreamEmission> {
    const message = this.ensureMessage(key);
    if (kind === "text" && message.textIndex === undefined) {
      message.textIndex = message.nextContentIndex++;
    } else if (kind === "refusal" && message.refusalIndex === undefined) {
      message.refusalIndex = message.nextContentIndex++;
    }
    return [];
  }

  *contentDone(_orderKey: string, _contentIndex: number): Iterable<ConvertedStreamEmission> {}

  *itemDone(_outputIndex: number): Iterable<ConvertedStreamEmission> {}

  *reasoningDelta(event: Extract<SemanticStreamEvent, { readonly kind: "reasoning_delta" }>): Iterable<ConvertedStreamEmission> {
    const reasoning = this.ensureReasoning(event.key, event.itemId);
    if (!reasoning.itemAdded) {
      reasoning.itemAdded = true;
      yield this.itemEvent(
        "response.output_item.added",
        reasoning.outputIndex,
        responseReasoning(reasoning, "in_progress", []),
      );
    }
    let part = reasoning.parts.get(event.partKey);
    if (part === undefined) {
      part = {
        presentation: event.presentation,
        index: event.partIndex,
        text: "",
        started: false,
      };
      reasoning.parts.set(event.partKey, part);
    } else if (part.presentation !== event.presentation || part.index !== event.partIndex) {
      invalid();
    }
    if (part.presentation === "summary" && !part.started) {
      part.started = true;
      yield this.event(wireObject([
        ["type", "response.reasoning_summary_part.added"],
        ["sequence_number", wireNumber(this.sequence++)],
        ["item_id", reasoning.id],
        ["output_index", wireNumber(reasoning.outputIndex)],
        ["summary_index", wireNumber(part.index)],
        ["part", summaryText("")],
      ]));
    } else if (part.presentation === "content" && !part.started) {
      yield this.contentEvent(
        "response.content_part.added",
        reasoning,
        part.index,
        reasoningText(""),
      );
    }
    part.started = true;
    part.text += event.delta;
    yield this.event(wireObject([
      ["type", part.presentation === "summary"
        ? "response.reasoning_summary_text.delta"
        : "response.reasoning_text.delta"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", reasoning.id],
      ["output_index", wireNumber(reasoning.outputIndex)],
      [part.presentation === "summary" ? "summary_index" : "content_index", wireNumber(part.index)],
      ["delta", event.delta],
    ]));
  }

  *reasoningDone(item: Extract<SemanticResponseItem, { readonly type: "reasoning" }>): Iterable<ConvertedStreamEmission> {
    if (!item.parts.some((part) => part.text.length > 0) && item.opaqueState === undefined) return;
    if (item.key === undefined) invalid();
    const reasoning = this.ensureReasoning(item.key, item.itemId);
    if (reasoning.done) return;
    if (!reasoning.itemAdded) {
      reasoning.itemAdded = true;
      yield this.itemEvent(
        "response.output_item.added",
        reasoning.outputIndex,
        responseReasoning(reasoning, "in_progress", []),
      );
    }
    for (const semanticPart of item.parts) {
      const partKey = semanticPart.key ?? `${item.key}:${semanticPart.presentation}:${semanticPart.index}`;
      const part = reasoning.parts.get(partKey);
      if (part === undefined || part.text !== semanticPart.text) invalid();
      if (part.presentation === "summary") {
        yield this.event(wireObject([
          ["type", "response.reasoning_summary_text.done"],
          ["sequence_number", wireNumber(this.sequence++)],
          ["item_id", reasoning.id],
          ["output_index", wireNumber(reasoning.outputIndex)],
          ["summary_index", wireNumber(part.index)],
          ["text", part.text],
        ]));
        yield this.event(wireObject([
          ["type", "response.reasoning_summary_part.done"],
          ["sequence_number", wireNumber(this.sequence++)],
          ["item_id", reasoning.id],
          ["output_index", wireNumber(reasoning.outputIndex)],
          ["summary_index", wireNumber(part.index)],
          ["part", summaryText(part.text)],
        ]));
      } else {
        yield this.event(wireObject([
          ["type", "response.reasoning_text.done"],
          ["sequence_number", wireNumber(this.sequence++)],
          ["item_id", reasoning.id],
          ["output_index", wireNumber(reasoning.outputIndex)],
          ["content_index", wireNumber(part.index)],
          ["text", part.text],
        ]));
        yield this.contentEvent(
          "response.content_part.done",
          reasoning,
          part.index,
          reasoningText(part.text),
        );
      }
    }
    reasoning.done = true;
    const completed = responseReasoning(reasoning, item.status ?? "completed", item.parts, reasoning.carrierToken);
    this.completed.set(reasoning.outputIndex, completed);
    if (reasoning.carrierToken !== undefined) {
      yield {
        kind: "checkpoint",
        intent: {
          responseId: this.responseId,
          output: this.completedOutput(),
          state: "partial",
          carrierTokens: this.carrierTokens(),
        },
      };
    }
    if (this.context.carrier === undefined || item.opaqueState === undefined) {
      yield this.itemEvent("response.output_item.done", reasoning.outputIndex, completed);
    }
  }

  *textDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    const message = this.ensureMessage(orderKey ?? key);
    if (!message.itemAdded) {
      message.itemAdded = true;
      yield this.itemEvent("response.output_item.added", message.outputIndex, responseMessage(message, "in_progress", "", ""));
    }
    if (message.textIndex === undefined) {
      message.textIndex = message.nextContentIndex++;
      yield this.contentEvent("response.content_part.added", message, message.textIndex, outputText(""));
    }
    yield this.event(wireObject([
      ["type", "response.output_text.delta"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", message.id],
      ["output_index", wireNumber(message.outputIndex)],
      ["content_index", wireNumber(message.textIndex)],
      ["delta", delta],
    ]));
  }

  *refusalDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    const message = this.ensureMessage(orderKey ?? key);
    if (!message.itemAdded) {
      message.itemAdded = true;
      yield this.itemEvent("response.output_item.added", message.outputIndex, responseMessage(message, "in_progress", "", ""));
    }
    if (message.refusalIndex === undefined) {
      message.refusalIndex = message.nextContentIndex++;
      yield this.contentEvent("response.content_part.added", message, message.refusalIndex, refusal(""));
    }
    yield this.event(wireObject([
      ["type", "response.refusal.delta"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", message.id],
      ["output_index", wireNumber(message.outputIndex)],
      ["content_index", wireNumber(message.refusalIndex)],
      ["delta", delta],
    ]));
  }

  *toolStart(key: string, callId: string, name: string, itemId?: string): Iterable<ConvertedStreamEmission> {
    const tool = {
      itemId: itemId ?? `fc_${this.context.createUuid()}`,
      callId,
      name,
      outputIndex: this.nextOutputIndex++,
      done: false,
    };
    this.tools.set(key, tool);
    yield this.itemEvent(
      "response.output_item.added",
      tool.outputIndex,
      responseTool(tool, "in_progress", ""),
    );
  }

  *toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    const tool = this.tools.get(key);
    if (tool === undefined) {
      invalid();
    }
    yield this.event(wireObject([
      ["type", "response.function_call_arguments.delta"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", tool.itemId],
      ["output_index", wireNumber(tool.outputIndex)],
      ["delta", delta],
    ]));
  }

  *toolDone(key: string, argumentsJson: string): Iterable<ConvertedStreamEmission> {
    const tool = this.tools.get(key);
    if (tool === undefined || tool.done) {
      return;
    }
    tool.done = true;
    const completed = responseTool(tool, "completed", argumentsJson);
    this.completed.set(tool.outputIndex, completed);
    yield {
      kind: "checkpoint",
      intent: {
        responseId: this.responseId,
        output: this.completedOutput(),
        state: "partial",
        ...(this.carrierTokens().length === 0 ? {} : { carrierTokens: this.carrierTokens() }),
      },
    };
    yield this.event(wireObject([
      ["type", "response.function_call_arguments.done"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", tool.itemId],
      ["output_index", wireNumber(tool.outputIndex)],
      ["name", tool.name],
      ["arguments", argumentsJson],
    ]));
    yield this.itemEvent(
      "response.output_item.done",
      tool.outputIndex,
      completed,
    );
  }

  *finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
    items: readonly SemanticResponseItem[],
  ): Iterable<ConvertedStreamEmission> {
    if (terminal.status === "completed" && this.context.carrier !== undefined) {
      const hasTool = items.some((item) => item.type === "tool_call");
      if (hasTool) {
        for (const item of items) {
          if (item.type !== "reasoning" || item.opaqueState === undefined || item.key === undefined) continue;
          const reasoning = this.ensureReasoning(item.key, item.itemId);
          reasoning.carrierToken ??= createStreamCarrier(item, this.context, "responses", this.responseId);
          const completed = responseReasoning(
            reasoning,
            item.status ?? terminal.status,
            item.parts,
            reasoning.carrierToken,
          );
          this.completed.set(reasoning.outputIndex, completed);
        }
        if (this.carrierTokens().length > 0) {
          yield {
            kind: "checkpoint",
            intent: {
              responseId: this.responseId,
              output: responseOutput(items, terminal.status, this.messages, this.reasoning, this.tools),
              state: "partial",
              carrierTokens: this.carrierTokens(),
            },
          };
        }
      }
    }
    for (const item of items) {
      if (item.type !== "message" || item.key === undefined) {
        continue;
      }
      const message = this.ensureMessage(item.key);
      if (message.itemAdded) {
        continue;
      }
      message.itemAdded = true;
      yield this.itemEvent(
        "response.output_item.added",
        message.outputIndex,
        responseMessage(message, "in_progress", "", ""),
      );
      for (const part of item.content) {
        if (part.type === "text" && message.textIndex === undefined) {
          message.textIndex = message.nextContentIndex++;
          yield this.contentEvent("response.content_part.added", message, message.textIndex, outputText(""));
        } else if (part.type === "refusal" && message.refusalIndex === undefined) {
          message.refusalIndex = message.nextContentIndex++;
          yield this.contentEvent("response.content_part.added", message, message.refusalIndex, refusal(""));
        }
      }
    }
    const output = responseOutput(items, terminal.status, this.messages, this.reasoning, this.tools);
    if (terminal.status === "completed") {
      yield {
        kind: "checkpoint",
        intent: {
          responseId: this.responseId,
          output,
          state: "complete",
          ...(this.carrierTokens().length === 0 ? {} : { carrierTokens: this.carrierTokens() }),
        },
      };
    }
    if (this.context.carrier !== undefined) {
      for (const item of items) {
        if (item.type !== "reasoning" || item.key === undefined) continue;
        const reasoning = this.reasoning.get(item.key);
        if (reasoning === undefined || item.opaqueState === undefined) continue;
        yield this.itemEvent(
          "response.output_item.done",
          reasoning.outputIndex,
          responseReasoning(reasoning, item.status ?? terminal.status, item.parts, reasoning.carrierToken),
        );
      }
    }
    for (const item of items) {
      if (item.type !== "message" || item.key === undefined) {
        continue;
      }
      const message = this.messages.get(item.key);
      if (message?.itemAdded !== true) {
        continue;
      }
      const text = item.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const refused = item.content.filter((part) => part.type === "refusal").map((part) => part.text).join("");
      this.completed.set(
        message.outputIndex,
        responseMessage(message, terminal.status, text, refused),
      );
      if (message.textIndex !== undefined) {
        yield this.event(wireObject([
          ["type", "response.output_text.done"],
          ["sequence_number", wireNumber(this.sequence++)],
          ["item_id", message.id],
          ["output_index", wireNumber(message.outputIndex)],
          ["content_index", wireNumber(message.textIndex)],
          ["text", text],
        ]));
        yield this.contentEvent("response.content_part.done", message, message.textIndex, outputText(text));
      }
      if (message.refusalIndex !== undefined) {
        yield this.event(wireObject([
          ["type", "response.refusal.done"],
          ["sequence_number", wireNumber(this.sequence++)],
          ["item_id", message.id],
          ["output_index", wireNumber(message.outputIndex)],
          ["content_index", wireNumber(message.refusalIndex)],
          ["refusal", refused],
        ]));
        yield this.contentEvent("response.content_part.done", message, message.refusalIndex, refusal(refused));
      }
      yield this.itemEvent(
        "response.output_item.done",
        message.outputIndex,
        responseMessage(message, terminal.status, text, refused),
      );
    }
    const finalType = terminal.status === "completed" ? "response.completed" : "response.incomplete";
    yield this.responseEvent(finalType, terminal.status, output, usage, terminal.finishReason);
  }

  private ensureMessage(key: string) {
    let message = this.messages.get(key);
    if (message === undefined) {
      message = {
        id: `msg_${this.context.createUuid()}`,
        outputIndex: this.nextOutputIndex++,
        itemAdded: false,
        nextContentIndex: 0,
      };
      this.messages.set(key, message);
    }
    return message;
  }

  private ensureReasoning(key: string, itemId?: string) {
    let reasoning = this.reasoning.get(key);
    if (reasoning === undefined) {
      reasoning = {
        id: itemId ?? `rs_${this.context.createUuid()}`,
        outputIndex: this.nextOutputIndex++,
        itemAdded: false,
        done: false,
        parts: new Map(),
      };
      this.reasoning.set(key, reasoning);
    } else if (itemId !== undefined && reasoning.id !== itemId) {
      invalid();
    }
    return reasoning;
  }

  private completedOutput(): readonly ReturnType<typeof wireObject>[] {
    return [...this.completed.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  }

  private carrierTokens(): readonly string[] {
    return [...this.reasoning.values()]
      .map((item) => item.carrierToken)
      .filter((token): token is string => token !== undefined);
  }

  private responseEvent(
    type: string,
    status: "in_progress" | "completed" | "incomplete",
    output: readonly ReturnType<typeof wireObject>[],
    usage = ZERO_USAGE,
    finishReason?: SemanticResponse["finishReason"],
  ): ConvertedStreamEmission {
    return this.event(wireObject([
      ["type", type],
      ["sequence_number", wireNumber(this.sequence++)],
      ["response", responseSnapshot(
        this.responseId,
        this.createdAt,
        this.context.model,
        status,
        output,
        usage,
        finishReason,
        this.context.previousResponseId,
      )],
    ]));
  }

  private itemEvent(
    type: string,
    outputIndex: number,
    item: ReturnType<typeof wireObject>,
  ): ConvertedStreamEmission {
    return this.event(wireObject([
      ["type", type],
      ["sequence_number", wireNumber(this.sequence++)],
      ["output_index", wireNumber(outputIndex)],
      ["item", item],
    ]));
  }

  private contentEvent(
    type: string,
    message: { readonly id: string; readonly outputIndex: number },
    contentIndex: number,
    part: ReturnType<typeof wireObject>,
  ): ConvertedStreamEmission {
    return this.event(wireObject([
      ["type", type],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", message.id],
      ["output_index", wireNumber(message.outputIndex)],
      ["content_index", wireNumber(contentIndex)],
      ["part", part],
    ]));
  }

  private event(value: ReturnType<typeof wireObject>): ConvertedStreamEmission {
    this.context.diagnostics?.shape("client_output", () => diagnosticShape(value));
    return { kind: "wire", bytes: encodeOpenaiResponsesSseEvent(value) };
  }
}

class ResponseEmissionFrontier {
  private item = 0;
  private readonly completedItems = new Set<number>();
  private readonly content = new Map<string, number>();
  private readonly completedContent = new Map<string, Set<number>>();

  allowsContent(key: string, orderKey: string | undefined): boolean {
    if (orderKey === undefined) {
      return false;
    }
    const itemIndex = responseOutputIndex(orderKey);
    const contentPosition = responseMessagePartPosition(key);
    if (itemIndex === undefined || orderKey !== responseMessageKey(itemIndex) || contentPosition === undefined) {
      return false;
    }
    return itemIndex === this.item
      && contentPosition.outputIndex === itemIndex
      && contentPosition.contentIndex === (this.content.get(orderKey) ?? 0);
  }

  allowsItem(key: string): boolean {
    const outputIndex = responseOutputIndex(key);
    return outputIndex !== undefined && outputIndex === this.item;
  }

  markContentDone(orderKey: string, contentIndex: number): void {
    const completed = this.completedContent.get(orderKey) ?? new Set<number>();
    completed.add(contentIndex);
    this.completedContent.set(orderKey, completed);
  }

  contentDoneAtFrontier(orderKey: string): boolean {
    return this.completedContent.get(orderKey)?.has(this.content.get(orderKey) ?? 0) === true;
  }

  advanceContent(orderKey: string): void {
    const frontier = this.content.get(orderKey) ?? 0;
    this.completedContent.get(orderKey)?.delete(frontier);
    this.content.set(orderKey, frontier + 1);
  }

  markItemDone(outputIndex: number): void {
    this.completedItems.add(outputIndex);
  }

  itemDoneAtFrontier(): boolean {
    return this.completedItems.has(this.item);
  }

  advanceItem(): void {
    this.completedItems.delete(this.item);
    this.item += 1;
  }

  currentItemOrderKey(): string {
    return responseMessageKey(this.item);
  }

  currentItemIndex(): number {
    return this.item;
  }

  currentContentIndex(): number {
    return this.content.get(this.currentItemOrderKey()) ?? 0;
  }
}

function responseOutput(
  items: readonly SemanticResponseItem[],
  status: "completed" | "incomplete",
  messages: ReadonlyMap<string, {
    readonly id: string;
    readonly outputIndex: number;
    readonly textIndex?: number;
    readonly refusalIndex?: number;
  }>,
  reasoning: ReadonlyMap<string, {
    readonly id: string;
    readonly outputIndex: number;
    readonly parts: ReadonlyMap<string, {
      readonly presentation: "summary" | "content";
      readonly index: number;
      readonly text: string;
    }>;
    readonly carrierToken?: string | undefined;
  }>,
  tools: ReadonlyMap<string, {
    readonly itemId: string;
    readonly callId: string;
    readonly name: string;
    readonly outputIndex: number;
  }>,
): ReturnType<typeof wireObject>[] {
  const indexed: Array<{ readonly index: number; readonly item: ReturnType<typeof wireObject> }> = [];
  for (const item of items) {
    if (item.type === "reasoning") {
      if (!item.parts.some((part) => part.text.length > 0) && item.opaqueState === undefined) continue;
      const state = item.key === undefined ? undefined : reasoning.get(item.key);
      if (state !== undefined) {
        indexed.push({
          index: state.outputIndex,
          item: responseReasoning(state, item.status ?? status, item.parts, state.carrierToken),
        });
      }
      continue;
    }
    if (item.type === "message") {
      const message = item.key === undefined ? undefined : messages.get(item.key);
      if (message !== undefined) {
        const text = item.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        const refused = item.content.filter((part) => part.type === "refusal").map((part) => part.text).join("");
        indexed.push({
          index: message.outputIndex,
          item: responseMessage(message, status, text, refused),
        });
      }
      continue;
    }
    const tool = item.key === undefined ? undefined : tools.get(item.key);
    if (tool !== undefined) {
      indexed.push({ index: tool.outputIndex, item: responseTool(tool, status, item.argumentsJson) });
    }
  }
  return indexed.sort((left, right) => left.index - right.index).map((entry) => entry.item);
}

function responseSnapshot(
  id: string,
  createdAt: number,
  model: string,
  status: "in_progress" | "completed" | "incomplete",
  output: readonly ReturnType<typeof wireObject>[],
  usage: Readonly<SemanticUsage>,
  finishReason?: SemanticResponse["finishReason"],
  previousResponseId?: string | null,
) {
  return wireObject([
    ["id", id],
    ["object", "response"],
    ["created_at", wireNumber(createdAt)],
    ["status", status],
    ["error", null],
    ["incomplete_details", status === "incomplete"
      ? wireObject([["reason", finishReason === "content_filter" || finishReason === "refusal"
        ? "content_filter"
        : "max_output_tokens"]])
      : null],
    ["instructions", null],
    ["metadata", wireObject([])],
    ["model", model],
    ["output", wireArray(output)],
    ["parallel_tool_calls", true],
    ["temperature", null],
    ["tool_choice", "auto"],
    ["tools", wireArray([])],
    ["top_p", null],
    ["max_output_tokens", null],
    ["previous_response_id", previousResponseId ?? null],
    ["reasoning", null],
    ["text", wireObject([])],
    ["truncation", "disabled"],
    ["usage", status === "in_progress" ? null : responsesUsage(usage)],
  ]);
}

function responseMessage(
  message: {
    readonly id: string;
    readonly textIndex?: number;
    readonly refusalIndex?: number;
  },
  status: "in_progress" | "completed" | "incomplete",
  text: string,
  refused: string,
) {
  const content: Array<{ readonly index: number; readonly part: ReturnType<typeof wireObject> }> = [];
  if (message.textIndex !== undefined) {
    content.push({ index: message.textIndex, part: outputText(text) });
  }
  if (message.refusalIndex !== undefined) {
    content.push({ index: message.refusalIndex, part: refusal(refused) });
  }
  return wireObject([
    ["type", "message"],
    ["id", message.id],
    ["status", status],
    ["role", "assistant"],
    ["content", wireArray(content.sort((left, right) => left.index - right.index).map((entry) => entry.part))],
  ]);
}

function responseTool(
  tool: { readonly itemId: string; readonly callId: string; readonly name: string },
  status: "in_progress" | "completed" | "incomplete",
  argumentsJson: string,
) {
  return wireObject([
    ["type", "function_call"],
    ["id", tool.itemId],
    ["call_id", tool.callId],
    ["name", tool.name],
    ["arguments", argumentsJson],
    ["status", status],
  ]);
}

function responseReasoning(
  reasoning: { readonly id: string },
  status: "in_progress" | "completed" | "incomplete",
  parts: readonly { readonly presentation: "summary" | "content"; readonly index: number; readonly text: string }[],
  carrierToken?: string,
) {
  const summary = parts
    .filter((part) => part.presentation === "summary")
    .sort((left, right) => left.index - right.index)
    .map((part) => summaryText(part.text));
  const content = parts
    .filter((part) => part.presentation === "content")
    .sort((left, right) => left.index - right.index)
    .map((part) => reasoningText(part.text));
  return wireObject([
    ["type", "reasoning"],
    ["id", reasoning.id],
    ["status", status],
    ["summary", wireArray(summary)],
    ["content", content.length === 0 ? undefined : wireArray(content)],
    ["encrypted_content", carrierToken],
  ]);
}

function createStreamCarrier(
  item: SemanticReasoningItem,
  context: Readonly<StreamConversionContext>,
  wireProtocol: "chat" | "messages" | "responses",
  responseId?: string,
): string {
  const carrier = context.carrier;
  if (carrier === undefined || carrier.binding.wireProtocol !== wireProtocol || item.opaqueState === undefined) invalid();
  const opaque = item.opaqueState;
  const state = opaque.kind === "responses_item" ? opaque.item
    : opaque.kind === "messages_block" ? opaque.block : opaque.state;
  const carrierResponseId = responseId ?? carrier.responseId;
  const created = carrier.store.create({
    binding: carrier.binding,
    sourceKind: opaque.kind,
    state: "partial",
    ...(carrierResponseId === undefined ? {} : { responseId: carrierResponseId }),
    payload: wireObject([["kind", opaque.kind], ["state", state]]),
    projection: wireObject([["type", "reasoning"], ["text", item.parts.map((part) => part.text).join("")]]),
  });
  carrier.onCreated?.(created.token);
  return created.token;
}

function replaceEncryptedContent(item: ReturnType<typeof wireObject>, token: string): ReturnType<typeof wireObject> {
  let replaced = false;
  const members = item.members.map((member) => {
    if (member.key !== "encrypted_content") return member;
    replaced = true;
    return { key: member.key, value: token };
  });
  if (!replaced) members.push({ key: "encrypted_content", value: token });
  return { kind: "object", members };
}

function summaryText(text: string) {
  return wireObject([["type", "summary_text"], ["text", text]]);
}

function reasoningText(text: string) {
  return wireObject([["type", "reasoning_text"], ["text", text]]);
}

function outputText(text: string) {
  return wireObject([["type", "output_text"], ["text", text], ["annotations", wireArray([])]]);
}

function refusal(text: string) {
  return wireObject([["type", "refusal"], ["refusal", text]]);
}

function chatUsage(usage: Readonly<SemanticUsage>) {
  return wireObject([
    ["prompt_tokens", wireNumber(usage.inputTokens)],
    ["completion_tokens", wireNumber(usage.outputTokens)],
    ["total_tokens", wireNumber(usage.inputTokens + usage.outputTokens)],
    ["prompt_tokens_details", wireObject([
      ["cached_tokens", wireNumber(usage.cacheReadTokens)],
      ["cache_write_tokens", usage.cacheWriteTokens === 0 ? undefined : wireNumber(usage.cacheWriteTokens)],
    ])],
    ["completion_tokens_details", wireObject([["reasoning_tokens", wireNumber(usage.reasoningTokens)]])],
  ]);
}

function messagesUsage(usage: Readonly<SemanticUsage>) {
  return {
    input_tokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens),
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens === 0 ? {} : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === 0 ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens }),
    output_tokens_details: usage.reasoningTokens === 0 ? null : { thinking_tokens: usage.reasoningTokens },
  };
}

function responsesUsage(usage: Readonly<SemanticUsage>) {
  return wireObject([
    ["input_tokens", wireNumber(usage.inputTokens)],
    ["input_tokens_details", wireObject([
      ["cached_tokens", wireNumber(usage.cacheReadTokens)],
      ["cache_write_tokens", usage.cacheWriteTokens === 0 ? undefined : wireNumber(usage.cacheWriteTokens)],
    ])],
    ["output_tokens", wireNumber(usage.outputTokens)],
    ["output_tokens_details", wireObject([["reasoning_tokens", wireNumber(usage.reasoningTokens)]])],
    ["total_tokens", wireNumber(usage.inputTokens + usage.outputTokens)],
  ]);
}

function chatFinish(value: SemanticResponse["finishReason"]): string {
  return value === "refusal" ? "content_filter" : value;
}

function messagesFinish(value: SemanticResponse["finishReason"]): string {
  if (value === "tool_calls") {
    return "tool_use";
  }
  if (value === "length") {
    return "max_tokens";
  }
  if (value === "refusal" || value === "content_filter") {
    return "refusal";
  }
  return "end_turn";
}

function reconcileSnapshot(current: string, snapshot: string): string {
  if (!snapshot.startsWith(current)) {
    invalid();
  }
  return snapshot.slice(current.length);
}

function invalid(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "converter",
    phase: "stream",
  });
}
