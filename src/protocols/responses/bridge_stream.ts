import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import { boundedCleanup } from "../../gateway/stream_execution.js";
import type { ChatChunk, ChatStreamFrame } from "../chat_completions/types.js";
import { isSemanticChatChunk } from "../chat_completions/stream_semantics.js";
import type { ResponsesRequest } from "./dto.js";
import type { ResponsesHistoryRecord } from "./history.js";
import type { RequestToolContext, ToolBinding } from "./tool_context.js";

export interface ResponsesBridgeStreamContext {
  readonly originalRequest: ResponsesRequest;
  readonly toolContext: RequestToolContext;
  readonly model: string;
  readonly nowUnixSeconds: () => number;
  readonly uuid: () => string;
  readonly customLlmProvider?: string;
  readonly modelId?: string;
}

export type ResponsesBridgeStreamInput = ChatChunk | ChatStreamFrame;

export type ResponsesStreamEmission =
  | { readonly kind: "event"; readonly event: WireJsonObject }
  | {
    readonly kind: "checkpoint";
    readonly event: WireJsonObject;
    readonly historyRecord: ResponsesHistoryRecord;
  };

interface StreamIds {
  readonly rawResponseId: string;
  readonly responseId: string;
}

interface MessageState {
  readonly id: string;
  readonly outputIndex: number;
  text: string;
  added: boolean;
  done: boolean;
  annotationsSeen: boolean;
  readonly annotations: WireJsonObject[];
}

interface ReasoningState {
  readonly id: string;
  readonly outputIndex: number;
  text: string;
  added: boolean;
  done: boolean;
}

interface ToolState {
  readonly key: string;
  readonly id: string;
  readonly index?: number;
  name: string;
  arguments: string;
  pendingArguments: string;
  added: boolean;
  done: boolean;
  outputIndex?: number;
  binding: ToolBinding | undefined;
}

interface ConversionState {
  readonly context: ResponsesBridgeStreamContext;
  readonly ids: StreamIds;
  readonly createdAt: number;
  sequence: number;
  nextOutputIndex: number;
  readonly completed: CompletedItem[];
  message?: MessageState;
  reasoning?: ReasoningState;
  readonly toolsByKey: Map<string, ToolState>;
  readonly toolKeysByIndex: Map<number, string>;
  readonly ambiguousToolIndexes: Set<number>;
  readonly providerFields: Map<string, WireJson>;
  usage?: WireJsonObject;
}

interface CompletedItem {
  readonly outputIndex: number;
  readonly item: WireJsonObject;
}

interface FirstChunk {
  readonly chunks: readonly ChatChunk[];
  readonly ids: StreamIds;
}

const MANAGED_ID_PREFIX = "litellm:custom_llm_provider:";

export async function* convertChatStream(
  chunks: AsyncIterable<ResponsesBridgeStreamInput>,
  context: ResponsesBridgeStreamContext,
): AsyncIterable<ResponsesStreamEmission> {
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    const first = await readFirstNonNullChunk(iterator, context);
    const state: ConversionState = {
      context,
      ids: first.ids,
      createdAt: context.nowUnixSeconds(),
      sequence: 1,
      nextOutputIndex: 0,
      completed: [],
      toolsByKey: new Map<string, ToolState>(),
      toolKeysByIndex: new Map<number, string>(),
      ambiguousToolIndexes: new Set<number>(),
      providerFields: new Map<string, WireJson>(),
    };

    yield eventEmission(eventWithResponse(state, "response.created", initialResponse(state)));
    yield eventEmission(eventWithResponse(state, "response.in_progress", initialResponse(state)));

    for (const chunk of first.chunks) {
      yield* processChunk(state, chunk);
    }

    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      const input = next.value;
      if (isDoneFrame(input)) {
        break;
      }
      if (isErrorFrame(input)) {
        throw streamFrameError(input.value);
      }
      const chunk = chatChunk(input);
      if (chunk.payload === null) {
        continue;
      }
      yield* processChunk(state, chunk);
    }

    yield* finalizeStream(state);
  } finally {
    if (iterator.return !== undefined) {
      void boundedCleanup(iterator.return());
    }
  }
}

