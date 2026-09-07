import type { EffectiveModelCapabilitySnapshot } from "../../copilot/capability_registry.js";
import { chooseOutputTokenBudget } from "../../copilot/model_capabilities.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import {
  type ConversionDegradationRule,
  type EncodedConversionRequest,
  type InferenceProtocol,
  type SemanticContent,
  type SemanticImage,
  type SemanticOutputFormat,
  type SemanticReasoning,
  type SemanticRequest,
  type SemanticRequestItem,
  type SemanticTool,
  type SemanticToolChoice,
  type SemanticToolResultItem,
} from "./types.js";
import {
  assertAllowedKeys,
  encodeWireObject,
  finiteNumber,
  invalid,
  jsonObjectString,
  oneMember,
  optionalBoolean,
  optionalObject,
  optionalString,
  parseStringList,
  positiveInteger,
  requiredArray,
  requiredObject,
  requiredString,
  unsupported,
  wireArray,
  wireNumber,
  wireObject,
} from "./wire.js";
import { isOpenAiStrictSchemaCompatible } from "./strict_schema.js";

const CHAT_TOP_LEVEL = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_completion_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "n",
  "stop",
  "metadata",
]);

const MESSAGES_TOP_LEVEL = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "metadata",
]);

const RESPONSES_TOP_LEVEL = new Set([
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
  "text",
  "response_format",
  "previous_response_id",
  "store",
  "background",
  "n",
  "stop",
  "metadata",
]);

interface EncodeContext {
  readonly resolvedModel: string;
  readonly capability: EffectiveModelCapabilitySnapshot;
}

export interface ProtocolRequestCodec {
  readonly protocol: InferenceProtocol;
  decode(body: WireJsonObject): SemanticRequest;
  encode(request: Readonly<SemanticRequest>, context: Readonly<EncodeContext>): EncodedConversionRequest;
}

export const CHAT_REQUEST_CODEC: ProtocolRequestCodec = {
  protocol: "chat",
  decode: decodeChatRequest,
  encode: (request, context) => encodeChatRequest(request, context),
};

export const MESSAGES_REQUEST_CODEC: ProtocolRequestCodec = {
  protocol: "messages",
  decode: decodeMessagesRequest,
  encode: (request, context) => encodeMessagesRequest(request, context),
};

export const RESPONSES_REQUEST_CODEC: ProtocolRequestCodec = {
  protocol: "responses",
  decode: decodeResponsesRequest,
  encode: (request, context) => encodeResponsesRequest(request, context),
};

export const PROTOCOL_REQUEST_CODECS: Readonly<Record<InferenceProtocol, ProtocolRequestCodec>> = {
  chat: CHAT_REQUEST_CODEC,
  messages: MESSAGES_REQUEST_CODEC,
  responses: RESPONSES_REQUEST_CODEC,
};

function decodeChatRequest(body: WireJsonObject): SemanticRequest {
  assertAllowedKeys(body, CHAT_TOP_LEVEL, "REQ-C-TOP");
  validateStreamOptions(oneMember(body, "stream_options", "REQ-C-STREAM-OPTIONS"));
  validateSingleChoice(oneMember(body, "n", "REQ-C-N"), "REQ-C-N");
  const degradations = new Set<ConversionDegradationRule>();
  const items: SemanticRequestItem[] = [];
  const messages = requiredArray(oneMember(body, "messages", "REQ-C-MESSAGES"), "REQ-C-MESSAGES");
  for (const value of messages.items) {
    decodeChatMessage(value, items);
  }
  const reasoning = reasoningFromEffort(
    optionalString(oneMember(body, "reasoning_effort", "REQ-C-REASONING"), "REQ-C-REASONING"),
    "REQ-C-REASONING",
    true,
  );
  return Object.freeze({
    source: "chat",
    model: optionalString(oneMember(body, "model", "REQ-C-MODEL"), "REQ-C-MODEL"),
    stream: optionalBoolean(oneMember(body, "stream", "REQ-C-STREAM"), "REQ-C-STREAM") ?? false,
    instructions: [],
    items,
    tools: decodeChatTools(oneMember(body, "tools", "REQ-C-TOOLS")),
    toolChoice: decodeChatToolChoice(oneMember(body, "tool_choice", "REQ-C-TOOL-CHOICE")),
    parallelToolCalls: optionalBoolean(
      oneMember(body, "parallel_tool_calls", "REQ-C-PARALLEL"),
      "REQ-C-PARALLEL",
    ),
    maxOutputTokens: aliasedPositiveInteger(
      body,
      ["max_completion_tokens", "max_tokens"],
      "REQ-C-LIMIT",
    ),
    temperature: finiteNumber(
      oneMember(body, "temperature", "REQ-C-TEMPERATURE"),
      "REQ-C-TEMPERATURE",
      0,
      2,
    ),
    topP: finiteNumber(oneMember(body, "top_p", "REQ-C-TOP-P"), "REQ-C-TOP-P", 0, 1),
    stop: parseStringList(oneMember(body, "stop", "REQ-C-STOP"), "REQ-C-STOP"),
    outputFormat: decodeChatOutputFormat(oneMember(body, "response_format", "REQ-C-FORMAT")),
    reasoning,
    metadata: validatedMetadata(oneMember(body, "metadata", "REQ-C-METADATA"), "chat"),
    degradations: [...degradations],
  });
}

function decodeChatMessage(value: WireJson, output: SemanticRequestItem[]): void {
  const message = requiredObject(value, "REQ-C-MESSAGE");
  const role = requiredString(oneMember(message, "role", "REQ-C-MESSAGE-ROLE"), "REQ-C-MESSAGE-ROLE");
  if (role === "system" || role === "developer" || role === "user") {
    assertAllowedKeys(message, new Set(["role", "content"]), "REQ-C-MESSAGE-KEY");
    output.push({
      type: "message",
      role,
      content: decodeChatContent(
        oneMember(message, "content", "REQ-C-MESSAGE-CONTENT"),
        role !== "user",
      ),
    });
    return;
  }
  if (role === "assistant") {
    assertAllowedKeys(message, new Set(["role", "content", "tool_calls", "refusal"]), "REQ-C-ASSISTANT");
    const content = decodeChatContent(
      oneMember(message, "content", "REQ-C-ASSISTANT-CONTENT"),
      true,
      true,
    );
    const refusalValue = oneMember(message, "refusal", "REQ-C-ASSISTANT-REFUSAL");
    const refusal = refusalValue === null
      ? undefined
      : optionalString(refusalValue, "REQ-C-ASSISTANT-REFUSAL");
    const combined = refusal === undefined ? content : [...content, { type: "refusal", text: refusal } as const];
    if (combined.length > 0) {
      output.push({ type: "message", role: "assistant", content: combined });
    }
    const calls = oneMember(message, "tool_calls", "REQ-C-TOOL-CALLS");
    if (calls !== undefined) {
      for (const call of requiredArray(calls, "REQ-C-TOOL-CALLS").items) {
        output.push(decodeChatToolCall(call));
      }
    }
    if (combined.length === 0 && calls === undefined) {
      invalid("REQ-C-ASSISTANT-EMPTY");
    }
    return;
  }
  if (role === "tool") {
    assertAllowedKeys(message, new Set(["role", "content", "tool_call_id"]), "REQ-C-TOOL-RESULT");
    output.push({
      type: "tool_result",
      callId: requiredString(
        oneMember(message, "tool_call_id", "REQ-C-TOOL-RESULT-ID"),
        "REQ-C-TOOL-RESULT-ID",
      ),
      content: decodeChatContent(oneMember(message, "content", "REQ-C-TOOL-RESULT-CONTENT"), false),
      isError: false,
    });
    return;
  }
  invalid("REQ-C-MESSAGE-ROLE");
}

function decodeChatContent(
  value: WireJson | undefined,
  textOnly: boolean,
  allowNull = false,
): readonly SemanticContent[] {
  if ((value === null || value === undefined) && allowNull) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  const array = requiredArray(value, "REQ-C-CONTENT");
  return array.items.map((item) => {
    const block = requiredObject(item, "REQ-C-CONTENT-BLOCK");
    const type = requiredString(oneMember(block, "type", "REQ-C-CONTENT-TYPE"), "REQ-C-CONTENT-TYPE");
    if (type === "text") {
      assertAllowedKeys(block, new Set(["type", "text"]), "REQ-C-TEXT");
      return {
        type: "text",
        text: requiredString(oneMember(block, "text", "REQ-C-TEXT"), "REQ-C-TEXT", true),
      } as const;
    }
    if (type === "image_url" && !textOnly) {
      assertAllowedKeys(block, new Set(["type", "image_url"]), "REQ-C-IMAGE");
      const image = requiredObject(oneMember(block, "image_url", "REQ-C-IMAGE"), "REQ-C-IMAGE");
      assertAllowedKeys(image, new Set(["url", "detail"]), "REQ-C-IMAGE");
      return imageContent(
        requiredString(oneMember(image, "url", "REQ-C-IMAGE-URL"), "REQ-C-IMAGE-URL"),
        optionalString(oneMember(image, "detail", "REQ-C-IMAGE-DETAIL"), "REQ-C-IMAGE-DETAIL"),
        "REQ-C-IMAGE",
      );
    }
    unsupported("REQ-C-CONTENT-TYPE");
  });
}

