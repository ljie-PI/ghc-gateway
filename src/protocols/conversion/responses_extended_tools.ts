import { createHash } from "node:crypto";
import { canonicalizeWireJson } from "../../serialization/canonical_json.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import {
  TOOL_RESULT_ERROR_MARKER,
  TOOL_RESULT_MEDIA_REPLACEMENT,
  toolResultMediaReference,
} from "./compatibility_markers.js";
import { isOpenaiStrictSchemaCompatible } from "./strict_schema.js";
import type {
  ConversionDegradationRule,
  ResponsesToolBindingLedger,
  ResponsesToolCallBinding,
  ResponsesToolResultBinding,
  ResponsesToolSourceBinding,
  SemanticResponse,
  SemanticResponseItem,
} from "./types.js";
import { invalid, unsupported } from "./wire.js";
import { containsReasoningCarrier } from "./reasoning_carriers.js";
import { projectKnownObject } from "./request_projection.js";

const EXTENDED_SENSITIVE_FIELDS = new Set([
  "allowed_callers", "caller", "container", "defer_loading", "encrypted_content", "output_schema",
  "previous_response_id", "reasoning_content", "reasoning_details", "reasoning_items", "tool_call_id", "tool_use_id",
]);

const CUSTOM_INPUT_SCHEMA = object([
  ["type", "object"],
  ["properties", object([
    ["input", object([
      ["type", "string"],
      ["description", "Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description."],
    ])],
  ])],
  ["required", array(["input"])],
]);

const TOOL_SEARCH_SCHEMA = object([
  ["type", "object"],
  ["properties", object([
    ["query", object([
      ["type", "string"],
      ["description", "Search query for tools or connectors to load."],
    ])],
    ["limit", object([
      ["type", "integer"],
      ["description", "Maximum number of tool groups to return."],
    ])],
  ])],
  ["required", array(["query"])],
]);

const TOOL_SEARCH_DESCRIPTION = "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.";

export interface PreparedResponsesExtendedTools {
  readonly body: WireJsonObject;
  readonly ledger: ResponsesToolBindingLedger;
  readonly chatTools: readonly WireJsonObject[];
}

export interface ResponsesToolCompatibilityProjection {
  readonly chatTools: readonly WireJsonObject[];
  readonly bindings: readonly ResponsesToolSourceBinding[];
}

interface MutableState {
  readonly degradations: Set<ConversionDegradationRule>;
  readonly discoveredTools: WeakMap<WireJsonObject, WireJsonArray>;
  readonly bindings: ResponsesToolSourceBinding[];
  readonly bySourceKey: Map<string, ResponsesToolSourceBinding>;
  readonly byChatName: Map<string, ResponsesToolSourceBinding>;
  readonly omittedSourceKeys: Set<string>;
  readonly tools: WireJsonObject[];
  readonly calls: ResponsesToolCallBinding[];
  readonly results: ResponsesToolResultBinding[];
}

export function prepareResponsesExtendedTools(
  body: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): PreparedResponsesExtendedTools | undefined {
  const decoded = decodeResponsesExtendedToolProjection(body, degradations);
  if (decoded === undefined) {
    return undefined;
  }
  const { state, inputValue, transformedChoice, projection } = decoded;
  if (single(body, "text", "REQ-R-EXT-TEXT") !== undefined || single(body, "response_format", "REQ-R-EXT-FORMAT") !== undefined) {
    unsupported("REQ-R-EXT-FORMAT");
  }
  validateInstructionOrdering(inputValue);
  const transformedInput = transformInput(state, inputValue);
  const transformedBody: WireJsonObject = Object.freeze({
    kind: "object",
    members: body.members.flatMap((member) => {
      if (member.key === "tools") return [{ key: member.key, value: array(state.tools) }];
      if (member.key === "input") return [{ key: member.key, value: transformedInput }];
      if (member.key === "tool_choice") {
        return transformedChoice === undefined ? [] : [{ key: member.key, value: transformedChoice }];
      }
      return [member];
    }),
  });
  const chatMessages = projectExtendedChatMessages(transformedBody, state);
  const prefixMembers = body.members
    .filter((member) => member.key === "n" || member.key === "parallel_tool_calls" || member.key === "stop" || member.key === "stream")
    .map((member) => Object.freeze({ key: member.key, value: immutableWire(member.value) }));
  const streamOptions = single(body, "stream_options", "REQ-R-EXT-STREAM-OPTIONS");
  if (streamOptions !== undefined) {
    prefixMembers.push(Object.freeze({ key: "stream_options", value: immutableWire(streamOptions) }));
  }
  const ledger: ResponsesToolBindingLedger = Object.freeze({
    kind: "responses_extended_tools",
    bindings: projection.bindings,
    calls: Object.freeze(state.calls.map((binding) => Object.freeze({ ...binding }))),
    results: Object.freeze(state.results.map((binding) => Object.freeze({ ...binding }))),
    chatMessages: Object.freeze(chatMessages.map((message) => immutableWire(message) as WireJsonObject)),
    chatPrefixMembers: Object.freeze(prefixMembers),
  });
  return {
    body: transformedBody,
    ledger,
    chatTools: projection.chatTools,
  };
}

interface DecodedResponsesExtendedToolProjection {
  readonly state: MutableState;
  readonly inputValue: WireJson | undefined;
  readonly transformedChoice: WireJson | undefined;
  readonly projection: ResponsesToolCompatibilityProjection;
}

function decodeResponsesExtendedToolProjection(
  body: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): DecodedResponsesExtendedToolProjection | undefined {
  const toolsValue = single(body, "tools", "REQ-R-EXT-TOOLS");
  const inputValue = single(body, "input", "REQ-R-EXT-INPUT");
  if (!hasExtendedSemantics(toolsValue, inputValue)) {
    return undefined;
  }
  const state: MutableState = {
    degradations,
    discoveredTools: new WeakMap(),
    bindings: [],
    bySourceKey: new Map(),
    byChatName: new Map(),
    omittedSourceKeys: new Set(),
    tools: [],
    calls: [],
    results: [],
  };
  const tools = requiredArray(toolsValue, "REQ-R-EXT-TOOLS");
  for (const tool of tools.items) addDeclaration(state, tool);
  collectDiscoveredDeclarations(state, inputValue);
  const projection: ResponsesToolCompatibilityProjection = Object.freeze({
    chatTools: projectValidatedChatTools(state),
    bindings: Object.freeze(state.bindings.map((binding) => Object.freeze({ ...binding }))),
  });
  return {
    state,
    inputValue,
    transformedChoice: transformToolChoice(state, single(body, "tool_choice", "REQ-R-EXT-CHOICE")),
    projection,
  };
}

function projectValidatedChatTools(state: MutableState): readonly WireJsonObject[] {
  return Object.freeze(state.tools.map((tool) => {
    const name = requiredString(single(tool, "name", "REQ-R-EXT-INTERNAL-NAME"), "REQ-R-EXT-INTERNAL-NAME");
    const binding = state.byChatName.get(name);
    return object([
      ["type", "function"],
      ["function", object([
        ["name", name],
        ["description", single(tool, "description", "REQ-R-EXT-INTERNAL-DESCRIPTION") ?? null],
        ["parameters", single(tool, "parameters", "REQ-R-EXT-INTERNAL-PARAMETERS") as WireJson],
        ...(binding?.kind === "custom" || binding?.kind === "tool_search"
          ? []
          : optionalCopied(tool, ["strict"])),
      ])],
    ]);
  }));
}