export function encodeManagedResponseId(
  id: string | undefined,
  context: Pick<ResponsesBridgeStreamContext, "customLlmProvider" | "modelId" | "uuid">,
): string | undefined {
  if (id === undefined) {
    return undefined;
  }
  if (isManagedResponseId(id)) {
    return id;
  }
  const provider = context.customLlmProvider ?? "None";
  const modelId = context.modelId ?? "None";
  return `resp_${Buffer.from(
    `litellm:custom_llm_provider:${provider};model_id:${modelId};response_id:${id}`,
    "utf8",
  ).toString("base64")}`;
}

async function readFirstNonNullChunk(
  iterator: AsyncIterator<ResponsesBridgeStreamInput>,
  context: ResponsesBridgeStreamContext,
): Promise<FirstChunk> {
  const chunks: ChatChunk[] = [];
  let firstResponseId: string | undefined;
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      const rawResponseId = firstResponseId ?? `resp_${context.uuid()}`;
      return {
        chunks,
        ids: { rawResponseId, responseId: encodeManagedResponseId(rawResponseId, context) ?? rawResponseId },
      };
    }
    const input = next.value;
    if (isDoneFrame(input)) {
      const rawResponseId = firstResponseId ?? `resp_${context.uuid()}`;
      return {
        chunks,
        ids: { rawResponseId, responseId: encodeManagedResponseId(rawResponseId, context) ?? rawResponseId },
      };
    }
    if (isErrorFrame(input)) {
      throw streamFrameError(input.value);
    }
    const chunk = chatChunk(input);
    if (chunk.payload === null) {
      continue;
    }
    chunks.push(chunk);
    firstResponseId ??= stringMember(asObject(chunk.payload), "id");
    if (!isSemanticChatChunk(chunk)) {
      continue;
    }
    const rawResponseId = firstResponseId ?? `resp_${context.uuid()}`;
    return {
      chunks,
      ids: { rawResponseId, responseId: encodeManagedResponseId(rawResponseId, context) ?? rawResponseId },
    };
  }
}

function* processChunk(
  state: ConversionState,
  chunk: ChatChunk,
): Iterable<ResponsesStreamEmission> {
  const payload = asObject(chunk.payload);
  if (payload === undefined) {
    return;
  }
  accumulateProviderFields(state, objectMember(payload, "provider_specific_fields"));
  const usage = objectMember(payload, "usage");
  if (usage !== undefined) {
    state.usage = usage;
  }

  const choice = firstChoice(payload);
  if (choice === undefined) {
    return;
  }
  const delta = objectMember(choice, "delta");
  const message = objectMember(choice, "message");
  const finishReason = memberValues(choice, "finish_reason")[0];
  if (delta !== undefined) {
    accumulateProviderFields(state, objectMember(delta, "provider_specific_fields"));
  }
  const reasoningDelta = stringMember(delta, "reasoning_content") ?? stringMember(delta, "reasoning");
  if (reasoningDelta !== undefined && reasoningDelta.length > 0) {
    yield* appendReasoning(state, reasoningDelta);
  }

  const content = stringMember(delta, "content");
  const deltaTools = arrayMember(delta, "tool_calls");
  const lateTools = arrayMember(message, "tool_calls");
  const shouldCloseReasoning = (content !== undefined && content.length > 0)
    || (deltaTools !== undefined && deltaTools.items.length > 0)
    || (lateTools !== undefined && lateTools.items.length > 0)
    || (finishReason !== undefined && finishReason !== null);
  if (shouldCloseReasoning) {
    yield* closeReasoning(state);
  }

  if (content !== undefined && content.length > 0) {
    yield* appendText(state, content, arrayMember(delta, "annotations"));
  } else {
    yield* queueAnnotations(state, arrayMember(delta, "annotations"));
  }

  if (deltaTools !== undefined) {
    for (const toolDelta of deltaTools.items) {
      if (isWireJsonObject(toolDelta)) {
        yield* applyToolDelta(state, toolDelta, false);
      }
    }
  }
  if (lateTools !== undefined) {
    for (const tool of lateTools.items) {
      if (isWireJsonObject(tool)) {
        yield* applyToolDelta(state, tool, true);
      }
    }
  }
}