function decodeChatToolCall(value: WireJson) {
  const call = requiredObject(value, "REQ-C-TOOL-CALL");
  assertAllowedKeys(call, new Set(["id", "type", "function", "index"]), "REQ-C-TOOL-CALL");
  const type = requiredString(oneMember(call, "type", "REQ-C-TOOL-CALL-TYPE"), "REQ-C-TOOL-CALL-TYPE");
  if (type !== "function") {
    unsupported("REQ-C-TOOL-CALL-TYPE");
  }
  const fn = requiredObject(oneMember(call, "function", "REQ-C-TOOL-CALL-FUNCTION"), "REQ-C-TOOL-CALL-FUNCTION");
  assertAllowedKeys(fn, new Set(["name", "arguments"]), "REQ-C-TOOL-CALL-FUNCTION");
  const argumentsJson = requiredString(
    oneMember(fn, "arguments", "REQ-C-TOOL-CALL-ARGS"),
    "REQ-C-TOOL-CALL-ARGS",
    true,
  );
  validateArgumentsJson(argumentsJson, "REQ-C-TOOL-CALL-ARGS");
  return {
    type: "tool_call",
    callId: requiredString(oneMember(call, "id", "REQ-C-TOOL-CALL-ID"), "REQ-C-TOOL-CALL-ID"),
    name: requiredString(oneMember(fn, "name", "REQ-C-TOOL-CALL-NAME"), "REQ-C-TOOL-CALL-NAME"),
    argumentsJson,
  } as const;
}

function decodeMessagesRequest(body: WireJsonObject): SemanticRequest {
  assertAllowedKeys(body, MESSAGES_TOP_LEVEL, "REQ-M-TOP");
  const degradations = new Set<ConversionDegradationRule>();
  const instructions = decodeMessagesSystem(oneMember(body, "system", "REQ-M-SYSTEM"), degradations);
  const items: SemanticRequestItem[] = [];
  for (const value of requiredArray(oneMember(body, "messages", "REQ-M-MESSAGES"), "REQ-M-MESSAGES").items) {
    decodeMessagesMessage(value, items, degradations);
  }
  if (oneMember(body, "top_k", "REQ-M-TOP-K") !== undefined) {
    positiveInteger(oneMember(body, "top_k", "REQ-M-TOP-K"), "REQ-M-TOP-K");
    degradations.add("sampling.top_k_omitted");
  }
  const outputConfig = optionalObject(
    oneMember(body, "output_config", "REQ-M-OUTPUT-CONFIG"),
    "REQ-M-OUTPUT-CONFIG",
  );
  if (outputConfig !== undefined) {
    assertAllowedKeys(outputConfig, new Set(["effort", "format"]), "REQ-M-OUTPUT-CONFIG");
  }
  const reasoning = mergeReasoning(
    reasoningFromEffort(
      optionalString(
        outputConfig === undefined ? undefined : oneMember(outputConfig, "effort", "REQ-M-EFFORT"),
        "REQ-M-EFFORT",
      ),
      "REQ-M-EFFORT",
    ),
    decodeMessagesThinking(oneMember(body, "thinking", "REQ-M-THINKING"), degradations),
  );
  return Object.freeze({
    source: "messages",
    model: optionalString(oneMember(body, "model", "REQ-M-MODEL"), "REQ-M-MODEL"),
    stream: optionalBoolean(oneMember(body, "stream", "REQ-M-STREAM"), "REQ-M-STREAM") ?? false,
    instructions,
    items,
    tools: decodeMessagesTools(oneMember(body, "tools", "REQ-M-TOOLS")),
    toolChoice: decodeMessagesToolChoice(oneMember(body, "tool_choice", "REQ-M-TOOL-CHOICE")),
    parallelToolCalls: messagesParallelToolCalls(oneMember(body, "tool_choice", "REQ-M-TOOL-CHOICE")),
    maxOutputTokens: positiveInteger(oneMember(body, "max_tokens", "REQ-M-LIMIT"), "REQ-M-LIMIT"),
    temperature: finiteNumber(
      oneMember(body, "temperature", "REQ-M-TEMPERATURE"),
      "REQ-M-TEMPERATURE",
      0,
      1,
    ),
    topP: finiteNumber(oneMember(body, "top_p", "REQ-M-TOP-P"), "REQ-M-TOP-P", 0, 1),
    stop: parseStringList(oneMember(body, "stop_sequences", "REQ-M-STOP"), "REQ-M-STOP"),
    outputFormat: decodeMessagesOutputFormat(
      outputConfig === undefined ? undefined : oneMember(outputConfig, "format", "REQ-M-FORMAT"),
    ),
    reasoning,
    metadata: validatedMetadata(oneMember(body, "metadata", "REQ-M-METADATA"), "messages"),
    degradations: [...degradations],
  });
}