export interface RestoredExtendedToolArguments {
  readonly rawCustomInput?: string;
  readonly toolSearchArguments?: WireJsonObject;
}

export function restoreResponsesExtendedToolArguments(
  kind: ResponsesToolSourceBinding["kind"],
  argumentsJson: string,
  status: "completed" | "incomplete",
): RestoredExtendedToolArguments {
  if (kind === "custom") {
    if (status === "incomplete") {
      try {
        const parsed = parseUpstreamArguments(argumentsJson);
        const inputs = memberValues(parsed, "input");
        return {
          rawCustomInput: inputs.length === 1 && typeof inputs[0] === "string"
            && parsed.members.every((member) => member.key === "input")
            ? inputs[0]
            : argumentsJson,
        };
      } catch {
        return { rawCustomInput: argumentsJson };
      }
    }
    const parsed = parseUpstreamArguments(argumentsJson);
    const inputs = memberValues(parsed, "input");
    if (inputs.length !== 1 || typeof inputs[0] !== "string" || parsed.members.some((member) => member.key !== "input")) {
      invalidToolArguments();
    }
    return { rawCustomInput: inputs[0] };
  }
  if (kind === "tool_search") {
    return {
      toolSearchArguments: status === "incomplete"
        ? incompleteToolSearchArguments(argumentsJson)
        : parseUpstreamArguments(argumentsJson),
    };
  }
  return {};
}

export function restoreResponsesExtendedTools(
  response: Readonly<SemanticResponse>,
  ledger: Readonly<ResponsesToolBindingLedger>,
): SemanticResponse {
  const callIds = new Set<string>();
  const items = response.items.map((item): SemanticResponseItem => {
    if (item.type !== "tool_call") {
      return item;
    }
    if (callIds.has(item.callId)) {
      invalidUpstream();
    }
    callIds.add(item.callId);
    const matches = ledger.bindings.filter((binding) => binding.chatName === item.name);
    if (matches.length !== 1) {
      invalidUpstream();
    }
    const binding = matches[0] as ResponsesToolSourceBinding;
    if (binding.kind === "custom" || binding.kind === "tool_search") {
      return {
        ...item,
        sourceKind: binding.kind,
        sourceName: binding.sourceName,
        ...restoreResponsesExtendedToolArguments(binding.kind, item.argumentsJson, response.status),
      };
    }
    return {
      ...item,
      sourceKind: binding.kind,
      sourceName: binding.sourceName,
      ...(binding.namespace === undefined ? {} : { namespace: binding.namespace }),
    };
  });
  return { ...response, items };
}

interface ExtendedMessageState {
  readonly output: WireJsonObject[];
  readonly pendingReasoning: string[];
}

function projectExtendedChatMessages(body: WireJsonObject, state: MutableState): WireJsonObject[] {
  return projectResponsesMessages(
    body,
    (namespace, name) => state.bySourceKey.get(sourceKey(namespace, name))?.chatName,
  );
}

function projectResponsesMessages(
  body: WireJsonObject,
  resolveChatName: (namespace: string | undefined, name: string) => string | undefined,
): WireJsonObject[] {
  const messageState: ExtendedMessageState = { output: [], pendingReasoning: [] };
  for (const instruction of compatibilityInstructionMessages(memberValues(body, "instructions")[0])) {
    messageState.output.push(instruction);
  }
  const input = memberValues(body, "input")[0];
  if (typeof input === "string") {
    flushPendingReasoning(messageState);
    messageState.output.push(chatMessage("user", input));
  } else {
    const items = isWireJsonArray(input) ? input.items : input === undefined ? [] : [input];
    projectExtendedInputItems(items, messageState, resolveChatName);
  }
  flushPendingReasoning(messageState);
  return mergeSystemMessages(messageState.output);
}

function projectExtendedInputItems(
  items: readonly WireJson[],
  state: ExtendedMessageState,
  resolveChatName: (namespace: string | undefined, name: string) => string | undefined,
): void {
  let calls: WireJsonObject[] = [];
  const flushCalls = (): void => {
    if (calls.length === 0) {
      return;
    }
    const reasoning = consumeReasoning(state);
    state.output.push(object([
      ["role", "assistant"],
      ["content", null],
      ["tool_calls", array(calls)],
      ["reasoning_content", reasoning.length > 0 ? reasoning : "tool call"],
    ]));
    calls = [];
  };

  for (const item of items) {
    if (!isWireJsonObject(item)) {
      flushCalls();
      continue;
    }
    const type = single(item, "type", "REQ-R-EXT-ITEM-TYPE");
    if (type === "reasoning") {
      appendReasoning(state.pendingReasoning, reasoningFromItem(item));
      continue;
    }
    const call = projectResponsesToolCallForCompatibility(item, resolveChatName);
    if (call !== undefined) {
      appendReasoning(state.pendingReasoning, reasoningFromItem(item));
      calls.push(call);
      continue;
    }
    flushCalls();
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
      const extracted = type === "function_call_output"
        ? { value: item as WireJson, media: [] as readonly WireJsonObject[] }
        : extractCompatibilityMedia(item);
      const content = isWireJsonObject(extracted.value)
        ? projectResponsesToolResultContentForCompatibility(extracted.value)
        : undefined;
      const callId = compatibilityCallId(item);
      if (content !== undefined && callId !== undefined) {
        state.output.push(toolMessage(callId, content));
      }
      if (extracted.media.length > 0 && callId !== undefined) {
        state.output.push(compatibilityMediaMessage(callId, extracted.media));
      }
      continue;
    }
    const message = projectExtendedMessage(item);
    if (message !== undefined) {
      const role = projectedChatRole(item);
      if (role !== "assistant") {
        flushPendingReasoning(state);
      } else {
        appendReasoning(state.pendingReasoning, reasoningFromItem(item));
      }
      state.output.push(message);
    }
  }
  flushCalls();
}

function projectExtendedMessage(item: WireJsonObject): WireJsonObject | undefined {
  const type = single(item, "type", "REQ-R-EXT-ITEM-TYPE");
  if (type !== undefined && type !== "message") {
    return undefined;
  }
  const content = single(item, "content", "REQ-R-EXT-MESSAGE-CONTENT");
  if (isWireJsonArray(content)) {
    const parts = content.items
      .map(projectExtendedContentPart)
      .filter((part): part is WireJsonObject => part !== undefined);
    return chatMessage(projectedChatRole(item), chatContentFromParts(parts));
  }
  return chatMessage(projectedChatRole(item), content ?? null);
}

