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

  for await (const event of decodeProtocolStream(context.source, bytes, context.eventLimitBytes)) {
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
    if (event.kind === "text_delta") {
      ledger.appendText(event.delta);
      yield* emitter.textDelta(event.delta);
      continue;
    }
    if (event.kind === "text_done") {
      const suffix = reconcileSnapshot(ledger.textValue(), event.text);
      if (suffix.length > 0) {
        ledger.appendText(suffix);
        yield* emitter.textDelta(suffix);
      }
      continue;
    }
    if (event.kind === "refusal_delta") {
      ledger.appendRefusal(event.delta);
      yield* emitter.refusalDelta(event.delta);
      continue;
    }
    if (event.kind === "refusal_done") {
      const suffix = reconcileSnapshot(ledger.refusalValue(), event.refusal);
      if (suffix.length > 0) {
        ledger.appendRefusal(suffix);
        yield* emitter.refusalDelta(suffix);
      }
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
      yield* emitter.toolDone(event.key, ledger.tool(event.key).argumentsJson);
      continue;
    }
    if (event.kind === "terminal") {
      if (terminal) {
        invalid();
      }
      terminal = true;
      if (event.status === "completed") {
        ledger.finishOpenTools();
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
  textDelta(delta: string): Iterable<ConvertedStreamEmission>;
  refusalDelta(delta: string): Iterable<ConvertedStreamEmission>;
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
  private roleSent = false;
  private readonly toolIndexes = new Map<string, number>();

  constructor(private readonly context: Readonly<StreamConversionContext>) {
    this.id = `chatcmpl_${context.createUuid()}`;
    this.created = context.nowUnixSeconds();
  }

  *start(): Iterable<ConvertedStreamEmission> {}

  *textDelta(delta: string): Iterable<ConvertedStreamEmission> {
    yield this.chunk(wireObject([
      ...(!this.roleSent ? [["role", "assistant"] as const] : []),
      ["content", delta],
    ]));
    this.roleSent = true;
  }

  *refusalDelta(delta: string): Iterable<ConvertedStreamEmission> {
    yield this.chunk(wireObject([
      ...(!this.roleSent ? [["role", "assistant"] as const] : []),
      ["refusal", delta],
    ]));
    this.roleSent = true;
  }

  *toolStart(key: string, callId: string, name: string): Iterable<ConvertedStreamEmission> {
    const index = this.toolIndexes.size;
    this.toolIndexes.set(key, index);
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
    const index = this.toolIndexes.get(key);
    if (index === undefined) {
      invalid();
    }
    yield this.chunk(wireObject([
      ["tool_calls", wireArray([wireObject([
        ["index", wireNumber(index)],
        ["function", wireObject([["arguments", delta]])],
      ])])],
    ]));
  }

  *toolDone(_key: string, _argumentsJson: string): Iterable<ConvertedStreamEmission> {}

  *finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
  ): Iterable<ConvertedStreamEmission> {
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
  private textIndex: number | undefined;
  private refusalIndex: number | undefined;
  private readonly toolIndexes = new Map<string, number>();
  private readonly openIndexes = new Set<number>();

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

  *textDelta(delta: string): Iterable<ConvertedStreamEmission> {
    if (this.textIndex === undefined) {
      this.textIndex = this.open({ type: "text", text: "" });
      yield this.event({
        type: "content_block_start",
        index: this.textIndex,
        content_block: { type: "text", text: "" },
      });
    }
    yield this.event({
      type: "content_block_delta",
      index: this.textIndex,
      delta: { type: "text_delta", text: delta },
    });
  }

  *refusalDelta(delta: string): Iterable<ConvertedStreamEmission> {
    if (this.refusalIndex === undefined) {
      this.refusalIndex = this.open({ type: "refusal", refusal: "" });
      yield this.event({
        type: "content_block_start",
        index: this.refusalIndex,
        content_block: { type: "refusal", refusal: "" },
      });
    }
    yield this.event({
      type: "content_block_delta",
      index: this.refusalIndex,
      delta: { type: "refusal_delta", refusal: delta },
    });
  }

  *toolStart(key: string, callId: string, name: string): Iterable<ConvertedStreamEmission> {
    const index = this.open({ type: "tool_use" });
    this.toolIndexes.set(key, index);
    yield this.event({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: callId, name, input: {} },
    });
  }

  *toolArgumentsDelta(key: string, delta: string): Iterable<ConvertedStreamEmission> {
    const index = this.toolIndexes.get(key);
    if (index === undefined) {
      invalid();
    }
    yield this.event({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: delta },
    });
  }

  *toolDone(_key: string, _argumentsJson: string): Iterable<ConvertedStreamEmission> {}

  *finish(
    terminal: Extract<SemanticStreamEvent, { readonly kind: "terminal" }>,
    usage: Readonly<SemanticUsage>,
  ): Iterable<ConvertedStreamEmission> {
    for (const index of [...this.openIndexes].sort((left, right) => left - right)) {
      yield this.event({ type: "content_block_stop", index });
    }
    yield this.event({
      type: "message_delta",
      delta: {
        stop_reason: messagesFinish(terminal.finishReason),
      },
      usage: messagesUsage(usage),
    });
    yield this.event({ type: "message_stop" });
  }

  private open(_block: unknown): number {
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.openIndexes.add(index);
    return index;
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
  private message: { readonly id: string; readonly outputIndex: number; added: boolean } | undefined;
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

  *textDelta(delta: string): Iterable<ConvertedStreamEmission> {
    const message = this.ensureMessage();
    if (!message.added) {
      message.added = true;
      yield this.itemEvent("response.output_item.added", message.outputIndex, responseMessage(message.id, "in_progress", ""));
      yield this.contentEvent("response.content_part.added", message, outputText(""));
    }
    yield this.event(wireObject([
      ["type", "response.output_text.delta"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", message.id],
      ["output_index", wireNumber(message.outputIndex)],
      ["content_index", wireNumber(0)],
      ["delta", delta],
    ]));
  }

  *refusalDelta(delta: string): Iterable<ConvertedStreamEmission> {
    const message = this.ensureMessage();
    if (!message.added) {
      message.added = true;
      yield this.itemEvent("response.output_item.added", message.outputIndex, responseMessage(message.id, "in_progress", ""));
      yield this.contentEvent("response.content_part.added", message, refusal(""));
    }
    yield this.event(wireObject([
      ["type", "response.refusal.delta"],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", message.id],
      ["output_index", wireNumber(message.outputIndex)],
      ["content_index", wireNumber(0)],
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
    const output = responseOutput(items, terminal.status, this.message, this.tools);
    yield {
      kind: "checkpoint",
      intent: { responseId: this.responseId, output, state: terminal.status === "completed" ? "complete" : "partial" },
    };
    if (this.message?.added === true) {
      const text = items
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const refused = items
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((part) => part.type === "refusal")
        .map((part) => part.text)
        .join("");
      const part = refused.length > 0 ? refusal(refused) : outputText(text);
      this.completed.set(
        this.message.outputIndex,
        responseMessage(this.message.id, terminal.status, refused.length > 0 ? refused : text, refused.length > 0),
      );
      yield this.event(wireObject([
        ["type", refused.length > 0 ? "response.refusal.done" : "response.output_text.done"],
        ["sequence_number", wireNumber(this.sequence++)],
        ["item_id", this.message.id],
        ["output_index", wireNumber(this.message.outputIndex)],
        ["content_index", wireNumber(0)],
        [refused.length > 0 ? "refusal" : "text", refused.length > 0 ? refused : text],
      ]));
      yield this.contentEvent("response.content_part.done", this.message, part);
      yield this.itemEvent(
        "response.output_item.done",
        this.message.outputIndex,
        responseMessage(this.message.id, terminal.status, refused.length > 0 ? refused : text, refused.length > 0),
      );
    }
    for (const item of items) {
      if (item.type !== "tool_call") {
        continue;
      }
      const entry = [...this.tools.entries()].find(([, tool]) => tool.callId === item.callId);
      if (entry !== undefined && !entry[1].done) {
        yield* this.toolDone(entry[0], item.argumentsJson);
      }
    }
    const finalType = terminal.status === "completed" ? "response.completed" : "response.incomplete";
    yield this.responseEvent(finalType, terminal.status, output, usage, terminal.finishReason);
  }

  private ensureMessage() {
    this.message ??= {
      id: `msg_${this.context.createUuid()}`,
      outputIndex: this.nextOutputIndex++,
      added: false,
    };
    return this.message;
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
    part: ReturnType<typeof wireObject>,
  ): ConvertedStreamEmission {
    return this.event(wireObject([
      ["type", type],
      ["sequence_number", wireNumber(this.sequence++)],
      ["item_id", message.id],
      ["output_index", wireNumber(message.outputIndex)],
      ["content_index", wireNumber(0)],
      ["part", part],
    ]));
  }

  private event(value: ReturnType<typeof wireObject>): ConvertedStreamEmission {
    return { kind: "wire", bytes: encodeResponsesSseEvent(value) };
  }
}

function responseOutput(
  items: readonly SemanticResponseItem[],
  status: "completed" | "incomplete",
  message: { readonly id: string; readonly outputIndex: number } | undefined,
  tools: ReadonlyMap<string, {
    readonly itemId: string;
    readonly callId: string;
    readonly name: string;
    readonly outputIndex: number;
  }>,
): ReturnType<typeof wireObject>[] {
  const indexed: Array<{ readonly index: number; readonly item: ReturnType<typeof wireObject> }> = [];
  if (message !== undefined) {
    const content = items
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content);
    const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
    const refused = content.filter((part) => part.type === "refusal").map((part) => part.text).join("");
    indexed.push({
      index: message.outputIndex,
      item: responseMessage(message.id, status, refused.length > 0 ? refused : text, refused.length > 0),
    });
  }
  for (const item of items) {
    if (item.type !== "tool_call") {
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
      ? wireObject([["reason", finishReason === "content_filter" ? "content_filter" : "max_output_tokens"]])
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
  id: string,
  status: "in_progress" | "completed" | "incomplete",
  value: string,
  refused = false,
) {
  return wireObject([
    ["type", "message"],
    ["id", id],
    ["status", status],
    ["role", "assistant"],
    ["content", wireArray([refused ? refusal(value) : outputText(value)])],
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