function decodeMessagesSystem(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticContent[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return requiredArray(value, "REQ-M-SYSTEM").items.map((item) => {
    const block = requiredObject(item, "REQ-M-SYSTEM-BLOCK");
    assertAllowedKeys(block, new Set(["type", "text", "cache_control"]), "REQ-M-SYSTEM-BLOCK");
    if (requiredString(oneMember(block, "type", "REQ-M-SYSTEM-TYPE"), "REQ-M-SYSTEM-TYPE") !== "text") {
      unsupported("REQ-M-SYSTEM-TYPE");
    }
    if (oneMember(block, "cache_control", "REQ-M-SYSTEM-CACHE") !== undefined) {
      validateCacheControl(oneMember(block, "cache_control", "REQ-M-SYSTEM-CACHE"));
      degradations.add("cache.control_omitted");
    }
    return {
      type: "text",
      text: requiredString(oneMember(block, "text", "REQ-M-SYSTEM-TEXT"), "REQ-M-SYSTEM-TEXT", true),
    } as const;
  });
}

function decodeMessagesMessage(
  value: WireJson,
  output: SemanticRequestItem[],
  degradations: Set<ConversionDegradationRule>,
): void {
  const message = requiredObject(value, "REQ-M-MESSAGE");
  assertAllowedKeys(message, new Set(["role", "content"]), "REQ-M-MESSAGE");
  const role = requiredString(oneMember(message, "role", "REQ-M-MESSAGE-ROLE"), "REQ-M-MESSAGE-ROLE");
  if (role !== "user" && role !== "assistant") {
    invalid("REQ-M-MESSAGE-ROLE");
  }
  const content = oneMember(message, "content", "REQ-M-MESSAGE-CONTENT");
  if (typeof content === "string") {
    output.push({ type: "message", role, content: [{ type: "text", text: content }] });
    return;
  }
  const ordinary: SemanticContent[] = [];
  const flushOrdinary = (): void => {
    if (ordinary.length === 0) {
      return;
    }
    output.push({ type: "message", role, content: ordinary.splice(0) });
  };
  for (const item of requiredArray(content, "REQ-M-MESSAGE-CONTENT").items) {
    const block = requiredObject(item, "REQ-M-CONTENT-BLOCK");
    const type = requiredString(oneMember(block, "type", "REQ-M-CONTENT-TYPE"), "REQ-M-CONTENT-TYPE");
    if (type === "text") {
      assertAllowedKeys(block, new Set(["type", "text", "cache_control"]), "REQ-M-TEXT");
      if (oneMember(block, "cache_control", "REQ-M-TEXT-CACHE") !== undefined) {
        validateCacheControl(oneMember(block, "cache_control", "REQ-M-TEXT-CACHE"));
        degradations.add("cache.control_omitted");
      }
      ordinary.push({
        type: "text",
        text: requiredString(oneMember(block, "text", "REQ-M-TEXT"), "REQ-M-TEXT", true),
      });
      continue;
    }
    if (type === "image") {
      if (role !== "user") {
        invalid("REQ-M-IMAGE-ROLE");
      }
      assertAllowedKeys(block, new Set(["type", "source", "cache_control"]), "REQ-M-IMAGE");
      if (oneMember(block, "cache_control", "REQ-M-IMAGE-CACHE") !== undefined) {
        validateCacheControl(oneMember(block, "cache_control", "REQ-M-IMAGE-CACHE"));
        degradations.add("cache.control_omitted");
      }
      ordinary.push(decodeMessagesImage(oneMember(block, "source", "REQ-M-IMAGE-SOURCE")));
      continue;
    }
    flushOrdinary();
    if (type === "tool_use") {
      if (role !== "assistant") {
        invalid("REQ-M-TOOL-USE-ROLE");
      }
      output.push(decodeMessagesToolUse(block, degradations));
      continue;
    }
    if (type === "tool_result") {
      if (role !== "user") {
        invalid("REQ-M-TOOL-RESULT-ROLE");
      }
      output.push(decodeMessagesToolResult(block, degradations));
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      if (type === "thinking") {
        assertAllowedKeys(block, new Set(["type", "thinking", "signature"]), "REQ-M-THINKING-BLOCK");
        requiredString(oneMember(block, "thinking", "REQ-M-THINKING-TEXT"), "REQ-M-THINKING-TEXT", true);
        optionalString(oneMember(block, "signature", "REQ-M-THINKING-SIGNATURE"), "REQ-M-THINKING-SIGNATURE");
      } else {
        assertAllowedKeys(block, new Set(["type", "data"]), "REQ-M-REDACTED-THINKING");
        requiredString(oneMember(block, "data", "REQ-M-REDACTED-DATA"), "REQ-M-REDACTED-DATA", true);
      }
      degradations.add(type === "thinking" ? "reasoning.presentation_omitted" : "reasoning.state_omitted");
      continue;
    }
    unsupported("REQ-M-CONTENT-TYPE");
  }
  flushOrdinary();
}

function decodeMessagesImage(value: WireJson | undefined): SemanticImage {
  const source = requiredObject(value, "REQ-M-IMAGE-SOURCE");
  const type = requiredString(oneMember(source, "type", "REQ-M-IMAGE-SOURCE-TYPE"), "REQ-M-IMAGE-SOURCE-TYPE");
  if (type === "base64") {
    assertAllowedKeys(source, new Set(["type", "media_type", "data"]), "REQ-M-IMAGE-SOURCE");
    const mediaType = requiredString(
      oneMember(source, "media_type", "REQ-M-IMAGE-MIME"),
      "REQ-M-IMAGE-MIME",
    );
    const data = requiredString(oneMember(source, "data", "REQ-M-IMAGE-DATA"), "REQ-M-IMAGE-DATA");
    return imageContent(`data:${mediaType};base64,${data}`, undefined, "REQ-M-IMAGE");
  }
  if (type === "url") {
    assertAllowedKeys(source, new Set(["type", "url"]), "REQ-M-IMAGE-SOURCE");
    return imageContent(
      requiredString(oneMember(source, "url", "REQ-M-IMAGE-URL"), "REQ-M-IMAGE-URL"),
      undefined,
      "REQ-M-IMAGE",
    );
  }
  unsupported("REQ-M-IMAGE-SOURCE-TYPE");
}

function decodeMessagesToolUse(
  value: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
) {
  assertAllowedKeys(value, new Set(["type", "id", "name", "input", "cache_control"]), "REQ-M-TOOL-USE");
  if (oneMember(value, "cache_control", "REQ-M-TOOL-USE-CACHE") !== undefined) {
    validateCacheControl(oneMember(value, "cache_control", "REQ-M-TOOL-USE-CACHE"));
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

function decodeMessagesToolResult(
  value: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): SemanticToolResultItem {
  assertAllowedKeys(
    value,
    new Set(["type", "tool_use_id", "content", "is_error", "cache_control"]),
    "REQ-M-TOOL-RESULT",
  );
  if (oneMember(value, "cache_control", "REQ-M-TOOL-RESULT-CACHE") !== undefined) {
    validateCacheControl(oneMember(value, "cache_control", "REQ-M-TOOL-RESULT-CACHE"));
    degradations.add("cache.control_omitted");
  }
  const rawContent = oneMember(value, "content", "REQ-M-TOOL-RESULT-CONTENT");
  if (rawContent !== undefined && typeof rawContent !== "string" && !isWireJsonArray(rawContent)) {
    invalid("REQ-M-TOOL-RESULT-CONTENT");
  }
  return {
    type: "tool_result",
    callId: requiredString(
      oneMember(value, "tool_use_id", "REQ-M-TOOL-RESULT-ID"),
      "REQ-M-TOOL-RESULT-ID",
    ),
    content: rawContent === undefined ? [] : decodeToolResultContent(rawContent, degradations),
    isError: optionalBoolean(
      oneMember(value, "is_error", "REQ-M-TOOL-RESULT-ERROR"),
      "REQ-M-TOOL-RESULT-ERROR",
    ) ?? false,
  };
}

function decodeResponsesRequest(body: WireJsonObject): SemanticRequest {
  assertAllowedKeys(body, RESPONSES_TOP_LEVEL, "REQ-R-TOP");
  validateStreamOptions(oneMember(body, "stream_options", "REQ-R-STREAM-OPTIONS"));
  validateSingleChoice(oneMember(body, "n", "REQ-R-N"), "REQ-R-N");
  const background = optionalBoolean(oneMember(body, "background", "REQ-R-BACKGROUND"), "REQ-R-BACKGROUND");
  if (background === true) {
    unsupported("REQ-R-BACKGROUND");
  }
  const previousResponseId = oneMember(body, "previous_response_id", "REQ-R-PREVIOUS");
  if (previousResponseId !== undefined) {
    requiredString(previousResponseId, "REQ-R-PREVIOUS");
  }
  const store = optionalBoolean(oneMember(body, "store", "REQ-R-STORE"), "REQ-R-STORE");
  if (store === true) {
    unsupported("REQ-R-STORE");
  }
  const degradations = new Set<ConversionDegradationRule>();
  const items = decodeResponsesInput(oneMember(body, "input", "REQ-R-INPUT"), degradations);
  const reasoningObject = optionalObject(
    oneMember(body, "reasoning", "REQ-R-REASONING"),
    "REQ-R-REASONING",
  );
  if (reasoningObject !== undefined) {
    assertAllowedKeys(reasoningObject, new Set(["effort", "summary", "encrypted_content"]), "REQ-R-REASONING");
    if (oneMember(reasoningObject, "summary", "REQ-R-REASONING-SUMMARY") !== undefined) {
      requiredString(oneMember(reasoningObject, "summary", "REQ-R-REASONING-SUMMARY"), "REQ-R-REASONING-SUMMARY");
      degradations.add("reasoning.presentation_omitted");
    }
    if (oneMember(reasoningObject, "encrypted_content", "REQ-R-REASONING-STATE") !== undefined) {
      requiredString(oneMember(reasoningObject, "encrypted_content", "REQ-R-REASONING-STATE"), "REQ-R-REASONING-STATE");
      degradations.add("reasoning.state_omitted");
    }
  }
  return Object.freeze({
    source: "responses",
    model: optionalString(oneMember(body, "model", "REQ-R-MODEL"), "REQ-R-MODEL"),
    stream: optionalBoolean(oneMember(body, "stream", "REQ-R-STREAM"), "REQ-R-STREAM") ?? false,
    instructions: decodeResponsesInstructions(oneMember(body, "instructions", "REQ-R-INSTRUCTIONS")),
    items,
    tools: decodeResponsesTools(oneMember(body, "tools", "REQ-R-TOOLS")),
    toolChoice: decodeResponsesToolChoice(oneMember(body, "tool_choice", "REQ-R-TOOL-CHOICE")),
    parallelToolCalls: optionalBoolean(
      oneMember(body, "parallel_tool_calls", "REQ-R-PARALLEL"),
      "REQ-R-PARALLEL",
    ),
    maxOutputTokens: aliasedPositiveInteger(
      body,
      ["max_output_tokens", "max_completion_tokens", "max_tokens"],
      "REQ-R-LIMIT",
    ),
    temperature: finiteNumber(
      oneMember(body, "temperature", "REQ-R-TEMPERATURE"),
      "REQ-R-TEMPERATURE",
      0,
      2,
    ),
    topP: finiteNumber(oneMember(body, "top_p", "REQ-R-TOP-P"), "REQ-R-TOP-P", 0, 1),
    stop: parseStringList(oneMember(body, "stop", "REQ-R-STOP"), "REQ-R-STOP"),
    outputFormat: decodeResponsesOutputFormat(body),
    reasoning: reasoningFromEffort(
      optionalString(
        reasoningObject === undefined ? undefined : oneMember(reasoningObject, "effort", "REQ-R-EFFORT"),
        "REQ-R-EFFORT",
      ),
      "REQ-R-EFFORT",
      true,
    ),
    metadata: validatedMetadata(oneMember(body, "metadata", "REQ-R-METADATA"), "responses"),
    degradations: [...degradations],
  });
}

function decodeResponsesInstructions(value: WireJson | undefined): readonly SemanticContent[] {
  if (value === undefined || value === null) {
    return [];
  }
  return [{ type: "text", text: requiredString(value, "REQ-R-INSTRUCTIONS", true) }];
}

function decodeResponsesInput(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticRequestItem[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "message", role: "user", content: [{ type: "text", text: value }] }];
  }
  const values = isWireJsonArray(value) ? value.items : [value];
  const output: SemanticRequestItem[] = [];
  for (const item of values) {
    const object = requiredObject(item, "REQ-R-INPUT-ITEM");
    const type = optionalString(oneMember(object, "type", "REQ-R-INPUT-TYPE"), "REQ-R-INPUT-TYPE");
    if (type === undefined || type === "message") {
      assertAllowedKeys(object, new Set(["type", "id", "role", "content", "status"]), "REQ-R-MESSAGE");
      const role = requiredString(oneMember(object, "role", "REQ-R-MESSAGE-ROLE"), "REQ-R-MESSAGE-ROLE");
      if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
        invalid("REQ-R-MESSAGE-ROLE");
      }
      output.push({
        type: "message",
        role,
        content: decodeResponsesContent(
          oneMember(object, "content", "REQ-R-MESSAGE-CONTENT"),
          role === "user",
        ),
      });
      continue;
    }
    if (type === "function_call") {
      assertAllowedKeys(
        object,
        new Set(["type", "id", "call_id", "name", "arguments", "status"]),
        "REQ-R-FUNCTION-CALL",
      );
      const argumentsJson = requiredString(
        oneMember(object, "arguments", "REQ-R-FUNCTION-ARGS"),
        "REQ-R-FUNCTION-ARGS",
        true,
      );
      validateArgumentsJson(argumentsJson, "REQ-R-FUNCTION-ARGS");
      output.push({
        type: "tool_call",
        itemId: optionalString(oneMember(object, "id", "REQ-R-FUNCTION-ITEM-ID"), "REQ-R-FUNCTION-ITEM-ID"),
        callId: requiredString(
          oneMember(object, "call_id", "REQ-R-FUNCTION-CALL-ID"),
          "REQ-R-FUNCTION-CALL-ID",
        ),
        name: requiredString(oneMember(object, "name", "REQ-R-FUNCTION-NAME"), "REQ-R-FUNCTION-NAME"),
        argumentsJson,
      });
      continue;
    }
    if (type === "function_call_output") {
      assertAllowedKeys(
        object,
        new Set(["type", "id", "call_id", "output", "status"]),
        "REQ-R-FUNCTION-OUTPUT",
      );
      output.push({
        type: "tool_result",
        callId: requiredString(
          oneMember(object, "call_id", "REQ-R-FUNCTION-OUTPUT-ID"),
          "REQ-R-FUNCTION-OUTPUT-ID",
        ),
        content: decodeToolResultContent(
          oneMember(object, "output", "REQ-R-FUNCTION-OUTPUT-CONTENT"),
          degradations,
        ),
        isError: oneMember(object, "status", "REQ-R-FUNCTION-OUTPUT-STATUS") === "failed",
      });
      continue;
    }
    if (type === "reasoning") {
      assertAllowedKeys(
        object,
        new Set(["type", "id", "status", "summary", "content", "encrypted_content"]),
        "REQ-R-REASONING-ITEM",
      );
      if (oneMember(object, "summary", "REQ-R-REASONING-SUMMARY") !== undefined) {
        requiredArray(oneMember(object, "summary", "REQ-R-REASONING-SUMMARY"), "REQ-R-REASONING-SUMMARY");
      }
      if (oneMember(object, "content", "REQ-R-REASONING-CONTENT") !== undefined) {
        requiredArray(oneMember(object, "content", "REQ-R-REASONING-CONTENT"), "REQ-R-REASONING-CONTENT");
      }
      if (oneMember(object, "encrypted_content", "REQ-R-REASONING-STATE") !== undefined) {
        requiredString(
          oneMember(object, "encrypted_content", "REQ-R-REASONING-STATE"),
          "REQ-R-REASONING-STATE",
        );
      }
      degradations.add("reasoning.presentation_omitted");
      continue;
    }
    unsupported("REQ-R-INPUT-TYPE");
  }
  return output;
}