function* finalizeStream(state: ConversionState): Iterable<ResponsesStreamEmission> {
  yield* closeReasoning(state);
  yield* closeMessage(state);
  for (const tool of [...state.toolsByKey.values()].sort(compareTools)) {
    yield* closeTool(state, tool);
  }
  yield checkpointEmission(state, eventWithResponse(state, "response.completed", completedResponse(state)));
}

function* appendText(
  state: ConversionState,
  delta: string,
  annotations: WireJsonArray | undefined,
): Iterable<ResponsesStreamEmission> {
  const message = ensureMessage(state);
  if (!message.added) {
    message.added = true;
    yield eventEmission(eventWithItem(state, "response.output_item.added", message.outputIndex, messageItem(message, "in_progress")));
    yield eventEmission(contentPartEvent(state, "response.content_part.added", message, messageContentPart(message)));
  }
  yield* queueAnnotations(state, annotations);
  message.text += delta;
  yield eventEmission(eventObject(state, [
    ["type", "response.output_text.delta"],
    ["sequence_number", number(state.sequence++)],
    ["item_id", message.id],
    ["output_index", number(message.outputIndex)],
    ["content_index", number(0)],
    ["delta", delta],
  ]));
}

function* queueAnnotations(
  state: ConversionState,
  annotations: WireJsonArray | undefined,
): Iterable<ResponsesStreamEmission> {
  if (annotations === undefined || annotations.items.length === 0) {
    return;
  }
  const message = ensureMessage(state);
  if (message.annotationsSeen) {
    return;
  }
  message.annotationsSeen = true;
  if (!message.added) {
    message.added = true;
    yield eventEmission(eventWithItem(state, "response.output_item.added", message.outputIndex, messageItem(message, "in_progress")));
    yield eventEmission(contentPartEvent(state, "response.content_part.added", message, messageContentPart(message)));
  }
  for (const value of annotations.items) {
    if (!isWireJsonObject(value) || stringMember(value, "type") !== "url_citation") {
      continue;
    }
    const annotation = urlCitationAnnotation(value);
    if (annotation === undefined) {
      continue;
    }
    const annotationIndex = message.annotations.length;
    message.annotations.push(annotation);
    yield eventEmission(eventObject(state, [
      ["type", "response.output_text.annotation.added"],
      ["sequence_number", number(state.sequence++)],
      ["item_id", message.id],
      ["output_index", number(message.outputIndex)],
      ["content_index", number(0)],
      ["annotation_index", number(annotationIndex)],
      ["annotation", annotation],
    ]));
  }
}

function* closeMessage(state: ConversionState): Iterable<ResponsesStreamEmission> {
  const message = state.message;
  if (message === undefined || !message.added || message.done) {
    return;
  }
  message.done = true;
  const part = messageContentPart(message);
  yield eventEmission(eventObject(state, [
    ["type", "response.output_text.done"],
    ["sequence_number", number(state.sequence++)],
    ["item_id", message.id],
    ["output_index", number(message.outputIndex)],
    ["content_index", number(0)],
    ["text", message.text],
  ]));
  yield eventEmission(contentPartEvent(state, "response.content_part.done", message, part));
  const item = messageItem(message, "completed");
  state.completed.push({ outputIndex: message.outputIndex, item });
  yield checkpointEmission(state, eventWithItem(state, "response.output_item.done", message.outputIndex, item));
}

