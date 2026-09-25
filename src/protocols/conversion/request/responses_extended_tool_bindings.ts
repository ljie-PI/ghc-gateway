import { isWireJsonArray, isWireJsonObject, parseWireJson, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { TOOL_RESULT_MEDIA_REPLACEMENT } from "../compatibility_markers.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { type ResponsesToolCallBinding, type ResponsesToolResultBinding, type ResponsesToolSourceBinding } from "../types.js";
import { invalid } from "../wire.js";
import { array, canonicalString, immutableWire, looksLikeNestedJson, type MutableState, object, optionalExtendedString, projectExtended, replaceMember, requiredObject, requiredString, single, sourceKey } from "./responses_extended_tool_shared.js";

export function transformInput(state: MutableState, input: WireJson | undefined): WireJson {
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
      const hasMedia = containsMedia(resultValue);
      if (hasMedia) {
        if (
          containsReasoningCarrier(resultValue)
          || containsNestedJsonReasoningCarrier(resultValue)
        ) invalid("REQ-R-EXT-RESULT-MEDIA");
        state.degradations.add("request.option_omitted");
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
        ["output", hasMedia ? TOOL_RESULT_MEDIA_REPLACEMENT
          : type === "function_call_output" ? canonicalResult(resultValue) : canonicalString(sanitized)],
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

function containsNestedJsonReasoningCarrier(value: WireJson, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!looksLikeNestedJson(trimmed)) return false;
    try {
      const bytes = new TextEncoder().encode(trimmed);
      const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 });
      return containsReasoningCarrier(parsed) || containsNestedJsonReasoningCarrier(parsed, depth + 1);
    } catch {
      return false;
    }
  }
  if (isWireJsonArray(value)) {
    return value.items.some((item) => containsNestedJsonReasoningCarrier(item, depth + 1));
  }
  return isWireJsonObject(value)
    && value.members.some((member) => containsNestedJsonReasoningCarrier(member.value, depth + 1));
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

function parseArguments(value: string, ruleId: string): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(value);
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 });
    return requiredObject(parsed, ruleId);
  } catch {
    invalid(ruleId);
  }
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
