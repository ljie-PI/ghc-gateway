import { isWireJsonObject, parseWireJson, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { projectToolRequest } from "../request_projection.js";
import { cleanChatToolSchema, isOpenaiStrictSchemaCompatible } from "../strict_schema.js";
import { ConversionContractError, type ConversionDegradationRule, type SemanticRequestItem, type SemanticTool, type SemanticToolChoice, type SemanticToolResultItem } from "../types.js";
import { invalid, jsonObjectString, oneMember, optionalBoolean, optionalString, requiredObject, requiredString, wireObject } from "../wire.js";
import { decodeToolResultContent } from "./content.js";
import { MESSAGES_SENSITIVE_EXTENSION_FIELDS, optionalChoiceString, optionalDiscriminator, optionalProtocolArray, optionalProtocolObject, projectMessagesMembers, projectRequestMembers, requestObject, TOOL_SENSITIVE_EXTENSION_FIELDS, validateCacheControl } from "./projection.js";

export function decodeChatToolCall(value: WireJson, degradations?: Set<ConversionDegradationRule>) {
  const projection = degradations ?? new Set<ConversionDegradationRule>();
  if (!isWireJsonObject(value)) {
    if (containsReasoningCarrier(value)) invalid("REQ-C-TOOL-CALL");
    projection.add("chat.extensions_omitted");
    return undefined;
  }
  const call = projectRequestMembers(
    value,
    new Set(["id", "type", "function", "index"]),
    "REQ-C-TOOL-CALL",
    "chat.extensions_omitted",
    projection,
    TOOL_SENSITIVE_EXTENSION_FIELDS,
  );
  const type = optionalDiscriminator(
    oneMember(call, "type", "REQ-C-TOOL-CALL-TYPE"),
    "REQ-C-TOOL-CALL-TYPE",
    projection,
  );
  if (type === undefined) return undefined;
  if (type !== "function") {
    projection.add("chat.extensions_omitted");
    return undefined;
  }
  const fn = projectRequestMembers(
    requestObject(oneMember(call, "function", "REQ-C-TOOL-CALL-FUNCTION"), "REQ-C-TOOL-CALL-FUNCTION"),
    new Set(["name", "arguments"]),
    "REQ-C-TOOL-CALL-FUNCTION",
    "chat.extensions_omitted",
    projection,
    TOOL_SENSITIVE_EXTENSION_FIELDS,
  );
  const argumentsJson = requiredString(
    oneMember(fn, "arguments", "REQ-C-TOOL-CALL-ARGS"),
    "REQ-C-TOOL-CALL-ARGS",
    true,
  );
  validateArgumentsJson(argumentsJson, "REQ-C-TOOL-CALL-ARGS");
  if (oneMember(call, "index", "REQ-C-TOOL-CALL-INDEX") !== undefined) {
    projection.add("request.option_omitted");
  }
  return {
    type: "tool_call",
    callId: requiredString(oneMember(call, "id", "REQ-C-TOOL-CALL-ID"), "REQ-C-TOOL-CALL-ID"),
    name: requiredString(oneMember(fn, "name", "REQ-C-TOOL-CALL-NAME"), "REQ-C-TOOL-CALL-NAME"),
    argumentsJson,
  } as const;
}

export function decodeMessagesToolUse(
  value: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
) {
  value = projectMessagesMembers(
    value,
    new Set(["type", "id", "name", "input", "cache_control"]),
    "REQ-M-TOOL-USE",
    degradations,
    MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  );
  if (oneMember(value, "cache_control", "REQ-M-TOOL-USE-CACHE") !== undefined) {
    validateCacheControl(oneMember(value, "cache_control", "REQ-M-TOOL-USE-CACHE"), degradations);
    degradations.add("cache.control_omitted");
  }
  const input = requiredObject(oneMember(value, "input", "REQ-M-TOOL-USE-INPUT"), "REQ-M-TOOL-USE-INPUT");
  return {
    type: "tool_call",
    callId: requiredString(oneMember(value, "id", "REQ-M-TOOL-USE-ID"), "REQ-M-TOOL-USE-ID"),
    name: requiredString(oneMember(value, "name", "REQ-M-TOOL-USE-NAME"), "REQ-M-TOOL-USE-NAME"),
    argumentsJson: jsonObjectString(input, "REQ-M-TOOL-USE-INPUT"),
  } as const;
}

export function decodeMessagesToolResult(
  value: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): SemanticToolResultItem {
  value = projectMessagesMembers(
    value,
    new Set(["type", "tool_use_id", "content", "is_error", "cache_control"]),
    "REQ-M-TOOL-RESULT",
    degradations,
    MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  );
  if (oneMember(value, "cache_control", "REQ-M-TOOL-RESULT-CACHE") !== undefined) {
    validateCacheControl(oneMember(value, "cache_control", "REQ-M-TOOL-RESULT-CACHE"), degradations);
    degradations.add("cache.control_omitted");
  }
  const rawContent = oneMember(value, "content", "REQ-M-TOOL-RESULT-CONTENT");
  if (rawContent !== undefined && containsReasoningCarrier(rawContent)) invalid("REQ-M-TOOL-RESULT-CONTENT");
  return {
    type: "tool_result",
    callId: requiredString(
      oneMember(value, "tool_use_id", "REQ-M-TOOL-RESULT-ID"),
      "REQ-M-TOOL-RESULT-ID",
    ),
    content: rawContent === undefined ? [] : decodeToolResultContent(rawContent, degradations, true),
    isError: optionalBoolean(
      oneMember(value, "is_error", "REQ-M-TOOL-RESULT-ERROR"),
      "REQ-M-TOOL-RESULT-ERROR",
    ) ?? false,
  };
}

export function decodeChatTools(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticTool[] {
  if (value === undefined) {
    return [];
  }
  const tools = optionalProtocolArray(value, "REQ-C-TOOLS", degradations);
  if (tools === undefined) return [];
  return tools.items.flatMap((item): readonly SemanticTool[] => {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-C-TOOL");
      degradations.add("chat.extensions_omitted");
      return [];
    }
    return omitMalformedToolDeclaration(item, degradations, "chat.extensions_omitted", () => {
      const tool = projectRequestMembers(
        item,
        new Set(["type", "function"]),
        "REQ-C-TOOL",
        "chat.extensions_omitted",
        degradations,
        TOOL_SENSITIVE_EXTENSION_FIELDS,
      );
      const type = optionalDiscriminator(
        oneMember(tool, "type", "REQ-C-TOOL-TYPE"),
        "REQ-C-TOOL-TYPE",
        degradations,
      );
      if (type === undefined || type !== "function") {
        degradations.add("chat.extensions_omitted");
        return [];
      }
      const fn = projectRequestMembers(
        requestObject(oneMember(tool, "function", "REQ-C-TOOL-FUNCTION"), "REQ-C-TOOL-FUNCTION"),
        new Set(["name", "description", "parameters", "strict"]),
        "REQ-C-TOOL-FUNCTION",
        "chat.extensions_omitted",
        degradations,
        TOOL_SENSITIVE_EXTENSION_FIELDS,
      );
      return [semanticTool(fn, "parameters", "REQ-C-TOOL", false)];
    });
  });
}

export function decodeMessagesTools(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticTool[] {
  if (value === undefined) {
    return [];
  }
  const tools = optionalProtocolArray(value, "REQ-M-TOOLS", degradations);
  if (tools === undefined) return [];
  return tools.items.flatMap((item): readonly SemanticTool[] => {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-M-TOOL");
      degradations.add("messages.extensions_omitted");
      return [];
    }
    return omitMalformedToolDeclaration(item, degradations, "messages.extensions_omitted", () => {
      const tool = projectMessagesMembers(
        item,
        new Set(["name", "description", "input_schema", "strict", "type", "cache_control"]),
        "REQ-M-TOOL",
        degradations,
        MESSAGES_SENSITIVE_EXTENSION_FIELDS,
      );
      const cacheControl = oneMember(tool, "cache_control", "REQ-M-TOOL-CACHE");
      if (cacheControl !== undefined) {
        validateCacheControl(cacheControl, degradations);
        degradations.add("cache.control_omitted");
      }
      const typeValue = oneMember(tool, "type", "REQ-M-TOOL-TYPE");
      const type = typeValue === undefined
        ? undefined
        : optionalDiscriminator(typeValue, "REQ-M-TOOL-TYPE", degradations);
      if (typeValue !== undefined && type === undefined) return [];
      if (type !== undefined && type !== "custom") {
        degradations.add("messages.extensions_omitted");
        return [];
      }
      const decoded = semanticTool(tool, "input_schema", "REQ-M-TOOL", false);
      if (decoded.strict === true && !isOpenaiStrictSchemaCompatible(decoded.parameters)) {
        degradations.add("request.option_omitted");
        return [{ ...decoded, strict: undefined }];
      }
      return [decoded];
    });
  });
}

export function decodeResponsesTools(
  value: WireJson | undefined,
  allowCompatibilityStrictOmission = false,
  degradations: Set<ConversionDegradationRule> = new Set(),
): readonly SemanticTool[] {
  if (value === undefined) {
    return [];
  }
  const tools = optionalProtocolArray(value, "REQ-R-TOOLS", degradations);
  if (tools === undefined) return [];
  return tools.items.flatMap((item): readonly SemanticTool[] => {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-R-TOOL");
      degradations.add("responses.extensions_omitted");
      return [];
    }
    return omitMalformedToolDeclaration(item, degradations, "responses.extensions_omitted", () => {
      const tool = projectRequestMembers(
        item,
        new Set(["type", "name", "description", "parameters", "strict"]),
        "REQ-R-TOOL",
        "responses.extensions_omitted",
        degradations,
        TOOL_SENSITIVE_EXTENSION_FIELDS,
      );
      const type = optionalDiscriminator(
        oneMember(tool, "type", "REQ-R-TOOL-TYPE"),
        "REQ-R-TOOL-TYPE",
        degradations,
      );
      if (type === undefined || type !== "function") {
        degradations.add("responses.extensions_omitted");
        return [];
      }
      const decoded = semanticTool(tool, "parameters", "REQ-R-TOOL");
      const compatible = isOpenaiStrictSchemaCompatible(decoded.parameters);
      if (decoded.strict === true && !compatible) {
        degradations.add("request.option_omitted");
        return [{ ...decoded, strict: undefined }];
      }
      if (decoded.strict !== undefined) return [decoded];
      if (!compatible) {
        if (!allowCompatibilityStrictOmission) degradations.add("request.option_omitted");
        return [decoded];
      }
      return [{ ...decoded, strict: true }];
    });
  });
}

