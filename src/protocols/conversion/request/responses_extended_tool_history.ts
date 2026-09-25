import { GatewayFailureError } from "../../../gateway/failures.js";
import { isWireJsonArray, isWireJsonObject, memberValues, parseWireJson, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { TOOL_RESULT_ERROR_MARKER, TOOL_RESULT_MEDIA_REPLACEMENT, toolResultMediaReference } from "../compatibility_markers.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { type ConversionDegradationRecorder } from "../degradations.js";
import { type ConversionDegradationRule, type ResponsesToolBindingLedger, type ResponsesToolSourceBinding, type SemanticResponse, type SemanticResponseItem } from "../types.js";
import { invalid } from "../wire.js";
import { array, canonicalString, looksLikeNestedJson, type MutableState, object, single, sourceKey } from "./responses_extended_tool_shared.js";

export interface RestoredExtendedToolArguments {
  readonly rawCustomInput?: string;
  readonly toolSearchArguments?: WireJsonObject;
  readonly degraded: boolean;
}

export function restoreResponsesExtendedToolArguments(
  kind: ResponsesToolSourceBinding["kind"],
  argumentsJson: string,
): RestoredExtendedToolArguments {
  if (kind === "custom") {
    if (argumentsJson.trim().length === 0) {
      return { rawCustomInput: "", degraded: false };
    }
    try {
      const parsed = parseUpstreamArguments(argumentsJson);
      const inputs = memberValues(parsed, "input");
      if (
        inputs.length === 1
        && typeof inputs[0] === "string"
      ) {
        return { rawCustomInput: inputs[0], degraded: false };
      }
    } catch {
      // Preserve the upstream argument text when it is not the synthetic custom-tool wrapper.
    }
    return { rawCustomInput: argumentsJson, degraded: true };
  }
  if (kind === "tool_search") {
    if (argumentsJson.trim().length === 0) {
      return { toolSearchArguments: object([]), degraded: false };
    }
    try {
      return { toolSearchArguments: parseUpstreamArguments(argumentsJson), degraded: false };
    } catch {
      return { toolSearchArguments: object([["query", argumentsJson]]), degraded: true };
    }
  }
  return { degraded: false };
}

export function restoreResponsesExtendedTools(
  response: Readonly<SemanticResponse>,
  ledger: Readonly<ResponsesToolBindingLedger>,
  degradations?: ConversionDegradationRecorder,
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
    if (matches.length === 0) {
      return { ...item, sourceKind: "function", sourceName: item.name };
    }
    if (matches.length > 1) {
      invalidUpstream();
    }
    const binding = matches[0] as ResponsesToolSourceBinding;
    if (binding.kind === "custom" || binding.kind === "tool_search") {
      const restored = restoreResponsesExtendedToolArguments(binding.kind, item.argumentsJson);
      if (restored.degraded) degradations?.add("request.option_omitted");
      return {
        ...item,
        sourceKind: binding.kind,
        sourceName: binding.sourceName,
        ...(restored.rawCustomInput === undefined ? {} : { rawCustomInput: restored.rawCustomInput }),
        ...(restored.toolSearchArguments === undefined ? {} : { toolSearchArguments: restored.toolSearchArguments }),
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

export function projectExtendedChatMessages(body: WireJsonObject, state: MutableState): WireJsonObject[] {
  const resultKinds = new Map(state.results.map((result) => [result.callId, result.kind]));
  return projectResponsesMessages(
    body,
    (namespace, name) => state.bySourceKey.get(sourceKey(namespace, name))?.chatName,
    (callId) => resultKinds.get(callId),
    state.degradations,
  );
}

function projectResponsesMessages(
  body: WireJsonObject,
  resolveChatName: (namespace: string | undefined, name: string) => string | undefined,
  resolveResultKind: (callId: string) => ResponsesToolSourceBinding["kind"] | undefined,
  degradations: Set<ConversionDegradationRule>,
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
    projectExtendedInputItems(items, messageState, resolveChatName, resolveResultKind, degradations);
  }
  flushPendingReasoning(messageState);
  return mergeSystemMessages(messageState.output);
}

function projectExtendedInputItems(
  items: readonly WireJson[],
  state: ExtendedMessageState,
  resolveChatName: (namespace: string | undefined, name: string) => string | undefined,
  resolveResultKind: (callId: string) => ResponsesToolSourceBinding["kind"] | undefined,
  degradations: Set<ConversionDegradationRule>,
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
      const callId = compatibilityCallId(item);
      const content = isWireJsonObject(extracted.value)
        ? projectResponsesToolResultContentForCompatibility(
          extracted.value,
          callId === undefined ? undefined : resolveResultKind(callId),
        )
        : undefined;
      if (content !== undefined && callId !== undefined) {
        state.output.push(toolMessage(callId, content));
      }
      if (extracted.media.length > 0 && callId !== undefined) {
        state.output.push(compatibilityMediaMessage(callId, extracted.media));
      }
      continue;
    }
    const message = projectExtendedMessage(item, degradations);
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

function projectExtendedMessage(
  item: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): WireJsonObject | undefined {
  const type = single(item, "type", "REQ-R-EXT-ITEM-TYPE");
  if (type !== undefined && type !== "message") {
    return undefined;
  }
  const role = projectedChatRole(item);
  const content = single(item, "content", "REQ-R-EXT-MESSAGE-CONTENT");
  if (isWireJsonArray(content)) {
    const parts = content.items
      .map((value) => {
        const part = projectExtendedContentPart(value);
        if (role === "system" && part === undefined) {
          if (containsReasoningCarrier(value)) invalid("REQ-R-EXT-MESSAGE-CONTENT");
          degradations.add("responses.extensions_omitted");
        }
        return part;
      })
      .filter((part): part is WireJsonObject => part !== undefined);
    if (role === "system") {
      const text = parts.flatMap((part) => {
        if (single(part, "type", "REQ-R-EXT-CONTENT-TYPE") !== "text") {
          degradations.add("responses.extensions_omitted");
          return [];
        }
        const value = single(part, "text", "REQ-R-EXT-CONTENT-TEXT");
        return typeof value === "string" && value.length > 0 ? [value] : [];
      });
      if (parts.length !== text.length) degradations.add("responses.extensions_omitted");
      return text.length === 0 ? undefined : chatMessage("system", text.join("\n\n"));
    }
    return chatMessage(role, chatContentFromParts(parts));
  }
  if (role === "system" && typeof content !== "string") {
    if (content !== undefined && containsReasoningCarrier(content)) invalid("REQ-R-EXT-MESSAGE-CONTENT");
    if (content !== undefined) degradations.add("responses.extensions_omitted");
    return undefined;
  }
  return chatMessage(role, content ?? null);
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

export function projectResponsesToolResultContentForCompatibility(
  item: WireJsonObject,
  sourceKind?: ResponsesToolSourceBinding["kind"],
): string | undefined {
  const type = compatibilityString(item, "type");
  let content: string;
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const value = memberValues(item, "output")[0];
    content = typeof value === "string"
      ? type === "custom_tool_call_output" || sourceKind === "custom" ? value : canonicalJsonStringOrOriginal(value)
      : value === undefined ? "" : canonicalString(value);
  } else if (type === "tool_search_output") {
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