function* appendReasoning(state: ConversionState, delta: string): Iterable<ResponsesStreamEmission> {
  const reasoning = ensureReasoning(state);
  if (!reasoning.added) {
    reasoning.added = true;
    yield eventEmission(eventWithItem(state, "response.output_item.added", reasoning.outputIndex, reasoningItem(reasoning, "in_progress")));
    yield eventEmission(eventObject(state, [
      ["type", "response.reasoning_summary_part.added"],
      ["sequence_number", number(state.sequence++)],
      ["item_id", reasoning.id],
      ["output_index", number(reasoning.outputIndex)],
      ["summary_index", number(0)],
      ["part", object([["type", "summary_text"], ["text", ""]])],
    ]));
  }
  reasoning.text += delta;
  yield eventEmission(eventObject(state, [
    ["type", "response.reasoning_summary_text.delta"],
    ["sequence_number", number(state.sequence++)],
    ["item_id", reasoning.id],
    ["output_index", number(reasoning.outputIndex)],
    ["summary_index", number(0)],
    ["delta", delta],
  ]));
}

function* closeReasoning(state: ConversionState): Iterable<ResponsesStreamEmission> {
  const reasoning = state.reasoning;
  if (reasoning === undefined || !reasoning.added || reasoning.done) {
    return;
  }
  reasoning.done = true;
  const part = object([["type", "summary_text"], ["text", reasoning.text]]);
  yield eventEmission(eventObject(state, [
    ["type", "response.reasoning_summary_text.done"],
    ["sequence_number", number(state.sequence++)],
    ["item_id", reasoning.id],
    ["output_index", number(reasoning.outputIndex)],
    ["summary_index", number(0)],
    ["text", reasoning.text],
  ]));
  yield eventEmission(eventObject(state, [
    ["type", "response.reasoning_summary_part.done"],
    ["sequence_number", number(state.sequence++)],
    ["item_id", reasoning.id],
    ["output_index", number(reasoning.outputIndex)],
    ["summary_index", number(0)],
    ["part", part],
  ]));
  const item = reasoningItem(reasoning, "completed");
  state.completed.push({ outputIndex: reasoning.outputIndex, item });
  yield checkpointEmission(state, eventWithItem(state, "response.output_item.done", reasoning.outputIndex, item));
}

function* applyToolDelta(
  state: ConversionState,
  delta: WireJsonObject,
  late: boolean,
): Iterable<ResponsesStreamEmission> {
  const tool = toolStateForDelta(state, delta);
  if (tool === undefined) {
    return;
  }
  const functionDelta = objectMember(delta, "function");
  const name = stringMember(functionDelta, "name");
  if (name !== undefined && name.length > 0) {
    tool.name += name;
    tool.binding = state.context.toolContext.chatNameToBinding.get(tool.name);
  }
  const argumentsDelta = stringMember(functionDelta, "arguments");
  if (argumentsDelta !== undefined && argumentsDelta.length > 0) {
    tool.arguments += argumentsDelta;
    tool.pendingArguments += argumentsDelta;
  }
  if (late && tool.arguments.length === 0) {
    const fullArguments = stringMember(functionDelta, "arguments");
    if (fullArguments !== undefined) {
      tool.arguments = fullArguments;
      tool.pendingArguments = fullArguments;
    }
  }
  yield* openToolIfReady(state, tool);
  if (tool.added) {
    yield* flushToolArgumentDeltas(state, tool);
  }
}

function* openToolIfReady(state: ConversionState, tool: ToolState): Iterable<ResponsesStreamEmission> {
  if (tool.added || tool.id.length === 0 || tool.name.length === 0) {
    return;
  }
  tool.added = true;
  tool.outputIndex = state.nextOutputIndex++;
  tool.binding = state.context.toolContext.chatNameToBinding.get(tool.name);
  yield eventEmission(eventWithItem(state, "response.output_item.added", tool.outputIndex, toolItem(tool, "in_progress")));
}