function omitMalformedToolDeclaration(
  value: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
  omission: ConversionDegradationRule,
  work: () => readonly SemanticTool[],
): readonly SemanticTool[] {
  try {
    return work();
  } catch (error: unknown) {
    if (!(error instanceof ConversionContractError) || containsReasoningCarrier(value)) throw error;
    degradations.add(omission);
    return [];
  }
}

function semanticTool(
  object: WireJsonObject,
  schemaKey: string,
  ruleId: string,
  defaultStrict?: boolean,
): SemanticTool {
  const description = optionalString(oneMember(object, "description", `${ruleId}-DESCRIPTION`), `${ruleId}-DESCRIPTION`);
  const strict = optionalBoolean(oneMember(object, "strict", `${ruleId}-STRICT`), `${ruleId}-STRICT`);
  return {
    kind: "function",
    name: requiredString(oneMember(object, "name", `${ruleId}-NAME`), `${ruleId}-NAME`),
    ...(description === undefined ? {} : { description }),
    parameters: requiredObject(oneMember(object, schemaKey, `${ruleId}-SCHEMA`), `${ruleId}-SCHEMA`),
    ...(strict === undefined && defaultStrict === undefined ? {} : { strict: strict ?? defaultStrict }),
  };
}

export function decodeChatToolChoice(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      return { kind: value };
    }
    if (containsReasoningCarrier(value)) invalid("REQ-C-TOOL-CHOICE");
    degradations.add("chat.extensions_omitted");
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-C-TOOL-CHOICE", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectRequestMembers(
    rawObject,
    new Set(["type", "function"]),
    "REQ-C-TOOL-CHOICE",
    "chat.extensions_omitted",
    degradations,
    TOOL_SENSITIVE_EXTENSION_FIELDS,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-C-TOOL-CHOICE-TYPE"),
    "REQ-C-TOOL-CHOICE-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type !== "function") {
    degradations.add("chat.extensions_omitted");
    return undefined;
  }
  const rawFunction = optionalProtocolObject(
    oneMember(object, "function", "REQ-C-TOOL-CHOICE-FUNCTION"),
    "REQ-C-TOOL-CHOICE-FUNCTION",
    degradations,
  );
  if (rawFunction === undefined) {
    degradations.add("request.option_omitted");
    return undefined;
  }
  const fn = projectRequestMembers(
    rawFunction,
    new Set(["name"]),
    "REQ-C-TOOL-CHOICE-FUNCTION",
    "chat.extensions_omitted",
    degradations,
    TOOL_SENSITIVE_EXTENSION_FIELDS,
  );
  const name = optionalChoiceString(
    oneMember(fn, "name", "REQ-C-TOOL-CHOICE-NAME"),
    "REQ-C-TOOL-CHOICE-NAME",
    degradations,
  );
  if (name === undefined) return undefined;
  return {
    kind: "tool",
    name,
  };
}