function decodeResponsesContent(value: WireJson | undefined, allowImage: boolean): readonly SemanticContent[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return requiredArray(value, "REQ-R-CONTENT").items.map((item) => {
    const block = requiredObject(item, "REQ-R-CONTENT-BLOCK");
    const type = requiredString(oneMember(block, "type", "REQ-R-CONTENT-TYPE"), "REQ-R-CONTENT-TYPE");
    if (type === "input_text" || type === "output_text" || type === "text") {
      assertAllowedKeys(block, new Set(["type", "text", "annotations"]), "REQ-R-TEXT");
      const annotations = oneMember(block, "annotations", "REQ-R-TEXT-ANNOTATIONS");
      if (annotations !== undefined) {
        requiredArray(annotations, "REQ-R-TEXT-ANNOTATIONS");
      }
      return {
        type: "text",
        text: requiredString(oneMember(block, "text", "REQ-R-TEXT"), "REQ-R-TEXT", true),
      } as const;
    }
    if (type === "refusal") {
      assertAllowedKeys(block, new Set(["type", "refusal"]), "REQ-R-REFUSAL");
      return {
        type: "refusal",
        text: requiredString(oneMember(block, "refusal", "REQ-R-REFUSAL"), "REQ-R-REFUSAL", true),
      } as const;
    }
    if (type === "input_image" && allowImage) {
      assertAllowedKeys(block, new Set(["type", "image_url", "detail"]), "REQ-R-IMAGE");
      return imageContent(
        requiredString(oneMember(block, "image_url", "REQ-R-IMAGE-URL"), "REQ-R-IMAGE-URL"),
        optionalString(oneMember(block, "detail", "REQ-R-IMAGE-DETAIL"), "REQ-R-IMAGE-DETAIL"),
        "REQ-R-IMAGE",
      );
    }
    unsupported("REQ-R-CONTENT-TYPE");
  });
}

function decodeToolResultContent(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticContent[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.startsWith("data:image/")
      && new TextEncoder().encode(trimmed).byteLength >= 8192
    ) {
      return [imageContent(trimmed, undefined, "REQ-MEDIA-DATA-URL")];
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: WireJson | undefined;
      try {
        const bytes = new TextEncoder().encode(trimmed);
        parsed = parseWireJson(bytes, {
          maxBytes: bytes.byteLength,
          maxDepth: Math.min(Math.max(bytes.byteLength, 64), 4096),
        });
      } catch {
        // A non-protocol JSON-looking string remains ordinary tool text.
      }
      if (parsed !== undefined) {
        const extracted = extractEmbeddedToolMedia(parsed);
        if (extracted.media.length > 0) {
          return [
            {
              type: "text",
              text: new TextDecoder().decode(serializeWireJson(extracted.value)),
            },
            ...extracted.media,
          ];
        }
      }
    }
    return [{ type: "text", text: value }];
  }
  if (isWireJsonObject(value)) {
    const type = oneMember(value, "type", "REQ-TOOL-RESULT-TYPE");
    if (type === "image") {
      assertAllowedKeys(value, new Set(["type", "source"]), "REQ-TOOL-RESULT-IMAGE");
      return [decodeMessagesImage(oneMember(value, "source", "REQ-TOOL-RESULT-IMAGE"))];
    }
    if (type === "input_image") {
      assertAllowedKeys(value, new Set(["type", "image_url", "detail"]), "REQ-TOOL-RESULT-IMAGE");
      return [imageContent(
        requiredString(
          oneMember(value, "image_url", "REQ-TOOL-RESULT-IMAGE-URL"),
          "REQ-TOOL-RESULT-IMAGE-URL",
        ),
        optionalString(
          oneMember(value, "detail", "REQ-TOOL-RESULT-IMAGE-DETAIL"),
          "REQ-TOOL-RESULT-IMAGE-DETAIL",
        ),
        "REQ-TOOL-RESULT-IMAGE",
      )];
    }
    if (type === "image_url") {
      assertAllowedKeys(value, new Set(["type", "image_url"]), "REQ-TOOL-RESULT-IMAGE");
      const image = requiredObject(
        oneMember(value, "image_url", "REQ-TOOL-RESULT-IMAGE"),
        "REQ-TOOL-RESULT-IMAGE",
      );
      assertAllowedKeys(image, new Set(["url", "detail"]), "REQ-TOOL-RESULT-IMAGE");
      return [imageContent(
        requiredString(oneMember(image, "url", "REQ-TOOL-RESULT-IMAGE-URL"), "REQ-TOOL-RESULT-IMAGE-URL"),
        optionalString(oneMember(image, "detail", "REQ-TOOL-RESULT-IMAGE-DETAIL"), "REQ-TOOL-RESULT-IMAGE-DETAIL"),
        "REQ-TOOL-RESULT-IMAGE",
      )];
    }
    const extracted = extractEmbeddedToolMedia(value);
    return [{
      type: "text",
      text: new TextDecoder().decode(serializeWireJson(extracted.value)),
    }, ...extracted.media];
  }

  function extractEmbeddedToolMedia(
    value: WireJson,
    depth = 0,
  ): { readonly value: WireJson; readonly media: readonly SemanticImage[] } {
    if (depth > 32) {
      return { value, media: [] };
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        trimmed.startsWith("data:image/")
        && new TextEncoder().encode(trimmed).byteLength >= 8192
      ) {
        return {
          value: "[cc-switch: tool result media moved to the following user message]",
          media: [imageContent(trimmed, undefined, "REQ-MEDIA-DATA-URL")],
        };
      }
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        let parsed: WireJson;
        try {
          const bytes = new TextEncoder().encode(trimmed);
          parsed = parseWireJson(bytes, {
            maxBytes: Math.max(bytes.byteLength, 1),
            maxDepth: Math.min(Math.max(bytes.byteLength, 64), 4096),
          });
        } catch {
          return { value, media: [] };
        }
        const extracted = extractEmbeddedToolMedia(parsed, depth + 1);
        if (extracted.media.length > 0) {
          return {
            value: new TextDecoder().decode(serializeWireJson(extracted.value)),
            media: extracted.media,
          };
        }
      }
      return { value, media: [] };
    }
    if (isWireJsonArray(value)) {
      const items: WireJson[] = [];
      const media: SemanticImage[] = [];
      for (const item of value.items) {
        const extracted = extractEmbeddedToolMedia(item, depth + 1);
        items.push(extracted.value);
        media.push(...extracted.media);
      }
      return { value: { kind: "array", items }, media };
    }
    if (!isWireJsonObject(value)) {
      return { value, media: [] };
    }
    const type = oneMember(value, "type", "REQ-TOOL-RESULT-EMBEDDED-TYPE");
    if (type === "image") {
      assertAllowedKeys(value, new Set(["type", "source"]), "REQ-TOOL-RESULT-EMBEDDED-IMAGE");
      return {
        value: "[cc-switch: tool result media moved to the following user message]",
        media: [decodeMessagesImage(oneMember(value, "source", "REQ-TOOL-RESULT-EMBEDDED-IMAGE"))],
      };
    }
    if (type === "input_image") {
      assertAllowedKeys(value, new Set(["type", "image_url", "detail"]), "REQ-TOOL-RESULT-EMBEDDED-IMAGE");
      return {
        value: "[cc-switch: tool result media moved to the following user message]",
        media: [imageContent(
          requiredString(
            oneMember(value, "image_url", "REQ-TOOL-RESULT-EMBEDDED-URL"),
            "REQ-TOOL-RESULT-EMBEDDED-URL",
          ),
          optionalString(
            oneMember(value, "detail", "REQ-TOOL-RESULT-EMBEDDED-DETAIL"),
            "REQ-TOOL-RESULT-EMBEDDED-DETAIL",
          ),
          "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
        )],
      };
    }
    if (type === "image_url") {
      assertAllowedKeys(value, new Set(["type", "image_url"]), "REQ-TOOL-RESULT-EMBEDDED-IMAGE");
      const image = requiredObject(
        oneMember(value, "image_url", "REQ-TOOL-RESULT-EMBEDDED-IMAGE"),
        "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
      );
      assertAllowedKeys(image, new Set(["url", "detail"]), "REQ-TOOL-RESULT-EMBEDDED-IMAGE");
      return {
        value: "[cc-switch: tool result media moved to the following user message]",
        media: [imageContent(
          requiredString(
            oneMember(image, "url", "REQ-TOOL-RESULT-EMBEDDED-URL"),
            "REQ-TOOL-RESULT-EMBEDDED-URL",
          ),
          optionalString(
            oneMember(image, "detail", "REQ-TOOL-RESULT-EMBEDDED-DETAIL"),
            "REQ-TOOL-RESULT-EMBEDDED-DETAIL",
          ),
          "REQ-TOOL-RESULT-EMBEDDED-IMAGE",
        )],
      };
    }
    const members: Array<{ key: string; value: WireJson }> = [];
    const media: SemanticImage[] = [];
    for (const member of value.members) {
      if (member.key !== "content") {
        members.push(member);
        continue;
      }
      const extracted = extractEmbeddedToolMedia(member.value, depth + 1);
      members.push({ key: member.key, value: extracted.value });
      media.push(...extracted.media);
    }
    return { value: { kind: "object", members }, media };
  }
  const array = requiredArray(value, "REQ-TOOL-RESULT-CONTENT");
  return array.items.map((item) => {
    const block = requiredObject(item, "REQ-TOOL-RESULT-BLOCK");
    const type = requiredString(
      oneMember(block, "type", "REQ-TOOL-RESULT-TYPE"),
      "REQ-TOOL-RESULT-TYPE",
    );
    if (type === "text" || type === "input_text") {
      assertAllowedKeys(block, new Set(["type", "text", "cache_control"]), "REQ-TOOL-RESULT-TEXT");
      if (oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE") !== undefined) {
        validateCacheControl(oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE"));
        degradations.add("cache.control_omitted");
      }
      return {
        type: "text",
        text: requiredString(
          oneMember(block, "text", "REQ-TOOL-RESULT-TEXT"),
          "REQ-TOOL-RESULT-TEXT",
          true,
        ),
      } as const;
    }
    if (type === "image") {
      assertAllowedKeys(block, new Set(["type", "source", "cache_control"]), "REQ-TOOL-RESULT-IMAGE");
      if (oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE") !== undefined) {
        validateCacheControl(oneMember(block, "cache_control", "REQ-TOOL-RESULT-CACHE"));
        degradations.add("cache.control_omitted");
      }
      return decodeMessagesImage(oneMember(block, "source", "REQ-TOOL-RESULT-IMAGE"));
    }
    if (type === "input_image") {
      assertAllowedKeys(block, new Set(["type", "image_url", "detail"]), "REQ-TOOL-RESULT-IMAGE");
      return imageContent(
        requiredString(
          oneMember(block, "image_url", "REQ-TOOL-RESULT-IMAGE-URL"),
          "REQ-TOOL-RESULT-IMAGE-URL",
        ),
        optionalString(
          oneMember(block, "detail", "REQ-TOOL-RESULT-IMAGE-DETAIL"),
          "REQ-TOOL-RESULT-IMAGE-DETAIL",
        ),
        "REQ-TOOL-RESULT-IMAGE",
      );
    }
    unsupported("REQ-TOOL-RESULT-TYPE");
  });
}

