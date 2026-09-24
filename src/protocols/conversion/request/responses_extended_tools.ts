import { isWireJsonArray, isWireJsonObject, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { isOpenaiStrictSchemaCompatible } from "../strict_schema.js";
import { type ConversionDegradationRule, type ResponsesToolBindingLedger, type ResponsesToolSourceBinding } from "../types.js";
import { invalid, unsupported } from "../wire.js";
import { transformInput, validateInstructionOrdering } from "./responses_extended_tool_bindings.js";
import { projectExtendedChatMessages } from "./responses_extended_tool_history.js";
import { array, canonicalString, immutableWire, looseObject, type MutableState, object, omitMalformedExtended, optionalCopied, optionalExtendedObject, optionalExtendedString, projectExtended, removeMember, replaceMember, requiredArray, requiredString, single, sourceKey } from "./responses_extended_tool_shared.js";
import { createHash } from "node:crypto";

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