function projectExtendedContentPart(value: WireJson): WireJsonObject | undefined {
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const type = single(value, "type", "REQ-R-EXT-CONTENT-TYPE");
  if (type === "input_text" || type === "output_text" || type === "text") {
    const text = single(value, "text", "REQ-R-EXT-CONTENT-TEXT");
    return typeof text !== "string" || text.length === 0 ? undefined : object([["type", "text"], ["text", text]]);
  }
  if (type === "refusal") {
    const text = single(value, "refusal", "REQ-R-EXT-CONTENT-REFUSAL");
    return typeof text !== "string" || text.length === 0 ? undefined : object([["type", "text"], ["text", text]]);
  }
  if (type === "input_image") {
    const image = single(value, "image_url", "REQ-R-EXT-CONTENT-IMAGE");
    return object([
      ["type", "image_url"],
      ["image_url", isWireJsonObject(image) ? image : object([["url", typeof image === "string" ? image : ""]])],
    ]);
  }
  if (type === "input_file") {
    const fields = ["file_id", "file_data", "filename"]
      .flatMap((key): Array<readonly [string, WireJson]> => {
        const field = memberValues(value, key)[0];
        return field === undefined ? [] : [[key, field]];
      });
    return fields.some(([key]) => key === "file_id" || key === "file_data")
      ? object([["type", "file"], ["file", object(fields)]])
      : undefined;
  }
  if (type === "input_audio") {
    const audio = memberValues(value, "input_audio")[0];
    return audio === undefined ? undefined : object([["type", "input_audio"], ["input_audio", audio]]);
  }
  return undefined;
}

function chatContentFromParts(parts: readonly WireJsonObject[]): WireJson {
  if (parts.every((part) => single(part, "type", "REQ-R-EXT-CONTENT-TYPE") === "text")) {
    return parts.map((part) => single(part, "text", "REQ-R-EXT-CONTENT-TEXT") as string).join("\n");
  }
  return array(parts);
}

function projectedChatRole(item: WireJsonObject): string {
  const role = single(item, "role", "REQ-R-EXT-MESSAGE-ROLE");
  if (role === "system" || role === "developer") {
    return "system";
  }
  if (role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

function reasoningFromItem(item: WireJsonObject): string | undefined {
  for (const key of ["reasoning_content", "reasoning"] as const) {
    const value = single(item, key, "REQ-R-EXT-REASONING");
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (isWireJsonObject(value)) {
      const nested = single(value, "content", "REQ-R-EXT-REASONING")
        ?? single(value, "text", "REQ-R-EXT-REASONING")
        ?? single(value, "summary", "REQ-R-EXT-REASONING");
      if (typeof nested === "string" && nested.length > 0) {
        return nested;
      }
    }
  }
  for (const key of ["reasoning_details", "summary"] as const) {
    const value = single(item, key, "REQ-R-EXT-REASONING");
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (isWireJsonArray(value)) {
      const text = value.items.map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!isWireJsonObject(part)) {
          return "";
        }
        const nested = single(part, "text", "REQ-R-EXT-REASONING")
          ?? single(part, "content", "REQ-R-EXT-REASONING");
        return typeof nested === "string" ? nested : "";
      }).filter((part) => part.length > 0).join("\n\n");
      return text.length === 0 ? undefined : text;
    }
  }
  return undefined;
}

function canonicalJsonStringOrOriginal(value: string): string {
  try {
    const bytes = new TextEncoder().encode(value);
    return canonicalString(parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 }));
  } catch {
    return value;
  }
}

function compatibilityInstructionMessages(value: WireJson | undefined): WireJsonObject[] {
  if (typeof value === "string") {
    return value.length === 0 ? [] : [chatMessage("system", value)];
  }
  if (!isWireJsonArray(value)) {
    return [];
  }
  const text = value.items.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    return isWireJsonObject(item) ? compatibilityString(item, "text") ?? "" : "";
  }).filter((item) => item.length > 0).join("\n\n");
  return text.length === 0 ? [] : [chatMessage("system", text)];
}

interface CompatibilityExtractedMedia {
  readonly value: WireJson;
  readonly media: readonly WireJsonObject[];
}

function extractCompatibilityMedia(value: WireJson, depth = 0): CompatibilityExtractedMedia {
  if (depth > 32) {
    invalid("REQ-R-EXT-TOOL-RESULT-MEDIA-DEPTH");
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (looksLikeNestedJson(trimmed)) {
      let parsed: WireJson;
      try {
        const bytes = new TextEncoder().encode(trimmed);
        parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 });
      } catch {
        invalid("REQ-R-EXT-TOOL-RESULT-MEDIA-JSON");
      }
      const extracted = extractCompatibilityMedia(parsed, depth + 1);
      if (extracted.media.length > 0) {
        return { value: canonicalString(extracted.value), media: extracted.media };
      }
    }
  }
  const media = compatibilityMediaPart(value);
  if (media !== undefined) {
    return { value: TOOL_RESULT_MEDIA_REPLACEMENT, media: [media] };
  }
  if (isWireJsonArray(value)) {
    const items: WireJson[] = [];
    const mediaItems: WireJsonObject[] = [];
    for (const item of value.items) {
      const extracted = extractCompatibilityMedia(item, depth + 1);
      items.push(extracted.value);
      mediaItems.push(...extracted.media);
    }
    return { value: array(items), media: mediaItems };
  }
  if (isWireJsonObject(value)) {
    const members: Array<readonly [string, WireJson]> = [];
    const mediaItems: WireJsonObject[] = [];
    for (const member of value.members) {
      const extracted = extractCompatibilityMedia(member.value, depth + 1);
      members.push([member.key, extracted.value]);
      mediaItems.push(...extracted.media);
    }
    return { value: object(members), media: mediaItems };
  }
  return { value, media: [] };
}

function looksLikeNestedJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[") || value.startsWith("\"");
}

function compatibilityMediaPart(value: WireJson): WireJsonObject | undefined {
  if (typeof value === "string" && value.trim().startsWith("data:image/")
    && new TextEncoder().encode(value.trim()).byteLength >= 8192) {
    return object([["type", "image_url"], ["image_url", object([["url", value.trim()]])]]);
  }
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const type = compatibilityString(value, "type");
  if (type === "input_image" || type === "image_url") {
    const image = memberValues(value, "image_url")[0] ?? memberValues(value, "source")[0];
    return object([
      ["type", "image_url"],
      ["image_url", isWireJsonObject(image) ? image : object([["url", typeof image === "string" ? image : ""]])],
    ]);
  }
  if (type === "input_file" || type === "input_audio") {
    return projectExtendedContentPart(value);
  }
  return undefined;
}

function compatibilityMediaMessage(callId: string, media: readonly WireJsonObject[]): WireJsonObject {
  return chatMessage("user", array([
    object([["type", "text"], ["text", toolResultMediaReference(callId)]]),
    ...media,
  ]));
}

function mergeSystemMessages(messages: readonly WireJsonObject[]): WireJsonObject[] {
  const systemText: string[] = [];
  const rest: WireJsonObject[] = [];
  for (const message of messages) {
    if (single(message, "role", "REQ-R-EXT-MESSAGE-ROLE") === "system") {
      const content = single(message, "content", "REQ-R-EXT-MESSAGE-CONTENT");
      if (typeof content === "string" && content.length > 0) {
        systemText.push(content);
      }
    } else {
      rest.push(message);
    }
  }
  return systemText.length === 0 ? rest : [chatMessage("system", systemText.join("\n\n")), ...rest];
}

function chatMessage(role: string, content: WireJson): WireJsonObject {
  return object([["role", role], ["content", content]]);
}