function* flushToolArgumentDeltas(state: ConversionState, tool: ToolState): Iterable<ResponsesStreamEmission> {
  if (tool.pendingArguments.length === 0 || toolKind(tool) === "custom") {
    tool.pendingArguments = toolKind(tool) === "custom" ? "" : tool.pendingArguments;
    return;
  }
  const outputIndex = tool.outputIndex;
  if (outputIndex === undefined) {
    return;
  }
  for (const slice of slices(tool.pendingArguments, 10)) {
    yield eventEmission(eventObject(state, [
      ["type", "response.function_call_arguments.delta"],
      ["sequence_number", number(state.sequence++)],
      ["item_id", tool.id],
      ["output_index", number(outputIndex)],
      ["delta", slice],
    ]));
  }
  tool.pendingArguments = "";
}

function* closeTool(state: ConversionState, tool: ToolState): Iterable<ResponsesStreamEmission> {
  if (tool.done || tool.id.length === 0 || tool.name.length === 0) {
    return;
  }
  yield* openToolIfReady(state, tool);
  yield* flushToolArgumentDeltas(state, tool);
  const outputIndex = tool.outputIndex;
  if (outputIndex === undefined) {
    return;
  }
  const kind = toolKind(tool);
  if (kind === "custom") {
    const input = customInput(tool.arguments);
    for (const slice of slices(input, 10)) {
      yield eventEmission(eventObject(state, [
        ["type", "response.custom_tool_call_input.delta"],
        ["sequence_number", number(state.sequence++)],
        ["item_id", tool.id],
        ["output_index", number(outputIndex)],
        ["delta", slice],
      ]));
    }
    yield eventEmission(eventObject(state, [
      ["type", "response.custom_tool_call_input.done"],
      ["sequence_number", number(state.sequence++)],
      ["item_id", tool.id],
      ["output_index", number(outputIndex)],
      ["input", input],
    ]));
  } else {
    yield eventEmission(eventObject(state, [
      ["type", "response.function_call_arguments.done"],
      ["sequence_number", number(state.sequence++)],
      ["item_id", tool.id],
      ["output_index", number(outputIndex)],
      ["arguments", tool.arguments],
      ["name", finalToolName(tool)],
    ]));
  }
  tool.done = true;
  const item = toolItem(tool, "completed");
  state.completed.push({ outputIndex, item });
  yield checkpointEmission(state, eventWithItem(state, "response.output_item.done", outputIndex, item));
}

function toolStateForDelta(state: ConversionState, delta: WireJsonObject): ToolState | undefined {
  const id = stringMember(delta, "id");
  const index = integerMember(delta, "index");
  if (id !== undefined && id.length > 0) {
    const existing = state.toolsByKey.get(id);
    if (existing !== undefined) {
      updateIndexMaps(state, id, index);
      return existing;
    }
    const tool: ToolState = {
      key: id,
      id,
      ...(index === undefined ? {} : { index }),
      name: "",
      arguments: "",
      pendingArguments: "",
      added: false,
      done: false,
      binding: undefined,
    };
    state.toolsByKey.set(id, tool);
    updateIndexMaps(state, id, index);
    return tool;
  }
  if (index === undefined || state.ambiguousToolIndexes.has(index)) {
    return undefined;
  }
  const key = state.toolKeysByIndex.get(index);
  return key === undefined ? undefined : state.toolsByKey.get(key);
}

function updateIndexMaps(state: ConversionState, key: string, index: number | undefined): void {
  if (index === undefined) {
    return;
  }
  const existing = state.toolKeysByIndex.get(index);
  if (existing !== undefined && existing !== key) {
    state.ambiguousToolIndexes.add(index);
    return;
  }
  if (!state.ambiguousToolIndexes.has(index)) {
    state.toolKeysByIndex.set(index, key);
  }
}

function ensureMessage(state: ConversionState): MessageState {
  if (state.message === undefined) {
    state.message = {
      id: `msg_${state.context.uuid()}`,
      outputIndex: state.nextOutputIndex++,
      text: "",
      added: false,
      done: false,
      annotationsSeen: false,
      annotations: [],
    };
  }
  return state.message;
}