export function decodeMessagesToolChoice(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-M-TOOL-CHOICE", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectMessagesMembers(
    rawObject,
    new Set(["type", "name", "disable_parallel_tool_use"]),
    "REQ-M-TOOL-CHOICE",
    degradations,
    MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-M-TOOL-CHOICE-TYPE"),
    "REQ-M-TOOL-CHOICE-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type === "auto") {
    return { kind: "auto" };
  }
  if (type === "none") {
    return { kind: "none" };
  }
  if (type === "any") {
    return { kind: "required" };
  }
  if (type === "tool") {
    const name = optionalChoiceString(
      oneMember(object, "name", "REQ-M-TOOL-CHOICE-NAME"),
      "REQ-M-TOOL-CHOICE-NAME",
      degradations,
    );
    if (name === undefined) return undefined;
    return {
      kind: "tool",
      name,
    };
  }
  degradations.add("messages.extensions_omitted");
  return undefined;
}

export function messagesParallelToolCalls(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-M-TOOL-CHOICE", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectMessagesMembers(
    rawObject,
    new Set(["type", "name", "disable_parallel_tool_use"]),
    "REQ-M-TOOL-CHOICE",
    degradations,
    MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  );
  const disabled = optionalBoolean(
    oneMember(object, "disable_parallel_tool_use", "REQ-M-PARALLEL"),
    "REQ-M-PARALLEL",
  );
  return disabled === undefined ? undefined : !disabled;
}