function toolMessage(callId: string, content: string): WireJsonObject {
  return object([["role", "tool"], ["tool_call_id", callId], ["content", content]]);
}

function consumeReasoning(state: ExtendedMessageState): string {
  const text = state.pendingReasoning.join("\n\n");
  state.pendingReasoning.length = 0;
  return text;
}

function appendReasoning(target: string[], value: string | undefined): void {
  if (value !== undefined && value.length > 0 && !target.includes(value)) {
    target.push(value);
  }
}

function flushPendingReasoning(state: ExtendedMessageState): void {
  if (state.pendingReasoning.length === 0) {
    return;
  }
  const previousIndex = state.output.findLastIndex((message) => single(message, "role", "REQ-R-EXT-MESSAGE-ROLE") === "assistant");
  const previous = state.output[previousIndex];
  if (previous !== undefined && single(previous, "reasoning_content", "REQ-R-EXT-REASONING") === undefined) {
    state.output[previousIndex] = {
      kind: "object",
      members: [...previous.members, { key: "reasoning_content", value: state.pendingReasoning.join("\n\n") }],
    };
  }
  state.pendingReasoning.length = 0;
}

function incompleteToolSearchArguments(value: string): WireJsonObject {
  if (value.trim().length === 0) {
    return object([]);
  }
  try {
    return parseUpstreamArguments(value);
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError && error.failure.kind === "invalid_tool_arguments") {
      return object([["query", value]]);
    }
    throw error;
  }
}

function parseUpstreamArguments(value: string): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(value);
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 });
    if (!isWireJsonObject(parsed)) {
      invalidToolArguments();
    }
    if (parsed.members.some((member, index) => parsed.members.findIndex((other) => other.key === member.key) !== index)) {
      invalidToolArguments();
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    invalidToolArguments();
  }
}

function invalidUpstream(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "converter",
    phase: "convert",
  });
}

function invalidToolArguments(): never {
  throw new GatewayFailureError({
    kind: "invalid_tool_arguments",
    source: "converter",
    phase: "convert",
  });
}

function hasExtendedSemantics(tools: WireJson | undefined, input: WireJson | undefined): boolean {
  if (isWireJsonArray(tools) && tools.items.some((tool) => (
    !isWireJsonObject(tool) || single(tool, "type", "REQ-R-EXT-TOOL-TYPE") !== "function"
  ))) {
    return true;
  }
  const items = isWireJsonArray(input) ? input.items : input === undefined ? [] : [input];
  return items.some((item) => {
    if (!isWireJsonObject(item)) {
      return false;
    }
    const type = single(item, "type", "REQ-R-EXT-ITEM-TYPE");
    return type === "custom_tool_call"
      || type === "custom_tool_call_output"
      || type === "tool_search_call"
      || type === "tool_search_output"
      || (type === "function_call" && single(item, "namespace", "REQ-R-EXT-ITEM-NS") !== undefined);
  });
}

function addDeclaration(state: MutableState, value: WireJson, namespace?: string): WireJsonObject | undefined {
  if (!isWireJsonObject(value)) {
    if (containsReasoningCarrier(value)) invalid("REQ-R-EXT-TOOL");
    state.degradations.add("responses.extensions_omitted");
    return undefined;
  }
  let tool = value;
  const type = single(tool, "type", "REQ-R-EXT-TOOL-TYPE");
  if (typeof type !== "string") {
    if (containsReasoningCarrier(tool)) invalid("REQ-R-EXT-TOOL-TYPE");
    markOmittedDeclaration(state, tool, namespace);
    state.degradations.add("responses.extensions_omitted");
    return undefined;
  }
  if (type === "function") {
    return addFunction(state, tool, namespace);
  }
  if (namespace !== undefined) {
    if (containsReasoningCarrier(tool)) invalid("REQ-R-EXT-TOOL-TYPE");
    markOmittedDeclaration(state, tool, namespace);
    state.degradations.add("responses.extensions_omitted");
    return undefined;
  }
  if (type === "custom") {
    return addCustom(state, tool);
  }
  if (type === "namespace") {
    return addNamespace(state, tool);
  }
  if (type === "tool_search") {
    tool = projectExtended(state, tool, new Set(["type"]), "REQ-R-EXT-SEARCH");
    addBinding(state, {
      kind: "tool_search",
      chatName: "tool_search",
      sourceName: "tool_search",
    }, object([
      ["type", "function"],
      ["name", "tool_search"],
      ["description", TOOL_SEARCH_DESCRIPTION],
      ["parameters", TOOL_SEARCH_SCHEMA],
      ["strict", false],
    ]));
    return tool;
  }
  if (containsReasoningCarrier(tool)) invalid("REQ-R-EXT-TOOL-TYPE");
  markOmittedDeclaration(state, tool, namespace);
  state.degradations.add("responses.extensions_omitted");
  return undefined;
}

function addFunction(state: MutableState, tool: WireJsonObject, namespace?: string): WireJsonObject {
  tool = projectExtended(
    state,
    tool,
    new Set(["type", "function", "name", "description", "parameters", "strict"]),
    "REQ-R-EXT-FUNCTION",
  );
  const nested = single(tool, "function", "REQ-R-EXT-FUNCTION-SHAPE");
  const shape = nested === undefined ? tool : projectExtended(
    state,
    looseObject(nested, "REQ-R-EXT-FUNCTION-SHAPE"),
    new Set(["name", "description", "parameters", "strict"]),
    "REQ-R-EXT-FUNCTION-SHAPE",
  );
  if (nested !== undefined) tool = replaceMember(tool, "function", shape);
  const sourceName = toolName(shape, "REQ-R-EXT-FUNCTION-NAME");
  const description = optionalExtendedString(
    state,
    single(shape, "description", "REQ-R-EXT-FUNCTION-DESCRIPTION"),
    "REQ-R-EXT-FUNCTION-DESCRIPTION",
  );
  const parametersValue = single(shape, "parameters", "REQ-R-EXT-FUNCTION-SCHEMA");
  const parametersObject = optionalExtendedObject(state, parametersValue, "REQ-R-EXT-FUNCTION-SCHEMA");
  const parameters = parametersObject === undefined
    ? object([["type", "object"], ["properties", object([])]])
    : normalizedParameters(parametersObject);
  const nestedStrict = single(shape, "strict", "REQ-R-EXT-FUNCTION-STRICT");
  const strictValue = nestedStrict === undefined && nested !== undefined
    ? single(tool, "strict", "REQ-R-EXT-FUNCTION-STRICT")
    : nestedStrict;
  const strict = strictValue === undefined || typeof strictValue === "boolean"
    ? strictValue
    : omitMalformedExtended(state, strictValue, "REQ-R-EXT-FUNCTION-STRICT");
  const projectedStrict = strict ?? (isOpenaiStrictSchemaCompatible(parameters) ? true : undefined);
  const chatName = namespace === undefined ? sourceName : projectedNamespaceName(namespace, sourceName);
  addBinding(state, {
    kind: namespace === undefined ? "function" : "namespace",
    chatName,
    sourceName,
    ...(namespace === undefined ? {} : { namespace }),
  }, object([
    ["type", "function"],
    ["name", chatName],
    ...(description === undefined ? [] : [["description", description] as const]),
    ["parameters", parameters],
    ...(projectedStrict === undefined ? [] : [["strict", projectedStrict] as const]),
  ]));
  return tool;
}