function decodeChatTools(value: WireJson | undefined): readonly SemanticTool[] {
  if (value === undefined) {
    return [];
  }
  return requiredArray(value, "REQ-C-TOOLS").items.map((item) => {
    const tool = requiredObject(item, "REQ-C-TOOL");
    assertAllowedKeys(tool, new Set(["type", "function"]), "REQ-C-TOOL");
    if (requiredString(oneMember(tool, "type", "REQ-C-TOOL-TYPE"), "REQ-C-TOOL-TYPE") !== "function") {
      unsupported("REQ-C-TOOL-TYPE");
    }
    const fn = requiredObject(oneMember(tool, "function", "REQ-C-TOOL-FUNCTION"), "REQ-C-TOOL-FUNCTION");
    assertAllowedKeys(fn, new Set(["name", "description", "parameters", "strict"]), "REQ-C-TOOL-FUNCTION");
    return semanticTool(fn, "parameters", "REQ-C-TOOL", false);
  });
}

function decodeMessagesTools(value: WireJson | undefined): readonly SemanticTool[] {
  if (value === undefined) {
    return [];
  }
  return requiredArray(value, "REQ-M-TOOLS").items.map((item) => {
    const tool = requiredObject(item, "REQ-M-TOOL");
    assertAllowedKeys(tool, new Set(["name", "description", "input_schema", "strict", "type"]), "REQ-M-TOOL");
    const type = optionalString(oneMember(tool, "type", "REQ-M-TOOL-TYPE"), "REQ-M-TOOL-TYPE");
    if (type !== undefined && type !== "custom") {
      unsupported("REQ-M-TOOL-TYPE");
    }
    return semanticTool(tool, "input_schema", "REQ-M-TOOL", false);
  });
}

function decodeResponsesTools(value: WireJson | undefined): readonly SemanticTool[] {
  if (value === undefined) {
    return [];
  }
  return requiredArray(value, "REQ-R-TOOLS").items.map((item) => {
    const tool = requiredObject(item, "REQ-R-TOOL");
    assertAllowedKeys(
      tool,
      new Set(["type", "name", "description", "parameters", "strict"]),
      "REQ-R-TOOL",
    );
    if (requiredString(oneMember(tool, "type", "REQ-R-TOOL-TYPE"), "REQ-R-TOOL-TYPE") !== "function") {
      unsupported("REQ-R-TOOL-TYPE");
    }
    const decoded = semanticTool(tool, "parameters", "REQ-R-TOOL");
    if (decoded.strict !== undefined) {
      return decoded;
    }
    if (!isOpenAiStrictSchemaCompatible(decoded.parameters)) {
      unsupported("REQ-R-TOOL-STRICT-AUTO");
    }
    return { ...decoded, strict: true };
  });
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
    name: requiredString(oneMember(object, "name", `${ruleId}-NAME`), `${ruleId}-NAME`),
    ...(description === undefined ? {} : { description }),
    parameters: requiredObject(oneMember(object, schemaKey, `${ruleId}-SCHEMA`), `${ruleId}-SCHEMA`),
    ...(strict === undefined && defaultStrict === undefined ? {} : { strict: strict ?? defaultStrict }),
  };
}

function decodeChatToolChoice(value: WireJson | undefined): SemanticToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      return { kind: value };
    }
    invalid("REQ-C-TOOL-CHOICE");
  }
  const object = requiredObject(value, "REQ-C-TOOL-CHOICE");
  assertAllowedKeys(object, new Set(["type", "function"]), "REQ-C-TOOL-CHOICE");
  if (requiredString(oneMember(object, "type", "REQ-C-TOOL-CHOICE-TYPE"), "REQ-C-TOOL-CHOICE-TYPE") !== "function") {
    unsupported("REQ-C-TOOL-CHOICE-TYPE");
  }
  const fn = requiredObject(
    oneMember(object, "function", "REQ-C-TOOL-CHOICE-FUNCTION"),
    "REQ-C-TOOL-CHOICE-FUNCTION",
  );
  assertAllowedKeys(fn, new Set(["name"]), "REQ-C-TOOL-CHOICE-FUNCTION");
  return {
    kind: "tool",
    name: requiredString(oneMember(fn, "name", "REQ-C-TOOL-CHOICE-NAME"), "REQ-C-TOOL-CHOICE-NAME"),
  };
}

function decodeMessagesToolChoice(value: WireJson | undefined): SemanticToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, "REQ-M-TOOL-CHOICE");
  assertAllowedKeys(object, new Set(["type", "name", "disable_parallel_tool_use"]), "REQ-M-TOOL-CHOICE");
  const type = requiredString(oneMember(object, "type", "REQ-M-TOOL-CHOICE-TYPE"), "REQ-M-TOOL-CHOICE-TYPE");
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
    return {
      kind: "tool",
      name: requiredString(oneMember(object, "name", "REQ-M-TOOL-CHOICE-NAME"), "REQ-M-TOOL-CHOICE-NAME"),
    };
  }
  unsupported("REQ-M-TOOL-CHOICE-TYPE");
}

function messagesParallelToolCalls(value: WireJson | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, "REQ-M-TOOL-CHOICE");
  const disabled = optionalBoolean(
    oneMember(object, "disable_parallel_tool_use", "REQ-M-PARALLEL"),
    "REQ-M-PARALLEL",
  );
  return disabled === undefined ? undefined : !disabled;
}

function decodeResponsesToolChoice(value: WireJson | undefined): SemanticToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      return { kind: value };
    }
    invalid("REQ-R-TOOL-CHOICE");
  }
  const object = requiredObject(value, "REQ-R-TOOL-CHOICE");
  assertAllowedKeys(object, new Set(["type", "name"]), "REQ-R-TOOL-CHOICE");
  if (requiredString(oneMember(object, "type", "REQ-R-TOOL-CHOICE-TYPE"), "REQ-R-TOOL-CHOICE-TYPE") !== "function") {
    unsupported("REQ-R-TOOL-CHOICE-TYPE");
  }
  return {
    kind: "tool",
    name: requiredString(oneMember(object, "name", "REQ-R-TOOL-CHOICE-NAME"), "REQ-R-TOOL-CHOICE-NAME"),
  };
}

