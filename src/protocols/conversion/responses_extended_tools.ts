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
import { isOpenAiStrictSchemaCompatible } from "./strict_schema.js";
import type {
  ResponsesToolBindingLedger,
  ResponsesToolCallBinding,
  ResponsesToolResultBinding,
  ResponsesToolSourceBinding,
  SemanticResponse,
  SemanticResponseItem,
} from "./types.js";
import { invalid, unsupported } from "./wire.js";

const EXTENDED_RESPONSES_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "stream",
  "stream_options",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "previous_response_id",
  "store",
  "background",
  "n",
  "metadata",
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
  readonly bindings: ResponsesToolSourceBinding[];
  readonly bySourceKey: Map<string, ResponsesToolSourceBinding>;
  readonly byChatName: Map<string, ResponsesToolSourceBinding>;
  readonly tools: WireJsonObject[];
  readonly calls: ResponsesToolCallBinding[];
  readonly results: ResponsesToolResultBinding[];
}

export function prepareResponsesExtendedTools(body: WireJsonObject): PreparedResponsesExtendedTools | undefined {
  const toolsValue = single(body, "tools", "REQ-R-EXT-TOOLS");
  const inputValue = single(body, "input", "REQ-R-EXT-INPUT");
  if (!hasExtendedSemantics(toolsValue, inputValue)) {
    return undefined;
  }
  assertAllowed(body, EXTENDED_RESPONSES_KEYS, "REQ-R-EXT-TOP");
  if (single(body, "text", "REQ-R-EXT-TEXT") !== undefined || single(body, "response_format", "REQ-R-EXT-FORMAT") !== undefined) {
    unsupported("REQ-R-EXT-FORMAT");
  }
  const state: MutableState = {
    bindings: [],
    bySourceKey: new Map(),
    byChatName: new Map(),
    tools: [],
    calls: [],
    results: [],
  };
  const tools = requiredArray(toolsValue, "REQ-R-EXT-TOOLS");
  for (const tool of tools.items) {
    addDeclaration(state, tool);
  }
  collectDiscoveredDeclarations(state, inputValue);
  validateInstructionOrdering(inputValue);
  const chatMessages = projectExtendedChatMessages(body, state);
  const transformedInput = transformInput(state, inputValue);
  const transformedChoice = transformToolChoice(state, single(body, "tool_choice", "REQ-R-EXT-CHOICE"));
  const prefixMembers = body.members
    .filter((member) => member.key === "n" || member.key === "parallel_tool_calls" || member.key === "stream")
    .map((member) => Object.freeze({ key: member.key, value: immutableWire(member.value) }));
  const streamOptions = single(body, "stream_options", "REQ-R-EXT-STREAM-OPTIONS");
  if (streamOptions !== undefined) {
    prefixMembers.push(Object.freeze({ key: "stream_options", value: immutableWire(streamOptions) }));
  }
  const ledger: ResponsesToolBindingLedger = Object.freeze({
    kind: "responses_extended_tools",
    bindings: Object.freeze(state.bindings.map((binding) => Object.freeze({ ...binding }))),
    calls: Object.freeze(state.calls.map((binding) => Object.freeze({ ...binding }))),
    results: Object.freeze(state.results.map((binding) => Object.freeze({ ...binding }))),
    chatMessages: Object.freeze(chatMessages.map((message) => immutableWire(message) as WireJsonObject)),
    chatPrefixMembers: Object.freeze(prefixMembers),
  });
  return {
    body: Object.freeze({
      kind: "object",
      members: body.members.map((member) => {
        if (member.key === "tools") {
          return { key: member.key, value: array(state.tools) };
        }
        if (member.key === "input") {
          return { key: member.key, value: transformedInput };
        }
        if (member.key === "tool_choice") {
          return { key: member.key, value: transformedChoice as WireJson };
        }
        return member;
      }),
    }),
    ledger,
    chatTools: Object.freeze(state.tools.map((tool) => {
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
    })),
  };
}