function addCustom(state: MutableState, tool: WireJsonObject): WireJsonObject {
  tool = projectExtended(state, tool, new Set(["type", "name", "description", "format"]), "REQ-R-EXT-CUSTOM");
  const name = toolName(tool, "REQ-R-EXT-CUSTOM-NAME");
  optionalExtendedString(
    state,
    single(tool, "description", "REQ-R-EXT-CUSTOM-DESCRIPTION"),
    "REQ-R-EXT-CUSTOM-DESCRIPTION",
  );
  const format = single(tool, "format", "REQ-R-EXT-CUSTOM-FORMAT");
  if (format !== undefined) {
    const formatObject = optionalExtendedObject(state, format, "REQ-R-EXT-CUSTOM-FORMAT");
    if (formatObject === undefined) {
      tool = removeMember(tool, "format");
    } else {
      const objectValue = projectExtended(
        state,
        formatObject,
        new Set(["type"]),
        "REQ-R-EXT-CUSTOM-FORMAT",
      );
      if (single(objectValue, "type", "REQ-R-EXT-CUSTOM-FORMAT-TYPE") !== "text") {
        state.degradations.add("request.option_omitted");
        tool = removeMember(tool, "format");
      } else {
        tool = replaceMember(tool, "format", objectValue);
      }
    }
  }
  addBinding(state, { kind: "custom", chatName: name, sourceName: name }, object([
    ["type", "function"],
    ["name", name],
    ["description", `Original tool definition:\n\`\`\`json\n${canonicalString(tool)}\n\`\`\``],
    ["parameters", CUSTOM_INPUT_SCHEMA],
    ["strict", false],
  ]));
  return tool;
}

function addNamespace(state: MutableState, tool: WireJsonObject): WireJsonObject | undefined {
  tool = projectExtended(
    state,
    tool,
    new Set(["type", "name", "description", "tools", "children"]),
    "REQ-R-EXT-NAMESPACE",
  );
  const namespace = toolName(tool, "REQ-R-EXT-NAMESPACE-NAME");
  optionalExtendedString(
    state,
    single(tool, "description", "REQ-R-EXT-NAMESPACE-DESCRIPTION"),
    "REQ-R-EXT-NAMESPACE-DESCRIPTION",
  );
  const tools = single(tool, "tools", "REQ-R-EXT-NAMESPACE-TOOLS");
  const children = single(tool, "children", "REQ-R-EXT-NAMESPACE-CHILDREN");
  if ((tools === undefined) === (children === undefined)) {
    invalid("REQ-R-EXT-NAMESPACE-CHILDREN");
  }
  const values = requiredArray(tools ?? children, "REQ-R-EXT-NAMESPACE-CHILDREN");
  if (values.items.length === 0) {
    invalid("REQ-R-EXT-NAMESPACE-CHILDREN");
  }
  const sanitized = values.items.flatMap((child) => {
    const declaration = addDeclaration(state, child, namespace);
    return declaration === undefined ? [] : [declaration];
  });
  if (sanitized.length === 0) {
    state.degradations.add("responses.extensions_omitted");
    return undefined;
  }
  return replaceMember(tool, tools === undefined ? "children" : "tools", array(sanitized));
}

function addBinding(state: MutableState, binding: ResponsesToolSourceBinding, tool: WireJsonObject): void {
  validateChatName(binding.chatName);
  const key = sourceKey(binding.namespace, binding.sourceName);
  if (state.bySourceKey.has(key) || state.byChatName.has(binding.chatName)) {
    invalid("REQ-R-EXT-TOOL-COLLISION");
  }
  const frozen = Object.freeze({ ...binding });
  state.bindings.push(frozen);
  state.bySourceKey.set(key, frozen);
  state.byChatName.set(binding.chatName, frozen);
  state.tools.push(tool);
}

function collectDiscoveredDeclarations(state: MutableState, input: WireJson | undefined): void {
  const items = isWireJsonArray(input) ? input.items : input === undefined ? [] : [input];
  for (const item of items) {
    if (!isWireJsonObject(item) || single(item, "type", "REQ-R-EXT-DISCOVERED-TYPE") !== "tool_search_output") {
      continue;
    }
    const projected = projectExtended(
      state,
      item,
      new Set(["type", "id", "call_id", "output", "status", "tools"]),
      "REQ-R-EXT-SEARCH-OUTPUT",
    );
    const tools = requiredArray(single(projected, "tools", "REQ-R-EXT-SEARCH-OUTPUT-TOOLS"), "REQ-R-EXT-SEARCH-OUTPUT-TOOLS");
    state.discoveredTools.set(item, array(tools.items.flatMap((tool) => {
      const declaration = addDeclaration(state, tool);
      return declaration === undefined ? [] : [declaration];
    })));
  }
}