function ensureReasoning(state: ConversionState): ReasoningState {
  if (state.reasoning === undefined || state.reasoning.done) {
    state.reasoning = {
      id: `rs_${state.context.uuid()}`,
      outputIndex: state.nextOutputIndex++,
      text: "",
      added: false,
      done: false,
    };
  }
  return state.reasoning;
}

function initialResponse(state: ConversionState): WireJsonObject {
  const request = state.context.originalRequest.body;
  const members: Array<readonly [string, WireJson]> = [
    ["id", state.ids.responseId],
    ["object", "response"],
    ["created_at", number(state.createdAt)],
    ["status", "in_progress"],
    ["error", null],
    ["incomplete_details", null],
    ["instructions", memberValues(request, "instructions")[0] ?? null],
    ["max_output_tokens", null],
    ["model", state.context.model],
    ["output", array([])],
    ["parallel_tool_calls", true],
    ["previous_response_id", null],
    ["reasoning", object([["effort", null], ["summary", null]])],
    ["store", true],
    ["tool_choice", transformedToolChoice(state) ?? "auto"],
    ["tools", memberValues(request, "tools")[0] ?? array([])],
    ["top_p", memberValues(request, "top_p")[0] ?? numberLexeme("1.0")],
  ];
  copyIfPresent(request, members, "temperature");
  copyIfPresent(request, members, "text");
  copyIfPresent(request, members, "truncation");
  copyIfPresent(request, members, "user");
  copyIfPresent(request, members, "metadata");
  return object(members);
}

function completedResponse(state: ConversionState): WireJsonObject {
  const members = initialResponse(state).members.map((member) => {
    if (member.key === "status") {
      return { key: "status", value: "completed" as WireJson };
    }
    if (member.key === "output") {
      return { key: "output", value: array(completedOutput(state)) as WireJson };
    }
    return member;
  });
  if (state.usage !== undefined) {
    members.push({ key: "usage", value: state.usage });
  }
  const providerFields = providerSpecificFields(state);
  if (providerFields !== undefined) {
    members.push({ key: "_hidden_params", value: object([["provider_specific_fields", providerFields]]) });
  }
  return { kind: "object", members };
}

function completedOutput(state: ConversionState): readonly WireJsonObject[] {
  return [...state.completed].sort((left, right) => left.outputIndex - right.outputIndex).map((entry) => entry.item);
}

function messageItem(message: MessageState, status: "in_progress" | "completed"): WireJsonObject {
  return object([
    ["type", "message"],
    ["id", message.id],
    ["status", status],
    ["role", "assistant"],
    ["content", array([messageContentPart(message)])],
  ]);
}

function messageContentPart(message: MessageState): WireJsonObject {
  return object([
    ["type", "output_text"],
    ["text", message.text],
    ["annotations", array(message.annotations)],
  ]);
}

function reasoningItem(reasoning: ReasoningState, status: "in_progress" | "completed"): WireJsonObject {
  return object([
    ["type", "reasoning"],
    ["id", reasoning.id],
    ["summary", array([object([["type", "summary_text"], ["text", reasoning.text]])])],
    ["status", status],
  ]);
}

function toolItem(tool: ToolState, status: "in_progress" | "completed"): WireJsonObject {
  const binding = tool.binding;
  const kind = toolKind(tool);
  if (kind === "custom") {
    return object([
      ["type", "custom_tool_call"],
      ["id", tool.id],
      ["call_id", tool.id],
      ["name", binding?.originalName ?? tool.name],
      ["input", status === "completed" ? customInput(tool.arguments) : ""],
      ["status", status],
    ]);
  }
  if (kind === "tool_search") {
    return object([
      ["type", "tool_search_call"],
      ["id", tool.id],
      ["call_id", tool.id],
      ["status", status],
      ["execution", "client"],
      ["arguments", status === "completed" ? toolSearchArguments(tool.arguments) : object([])],
    ]);
  }
  const members: Array<readonly [string, WireJson]> = [
    ["type", "function_call"],
    ["id", tool.id],
    ["call_id", tool.id],
    ["name", binding?.kind === "namespace" ? binding.originalName : tool.name],
    ["arguments", tool.arguments],
    ["status", status],
  ];
  if (binding?.kind === "namespace" && binding.namespace !== undefined) {
    members.push(["namespace", binding.namespace]);
  }
  return object(members);
}