export interface CompatibilityResponsesToolBinding {
  readonly kind: ResponsesToolSourceBinding["kind"];
  readonly originalName: string;
  readonly namespace?: string;
}

export function restoredResponsesToolNameForCompatibility(
  binding: CompatibilityResponsesToolBinding | undefined,
  chatName: string,
): string {
  if (binding?.kind === "namespace") {
    return binding.originalName;
  }
  if (binding?.kind === "tool_search") {
    return "tool_search";
  }
  return binding?.originalName ?? chatName;
}

export function projectRestoredResponsesToolCallForCompatibility(
  binding: CompatibilityResponsesToolBinding,
  callId: string,
  argumentsJson: string,
  itemStatus: string,
  responseStatus: "completed" | "incomplete",
  includeToolSearchItemId = false,
): WireJsonObject | undefined {
  if (binding.kind === "function") {
    return undefined;
  }
  if (binding.kind === "namespace") {
    return object([
      ["type", "function_call"],
      ["id", callId],
      ["call_id", callId],
      ["name", binding.originalName],
      ...(binding.namespace === undefined ? [] : [["namespace", binding.namespace] as const]),
      ["arguments", argumentsJson],
      ["status", itemStatus],
    ]);
  }
  const restored = includeToolSearchItemId && itemStatus === "in_progress"
    ? {}
    : restoreResponsesExtendedToolArguments(binding.kind, argumentsJson, responseStatus);
  if (binding.kind === "custom") {
    return object([
      ["type", "custom_tool_call"],
      ["id", callId],
      ["call_id", callId],
      ["name", binding.originalName],
      ...(includeToolSearchItemId
        ? [["input", restored.rawCustomInput ?? ""] as const, ["status", itemStatus] as const]
        : [["status", itemStatus] as const, ["input", restored.rawCustomInput ?? ""] as const]),
    ]);
  }
  return object([
    ["type", "tool_search_call"],
    ...(includeToolSearchItemId ? [["id", callId] as const] : []),
    ["call_id", callId],
    ["status", itemStatus],
    ["execution", "client"],
    ["arguments", restored.toolSearchArguments ?? object([])],
  ]);
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

export function projectResponsesMessagesForCompatibility(body: WireJsonObject): readonly WireJsonObject[] {
  const projection = projectResponsesToolsForCompatibility(body);
  const bySource = new Map(projection.bindings.map((binding) => [sourceKey(binding.namespace, binding.sourceName), binding.chatName]));
  return projectResponsesMessages(body, (namespace, name) => bySource.get(sourceKey(namespace, name)));
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
      const callId = compatibilityString(item, "call_id")?.trim()
        || compatibilityString(item, "id")?.trim()
        || "";
      if (content !== undefined) {
        state.output.push(toolMessage(callId, content));
      }
      if (extracted.media.length > 0) {
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
    return { value: "[cc-switch: tool result media moved to the following user message]", media: [media] };
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
    object([["type", "text"], ["text", `[cc-switch: media output of tool call ${callId}]`]]),
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
    isWireJsonObject(tool) && single(tool, "type", "REQ-R-EXT-TOOL-TYPE") !== "function"
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

function addDeclaration(state: MutableState, value: WireJson, namespace?: string): void {
  const tool = requiredObject(value, "REQ-R-EXT-TOOL");
  const type = requiredString(single(tool, "type", "REQ-R-EXT-TOOL-TYPE"), "REQ-R-EXT-TOOL-TYPE");
  if (type === "function") {
    addFunction(state, tool, namespace);
    return;
  }
  if (namespace !== undefined) {
    unsupported("REQ-R-EXT-NAMESPACE-CHILD");
  }
  if (type === "custom") {
    addCustom(state, tool);
    return;
  }
  if (type === "namespace") {
    addNamespace(state, tool);
    return;
  }
  if (type === "tool_search") {
    assertAllowed(tool, new Set(["type"]), "REQ-R-EXT-SEARCH");
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
    return;
  }
  unsupported("REQ-R-EXT-TOOL-TYPE");
}

function addFunction(state: MutableState, tool: WireJsonObject, namespace?: string): void {
  assertAllowed(tool, new Set(["type", "function", "name", "description", "parameters", "strict"]), "REQ-R-EXT-FUNCTION");
  const nested = single(tool, "function", "REQ-R-EXT-FUNCTION-SHAPE");
  const shape = nested === undefined ? tool : requiredObject(nested, "REQ-R-EXT-FUNCTION-SHAPE");
  if (nested !== undefined) {
    assertAllowed(shape, new Set(["name", "description", "parameters", "strict"]), "REQ-R-EXT-FUNCTION-SHAPE");
  }
  const sourceName = toolName(shape, "REQ-R-EXT-FUNCTION-NAME");
  const description = optionalString(single(shape, "description", "REQ-R-EXT-FUNCTION-DESCRIPTION"), "REQ-R-EXT-FUNCTION-DESCRIPTION");
  const parameters = requiredObject(single(shape, "parameters", "REQ-R-EXT-FUNCTION-SCHEMA"), "REQ-R-EXT-FUNCTION-SCHEMA");
  if (single(parameters, "type", "REQ-R-EXT-FUNCTION-SCHEMA-TYPE") !== "object") {
    invalid("REQ-R-EXT-FUNCTION-SCHEMA");
  }
  const strictValue = single(shape, "strict", "REQ-R-EXT-FUNCTION-STRICT");
  if (strictValue !== undefined && typeof strictValue !== "boolean") {
    invalid("REQ-R-EXT-FUNCTION-STRICT");
  }
  if (strictValue === undefined && !isOpenAiStrictSchemaCompatible(parameters)) {
    unsupported("REQ-R-EXT-FUNCTION-STRICT-AUTO");
  }
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
    ["parameters", normalizedParameters(parameters)],
    ["strict", strictValue ?? true],
  ]));
}