export function decodeResponsesToolChoice(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      return { kind: value };
    }
    if (containsReasoningCarrier(value)) invalid("REQ-R-TOOL-CHOICE");
    degradations.add("responses.extensions_omitted");
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-R-TOOL-CHOICE", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectRequestMembers(
    rawObject,
    new Set(["type", "name"]),
    "REQ-R-TOOL-CHOICE",
    "responses.extensions_omitted",
    degradations,
    TOOL_SENSITIVE_EXTENSION_FIELDS,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-R-TOOL-CHOICE-TYPE"),
    "REQ-R-TOOL-CHOICE-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type !== "function") {
    degradations.add("responses.extensions_omitted");
    return undefined;
  }
  const name = optionalChoiceString(
    oneMember(object, "name", "REQ-R-TOOL-CHOICE-NAME"),
    "REQ-R-TOOL-CHOICE-NAME",
    degradations,
  );
  if (name === undefined) return undefined;
  return {
    kind: "tool",
    name,
  };
}

export function projectSemanticToolRequest(
  items: readonly SemanticRequestItem[],
  tools: readonly SemanticTool[],
  toolChoice: SemanticToolChoice | undefined,
  parallelToolCalls: boolean | undefined,
  degradations: Set<ConversionDegradationRule>,
) {
  return projectToolRequest({
    items,
    tools,
    toolChoice,
    parallelToolCalls,
    degradations,
  });
}

