import { GatewayFailureError } from "../../gateway/failures.js";
import { encodeAnthropicSse } from "../anthropic_messages/wire.js";
import { encodeOpenAiChatDone, encodeOpenAiChatSseChunk } from "../openai_chat/wire.js";
import { encodeResponsesSseEvent } from "../responses/wire.js";
import { SemanticItemLedger } from "./ledger.js";
import { decodeProtocolStream } from "./stream_decoders.js";
import type {
  ConversionDegradationRule,
  ConvertedStreamEmission,
  InferenceProtocol,
  SemanticResponse,
  SemanticResponseItem,
  SemanticStreamEvent,
  SemanticUsage,
} from "./types.js";
import { wireArray, wireNumber, wireObject } from "./wire.js";
import { managedConvertedResponseId } from "./ids.js";

export interface StreamConversionContext {
  readonly source: InferenceProtocol;
  readonly target: InferenceProtocol;
  readonly model: string;
  readonly eventLimitBytes: number;
  readonly accumulatorBytes: number;
  readonly createUuid: () => string;
  readonly nowUnixSeconds: () => number;
  readonly degradations?: readonly ConversionDegradationRule[];
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
  )) {
    if (event.kind === "usage") {
      usage = event.usage;
      yield { kind: "usage", usage };
      continue;
    }
    if (!started) {
      started = true;
      yield { kind: "first_semantic" };
      yield* emitter.start();
    }
    if (event.kind === "message_start") {
      ledger.startMessage(event.key);
      yield* emitter.messageStart(event.key);
      continue;
    }
    if (event.kind === "text_delta") {
      ledger.appendText(event.key, event.delta, event.orderKey);
      yield* emitter.textDelta(event.key, event.delta, event.orderKey);
      continue;
    }
    if (event.kind === "text_done") {
      const suffix = reconcileSnapshot(ledger.textValue(event.key), event.text);
      if (suffix.length > 0) {
        ledger.appendText(event.key, suffix, event.orderKey);
        yield* emitter.textDelta(event.key, suffix, event.orderKey);
      }
      continue;
    }
    if (event.kind === "refusal_delta") {
      ledger.appendRefusal(event.key, event.delta, event.orderKey);
      yield* emitter.refusalDelta(event.key, event.delta, event.orderKey);
      continue;
    }
    if (event.kind === "refusal_done") {
      const suffix = reconcileSnapshot(ledger.refusalValue(event.key), event.refusal);
      if (suffix.length > 0) {
        ledger.appendRefusal(event.key, suffix, event.orderKey);
        yield* emitter.refusalDelta(event.key, suffix, event.orderKey);
      }
      continue;
    }
    if (event.kind === "content_done") {
      yield* emitter.contentDone(event.orderKey, event.contentIndex);
      continue;
    }
    if (event.kind === "item_done") {
      yield* emitter.itemDone(event.outputIndex);
      continue;
    }
    if (event.kind === "tool_start") {
      ledger.startTool(event);
      yield* emitter.toolStart(event.key, event.callId, event.name, event.itemId);
      continue;
    }
    if (event.kind === "tool_arguments_delta") {
      ledger.appendToolArguments(event.key, event.delta);
      yield* emitter.toolArgumentsDelta(event.key, event.delta);
      continue;
    }
    if (event.kind === "tool_done") {
      const suffix = ledger.finishTool(event.key, event.argumentsJson);
      if (suffix.length > 0) {
        yield* emitter.toolArgumentsDelta(event.key, suffix);
      }
      if (context.target === "messages") {
        yield* emitter.toolDone(event.key, ledger.tool(event.key).argumentsJson);
      }
      continue;
    }
    if (event.kind === "terminal") {
      if (terminal) {
        invalid();
      }
      terminal = true;
      if (event.status === "completed") {
        ledger.finishOpenTools();
        for (const key of ledger.toolKeys()) {
          yield* emitter.toolDone(key, ledger.tool(key).argumentsJson);
        }
      }
      const items = ledger.items(event.status);
      yield* emitter.finish(event, usage, items);
      yield { kind: "terminal", terminal: event.status };
      return;
    }
  }
  invalid();
}

