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
    if (binding.kind === "custom") {
      let rawCustomInput: string;
      if (response.status === "incomplete") {
        try {
          const parsed = parseUpstreamArguments(item.argumentsJson);
          const inputs = memberValues(parsed, "input");
          rawCustomInput = inputs.length === 1 && typeof inputs[0] === "string"
            && parsed.members.every((member) => member.key === "input")
            ? inputs[0]
            : item.argumentsJson;
        } catch {
          rawCustomInput = item.argumentsJson;
        }
      } else {
        const parsed = parseUpstreamArguments(item.argumentsJson);
        const inputs = memberValues(parsed, "input");
        if (inputs.length !== 1 || typeof inputs[0] !== "string" || parsed.members.some((member) => member.key !== "input")) {
          invalidToolArguments();
        }
        rawCustomInput = inputs[0];
      }
      return {
        ...item,
        sourceKind: "custom",
        sourceName: binding.sourceName,
        rawCustomInput,
      };
    }
    if (binding.kind === "tool_search") {
      return {
        ...item,
        sourceKind: "tool_search",
        sourceName: binding.sourceName,
        toolSearchArguments: parseUpstreamArguments(item.argumentsJson),
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
    return false;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("data:image/")) {
      return true;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const bytes = new TextEncoder().encode(trimmed);
        return containsMedia(parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 }), depth + 1);
      } catch {
        return false;
      }
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

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}