function decodeChatOutputFormat(value: WireJson | undefined): SemanticOutputFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, "REQ-C-FORMAT");
  assertAllowedKeys(object, new Set(["type", "json_schema"]), "REQ-C-FORMAT");
  const type = requiredString(oneMember(object, "type", "REQ-C-FORMAT-TYPE"), "REQ-C-FORMAT-TYPE");
  if (type === "json_object") {
    return { kind: "json_object" };
  }
  if (type !== "json_schema") {
    unsupported("REQ-C-FORMAT-TYPE");
  }
  return decodeNamedSchema(
    requiredObject(oneMember(object, "json_schema", "REQ-C-FORMAT-SCHEMA"), "REQ-C-FORMAT-SCHEMA"),
    "REQ-C-FORMAT-SCHEMA",
  );
}

function decodeMessagesOutputFormat(value: WireJson | undefined): SemanticOutputFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, "REQ-M-FORMAT");
  assertAllowedKeys(object, new Set(["type", "name", "description", "schema", "strict"]), "REQ-M-FORMAT");
  const type = requiredString(oneMember(object, "type", "REQ-M-FORMAT-TYPE"), "REQ-M-FORMAT-TYPE");
  if (type === "json_object") {
    return { kind: "json_object" };
  }
  if (type !== "json_schema") {
    unsupported("REQ-M-FORMAT-TYPE");
  }
  const description = optionalString(
    oneMember(object, "description", "REQ-M-FORMAT-DESCRIPTION"),
    "REQ-M-FORMAT-DESCRIPTION",
  );
  const strict = optionalBoolean(oneMember(object, "strict", "REQ-M-FORMAT-STRICT"), "REQ-M-FORMAT-STRICT");
  if (strict === false) {
    unsupported("REQ-M-FORMAT-STRICT");
  }
  const schema = requiredObject(oneMember(object, "schema", "REQ-M-FORMAT-SCHEMA"), "REQ-M-FORMAT-SCHEMA");
  validateOpenAiStrictSchema(schema, true);
  return {
    kind: "json_schema",
    name: optionalString(oneMember(object, "name", "REQ-M-FORMAT-NAME"), "REQ-M-FORMAT-NAME") ?? "response",
    ...(description === undefined ? {} : { description }),
    schema,
    strict: true,
  };
}

function validateOpenAiStrictSchema(schema: WireJsonObject, root = false, depth = 0): void {
  if (!isOpenAiStrictSchemaCompatible(schema, root, depth)) {
    unsupported("REQ-M-FORMAT-STRICT-SCHEMA");
  }
}

function decodeResponsesOutputFormat(body: WireJsonObject): SemanticOutputFormat | undefined {
  const text = optionalObject(oneMember(body, "text", "REQ-R-TEXT-FORMAT"), "REQ-R-TEXT-FORMAT");
  const responseFormat = oneMember(body, "response_format", "REQ-R-FORMAT");
  if (text !== undefined) {
    assertAllowedKeys(text, new Set(["format"]), "REQ-R-TEXT-FORMAT");
  }
  const textFormat = text === undefined ? undefined : oneMember(text, "format", "REQ-R-TEXT-FORMAT");
  if (textFormat !== undefined && responseFormat !== undefined) {
    invalid("REQ-R-FORMAT-CONFLICT");
  }
  const value = textFormat ?? responseFormat;
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, "REQ-R-FORMAT");
  assertAllowedKeys(object, new Set(["type", "name", "description", "schema", "strict"]), "REQ-R-FORMAT");
  const type = requiredString(oneMember(object, "type", "REQ-R-FORMAT-TYPE"), "REQ-R-FORMAT-TYPE");
  if (type === "json_object") {
    return { kind: "json_object" };
  }
  if (type !== "json_schema") {
    unsupported("REQ-R-FORMAT-TYPE");
  }
  return decodeNamedSchema(object, "REQ-R-FORMAT");
}

function decodeNamedSchema(object: WireJsonObject, ruleId: string): SemanticOutputFormat {
  assertAllowedKeys(object, new Set(["type", "name", "description", "schema", "strict"]), ruleId);
  const description = optionalString(oneMember(object, "description", `${ruleId}-DESCRIPTION`), `${ruleId}-DESCRIPTION`);
  const strict = optionalBoolean(oneMember(object, "strict", `${ruleId}-STRICT`), `${ruleId}-STRICT`);
  return {
    kind: "json_schema",
    name: requiredString(oneMember(object, "name", `${ruleId}-NAME`), `${ruleId}-NAME`),
    ...(description === undefined ? {} : { description }),
    schema: requiredObject(oneMember(object, "schema", `${ruleId}-VALUE`), `${ruleId}-VALUE`),
    ...(strict === undefined ? {} : { strict }),
  };
}

function decodeMessagesThinking(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticReasoning | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, "REQ-M-THINKING");
  assertAllowedKeys(object, new Set(["type", "budget_tokens"]), "REQ-M-THINKING");
  const type = requiredString(oneMember(object, "type", "REQ-M-THINKING-TYPE"), "REQ-M-THINKING-TYPE");
  if (type === "disabled") {
    return undefined;
  }
  if (type === "adaptive") {
    degradations.add("reasoning.budget_coarsened");
    return { effort: "xhigh" };
  }
  if (type !== "enabled") {
    unsupported("REQ-M-THINKING-TYPE");
  }
  const budget = positiveInteger(oneMember(object, "budget_tokens", "REQ-M-THINKING-BUDGET"), "REQ-M-THINKING-BUDGET");
  degradations.add("reasoning.budget_coarsened");
  return { effort: effortFromBudget(budget ?? 0) };
}

function encodeChatRequest(
  request: Readonly<SemanticRequest>,
  context: Readonly<EncodeContext>,
): EncodedConversionRequest {
  const messages = encodeChatMessages(request);
  const budget = request.source === "messages"
    ? outputBudget(request.maxOutputTokens, context.capability)
    : request.maxOutputTokens;
  const tokenField = context.capability.profile.chatOutputTokenField.value;
  if (budget !== undefined && tokenField === null) {
    unsupported("REQ-TARGET-C-TOKEN-DIALECT");
  }
  const body = wireObject([
    ["model", context.resolvedModel],
    ["messages", wireArray(messages)],
    ...(budget === undefined || tokenField === null ? [] : [[tokenField, wireNumber(budget)] as const]),
    ["temperature", request.temperature === undefined ? undefined : wireNumber(request.temperature)],
    ["top_p", request.topP === undefined ? undefined : wireNumber(request.topP)],
    ["stop", request.stop === undefined ? undefined : wireArray(request.stop)],
    ["stream", request.stream ? true : undefined],
    ["stream_options", request.stream ? wireObject([["include_usage", true]]) : undefined],
    ["tools", request.tools.length === 0 ? undefined : wireArray(request.tools.map(encodeChatTool))],
    ["tool_choice", encodeChatToolChoice(request.toolChoice)],
    ["parallel_tool_calls", request.parallelToolCalls],
    ["response_format", encodeChatOutputFormat(request.outputFormat)],
    ["reasoning_effort", request.reasoning?.effort],
    ["metadata", request.metadata],
  ]);
  return encodedRequest(request, body);
}

function encodeResponsesRequest(
  request: Readonly<SemanticRequest>,
  context: Readonly<EncodeContext>,
): EncodedConversionRequest {
  if (request.stop !== undefined) {
    unsupported("REQ-TARGET-R-STOP");
  }
  const body = wireObject([
    ["model", context.resolvedModel],
    ["instructions", textContent(request.instructions)],
    ["input", wireArray(encodeResponsesItems(request.items))],
    ["max_output_tokens", request.maxOutputTokens === undefined ? undefined : wireNumber(request.maxOutputTokens)],
    ["temperature", request.temperature === undefined ? undefined : wireNumber(request.temperature)],
    ["top_p", request.topP === undefined ? undefined : wireNumber(request.topP)],
    ["stream", request.stream ? true : undefined],
    ["tools", request.tools.length === 0 ? undefined : wireArray(request.tools.map(encodeResponsesTool))],
    ["tool_choice", encodeResponsesToolChoice(request.toolChoice)],
    ["parallel_tool_calls", request.parallelToolCalls],
    ["text", request.outputFormat === undefined
      ? undefined
      : wireObject([["format", encodeResponsesOutputFormat(request.outputFormat)]])],
    ["reasoning", request.reasoning?.effort === undefined
      ? undefined
      : wireObject([["effort", request.reasoning.effort]])],
    ["metadata", request.metadata],
  ]);
  return encodedRequest(request, body);
}