function addCustom(state: MutableState, tool: WireJsonObject): void {
  assertAllowed(tool, new Set(["type", "name", "description", "format"]), "REQ-R-EXT-CUSTOM");
  const name = toolName(tool, "REQ-R-EXT-CUSTOM-NAME");
  optionalString(single(tool, "description", "REQ-R-EXT-CUSTOM-DESCRIPTION"), "REQ-R-EXT-CUSTOM-DESCRIPTION");
  const format = single(tool, "format", "REQ-R-EXT-CUSTOM-FORMAT");
  if (format !== undefined) {
    const objectValue = requiredObject(format, "REQ-R-EXT-CUSTOM-FORMAT");
    assertAllowed(objectValue, new Set(["type"]), "REQ-R-EXT-CUSTOM-FORMAT");
    if (single(objectValue, "type", "REQ-R-EXT-CUSTOM-FORMAT-TYPE") !== "text") {
      unsupported("REQ-R-EXT-CUSTOM-FORMAT-TYPE");
    }
  }
  addBinding(state, { kind: "custom", chatName: name, sourceName: name }, object([
    ["type", "function"],
    ["name", name],
    ["description", `Original tool definition:\n\`\`\`json\n${canonicalString(tool)}\n\`\`\``],
    ["parameters", CUSTOM_INPUT_SCHEMA],
    ["strict", false],
  ]));
}