export function encodeChatTool(tool: SemanticTool, degradations?: Set<ConversionDegradationRule>): WireJsonObject {
  const cleaned = cleanChatToolSchema(tool.parameters);
  if (cleaned.changed) degradations?.add("request.option_omitted");
  return wireObject([
    ["type", "function"],
    ["function", wireObject([
      ["name", tool.name],
      ["description", tool.description ?? (tool.sourceName === undefined ? undefined : null)],
      ["parameters", cleaned.schema],
      ["strict", tool.kind === "custom" || tool.kind === "tool_search" ? undefined : tool.strict],
    ])],
  ]);
}

export function encodeResponsesTool(tool: SemanticTool): WireJsonObject {
  return wireObject([
    ["type", "function"],
    ["name", tool.name],
    ["description", tool.description],
    ["parameters", tool.parameters],
    ["strict", tool.strict],
  ]);
}

export function encodeMessagesTool(tool: SemanticTool): WireJsonObject {
  return wireObject([
    ["name", tool.name],
    ["description", tool.description],
    ["input_schema", tool.parameters],
    ["strict", tool.strict],
  ]);
}

export function encodeChatToolCall(item: Extract<SemanticRequestItem, { readonly type: "tool_call" }>): WireJsonObject {
  return wireObject([
    ["id", item.callId],
    ["type", "function"],
    ["function", wireObject([["name", item.name], ["arguments", item.argumentsJson]])],
  ]);
}

export function encodeChatToolChoice(choice: SemanticToolChoice | undefined): WireJson | undefined {
  if (choice === undefined || choice.kind !== "tool") {
    return choice?.kind;
  }
  return wireObject([["type", "function"], ["function", wireObject([["name", choice.name]])]]);
}

export function encodeResponsesToolChoice(choice: SemanticToolChoice | undefined): WireJson | undefined {
  if (choice === undefined || choice.kind !== "tool") {
    return choice?.kind;
  }
  return wireObject([["type", "function"], ["name", choice.name]]);
}

export function encodeMessagesToolChoice(
  choice: SemanticToolChoice | undefined,
  parallel: boolean | undefined,
): WireJson | undefined {
  if (choice === undefined && parallel !== false) {
    return undefined;
  }
  const type = choice === undefined || choice.kind === "auto"
    ? "auto"
    : choice.kind === "required"
      ? "any"
      : choice.kind;
  return wireObject([
    ["type", type],
    ["name", choice?.kind === "tool" ? choice.name : undefined],
    ["disable_parallel_tool_use", parallel === false ? true : undefined],
  ]);
}

export function validateArgumentsJson(value: string, ruleId: string): void {
  parseArgumentsObject(value, ruleId);
}

export function parseArgumentsObject(value: string, ruleId: string): WireJsonObject {
  let parsed: WireJson;
  try {
    const bytes = new TextEncoder().encode(value);
    parsed = parseWireJson(bytes, { maxBytes: Math.max(bytes.byteLength, 1), maxDepth: 32 });
  } catch {
    invalid(ruleId);
  }
  return requiredObject(parsed, ruleId);
}