function encodeMessagesRequest(
  request: Readonly<SemanticRequest>,
  context: Readonly<EncodeContext>,
): EncodedConversionRequest {
  if (request.temperature !== undefined && request.temperature > 1) {
    unsupported("REQ-TARGET-M-TEMPERATURE");
  }
  if (
    request.metadata !== undefined
    && (!isWireJsonObject(request.metadata)
      || request.metadata.members.some((member) => member.key !== "user_id"))
  ) {
    unsupported("REQ-TARGET-M-METADATA");
  }
  if (request.outputFormat?.kind === "json_object") {
    unsupported("REQ-TARGET-M-JSON-OBJECT");
  }
  const targetReasoning = request.reasoning?.effort === "none"
    ? undefined
    : request.reasoning?.effort === "minimal"
      ? { effort: "low" as const }
      : request.reasoning;
  const targetDegradations: ConversionDegradationRule[] = request.reasoning?.effort === "minimal"
    ? ["reasoning.budget_coarsened"]
    : [];
  const budget = outputBudget(request.maxOutputTokens, context.capability);
  const split = splitMessagesInstructions(request);
  const body = wireObject([
    ["model", context.resolvedModel],
    ["system", encodeMessagesSystem(split.instructions)],
    ["messages", wireArray(encodeMessagesItems(split.items))],
    ["max_tokens", wireNumber(budget)],
    ["temperature", request.temperature === undefined ? undefined : wireNumber(request.temperature)],
    ["top_p", request.topP === undefined ? undefined : wireNumber(request.topP)],
    ["stop_sequences", request.stop === undefined ? undefined : wireArray(request.stop)],
    ["stream", request.stream ? true : undefined],
    ["tools", request.tools.length === 0 ? undefined : wireArray(request.tools.map(encodeMessagesTool))],
    ["tool_choice", encodeMessagesToolChoice(request.toolChoice, request.parallelToolCalls)],
    ["output_config", encodeMessagesOutputConfig(request.outputFormat, targetReasoning)],
    ["metadata", request.metadata],
  ]);
  return encodedRequest(request, body, targetDegradations);
}

function splitMessagesInstructions(request: Readonly<SemanticRequest>): {
  readonly instructions: readonly SemanticContent[];
  readonly items: readonly SemanticRequestItem[];
} {
  const instructions = [...request.instructions];
  let index = 0;
  for (; index < request.items.length; index += 1) {
    const item = request.items[index];
    if (item?.type !== "message" || (item.role !== "system" && item.role !== "developer")) {
      break;
    }
    instructions.push(...item.content);
  }
  if (request.items.slice(index).some((item) => (
    item.type === "message" && (item.role === "system" || item.role === "developer")
  ))) {
    unsupported("REQ-TARGET-M-MIDSTREAM-INSTRUCTION");
  }
  return { instructions, items: request.items.slice(index) };
}

function encodeChatMessages(request: Readonly<SemanticRequest>): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  let toolRoundOpen = false;
  if (request.instructions.length > 0) {
    output.push(wireObject([["role", "system"], ["content", textContent(request.instructions) ?? ""]]));
  }
  for (let itemIndex = 0; itemIndex < request.items.length; itemIndex += 1) {
    const item = request.items[itemIndex];
    if (item === undefined) {
      continue;
    }
    if (item.type === "message") {
      if (toolRoundOpen) {
        unsupported("REQ-TARGET-C-TOOL-ROUND-ORDER");
      }
      output.push(wireObject([
        ["role", item.role],
        ["content", encodeChatContent(item.content)],
      ]));
      continue;
    }
    if (item.type === "tool_call") {
      const last = output.at(-1);
      if (last !== undefined && oneMember(last, "role", "REQ-INTERNAL") === "assistant") {
        appendObjectArrayMember(last, "tool_calls", encodeChatToolCall(item));
        if (oneMember(last, "content", "REQ-INTERNAL") === undefined) {
          appendMember(last, "content", null);
        }
      } else {
        output.push(wireObject([
          ["role", "assistant"],
          ["content", null],
          ["tool_calls", wireArray([encodeChatToolCall(item)])],
        ]));
      }
      toolRoundOpen = true;
      continue;
    }
    const results: SemanticToolResultItem[] = [];
    for (; itemIndex < request.items.length; itemIndex += 1) {
      const candidate = request.items[itemIndex];
      if (candidate?.type !== "tool_result") {
        itemIndex -= 1;
        break;
      }
      results.push(candidate);
    }
    const mediaContent: WireJson[] = [];
    for (const result of results) {
      const text = textContent(result.content) ?? "";
      const images = result.content.filter((part): part is SemanticImage => part.type === "image");
      output.push(wireObject([
        ["role", "tool"],
        ["tool_call_id", result.callId],
        ["content", images.length === 0
          ? toolResultText(text, result.isError)
          : `${toolResultText(text, result.isError)}${text.length === 0 && !result.isError ? "" : "\n"}[cc-switch: tool result media moved to the following user message]`],
      ]));
      if (images.length > 0) {
        mediaContent.push(
          wireObject([["type", "text"], ["text", `[cc-switch: media output of tool call ${result.callId}]`]]),
          ...images.map(encodeChatImage),
        );
      }
    }
    toolRoundOpen = false;
    if (mediaContent.length > 0) {
      output.push(wireObject([["role", "user"], ["content", wireArray(mediaContent)]]));
    }
  }
  return output;
}

function encodeResponsesItems(items: readonly SemanticRequestItem[]): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  for (const item of items) {
    if (item.type === "message") {
      output.push(wireObject([
        ["type", "message"],
        ["role", item.role],
        ["content", wireArray(item.content.map((part) => encodeResponsesContent(part, item.role === "assistant")))],
      ]));
    } else if (item.type === "tool_call") {
      output.push(wireObject([
        ["type", "function_call"],
        ["id", item.itemId],
        ["call_id", item.callId],
        ["name", item.name],
        ["arguments", item.argumentsJson],
      ]));
    } else {
      output.push(wireObject([
        ["type", "function_call_output"],
        ["call_id", item.callId],
        ["output", encodeResponsesToolResultContent(item.content, item.isError)],
      ]));
    }
  }
  return output;
}

function encodeMessagesItems(items: readonly SemanticRequestItem[]): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  for (const item of items) {
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") {
        if (output.length > 0) {
          unsupported("REQ-TARGET-M-MIDSTREAM-INSTRUCTION");
        }
        continue;
      }
      pushMessagesRole(output, item.role, item.content.map(encodeMessagesContent));
      continue;
    }
    if (item.type === "tool_call") {
      const input = parseArgumentsObject(item.argumentsJson, "REQ-TARGET-M-TOOL-ARGS");
      pushMessagesRole(output, "assistant", [wireObject([
        ["type", "tool_use"],
        ["id", item.callId],
        ["name", item.name],
        ["input", input],
      ])]);
      continue;
    }
    pushMessagesRole(output, "user", [wireObject([
      ["type", "tool_result"],
      ["tool_use_id", item.callId],
      ["content", wireArray(item.content.map(encodeMessagesContent))],
      ["is_error", item.isError ? true : undefined],
    ])]);
  }
  if (output.length === 0) {
    unsupported("REQ-TARGET-M-EMPTY");
  }
  return output;
}

function encodeMessagesSystem(content: readonly SemanticContent[]): WireJson | undefined {
  if (content.length === 0) {
    return undefined;
  }
  return wireArray(content.map((part) => {
    if (part.type !== "text") {
      unsupported("REQ-TARGET-M-SYSTEM-CONTENT");
    }
    return wireObject([["type", "text"], ["text", part.text]]);
  }));
}

function pushMessagesRole(
  output: WireJsonObject[],
  role: "user" | "assistant",
  blocks: readonly WireJson[],
): void {
  const previous = output.at(-1);
  if (previous !== undefined && oneMember(previous, "role", "REQ-INTERNAL") === role) {
    const content = oneMember(previous, "content", "REQ-INTERNAL");
    if (isWireJsonArray(content)) {
      (content.items as WireJson[]).push(...blocks);
      return;
    }
  }
  output.push(wireObject([["role", role], ["content", wireArray(blocks)]]));
}

function encodeChatContent(content: readonly SemanticContent[]): WireJson {
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }
  return wireArray(content.map((part) => {
    if (part.type === "text") {
      return wireObject([["type", "text"], ["text", part.text]]);
    }
    if (part.type === "image") {
      return encodeChatImage(part);
    }
    return wireObject([["type", "text"], ["text", part.text]]);
  }));
}

function encodeChatImage(part: SemanticImage): WireJsonObject {
  return wireObject([
    ["type", "image_url"],
    ["image_url", wireObject([["url", part.url], ["detail", part.detail]])],
  ]);
}

function encodeResponsesContent(content: SemanticContent, assistant: boolean): WireJsonObject {
  if (content.type === "image") {
    if (assistant) {
      unsupported("REQ-TARGET-R-ASSISTANT-IMAGE");
    }
    return wireObject([["type", "input_image"], ["image_url", content.url], ["detail", content.detail]]);
  }
  if (content.type === "refusal") {
    return wireObject([["type", "refusal"], ["refusal", content.text]]);
  }
  return wireObject([["type", assistant ? "output_text" : "input_text"], ["text", content.text]]);
}

function encodeResponsesToolResultContent(
  content: readonly SemanticContent[],
  isError: boolean,
): WireJson {
  if (!isError && content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }
  return wireArray([
    ...(isError
      ? [wireObject([["type", "input_text"], ["text", "[cc-switch:tool-result-error]"]])]
      : []),
    ...content.map((part) => encodeResponsesContent(part, false)),
  ]);
}

function encodeMessagesContent(content: SemanticContent): WireJsonObject {
  if (content.type === "text") {
    return wireObject([["type", "text"], ["text", content.text]]);
  }
  if (content.type === "refusal") {
    return wireObject([["type", "text"], ["text", content.text]]);
  }
  const data = parseDataUrl(content.url);
  if (data !== undefined) {
    return wireObject([
      ["type", "image"],
      ["source", wireObject([
        ["type", "base64"],
        ["media_type", data.mediaType],
        ["data", data.data],
      ])],
    ]);
  }
  return wireObject([
    ["type", "image"],
    ["source", wireObject([["type", "url"], ["url", content.url]])],
  ]);
}