function addNamespace(state: MutableState, tool: WireJsonObject): void {
  assertAllowed(tool, new Set(["type", "name", "description", "tools", "children"]), "REQ-R-EXT-NAMESPACE");
  const namespace = toolName(tool, "REQ-R-EXT-NAMESPACE-NAME");
  optionalString(single(tool, "description", "REQ-R-EXT-NAMESPACE-DESCRIPTION"), "REQ-R-EXT-NAMESPACE-DESCRIPTION");
  const tools = single(tool, "tools", "REQ-R-EXT-NAMESPACE-TOOLS");
  const children = single(tool, "children", "REQ-R-EXT-NAMESPACE-CHILDREN");
  if ((tools === undefined) === (children === undefined)) {
    invalid("REQ-R-EXT-NAMESPACE-CHILDREN");
  }
  const values = requiredArray(tools ?? children, "REQ-R-EXT-NAMESPACE-CHILDREN");
  if (values.items.length === 0) {
    invalid("REQ-R-EXT-NAMESPACE-CHILDREN");
  }
  for (const child of values.items) {
    addDeclaration(state, child, namespace);
  }
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
    assertAllowed(item, new Set(["type", "id", "call_id", "output", "status", "tools"]), "REQ-R-EXT-SEARCH-OUTPUT");
    const tools = requiredArray(single(item, "tools", "REQ-R-EXT-SEARCH-OUTPUT-TOOLS"), "REQ-R-EXT-SEARCH-OUTPUT-TOOLS");
    for (const tool of tools.items) {
      addDeclaration(state, tool);
    }
  }
}