interface StreamEmitter {
  start(): Iterable<ConvertedStreamEmission>;
  messageStart(key: string): Iterable<ConvertedStreamEmission>;
  contentDone(orderKey: string, contentIndex: number): Iterable<ConvertedStreamEmission>;
  itemDone(outputIndex: number): Iterable<ConvertedStreamEmission>;
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
  private readonly streamedContent = new Map<string, { text: string; refusal: string }>();
  private readonly responseFrontier = new ResponseEmissionFrontier();
  private responseDeliveryBlocked = false;

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

  *messageStart(_key: string): Iterable<ConvertedStreamEmission> {}

  contentDone(orderKey: string, contentIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.completeContent(orderKey, contentIndex);
    return [];
  }

  itemDone(outputIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.completeItem(outputIndex);
    return [];
  }

  *textDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses) {
      if (this.responseDeliveryBlocked || !this.responseFrontier.allowsContent(key, orderKey)) {
        this.responseDeliveryBlocked = true;
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
      if (this.responseDeliveryBlocked || !this.responseFrontier.allowsContent(key, orderKey)) {
        this.responseDeliveryBlocked = true;
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
      if (this.responseDeliveryBlocked || !this.responseFrontier.allowsItem(key)) {
        this.responseDeliveryBlocked = true;
        return;
      }
    }
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

  *toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    if (this.sourceResponses && this.responseDeliveryBlocked) {
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
      yield* this.emitBufferedResponseItems(items);
    }
    if (!this.roleSent) {
      yield this.chunk(wireObject([["role", "assistant"], ["content", ""]]));
      this.roleSent = true;
    }
    yield this.chunk(wireObject([]), chatFinish(terminal.finishReason));
    yield {
      kind: "wire",
      bytes: encodeOpenAiChatSseChunk(wireObject([
        ["id", this.id],
        ["object", "chat.completion.chunk"],
        ["created", wireNumber(this.created)],
        ["model", this.context.model],
        ["choices", wireArray([])],
        ["usage", chatUsage(usage)],
      ])),
    };
    yield { kind: "wire", bytes: encodeOpenAiChatDone() };
  }

  private *emitBufferedResponseItems(items: readonly SemanticResponseItem[]): Iterable<ConvertedStreamEmission> {
    for (const item of items) {
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

  private chunk(delta: ReturnType<typeof wireObject>, finish?: string): ConvertedStreamEmission {
    return {
      kind: "wire",
      bytes: encodeOpenAiChatSseChunk(wireObject([
        ["id", this.id],
        ["object", "chat.completion.chunk"],
        ["created", wireNumber(this.created)],
        ["model", this.context.model],
        ["choices", wireArray([wireObject([
          ["index", wireNumber(0)],
          ["delta", delta],
          ["finish_reason", finish ?? null],
        ])])],
      ])),
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
  private responseDeliveryBlocked = false;
  private readonly streamedContent = new Map<string, { text: string; refusal: string }>();
  private readonly tools = new Map<string, {
    readonly callId: string;
    readonly name: string;
    argumentsJson: string;
    done: boolean;
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
        },
      },
    });
  }

  messageStart(key: string): Iterable<ConvertedStreamEmission> {
    this.firstMessageKey ??= key;
    return [];
  }

  contentDone(orderKey: string, contentIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.completeContent(orderKey, contentIndex);
    return [];
  }

  itemDone(outputIndex: number): Iterable<ConvertedStreamEmission> {
    this.responseFrontier.completeItem(outputIndex);
    return [];
  }

  *textDelta(key: string, delta: string, orderKey?: string): Iterable<ConvertedStreamEmission> {
    const messageKey = orderKey ?? key;
    this.firstMessageKey ??= messageKey;
    if (
      this.context.source === "responses"
        ? this.responseDeliveryBlocked || !this.responseFrontier.allowsContent(key, orderKey)
        : this.bufferAfterTool || messageKey !== this.firstMessageKey
    ) {
      if (this.context.source === "responses") {
        this.responseDeliveryBlocked = true;
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
        ? this.responseDeliveryBlocked || !this.responseFrontier.allowsContent(key, orderKey)
        : this.bufferAfterTool || messageKey !== this.firstMessageKey
    ) {
      if (this.context.source === "responses") {
        this.responseDeliveryBlocked = true;
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
    if (this.context.source === "responses") {
      this.responseDeliveryBlocked = true;
    }
    this.tools.set(key, { callId, name, argumentsJson: "", done: false });
  }

  toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    const tool = this.tools.get(key);
    if (tool === undefined || tool.done) {
      invalid();
    }
    this.bufferedBytes += new TextEncoder().encode(delta).byteLength;
    if (this.bufferedBytes > this.context.accumulatorBytes) {
      invalid();
    }
    tool.argumentsJson += delta;
    return [];
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
  }

  *finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
    items: readonly SemanticResponseItem[],
  ): Iterable<ConvertedStreamEmission> {
    yield* this.closeActiveText();
    yield* this.emitBufferedItems(items);
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

  private *emitBufferedItems(items: readonly SemanticResponseItem[]): Iterable<ConvertedStreamEmission> {
    for (const item of items) {
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
      const index = this.nextIndex++;
      yield this.event({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: tool.callId, name: tool.name, input: {} },
      });
      if (item.argumentsJson.length > 0) {
        yield this.event({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: item.argumentsJson },
        });
      }
      yield this.event({ type: "content_block_stop", index });
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

  private recordStreamed(key: string, kind: "text" | "refusal", delta: string): void {
    const current = this.streamedContent.get(key) ?? { text: "", refusal: "" };
    current[kind] += delta;
    this.streamedContent.set(key, current);
  }

  private event(value: Record<string, unknown>): ConvertedStreamEmission {
    return {
      kind: "wire",
      bytes: encodeAnthropicSse(value as { readonly type: string; readonly [key: string]: unknown }),
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

  *messageStart(_key: string): Iterable<ConvertedStreamEmission> {}

  *contentDone(_orderKey: string, _contentIndex: number): Iterable<ConvertedStreamEmission> {}

  *itemDone(_outputIndex: number): Iterable<ConvertedStreamEmission> {}

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
    const output = responseOutput(items, terminal.status, this.messages, this.tools);
    if (terminal.status === "completed") {
      const checkpointedOutput = this.completedOutput();
      const receiptOnly = items.every((item) => item.type === "tool_call")
        && checkpointedOutput.length === output.length;
      yield {
        kind: "checkpoint",
        intent: {
          responseId: this.responseId,
          output: receiptOnly ? [] : output,
          state: "complete",
        },
      };
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

  private completedOutput(): readonly ReturnType<typeof wireObject>[] {
    return [...this.completed.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
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
    return { kind: "wire", bytes: encodeResponsesSseEvent(value) };
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
    const itemMatch = /^responses:(\d+):message$/u.exec(orderKey);
    const contentMatch = /^responses:\d+:(\d+):/u.exec(key);
    if (itemMatch?.[1] === undefined || contentMatch?.[1] === undefined) {
      return false;
    }
    return Number.parseInt(itemMatch[1], 10) === this.item
      && Number.parseInt(contentMatch[1], 10) === (this.content.get(orderKey) ?? 0);
  }

  allowsItem(key: string): boolean {
    const match = /^responses:(\d+)$/u.exec(key);
    return match?.[1] !== undefined && Number.parseInt(match[1], 10) === this.item;
  }

  completeContent(orderKey: string, contentIndex: number): void {
    const completed = this.completedContent.get(orderKey) ?? new Set<number>();
    completed.add(contentIndex);
    this.completedContent.set(orderKey, completed);
    let frontier = this.content.get(orderKey) ?? 0;
    while (completed.delete(frontier)) {
      frontier += 1;
    }
    this.content.set(orderKey, frontier);
  }

  completeItem(outputIndex: number): void {
    this.completedItems.add(outputIndex);
    while (this.completedItems.delete(this.item)) {
      this.item += 1;
    }
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
  tools: ReadonlyMap<string, {
    readonly itemId: string;
    readonly callId: string;
    readonly name: string;
    readonly outputIndex: number;
  }>,
): ReturnType<typeof wireObject>[] {
  const indexed: Array<{ readonly index: number; readonly item: ReturnType<typeof wireObject> }> = [];
  for (const item of items) {
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
    const tool = [...tools.values()].find((candidate) => candidate.callId === item.callId);
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
    ["previous_response_id", null],
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