function toolKind(tool: ToolState): ToolBinding["kind"] {
  return tool.binding?.kind ?? "function";
}

function finalToolName(tool: ToolState): string {
  if (tool.binding?.kind === "namespace") {
    return tool.binding.originalName;
  }
  if (toolKind(tool) === "tool_search") {
    return "tool_search";
  }
  return tool.binding?.originalName ?? tool.name;
}

function eventWithResponse(state: ConversionState, type: string, response: WireJsonObject): WireJsonObject {
  return eventObject(state, [
    ["type", type],
    ["sequence_number", number(state.sequence++)],
    ["response", response],
  ]);
}

function eventWithItem(
  state: ConversionState,
  type: string,
  outputIndex: number,
  item: WireJsonObject,
): WireJsonObject {
  return eventObject(state, [
    ["type", type],
    ["sequence_number", number(state.sequence++)],
    ["output_index", number(outputIndex)],
    ["item", item],
  ]);
}

function contentPartEvent(
  state: ConversionState,
  type: string,
  message: MessageState,
  part: WireJsonObject,
): WireJsonObject {
  return eventObject(state, [
    ["type", type],
    ["sequence_number", number(state.sequence++)],
    ["item_id", message.id],
    ["output_index", number(message.outputIndex)],
    ["content_index", number(0)],
    ["part", part],
  ]);
}

function eventObject(_state: ConversionState, members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return object(members);
}

function eventEmission(event: WireJsonObject): ResponsesStreamEmission {
  return { kind: "event", event };
}

function checkpointEmission(state: ConversionState, event: WireJsonObject): ResponsesStreamEmission {
  return {
    kind: "checkpoint",
    event,
    historyRecord: {
      responseId: state.ids.responseId,
      output: completedOutput(state),
    },
  };
}

function transformedToolChoice(state: ConversionState): WireJson | undefined {
  const value = memberValues(state.context.originalRequest.body, "tool_choice")[0];
  if (!isWireJsonObject(value)) {
    return value;
  }
  const type = stringMember(value, "type");
  if (type === "function") {
    return object([["type", "function"], ["name", stringMember(value, "name") ?? ""]]);
  }
  if (type === "custom") {
    return object([["type", "custom"], ["name", stringMember(value, "name") ?? ""]]);
  }
  if (type === "tool_search") {
    return object([["type", "tool_search"]]);
  }
  return value;
}

function copyIfPresent(
  source: WireJsonObject,
  target: Array<readonly [string, WireJson]>,
  key: string,
): void {
  const value = memberValues(source, key)[0];
  if (value !== undefined) {
    target.push([key, value]);
  }
}

function accumulateProviderFields(state: ConversionState, fields: WireJsonObject | undefined): void {
  if (fields === undefined) {
    return;
  }
  for (const member of fields.members) {
    state.providerFields.set(member.key, member.value);
  }
}

function providerSpecificFields(state: ConversionState): WireJsonObject | undefined {
  if (state.providerFields.size === 0) {
    return undefined;
  }
  return object([...state.providerFields.entries()]);
}

function urlCitationAnnotation(source: WireJsonObject): WireJsonObject | undefined {
  const url = stringMember(source, "url");
  if (url === undefined) {
    return undefined;
  }
  const members: Array<readonly [string, WireJson]> = [["type", "url_citation"]];
  copyIfPresent(source, members, "start_index");
  copyIfPresent(source, members, "end_index");
  members.push(["url", url]);
  copyIfPresent(source, members, "title");
  return object(members);
}