function transformInput(state: MutableState, input: WireJson | undefined): WireJson {
  if (!isWireJsonArray(input)) {
    return input ?? array([]);
  }
  const calls = new Map<string, ResponsesToolSourceBinding>();
  const results = new Set<string>();
  const output: WireJson[] = [];
  for (const value of input.items) {
    if (!isWireJsonObject(value)) {
      output.push(value);
      continue;
    }
    const type = single(value, "type", "REQ-R-EXT-ITEM-TYPE");
    if (type === "custom_tool_call") {
      assertAllowed(value, new Set(["type", "id", "call_id", "name", "input", "status"]), "REQ-R-EXT-CUSTOM-CALL");
      const binding = requiredBinding(state, undefined, requiredString(single(value, "name", "REQ-R-EXT-CUSTOM-CALL-NAME"), "REQ-R-EXT-CUSTOM-CALL-NAME"), "custom");
      const callId = registerCall(calls, value, binding);
      const rawInput = requiredString(single(value, "input", "REQ-R-EXT-CUSTOM-CALL-INPUT"), "REQ-R-EXT-CUSTOM-CALL-INPUT", true);
      state.calls.push(callBinding(value, callId, binding, { rawCustomInput: rawInput }));
      output.push(object([
        ["type", "function_call"],
        ...optionalCopied(value, ["id"]),
        ["call_id", callId],
        ["name", binding.chatName],
        ["arguments", canonicalString(object([["input", rawInput]]))],
        ...optionalCopied(value, ["status"]),
      ]));
      continue;
    }
    if (type === "tool_search_call") {
      assertAllowed(value, new Set(["type", "id", "call_id", "arguments", "status", "execution"]), "REQ-R-EXT-SEARCH-CALL");
      const binding = requiredBinding(state, undefined, "tool_search", "tool_search");
      const callId = registerCall(calls, value, binding);
      const argumentsValue = requiredObject(single(value, "arguments", "REQ-R-EXT-SEARCH-CALL-ARGS"), "REQ-R-EXT-SEARCH-CALL-ARGS");
      state.calls.push(callBinding(value, callId, binding, { toolSearchArguments: immutableWire(argumentsValue) as WireJsonObject }));
      output.push(object([
        ["type", "function_call"],
        ...optionalCopied(value, ["id"]),
        ["call_id", callId],
        ["name", binding.chatName],
        ["arguments", canonicalString(argumentsValue)],
        ...optionalCopied(value, ["status"]),
      ]));
      continue;
    }
    if (type === "function_call") {
      assertAllowed(value, new Set(["type", "id", "call_id", "name", "namespace", "arguments", "status"]), "REQ-R-EXT-FUNCTION-CALL");
      const name = requiredString(single(value, "name", "REQ-R-EXT-FUNCTION-CALL-NAME"), "REQ-R-EXT-FUNCTION-CALL-NAME");
      const namespace = optionalString(single(value, "namespace", "REQ-R-EXT-FUNCTION-CALL-NS"), "REQ-R-EXT-FUNCTION-CALL-NS");
      const binding = requiredBinding(state, namespace, name);
      if (binding.kind !== "function" && binding.kind !== "namespace") {
        invalid("REQ-R-EXT-FUNCTION-CALL-BINDING");
      }
      const callId = registerCall(calls, value, binding);
      const argumentsText = requiredString(single(value, "arguments", "REQ-R-EXT-FUNCTION-CALL-ARGS"), "REQ-R-EXT-FUNCTION-CALL-ARGS", true);
      const parsedArguments = parseArguments(argumentsText, "REQ-R-EXT-FUNCTION-CALL-ARGS");
      state.calls.push(callBinding(value, callId, binding));
      output.push(object([
        ["type", "function_call"],
        ...optionalCopied(value, ["id"]),
        ["call_id", callId],
        ["name", binding.chatName],
        ["arguments", canonicalString(parsedArguments)],
        ...optionalCopied(value, ["status"]),
      ]));
      continue;
    }
    if (type === "custom_tool_call_output" || type === "tool_search_output" || type === "function_call_output") {
      const allowed = type === "function_call_output"
        ? new Set(["type", "id", "call_id", "output", "status"])
        : new Set(["type", "id", "call_id", "output", "status", "tools"]);
      assertAllowed(value, allowed, "REQ-R-EXT-RESULT");
      const callId = requiredString(single(value, "call_id", "REQ-R-EXT-RESULT-ID"), "REQ-R-EXT-RESULT-ID");
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
      const status = requestResultStatus(single(value, "status", "REQ-R-EXT-RESULT-STATUS"));
      state.results.push(Object.freeze({
        kind: binding.kind,
        callId,
        ...optionalItemId(value),
        ...(status === undefined ? {} : { status }),
      }));
      results.add(callId);
      output.push(object([
        ["type", "function_call_output"],
        ...optionalCopied(value, ["id"]),
        ["call_id", callId],
        ["output", type === "function_call_output" ? canonicalResult(resultValue) : canonicalString(value)],
        ...optionalCopied(value, ["status"]),
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

function transformToolChoice(state: MutableState, value: WireJson | undefined): WireJson | undefined {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  const choice = requiredObject(value, "REQ-R-EXT-CHOICE");
  assertAllowed(choice, new Set(["type", "name", "namespace"]), "REQ-R-EXT-CHOICE");
  const type = requiredString(single(choice, "type", "REQ-R-EXT-CHOICE-TYPE"), "REQ-R-EXT-CHOICE-TYPE");
  if (type !== "function" && type !== "custom" && type !== "tool_search") {
    invalid("REQ-R-EXT-CHOICE-TYPE");
  }
  const name = requiredString(single(choice, "name", "REQ-R-EXT-CHOICE-NAME"), "REQ-R-EXT-CHOICE-NAME");
  const namespace = optionalString(single(choice, "namespace", "REQ-R-EXT-CHOICE-NS"), "REQ-R-EXT-CHOICE-NS");
  const binding = requiredBinding(state, namespace, name);
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
  value: WireJsonObject,
  callId: string,
  binding: ResponsesToolSourceBinding,
  extended: Pick<ResponsesToolCallBinding, "rawCustomInput" | "toolSearchArguments"> = {},
): ResponsesToolCallBinding {
  const status = requestCallStatus(single(value, "status", "REQ-R-EXT-CALL-STATUS"));
  return Object.freeze({
    ...binding,
    callId,
    ...optionalItemId(value),
    ...(status === undefined ? {} : { status }),
    ...extended,
  });
}

function optionalItemId(value: WireJsonObject): { readonly itemId?: string } {
  const itemId = optionalString(single(value, "id", "REQ-R-EXT-ITEM-ID"), "REQ-R-EXT-ITEM-ID");
  return itemId === undefined ? {} : { itemId };
}

function requestCallStatus(value: WireJson | undefined): ResponsesToolCallBinding["status"] {
  if (value === undefined || value === "completed" || value === "incomplete" || value === "in_progress") {
    return value;
  }
  invalid("REQ-R-EXT-STATUS");
}

function requestResultStatus(value: WireJson | undefined): ResponsesToolResultBinding["status"] {
  if (value === undefined || value === "completed" || value === "incomplete" || value === "in_progress" || value === "failed") {
    return value;
  }
  invalid("REQ-R-EXT-STATUS");
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

function assertAllowed(value: WireJsonObject, allowed: ReadonlySet<string>, ruleId: string): void {
  const duplicates = value.members.some((member, index) => value.members.findIndex((other) => other.key === member.key) !== index);
  if (duplicates) {
    invalid(ruleId);
  }
  if (value.members.some((member) => !allowed.has(member.key))) {
    unsupported(ruleId);
  }
}

function single(value: WireJsonObject, key: string, ruleId: string): WireJson | undefined {
  const values = memberValues(value, key);
  if (values.length > 1) {
    invalid(ruleId);
  }
  return values[0];
}

function requiredObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) {
    invalid(ruleId);
  }
  assertAllowed(value, new Set(value.members.map((member) => member.key)), ruleId);
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

function optionalString(value: WireJson | undefined, ruleId: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, ruleId);
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
  return `[cc-switch:tool-result-error]${content.length === 0 ? "" : `\n${content}`}`;
}

export function projectResponsesToolChoiceForCompatibility(
  value: WireJson | undefined,
  chatNameForSource: (namespace: string | undefined, name: string) => string | undefined,
  target: "chat" | "responses" = "chat",
): WireJson | undefined {
  if (!isWireJsonObject(value)) {
    return value;
  }
  const type = compatibilityString(value, "type");
  if (type === "function") {
    const sourceName = compatibilityString(value, "name") ?? "";
    if (target === "responses") {
      return object([["type", "function"], ["name", sourceName]]);
    }
    const chatName = chatNameForSource(compatibilityString(value, "namespace"), sourceName) ?? sourceName;
    return object([["type", "function"], ["function", object([["name", chatName]])]]);
  }
  if (type === "tool_search") {
    return target === "responses"
      ? object([["type", "tool_search"]])
      : object([["type", "function"], ["function", object([["name", "tool_search"]])]]);
  }
  if (type === "custom") {
    const name = compatibilityString(value, "name") ?? "";
    return target === "responses"
      ? object([["type", "custom"], ["name", name]])
      : object([["type", "function"], ["function", object([["name", name]])]]);
  }
  return value;
}

export function projectResponsesToolCallForCompatibility(
  item: WireJsonObject,
  chatNameForSource: (namespace: string | undefined, name: string) => string | undefined,
): WireJsonObject | undefined {
  const type = compatibilityString(item, "type");
  const callId = compatibilityString(item, "call_id")?.trim()
    || compatibilityString(item, "id")?.trim()
    || "";
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

export function projectResponsesToolsForCompatibility(body: WireJsonObject): ResponsesToolCompatibilityProjection {
  const chatTools: WireJsonObject[] = [];
  const bindings: ResponsesToolSourceBinding[] = [];
  const byChatName = new Set<string>();
  const add = (binding: ResponsesToolSourceBinding, tool: WireJsonObject): void => {
    if (byChatName.has(binding.chatName)) {
      return;
    }
    byChatName.add(binding.chatName);
    bindings.push(binding);
    chatTools.push(tool);
  };
  const addTool = (value: WireJson, namespace?: string): void => {
    if (typeof value === "string") {
      addCompatibilityCustom(value, value, add);
      return;
    }
    if (!isWireJsonObject(value)) {
      return;
    }
    const type = memberValues(value, "type")[0];
    const nested = memberValues(value, "function")[0];
    if (type === "function" || (type === undefined && (isWireJsonObject(nested) || memberValues(value, "name")[0] !== undefined))) {
      const shape = isWireJsonObject(nested) ? nested : value;
      const sourceName = compatibilityString(shape, "name")?.trim() ?? "";
      if (sourceName.length === 0) {
        return;
      }
      const chatName = namespace === undefined ? sourceName : projectedNamespaceName(namespace, sourceName);
      const parametersValue = memberValues(shape, "parameters")[0];
      const parameters = isWireJsonObject(parametersValue)
        ? normalizedParameters(parametersValue)
        : object([["type", "object"], ["properties", object([])]]);
      const strictValue = memberValues(shape, "strict")[0] ?? memberValues(value, "strict")[0];
      const functionMembers: Array<readonly [string, WireJson]> = [
        ["name", chatName],
        ["description", memberValues(shape, "description")[0] ?? null],
        ["parameters", parameters],
      ];
      if (strictValue === true || strictValue === false) {
        functionMembers.push(["strict", strictValue]);
      } else if (isOpenAiStrictSchemaCompatible(parameters)) {
        functionMembers.push(["strict", true]);
      }
      add({
        kind: namespace === undefined ? "function" : "namespace",
        chatName,
        sourceName,
        ...(namespace === undefined ? {} : { namespace }),
      }, object([["type", "function"], ["function", object(functionMembers)]]));
      return;
    }
    if (type === "namespace") {
      const namespaceName = compatibilityString(value, "name") ?? "";
      const children = memberValues(value, "tools")[0] ?? memberValues(value, "children")[0];
      if (isWireJsonArray(children)) {
        for (const child of children.items) {
          if (isWireJsonObject(child) && memberValues(child, "type")[0] === "function") {
            addTool(child, namespaceName);
          }
        }
      }
      return;
    }
    if (type === "custom") {
      const name = compatibilityString(value, "name")?.trim() ?? "";
      addCompatibilityCustom(name, value, add);
      return;
    }
    if (type === "tool_search") {
      add({ kind: "tool_search", chatName: "tool_search", sourceName: "tool_search" }, object([
        ["type", "function"],
        ["function", object([
          ["name", "tool_search"],
          ["description", TOOL_SEARCH_DESCRIPTION],
          ["parameters", TOOL_SEARCH_SCHEMA],
        ])],
      ]));
    }
  };
  const declared = memberValues(body, "tools")[0];
  if (isWireJsonArray(declared)) {
    for (const tool of declared.items) {
      addTool(tool);
    }
  }
  collectCompatibilityDiscovered(memberValues(body, "input")[0], addTool);
  return { chatTools, bindings };
}

function addCompatibilityCustom(
  name: string,
  original: WireJson,
  add: (binding: ResponsesToolSourceBinding, tool: WireJsonObject) => void,
): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return;
  }
  add({ kind: "custom", chatName: trimmed, sourceName: trimmed }, object([
    ["type", "function"],
    ["function", object([
      ["name", trimmed],
      ["description", `Original tool definition:\n\`\`\`json\n${canonicalString(original)}\n\`\`\``],
      ["parameters", CUSTOM_INPUT_SCHEMA],
    ])],
  ]));
}

function collectCompatibilityDiscovered(
  value: WireJson | undefined,
  addTool: (value: WireJson, namespace?: string) => void,
  depth = 0,
): void {
  if (value === undefined || depth > 32) {
    return;
  }
  if (isWireJsonArray(value)) {
    for (const item of value.items) {
      collectCompatibilityDiscovered(item, addTool, depth + 1);
    }
    return;
  }
  if (!isWireJsonObject(value)) {
    return;
  }
  if (memberValues(value, "type")[0] === "tool_search_output") {
    const tools = memberValues(value, "tools")[0];
    if (isWireJsonArray(tools)) {
      for (const tool of tools.items) {
        addTool(tool);
      }
    }
  }
  for (const member of value.members) {
    collectCompatibilityDiscovered(member.value, addTool, depth + 1);
  }
}

function compatibilityString(value: WireJsonObject, key: string): string | undefined {
  const member = memberValues(value, key)[0];
  return typeof member === "string" ? member : undefined;
}

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}