function encodeChatTool(tool: SemanticTool): WireJsonObject {
  return wireObject([
    ["type", "function"],
    ["function", wireObject([
      ["name", tool.name],
      ["description", tool.description],
      ["parameters", tool.parameters],
      ["strict", tool.strict],
    ])],
  ]);
}

function encodeResponsesTool(tool: SemanticTool): WireJsonObject {
  return wireObject([
    ["type", "function"],
    ["name", tool.name],
    ["description", tool.description],
    ["parameters", tool.parameters],
    ["strict", tool.strict],
  ]);
}

function encodeMessagesTool(tool: SemanticTool): WireJsonObject {
  return wireObject([
    ["name", tool.name],
    ["description", tool.description],
    ["input_schema", tool.parameters],
    ["strict", tool.strict],
  ]);
}

function encodeChatToolCall(item: Extract<SemanticRequestItem, { readonly type: "tool_call" }>): WireJsonObject {
  return wireObject([
    ["id", item.callId],
    ["type", "function"],
    ["function", wireObject([["name", item.name], ["arguments", item.argumentsJson]])],
  ]);
}

function encodeChatToolChoice(choice: SemanticToolChoice | undefined): WireJson | undefined {
  if (choice === undefined || choice.kind !== "tool") {
    return choice?.kind;
  }
  return wireObject([["type", "function"], ["function", wireObject([["name", choice.name]])]]);
}

function encodeResponsesToolChoice(choice: SemanticToolChoice | undefined): WireJson | undefined {
  if (choice === undefined || choice.kind !== "tool") {
    return choice?.kind;
  }
  return wireObject([["type", "function"], ["name", choice.name]]);
}

function encodeMessagesToolChoice(
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

function encodeChatOutputFormat(format: SemanticOutputFormat | undefined): WireJson | undefined {
  if (format === undefined || format.kind === "json_object") {
    return format === undefined ? undefined : wireObject([["type", "json_object"]]);
  }
  return wireObject([
    ["type", "json_schema"],
    ["json_schema", encodeNamedSchema(format)],
  ]);
}

function encodeResponsesOutputFormat(format: SemanticOutputFormat): WireJsonObject {
  return format.kind === "json_object"
    ? wireObject([["type", "json_object"]])
    : wireObject([["type", "json_schema"], ...namedSchemaEntries(format)]);
}

function encodeMessagesOutputConfig(
  format: SemanticOutputFormat | undefined,
  reasoning: SemanticReasoning | undefined,
): WireJson | undefined {
  if (format === undefined && reasoning?.effort === undefined) {
    return undefined;
  }
  return wireObject([
    ["effort", reasoning?.effort],
    ["format", format === undefined
      ? undefined
      : format.kind === "json_object"
        ? undefined
        : wireObject([["type", "json_schema"], ["schema", format.schema]])],
  ]);
}

function encodeNamedSchema(format: Extract<SemanticOutputFormat, { readonly kind: "json_schema" }>): WireJsonObject {
  return wireObject(namedSchemaEntries(format));
}

function namedSchemaEntries(
  format: Extract<SemanticOutputFormat, { readonly kind: "json_schema" }>,
): readonly (readonly [string, WireJson | undefined])[] {
  return [
    ["name", format.name],
    ["description", format.description],
    ["schema", format.schema],
    ["strict", format.strict],
  ];
}

function encodedRequest(
  request: Readonly<SemanticRequest>,
  body: WireJsonObject,
  additionalDegradations: readonly ConversionDegradationRule[] = [],
): EncodedConversionRequest {
  const firstItem = request.items[0];
  return Object.freeze({
    body,
    bytes: encodeWireObject(body),
    stream: request.stream,
    hasVisionInput: request.instructions.some((part) => part.type === "image")
      || request.items.some((item) => (
        (item.type === "message" || item.type === "tool_result")
        && item.content.some((part) => part.type === "image")
      )),
    initiator: firstItem?.type === "message" && firstItem.role === "assistant" ? "agent" : "user",
    messagesBetaFeatures: [],
    degradations: [...new Set([...request.degradations, ...additionalDegradations])],
  });
}

function outputBudget(explicit: number | undefined, capability: EffectiveModelCapabilitySnapshot): number {
  try {
    return chooseOutputTokenBudget(explicit, capability.defaultOutputTokens);
  } catch {
    invalid("REQ-TARGET-M-LIMIT");
  }
}

function validateStreamOptions(value: WireJson | undefined): void {
  if (value === undefined) {
    return;
  }
  const object = requiredObject(value, "REQ-STREAM-OPTIONS");
  assertAllowedKeys(object, new Set(["include_usage"]), "REQ-STREAM-OPTIONS");
  optionalBoolean(oneMember(object, "include_usage", "REQ-STREAM-USAGE"), "REQ-STREAM-USAGE");
}

function validateSingleChoice(value: WireJson | undefined, ruleId: string): void {
  if (value === undefined) {
    return;
  }
  const parsed = positiveInteger(value, ruleId);
  if (parsed !== 1) {
    unsupported(ruleId);
  }
}

function aliasedPositiveInteger(
  object: WireJsonObject,
  keys: readonly string[],
  ruleId: string,
): number | undefined {
  const values = keys
    .map((key) => positiveInteger(oneMember(object, key, ruleId), ruleId))
    .filter((value): value is number => value !== undefined);
  if (new Set(values).size > 1) {
    invalid(ruleId);
  }
  return values[0];
}

function reasoningFromEffort(
  value: string | undefined,
  ruleId: string,
  allowNone = false,
): SemanticReasoning | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "none" && allowNone) {
    return { effort: "none" };
  }
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return { effort: value };
  }
  if (value === "max") {
    return { effort: "xhigh" };
  }
  invalid(ruleId);
}

function mergeReasoning(
  first: SemanticReasoning | undefined,
  second: SemanticReasoning | undefined,
): SemanticReasoning | undefined {
  if (first?.effort !== undefined && second?.effort !== undefined && first.effort !== second.effort) {
    invalid("REQ-M-REASONING-CONFLICT");
  }
  return first ?? second;
}

function effortFromBudget(value: number): "low" | "medium" | "high" | "xhigh" {
  if (value <= 2048) {
    return "low";
  }
  if (value <= 8192) {
    return "medium";
  }
  if (value <= 16_384) {
    return "high";
  }
  return "xhigh";
}

function imageContent(
  url: string,
  detail: string | undefined,
  ruleId: string,
): SemanticImage {
  if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
    invalid(ruleId);
  }
  if (parseDataUrl(url) === undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid(ruleId);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      unsupported(ruleId);
    }
  }
  return {
    type: "image",
    url,
    ...(detail === undefined ? {} : { detail }),
  };
}

function parseDataUrl(url: string): { readonly mediaType: string; readonly data: string } | undefined {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { mediaType: match[1], data: match[2] };
}

function validateArgumentsJson(value: string, ruleId: string): void {
  parseArgumentsObject(value, ruleId);
}

function validateCacheControl(value: WireJson | undefined): void {
  const object = requiredObject(value, "REQ-M-CACHE-CONTROL");
  assertAllowedKeys(object, new Set(["type", "ttl"]), "REQ-M-CACHE-CONTROL");
  if (oneMember(object, "type", "REQ-M-CACHE-CONTROL-TYPE") !== "ephemeral") {
    invalid("REQ-M-CACHE-CONTROL-TYPE");
  }
  const ttl = optionalString(oneMember(object, "ttl", "REQ-M-CACHE-CONTROL-TTL"), "REQ-M-CACHE-CONTROL-TTL");
  if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") {
    invalid("REQ-M-CACHE-CONTROL-TTL");
  }
}

function validatedMetadata(
  value: WireJson | undefined,
  source: InferenceProtocol,
): WireJson | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = requiredObject(value, `REQ-${source.toUpperCase()}-METADATA`);
  if (source === "messages") {
    assertAllowedKeys(object, new Set(["user_id"]), "REQ-M-METADATA");
  }
  for (const member of object.members) {
    if (typeof member.value !== "string") {
      invalid(`REQ-${source.toUpperCase()}-METADATA`);
    }
  }
  return object;
}

function parseArgumentsObject(value: string, ruleId: string): WireJsonObject {
  let parsed: WireJson;
  try {
    const bytes = new TextEncoder().encode(value);
    parsed = parseWireJson(bytes, { maxBytes: Math.max(bytes.byteLength, 1), maxDepth: 32 });
  } catch {
    invalid(ruleId);
  }
  return requiredObject(parsed, ruleId);
}

function textContent(content: readonly SemanticContent[]): string | undefined {
  const text = content
    .filter((part): part is Extract<SemanticContent, { readonly type: "text" | "refusal" }> => (
      part.type === "text" || part.type === "refusal"
    ))
    .map((part) => part.text)
    .join("");
  return text.length === 0 ? undefined : text;
}

function toolResultText(text: string, isError: boolean): string {
  return isError
    ? `[cc-switch:tool-result-error]${text.length === 0 ? "" : `\n${text}`}`
    : text;
}

function appendMember(object: WireJsonObject, key: string, value: WireJson): void {
  (object.members as Array<{ key: string; value: WireJson }>).push({ key, value });
}

function appendObjectArrayMember(object: WireJsonObject, key: string, value: WireJsonObject): void {
  const existing = oneMember(object, key, "REQ-INTERNAL");
  if (isWireJsonArray(existing)) {
    (existing.items as WireJson[]).push(value);
    return;
  }
  appendMember(object, key, wireArray([value]));
}