function customInput(argumentsText: string): string {
  if (argumentsText.trim().length === 0) {
    return "";
  }
  const parsed = parseJson(argumentsText);
  if (isWireJsonObject(parsed)) {
    const input = memberValues(parsed, "input")[0];
    if (typeof input === "string") {
      return input;
    }
  }
  return argumentsText;
}

function toolSearchArguments(argumentsText: string): WireJsonObject {
  if (argumentsText.trim().length === 0) {
    return object([]);
  }
  const parsed = parseJson(argumentsText);
  if (isWireJsonObject(parsed)) {
    return parsed;
  }
  return object([["query", argumentsText]]);
}

function parseJson(value: string): WireJson | undefined {
  try {
    const bytes = new TextEncoder().encode(value);
    return parseWireJson(bytes, { maxBytes: Math.max(bytes.byteLength, 1), maxDepth: 64 });
  } catch (_error: unknown) {
    return undefined;
  }
}

function firstChoice(payload: WireJsonObject): WireJsonObject | undefined {
  const choices = arrayMember(payload, "choices");
  const first = choices?.items[0];
  return isWireJsonObject(first) ? first : undefined;
}

function asObject(value: WireJson | undefined): WireJsonObject | undefined {
  return isWireJsonObject(value) ? value : undefined;
}

function objectMember(object: WireJsonObject | undefined, key: string): WireJsonObject | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = memberValues(object, key)[0];
  return isWireJsonObject(value) ? value : undefined;
}

function arrayMember(object: WireJsonObject | undefined, key: string): WireJsonArray | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = memberValues(object, key)[0];
  return isWireJsonArray(value) ? value : undefined;
}

function stringMember(object: WireJsonObject | undefined, key: string): string | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = memberValues(object, key)[0];
  return typeof value === "string" ? value : undefined;
}

function integerMember(object: WireJsonObject, key: string): number | undefined {
  const value = memberValues(object, key)[0];
  if (!isWireJsonNumber(value)) {
    return undefined;
  }
  const parsed = Number(value.lexeme);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}

function number(value: number): WireJson {
  return { kind: "number", lexeme: String(value) };
}

function numberLexeme(lexeme: string): WireJson {
  return { kind: "number", lexeme };
}

function slices(value: string, size: number): readonly string[] {
  const output: string[] = [];
  const characters = Array.from(value);
  for (let index = 0; index < characters.length; index += size) {
    output.push(characters.slice(index, index + size).join(""));
  }
  return output;
}

function compareTools(left: ToolState, right: ToolState): number {
  const leftIndex = left.outputIndex ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.outputIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  return left.key.localeCompare(right.key);
}

function isDoneFrame(input: ResponsesBridgeStreamInput): input is ChatStreamFrame & { readonly kind: "done" } {
  return (input as { readonly kind?: unknown }).kind === "done";
}

function isErrorFrame(input: ResponsesBridgeStreamInput): input is ChatStreamFrame & { readonly kind: "error" } {
  return (input as { readonly kind?: unknown }).kind === "error";
}

function isChunkFrame(input: ResponsesBridgeStreamInput): input is ChatStreamFrame & { readonly kind: "chunk" } {
  return (input as { readonly kind?: unknown }).kind === "chunk";
}

function chatChunk(input: ResponsesBridgeStreamInput): ChatChunk {
  return isChunkFrame(input) ? input.chunk : input as ChatChunk;
}

function streamFrameError(_value: WireJson | string): Error {
  return new GatewayFailureError({
    kind: "upstream_stream_error",
    source: "parser",
    phase: "stream",
  });
}

function isManagedResponseId(id: string): boolean {
  if (!id.startsWith("resp_")) {
    return false;
  }
  try {
    const decoded = Buffer.from(id.slice(5), "base64").toString("utf8");
    return decoded.startsWith(MANAGED_ID_PREFIX)
      && decoded.includes(";model_id:")
      && decoded.includes(";response_id:");
  } catch (_error: unknown) {
    return false;
  }
}