function transformInput(state: MutableState, input: WireJson | undefined): WireJson {
  if (!isWireJsonArray(input)) {
    return input ?? array([]);
  }
  const calls = new Map<string, ResponsesToolSourceBinding>();
  const results = new Set<string>();
  const omittedCallIds = new Set<string>();
  const output: WireJson[] = [];
  for (const inputValue of input.items) {
    let value = inputValue;
    if (!isWireJsonObject(value)) {
      output.push(value);
      continue;
    }
    const type = single(value, "type", "REQ-R-EXT-ITEM-TYPE");
    if (type === "custom_tool_call") {
      value = projectExtended(state, value, new Set(["type", "id", "call_id", "name", "input", "status"]), "REQ-R-EXT-CUSTOM-CALL");
      const name = requiredString(single(value, "name", "REQ-R-EXT-CUSTOM-CALL-NAME"), "REQ-R-EXT-CUSTOM-CALL-NAME");
      const binding = state.bySourceKey.get(sourceKey(undefined, name));
      if (binding === undefined && state.omittedSourceKeys.has(sourceKey(undefined, name))) {
        omitExtendedCall(state, value, omittedCallIds);
        continue;
      }
      if (binding === undefined || binding.kind !== "custom") invalid("REQ-R-EXT-MISSING-BINDING");
      const callId = registerCall(calls, value, binding);
      const rawInput = requiredString(single(value, "input", "REQ-R-EXT-CUSTOM-CALL-INPUT"), "REQ-R-EXT-CUSTOM-CALL-INPUT", true);
      const itemId = optionalItemId(state, value);
      const status = requestCallStatus(state, single(value, "status", "REQ-R-EXT-CALL-STATUS"));
      state.calls.push(callBinding(callId, binding, itemId, status, { rawCustomInput: rawInput }));
      output.push(object([
        ["type", "function_call"],
        ...(itemId === undefined ? [] : [["id", itemId] as const]),
        ["call_id", callId],
        ["name", binding.chatName],
        ["arguments", canonicalString(object([["input", rawInput]]))],
        ...(status === undefined ? [] : [["status", status] as const]),
      ]));
      continue;
    }
    if (type === "tool_search_call") {
      value = projectExtended(state, value, new Set(["type", "id", "call_id", "arguments", "status", "execution"]), "REQ-R-EXT-SEARCH-CALL");
      const execution = single(value, "execution", "REQ-R-EXT-SEARCH-CALL-EXECUTION");
      if (execution !== undefined) {
        if (containsReasoningCarrier(execution)) invalid("REQ-R-EXT-SEARCH-CALL-EXECUTION");
        state.degradations.add("request.option_omitted");
      }
      const binding = requiredBinding(state, undefined, "tool_search", "tool_search");
      const callId = registerCall(calls, value, binding);
      const argumentsValue = requiredObject(single(value, "arguments", "REQ-R-EXT-SEARCH-CALL-ARGS"), "REQ-R-EXT-SEARCH-CALL-ARGS");
      const itemId = optionalItemId(state, value);
      const status = requestCallStatus(state, single(value, "status", "REQ-R-EXT-CALL-STATUS"));
      state.calls.push(callBinding(callId, binding, itemId, status, { toolSearchArguments: immutableWire(argumentsValue) as WireJsonObject }));
      output.push(object([
        ["type", "function_call"],
        ...(itemId === undefined ? [] : [["id", itemId] as const]),
        ["call_id", callId],
        ["name", binding.chatName],
        ["arguments", canonicalString(argumentsValue)],
        ...(status === undefined ? [] : [["status", status] as const]),
      ]));
      continue;
    }
    if (type === "function_call") {
      value = projectExtended(state, value, new Set(["type", "id", "call_id", "name", "namespace", "arguments", "status"]), "REQ-R-EXT-FUNCTION-CALL");
      const name = requiredString(single(value, "name", "REQ-R-EXT-FUNCTION-CALL-NAME"), "REQ-R-EXT-FUNCTION-CALL-NAME");
      const namespace = optionalExtendedString(
        state,
        single(value, "namespace", "REQ-R-EXT-FUNCTION-CALL-NS"),
        "REQ-R-EXT-FUNCTION-CALL-NS",
      );
      const key = sourceKey(namespace, name);
      const binding = state.bySourceKey.get(key);
      if (binding === undefined && state.omittedSourceKeys.has(key)) {
        omitExtendedCall(state, value, omittedCallIds);
        continue;
      }
      if (binding === undefined) invalid("REQ-R-EXT-MISSING-BINDING");
      if (binding.kind !== "function" && binding.kind !== "namespace") {
        invalid("REQ-R-EXT-FUNCTION-CALL-BINDING");
      }
      const callId = registerCall(calls, value, binding);
      const argumentsText = requiredString(single(value, "arguments", "REQ-R-EXT-FUNCTION-CALL-ARGS"), "REQ-R-EXT-FUNCTION-CALL-ARGS", true);
      const parsedArguments = parseArguments(argumentsText, "REQ-R-EXT-FUNCTION-CALL-ARGS");
      const itemId = optionalItemId(state, value);
      const status = requestCallStatus(state, single(value, "status", "REQ-R-EXT-CALL-STATUS"));
      state.calls.push(callBinding(callId, binding, itemId, status));
      output.push(object([
        ["type", "function_call"],
        ...(itemId === undefined ? [] : [["id", itemId] as const]),
        ["call_id", callId],
        ["name", binding.chatName],
        ["arguments", canonicalString(parsedArguments)],
        ...(status === undefined ? [] : [["status", status] as const]),
      ]));
      continue;
    }
    if (type === "custom_tool_call_output" || type === "tool_search_output" || type === "function_call_output") {
      const allowed = type === "function_call_output"
        ? new Set(["type", "id", "call_id", "output", "status"])
        : new Set(["type", "id", "call_id", "output", "status", "tools"]);
      value = projectExtended(state, value, allowed, "REQ-R-EXT-RESULT");
      const callId = requiredString(single(value, "call_id", "REQ-R-EXT-RESULT-ID"), "REQ-R-EXT-RESULT-ID");
      if (omittedCallIds.has(callId)) {
        state.degradations.add("tools.history_omitted");
        continue;
      }
      const binding = calls.get(callId);
      if (binding === undefined || results.has(callId)) {
        invalid("REQ-R-EXT-RESULT-BINDING");
      }
      if ((type === "custom_tool_call_output") !== (binding.kind === "custom")
        || (type === "tool_search_output") !== (binding.kind === "tool_search")) {
        invalid("REQ-R-EXT-RESULT-KIND");
      }
      const resultValue = type === "tool_search_output"
        ? single(value, "tools", "REQ-R-EXT-SEARCH-OUTPUT-TOOLS")
        : single(value, "output", "REQ-R-EXT-RESULT-OUTPUT");
      if (resultValue === undefined) {
        invalid("REQ-R-EXT-RESULT-OUTPUT");
      }
      if (containsMedia(resultValue)) {
        unsupported("REQ-R-EXT-RESULT-MEDIA");
      }
      const status = requestResultStatus(state, single(value, "status", "REQ-R-EXT-RESULT-STATUS"));
      const itemId = optionalItemId(state, value);
      const discoveredTools = type === "tool_search_output" && isWireJsonObject(inputValue)
        ? state.discoveredTools.get(inputValue)
        : undefined;
      if (discoveredTools !== undefined) value = replaceMember(value, "tools", discoveredTools);
      const sanitized = presentationFields(value, itemId, status);
      state.results.push(Object.freeze({
        kind: binding.kind,
        callId,
        ...(itemId === undefined ? {} : { itemId }),
        ...(status === undefined ? {} : { status }),
      }));
      results.add(callId);
      output.push(object([
        ["type", "function_call_output"],
        ...(itemId === undefined ? [] : [["id", itemId] as const]),
        ["call_id", callId],
        ["output", type === "function_call_output" ? canonicalResult(resultValue) : canonicalString(sanitized)],
        ...(status === undefined ? [] : [["status", status] as const]),
      ]));
      continue;
    }
    output.push(value);
  }
  return array(output);
}

function registerCall(
  calls: Map<string, ResponsesToolSourceBinding>,
  value: WireJsonObject,
  binding: ResponsesToolSourceBinding,
): string {
  const callId = requiredString(single(value, "call_id", "REQ-R-EXT-CALL-ID"), "REQ-R-EXT-CALL-ID");
  if (calls.has(callId)) {
    invalid("REQ-R-EXT-DUPLICATE-CALL-ID");
  }
  calls.set(callId, binding);
  return callId;
}

function omitExtendedCall(
  state: Pick<MutableState, "degradations">,
  value: WireJsonObject,
  omittedCallIds: Set<string>,
): void {
  const callId = requiredString(single(value, "call_id", "REQ-R-EXT-CALL-ID"), "REQ-R-EXT-CALL-ID");
  if (omittedCallIds.has(callId)) invalid("REQ-R-EXT-DUPLICATE-CALL-ID");
  omittedCallIds.add(callId);
  state.degradations.add("tools.history_omitted");
}

function transformToolChoice(state: MutableState, value: WireJson | undefined): WireJson | undefined {
  if (value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") return value;
    state.degradations.add("request.option_omitted");
    return undefined;
  }
  const rawChoice = optionalExtendedObject(state, value, "REQ-R-EXT-CHOICE");
  if (rawChoice === undefined) return undefined;
  const choice = projectExtended(
    state,
    rawChoice,
    new Set(["type", "name", "namespace"]),
    "REQ-R-EXT-CHOICE",
  );
  const type = optionalExtendedString(
    state,
    single(choice, "type", "REQ-R-EXT-CHOICE-TYPE"),
    "REQ-R-EXT-CHOICE-TYPE",
  );
  if (type === undefined) return undefined;
  if (type !== "function" && type !== "custom" && type !== "tool_search") {
    state.degradations.add("request.option_omitted");
    return undefined;
  }
  const name = optionalExtendedString(
    state,
    single(choice, "name", "REQ-R-EXT-CHOICE-NAME"),
    "REQ-R-EXT-CHOICE-NAME",
  );
  if (name === undefined) return undefined;
  const namespaceValue = single(choice, "namespace", "REQ-R-EXT-CHOICE-NS");
  const namespace = optionalExtendedString(state, namespaceValue, "REQ-R-EXT-CHOICE-NS");
  if (namespaceValue !== undefined && namespace === undefined) return undefined;
  const key = sourceKey(namespace, name);
  const binding = state.bySourceKey.get(key);
  if (binding === undefined && state.omittedSourceKeys.has(key)) {
    state.degradations.add("request.option_omitted");
    return undefined;
  }
  if (binding === undefined) invalid("REQ-R-EXT-MISSING-BINDING");
  if ((type === "custom" && binding.kind !== "custom")
    || (type === "tool_search" && binding.kind !== "tool_search")
    || (type === "function" && binding.kind !== "function" && binding.kind !== "namespace")) {
    invalid("REQ-R-EXT-CHOICE-BINDING");
  }
  return object([["type", "function"], ["name", binding.chatName]]);
}

function requiredBinding(
  state: MutableState,
  namespace: string | undefined,
  name: string,
  kind?: ResponsesToolSourceBinding["kind"],
): ResponsesToolSourceBinding {
  const binding = state.bySourceKey.get(sourceKey(namespace, name));
  if (binding === undefined || (kind !== undefined && binding.kind !== kind)) {
    invalid("REQ-R-EXT-MISSING-BINDING");
  }
  return binding;
}

function markOmittedDeclaration(
  state: Pick<MutableState, "omittedSourceKeys">,
  tool: WireJsonObject,
  namespace: string | undefined,
): void {
  const nested = single(tool, "function", "REQ-R-EXT-OMITTED");
  const shape = isWireJsonObject(nested) ? nested : tool;
  const name = single(shape, "name", "REQ-R-EXT-OMITTED");
  if (typeof name === "string" && name.length > 0) {
    state.omittedSourceKeys.add(sourceKey(namespace, name));
  }
}

function validateInstructionOrdering(input: WireJson | undefined): void {
  const items = isWireJsonArray(input) ? input.items : isWireJsonObject(input) ? [input] : [];
  let ordinarySeen = false;
  for (const item of items) {
    if (!isWireJsonObject(item) || (single(item, "type", "REQ-R-EXT-INSTRUCTION") !== undefined
      && single(item, "type", "REQ-R-EXT-INSTRUCTION") !== "message")) {
      ordinarySeen = true;
      continue;
    }
    const role = single(item, "role", "REQ-R-EXT-INSTRUCTION-ROLE");
    if (role === "developer" || (role === "system" && ordinarySeen)) {
      unsupported("REQ-R-EXT-INSTRUCTION-ORDER");
    }
    if (role !== "system") {
      ordinarySeen = true;
    }
  }
}

function containsMedia(value: WireJson, depth = 0): boolean {
  if (depth > 32) {
    invalid("REQ-R-EXT-RESULT-MEDIA-DEPTH");
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("data:image/")) {
      return true;
    }
    if (looksLikeNestedJson(trimmed)) {
      let parsed: WireJson;
      try {
        const bytes = new TextEncoder().encode(trimmed);
        parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 });
      } catch {
        invalid("REQ-R-EXT-RESULT-MEDIA-JSON");
      }
      return containsMedia(parsed, depth + 1);
    }
    return false;
  }
  if (isWireJsonArray(value)) {
    return value.items.some((item) => containsMedia(item, depth + 1));
  }
  if (!isWireJsonObject(value)) {
    return false;
  }
  const type = single(value, "type", "REQ-R-EXT-MEDIA-TYPE");
  return type === "image" || type === "input_image" || type === "image_url"
    || value.members.some((member) => containsMedia(member.value, depth + 1));
}

function projectedNamespaceName(namespace: string, name: string): string {
  const full = `${namespace}__${name}`;
  if (new TextEncoder().encode(full).byteLength <= 64) {
    return full;
  }
  const suffix = `__${createHash("sha256").update(full).digest("hex").slice(0, 16)}`;
  const maximum = 64 - new TextEncoder().encode(suffix).byteLength;
  let prefix = "";
  for (const character of full) {
    if (new TextEncoder().encode(`${prefix}${character}`).byteLength > maximum) {
      break;
    }
    prefix += character;
  }
  return `${prefix}${suffix}`;
}

function normalizedParameters(value: WireJsonObject): WireJsonObject {
  return {
    kind: "object",
    members: [
      { key: "type", value: "object" },
      ...value.members.filter((member) => member.key !== "type"),
    ],
  };
}

function validateChatName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(name) || new TextEncoder().encode(name).byteLength > 64) {
    invalid("REQ-R-EXT-TOOL-NAME");
  }
}

function toolName(value: WireJsonObject, ruleId: string): string {
  const name = requiredString(single(value, "name", ruleId), ruleId).trim();
  if (name.length === 0) {
    invalid(ruleId);
  }
  return name;
}

function callBinding(
  callId: string,
  binding: ResponsesToolSourceBinding,
  itemId: string | undefined,
  status: ResponsesToolCallBinding["status"],
  extended: Pick<ResponsesToolCallBinding, "rawCustomInput" | "toolSearchArguments"> = {},
): ResponsesToolCallBinding {
  return Object.freeze({
    ...binding,
    callId,
    ...(itemId === undefined ? {} : { itemId }),
    ...(status === undefined ? {} : { status }),
    ...extended,
  });
}

function optionalItemId(
  state: Pick<MutableState, "degradations">,
  value: WireJsonObject,
): string | undefined {
  const itemId = single(value, "id", "REQ-R-EXT-ITEM-ID");
  if (itemId === undefined) return undefined;
  if (containsReasoningCarrier(itemId)) invalid("REQ-R-EXT-ITEM-ID");
  state.degradations.add("request.option_omitted");
  return typeof itemId === "string" && itemId.length > 0 ? itemId : undefined;
}

function requestCallStatus(
  state: Pick<MutableState, "degradations">,
  value: WireJson | undefined,
): ResponsesToolCallBinding["status"] {
  if (value !== undefined && containsReasoningCarrier(value)) invalid("REQ-R-EXT-STATUS");
  if (value === undefined || value === "completed" || value === "incomplete" || value === "in_progress") {
    if (value !== undefined) state.degradations.add("request.option_omitted");
    return value;
  }
  state.degradations.add("request.option_omitted");
  return undefined;
}

function requestResultStatus(
  state: Pick<MutableState, "degradations">,
  value: WireJson | undefined,
): ResponsesToolResultBinding["status"] {
  if (value !== undefined && containsReasoningCarrier(value)) invalid("REQ-R-EXT-STATUS");
  if (value === undefined || value === "completed" || value === "incomplete" || value === "in_progress" || value === "failed") {
    if (value !== undefined) state.degradations.add("request.option_omitted");
    return value;
  }
  state.degradations.add("request.option_omitted");
  return undefined;
}

function presentationFields(
  value: WireJsonObject,
  itemId: string | undefined,
  status: ResponsesToolResultBinding["status"],
): WireJsonObject {
  return {
    kind: "object",
    members: value.members.flatMap((member) => {
      if (member.key === "id") return itemId === undefined ? [] : [{ key: member.key, value: itemId }];
      if (member.key === "status") return status === undefined ? [] : [{ key: member.key, value: status }];
      return [member];
    }),
  };
}

function replaceMember(objectValue: WireJsonObject, key: string, value: WireJson): WireJsonObject {
  return {
    kind: "object",
    members: objectValue.members.map((member) => member.key === key ? { key, value } : member),
  };
}

function removeMember(objectValue: WireJsonObject, key: string): WireJsonObject {
  return {
    kind: "object",
    members: objectValue.members.filter((member) => member.key !== key),
  };
}

function parseArguments(value: string, ruleId: string): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(value);
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 });
    return requiredObject(parsed, ruleId);
  } catch {
    invalid(ruleId);
  }
}

function optionalCopied(value: WireJsonObject, keys: readonly string[]): Array<readonly [string, WireJson]> {
  return keys.flatMap((key) => {
    const found = single(value, key, `REQ-R-EXT-${key.toUpperCase()}`);
    return found === undefined ? [] : [[key, found] as const];
  });
}

function sourceKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ""}\u0000${name}`;
}

function canonicalResult(value: WireJson): string {
  if (typeof value !== "string") {
    return canonicalString(value);
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    const bytes = new TextEncoder().encode(trimmed);
    return canonicalString(parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 }));
  } catch {
    return value;
  }
}

function canonicalString(value: WireJson): string {
  return new TextDecoder().decode(canonicalizeWireJson(value));
}

function projectExtended(
  state: Pick<MutableState, "degradations">,
  value: WireJsonObject,
  allowed: ReadonlySet<string>,
  ruleId: string,
): WireJsonObject {
  return projectKnownObject(value, {
    knownKeys: allowed,
    sensitiveKeys: EXTENDED_SENSITIVE_FIELDS,
    omittedValueIsUnsafe: containsReasoningCarrier,
    ruleId,
    omission: "responses.extensions_omitted",
    degradations: state.degradations,
  });
}

function looseObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) invalid(ruleId);
  return value;
}

function single(value: WireJsonObject, key: string, _ruleId: string): WireJson | undefined {
  return memberValues(value, key)[0];
}

function requiredObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) {
    invalid(ruleId);
  }
  return value;
}

function requiredArray(value: WireJson | undefined, ruleId: string): WireJsonArray {
  if (!isWireJsonArray(value)) {
    invalid(ruleId);
  }
  return value;
}

function requiredString(value: WireJson | undefined, ruleId: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalid(ruleId);
  }
  return value;
}

function optionalExtendedString(
  state: Pick<MutableState, "degradations">,
  value: WireJson | undefined,
  ruleId: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  return omitMalformedExtended(state, value, ruleId);
}

function optionalExtendedObject(
  state: Pick<MutableState, "degradations">,
  value: WireJson | undefined,
  ruleId: string,
): WireJsonObject | undefined {
  if (value === undefined) return undefined;
  if (isWireJsonObject(value)) return value;
  return omitMalformedExtended(state, value, ruleId);
}

function omitMalformedExtended(
  state: Pick<MutableState, "degradations">,
  value: WireJson,
  ruleId: string,
): undefined {
  if (containsReasoningCarrier(value)) invalid(ruleId);
  state.degradations.add("request.option_omitted");
  return undefined;
}

function immutableWire(value: WireJson): WireJson {
  if (isWireJsonArray(value)) {
    return Object.freeze({ kind: "array", items: Object.freeze(value.items.map(immutableWire)) });
  }
  if (isWireJsonObject(value)) {
    return Object.freeze({
      kind: "object",
      members: Object.freeze(value.members.map((member) => Object.freeze({
        key: member.key,
        value: immutableWire(member.value),
      }))),
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze({ ...value });
  }
  return value;
}

export function projectResponsesToolResultContentForCompatibility(item: WireJsonObject): string | undefined {
  const type = compatibilityString(item, "type");
  let content: string;
  if (type === "function_call_output") {
    const value = memberValues(item, "output")[0];
    content = typeof value === "string"
      ? canonicalJsonStringOrOriginal(value)
      : value === undefined ? "" : canonicalString(value);
  } else if (type === "custom_tool_call_output" || type === "tool_search_output") {
    content = canonicalString(item);
  } else {
    return undefined;
  }
  if (memberValues(item, "status")[0] !== "failed") {
    return content;
  }
  return `${TOOL_RESULT_ERROR_MARKER}${content.length === 0 ? "" : `\n${content}`}`;
}

export function projectResponsesToolCallForCompatibility(
  item: WireJsonObject,
  chatNameForSource: (namespace: string | undefined, name: string) => string | undefined,
): WireJsonObject | undefined {
  const type = compatibilityString(item, "type");
  const callId = compatibilityCallId(item);
  if (callId === undefined) return undefined;
  if (type === "function_call") {
    const sourceName = compatibilityString(item, "name") ?? "";
    const namespace = compatibilityString(item, "namespace");
    const chatName = chatNameForSource(namespace, sourceName) ?? sourceName;
    return compatibilityChatToolCall(callId, chatName, compatibilityArguments(memberValues(item, "arguments")[0]));
  }
  if (type === "custom_tool_call") {
    return compatibilityChatToolCall(
      callId,
      compatibilityString(item, "name") ?? "",
      canonicalString(object([["input", memberValues(item, "input")[0] ?? ""]])),
    );
  }
  if (type === "tool_search_call") {
    return compatibilityChatToolCall(
      callId,
      "tool_search",
      canonicalString(memberValues(item, "arguments")[0] ?? object([])),
    );
  }
  return undefined;
}

function compatibilityChatToolCall(id: string, name: string, argumentsJson: string): WireJsonObject {
  return object([
    ["id", id],
    ["type", "function"],
    ["function", object([["name", name], ["arguments", argumentsJson]])],
  ]);
}

function compatibilityArguments(value: WireJson | undefined): string {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return "{}";
  }
  if (typeof value !== "string") {
    return canonicalString(value);
  }
  try {
    const bytes = new TextEncoder().encode(value);
    return canonicalString(parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 }));
  } catch {
    return value;
  }
}

function compatibilityString(value: WireJsonObject, key: string): string | undefined {
  const member = memberValues(value, key)[0];
  return typeof member === "string" ? member : undefined;
}

function compatibilityCallId(value: WireJsonObject): string | undefined {
  const callIds = memberValues(value, "call_id");
  return callIds.length === 1 && typeof callIds[0] === "string" && callIds[0].length > 0
    ? callIds[0]
    : undefined;
}

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}
