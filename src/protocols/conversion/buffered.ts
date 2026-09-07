import { GatewayFailureError } from "../../gateway/failures.js";
import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type {
  ConversionDegradationRule,
  ConvertedBufferedResponse,
  InferenceProtocol,
  SemanticContent,
  SemanticRefusal,
  SemanticResponse,
  SemanticResponseItem,
  SemanticToolCallItem,
  SemanticUsage,
} from "./types.js";
import { encodeWireObject, wireArray, wireNumber, wireObject } from "./wire.js";
import { managedConvertedResponseId } from "./ids.js";

export interface BufferedConversionContext {
  readonly source: InferenceProtocol;
  readonly target: InferenceProtocol;
  readonly model: string;
  readonly maxBytes: number;
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

export function convertBufferedResponse(
  bytes: Uint8Array,
  context: Readonly<BufferedConversionContext>,
): ConvertedBufferedResponse {
  const payload = parseObject(bytes, context.maxBytes);
  const semantic = decodeBuffered(context.source, payload);
  const envelope = responseEnvelope(semantic, context);
  const checkpoint = context.target === "responses"
    ? responseCheckpoint(envelope)
    : undefined;
  return {
    body: envelope,
    bytes: encodeWireObject(envelope),
    observations: {
      firstSemantic: semantic.items.length > 0,
      usage: semantic.usage,
      terminal: semantic.status,
      degradations: context.degradations ?? [],
    },
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

function decodeBuffered(source: InferenceProtocol, payload: WireJsonObject): SemanticResponse {
  if (source === "chat") {
    return decodeChat(payload);
  }
  if (source === "messages") {
    return decodeMessages(payload);
  }
  return decodeResponses(payload);
}

function decodeChat(payload: WireJsonObject): SemanticResponse {
  const choices = arrayMember(payload, "choices");
  if (choices === undefined || choices.items.length !== 1 || !isWireJsonObject(choices.items[0])) {
    upstreamInvalid();
  }
  const choice = choices.items[0];
  const message = objectMember(choice, "message");
  if (message === undefined) {
    upstreamInvalid();
  }
  const items: SemanticResponseItem[] = [];
  const finishReason = chatFinishReason(singleMember(choice, "finish_reason"));
  const completeTools = finishReason !== "length" && finishReason !== "content_filter";
  const content: Array<Extract<SemanticContent, { readonly type: "text" | "refusal" }>> = [];
  const text = stringOrNullMember(message, "content");
  if (text !== undefined && text !== null) {
    content.push({ type: "text", text });
  }
  const refusal = stringOrNullMember(message, "refusal");
  if (refusal !== undefined && refusal !== null) {
    content.push({ type: "refusal", text: refusal });
  }
  if (content.length > 0) {
    items.push({ type: "message", content });
  }
  const toolCalls = arrayMember(message, "tool_calls");
  if (toolCalls !== undefined) {
    for (const value of toolCalls.items) {
      items.push(decodeChatToolCall(value, completeTools));
    }
  }
  if (finishReason === "tool_calls" && !items.some((item) => item.type === "tool_call")) {
    upstreamInvalid();
  }
  return {
    source: "chat",
    items,
    status: finishReason === "length" || finishReason === "content_filter" ? "incomplete" : "completed",
    finishReason,
    usage: chatUsage(objectMember(payload, "usage")),
  };
}

function decodeChatToolCall(value: WireJson, complete: boolean): SemanticToolCallItem {
  if (!isWireJsonObject(value)) {
    upstreamInvalid();
  }
  const fn = objectMember(value, "function");
  if (fn === undefined) {
    upstreamInvalid();
  }
  const callId = stringMember(value, "id");
  const name = stringMember(fn, "name");
  const argumentsJson = stringMember(fn, "arguments");
  if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0 || argumentsJson === undefined) {
    upstreamInvalid();
  }
  if (complete) {
    validateCompleteArguments(argumentsJson);
  }
  return { type: "tool_call", callId, name, argumentsJson };
}

function chatFinishReason(value: WireJson | undefined): SemanticResponse["finishReason"] {
  if (value === "stop") {
    return "stop";
  }
  if (value === "tool_calls" || value === "length" || value === "content_filter") {
    return value;
  }
  upstreamInvalid();
}

function decodeMessages(payload: WireJsonObject): SemanticResponse {
  if (singleMember(payload, "type") !== "message" || singleMember(payload, "role") !== "assistant") {
    upstreamInvalid();
  }
  const content = arrayMember(payload, "content");
  if (content === undefined) {
    upstreamInvalid();
  }
  const items: SemanticResponseItem[] = [];
  let messageContent: Array<Extract<SemanticContent, { readonly type: "text" | "refusal" }>> = [];
  const flushMessage = (): void => {
    if (messageContent.length > 0) {
      items.push({ type: "message", content: messageContent });
      messageContent = [];
    }
  };
  for (const value of content.items) {
    if (!isWireJsonObject(value)) {
      upstreamInvalid();
    }
    const type = stringMember(value, "type");
    if (type === "text") {
      const text = stringMember(value, "text");
      if (text === undefined) {
        upstreamInvalid();
      }
      messageContent.push({ type: "text", text });
      continue;
    }
    if (type === "refusal") {
      const refusal = stringMember(value, "refusal") ?? stringMember(value, "text");
      if (refusal === undefined) {
        upstreamInvalid();
      }
      messageContent.push({ type: "refusal", text: refusal });
      continue;
    }
    if (type === "tool_use") {
      flushMessage();
      const callId = stringMember(value, "id");
      const name = stringMember(value, "name");
      const input = objectMember(value, "input");
      if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0 || input === undefined) {
        upstreamInvalid();
      }
      items.push({
        type: "tool_call",
        callId,
        name,
        argumentsJson: new TextDecoder().decode(encodeWireObject(input)),
      });
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      continue;
    }
    upstreamInvalid();
  }
  flushMessage();
  const finishReason = messagesFinishReason(singleMember(payload, "stop_reason"));
  const responseItems = finishReason === "refusal"
    ? items.map((item): SemanticResponseItem => item.type === "message"
      ? {
        type: "message",
        content: item.content.map((part) => (
          part.type === "text" ? { type: "refusal", text: part.text } : part
        )),
      }
      : item)
    : items;
  return {
    source: "messages",
    items: responseItems,
    status: finishReason === "length" || finishReason === "content_filter" || finishReason === "refusal"
      ? "incomplete"
      : "completed",
    finishReason,
    usage: messagesUsage(objectMember(payload, "usage")),
  };
}

function messagesFinishReason(value: WireJson | undefined): SemanticResponse["finishReason"] {
  if (value === "end_turn" || value === "stop_sequence") {
    return "stop";
  }
  if (value === "tool_use") {
    return "tool_calls";
  }
  if (value === "max_tokens" || value === "model_context_window_exceeded") {
    return "length";
  }
  if (value === "refusal") {
    return "refusal";
  }
  upstreamInvalid();
}

function decodeResponses(payload: WireJsonObject): SemanticResponse {
  if (singleMember(payload, "object") !== "response") {
    upstreamInvalid();
  }
  const status = singleMember(payload, "status");
  if (status === "failed") {
    throw new GatewayFailureError({
      kind: "upstream_stream_error",
      source: "converter",
      phase: "convert",
    });
  }
  if (status !== "completed" && status !== "incomplete") {
    upstreamInvalid();
  }
  const output = arrayMember(payload, "output");
  if (output === undefined) {
    upstreamInvalid();
  }
  const items: SemanticResponseItem[] = [];
  for (const value of output.items) {
    if (!isWireJsonObject(value)) {
      upstreamInvalid();
    }
    const type = stringMember(value, "type");
    if (type === "message") {
      const itemStatus = stringMember(value, "status");
      if (
        (itemStatus !== undefined
          && itemStatus !== "completed"
          && itemStatus !== "incomplete"
          && itemStatus !== "in_progress")
        || (status === "completed" && itemStatus !== undefined && itemStatus !== "completed")
      ) {
        upstreamInvalid();
      }
      const content = arrayMember(value, "content");
      if (content === undefined) {
        upstreamInvalid();
      }
      const parts: Array<Extract<SemanticContent, { readonly type: "text" | "refusal" }>> = [];
      for (const part of content.items) {
        if (!isWireJsonObject(part)) {
          upstreamInvalid();
        }
        const partType = stringMember(part, "type");
        if (partType === "output_text") {
          const text = stringMember(part, "text");
          if (text === undefined) {
            upstreamInvalid();
          }
          parts.push({ type: "text", text });
        } else if (partType === "refusal") {
          const refusal = stringMember(part, "refusal");
          if (refusal === undefined) {
            upstreamInvalid();
          }
          parts.push({ type: "refusal", text: refusal });
        } else {
          upstreamInvalid();
        }
      }
      if (parts.length > 0) {
        items.push({ type: "message", content: parts });
      }
      continue;
    }
    if (type === "function_call") {
      const callId = stringMember(value, "call_id");
      const name = stringMember(value, "name");
      const argumentsJson = stringMember(value, "arguments");
      if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0 || argumentsJson === undefined) {
        upstreamInvalid();
      }
      const itemStatus = stringMember(value, "status");
      if (
        itemStatus !== undefined
        && itemStatus !== "completed"
        && itemStatus !== "incomplete"
        && itemStatus !== "in_progress"
      ) {
        upstreamInvalid();
      }
      if (status === "completed" && itemStatus !== undefined && itemStatus !== "completed") {
        upstreamInvalid();
      }
      if (itemStatus === "completed" || (itemStatus === undefined && status === "completed")) {
        validateCompleteArguments(argumentsJson);
      }
      const itemId = stringMember(value, "id");
      items.push({
        type: "tool_call",
        ...(itemId === undefined ? {} : { itemId }),
        callId,
        name,
        argumentsJson,
      });
      continue;
    }
    if (type === "reasoning") {
      continue;
    }
    upstreamInvalid();
  }
  const incompleteReason = status === "incomplete"
    ? stringMember(objectMember(payload, "incomplete_details"), "reason")
    : undefined;
  return {
    source: "responses",
    items,
    status,
    finishReason: status === "incomplete"
      ? incompleteReason === "content_filter" ? "content_filter" : "length"
      : items.some((item) => item.type === "tool_call")
        ? "tool_calls"
        : items.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"))
          ? "refusal"
          : "stop",
    usage: responsesUsage(objectMember(payload, "usage")),
  };
}

function responseEnvelope(
  response: Readonly<SemanticResponse>,
  context: Readonly<BufferedConversionContext>,
): WireJsonObject {
  if (context.target === "chat") {
    return chatEnvelope(response, context);
  }
  if (context.target === "messages") {
    return messagesEnvelope(response, context);
  }
  return responsesEnvelope(response, context);
}

function chatEnvelope(
  response: Readonly<SemanticResponse>,
  context: Readonly<BufferedConversionContext>,
): WireJsonObject {
  const messageParts = response.items
    .filter((item): item is Extract<SemanticResponseItem, { readonly type: "message" }> => item.type === "message")
    .flatMap((item) => item.content);
  const text = messageParts.filter((part) => part.type === "text").map((part) => part.text).join("");
  const refusal = messageParts.filter((part): part is SemanticRefusal => part.type === "refusal").map((part) => part.text).join("");
  const calls = response.items
    .filter((item): item is SemanticToolCallItem => item.type === "tool_call")
    .map((item, index) => wireObject([
      ["index", wireNumber(index)],
      ["id", item.callId],
      ["type", "function"],
      ["function", wireObject([["name", item.name], ["arguments", item.argumentsJson]])],
    ]));
  const message = wireObject([
    ["role", "assistant"],
    ["content", text.length === 0 ? null : text],
    ["refusal", refusal.length === 0 ? undefined : refusal],
    ["tool_calls", calls.length === 0 ? undefined : wireArray(calls)],
  ]);
  return wireObject([
    ["id", `chatcmpl_${context.createUuid()}`],
    ["object", "chat.completion"],
    ["created", wireNumber(context.nowUnixSeconds())],
    ["model", context.model],
    ["choices", wireArray([wireObject([
      ["index", wireNumber(0)],
      ["message", message],
      ["finish_reason", chatTargetFinish(response.finishReason)],
    ])])],
    ["usage", chatUsageEnvelope(response.usage)],
  ]);
}

function messagesEnvelope(
  response: Readonly<SemanticResponse>,
  context: Readonly<BufferedConversionContext>,
): WireJsonObject {
  const content: WireJsonObject[] = [];
  for (const item of response.items) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push(wireObject([["type", "text"], ["text", part.text]]));
      }
    } else {
      content.push(wireObject([
        ["type", "tool_use"],
        ["id", item.callId],
        ["name", item.name],
        ["input", parseArgumentsObject(item.argumentsJson)],
      ]));
    }
  }
  return wireObject([
    ["id", `msg_${context.createUuid()}`],
    ["type", "message"],
    ["role", "assistant"],
    ["model", context.model],
    ["content", wireArray(content)],
    ["stop_reason", messagesTargetFinish(response.finishReason)],
    ["stop_sequence", null],
    ["usage", messagesUsageEnvelope(response.usage)],
  ]);
}

function responsesEnvelope(
  response: Readonly<SemanticResponse>,
  context: Readonly<BufferedConversionContext>,
): WireJsonObject {
  const output: WireJsonObject[] = [];
  for (const item of response.items) {
    if (item.type === "message") {
      const content = item.content.map((part) => part.type === "text"
        ? wireObject([
          ["type", "output_text"],
          ["text", part.text],
          ["annotations", wireArray([])],
        ])
        : wireObject([["type", "refusal"], ["refusal", part.text]]));
      output.push(wireObject([
        ["type", "message"],
        ["id", `msg_${context.createUuid()}`],
        ["status", response.status],
        ["role", "assistant"],
        ["content", wireArray(content)],
      ]));
    } else {
      output.push(wireObject([
        ["type", "function_call"],
        ["id", item.itemId ?? `fc_${context.createUuid()}`],
        ["call_id", item.callId],
        ["name", item.name],
        ["arguments", item.argumentsJson],
        ["status", response.status],
      ]));
    }
  }
  const responseId = managedConvertedResponseId(context.source, context.model, context.createUuid());
  return wireObject([
    ["id", responseId],
    ["object", "response"],
    ["created_at", wireNumber(context.nowUnixSeconds())],
    ["status", response.status],
    ["error", null],
    ["incomplete_details", response.status === "incomplete"
      ? wireObject([["reason", response.finishReason === "content_filter" || response.finishReason === "refusal"
        ? "content_filter"
        : "max_output_tokens"]])
      : null],
    ["instructions", null],
    ["metadata", wireObject([])],
    ["model", context.model],
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
    ["usage", responsesUsageEnvelope(response.usage)],
  ]);
}

function responseCheckpoint(body: WireJsonObject) {
  const responseId = stringMember(body, "id");
  const output = arrayMember(body, "output");
  const status = stringMember(body, "status");
  if (responseId === undefined || output === undefined || (status !== "completed" && status !== "incomplete")) {
    upstreamInvalid();
  }
  return {
    responseId,
    output: status === "completed" ? output.items : [],
    state: status === "completed" ? "complete" as const : "route_only" as const,
  };
}

function chatUsage(value: WireJsonObject | undefined): SemanticUsage {
  if (value === undefined) {
    return ZERO_USAGE;
  }
  const promptDetails = objectMember(value, "prompt_tokens_details");
  const completionDetails = objectMember(value, "completion_tokens_details");
  return {
    inputTokens: nonnegativeIntegerMember(value, "prompt_tokens"),
    outputTokens: nonnegativeIntegerMember(value, "completion_tokens"),
    cacheReadTokens: nonnegativeIntegerMember(promptDetails, "cached_tokens")
      || nonnegativeIntegerMember(value, "cache_read_input_tokens"),
    cacheWriteTokens: nonnegativeIntegerMember(promptDetails, "cache_write_tokens")
      || nonnegativeIntegerMember(value, "cache_creation_input_tokens"),
    reasoningTokens: nonnegativeIntegerMember(completionDetails, "reasoning_tokens"),
  };
}

function messagesUsage(value: WireJsonObject | undefined): SemanticUsage {
  if (value === undefined) {
    return ZERO_USAGE;
  }
  const cacheReadTokens = nonnegativeIntegerMember(value, "cache_read_input_tokens");
  const cacheWriteTokens = nonnegativeIntegerMember(value, "cache_creation_input_tokens");
  return {
    inputTokens: nonnegativeIntegerMember(value, "input_tokens") + cacheReadTokens + cacheWriteTokens,
    outputTokens: nonnegativeIntegerMember(value, "output_tokens"),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
  };
}

function responsesUsage(value: WireJsonObject | undefined): SemanticUsage {
  if (value === undefined) {
    return ZERO_USAGE;
  }
  const inputDetails = objectMember(value, "input_tokens_details");
  const outputDetails = objectMember(value, "output_tokens_details");
  return {
    inputTokens: nonnegativeIntegerMember(value, "input_tokens"),
    outputTokens: nonnegativeIntegerMember(value, "output_tokens"),
    cacheReadTokens: nonnegativeIntegerMember(inputDetails, "cached_tokens"),
    cacheWriteTokens: nonnegativeIntegerMember(inputDetails, "cache_write_tokens"),
    reasoningTokens: nonnegativeIntegerMember(outputDetails, "reasoning_tokens"),
  };
}

function chatUsageEnvelope(usage: Readonly<SemanticUsage>): WireJsonObject {
  return wireObject([
    ["prompt_tokens", wireNumber(usage.inputTokens)],
    ["completion_tokens", wireNumber(usage.outputTokens)],
    ["total_tokens", wireNumber(usage.inputTokens + usage.outputTokens)],
    ["prompt_tokens_details", wireObject([
      ["cached_tokens", wireNumber(usage.cacheReadTokens)],
      ["cache_write_tokens", usage.cacheWriteTokens === 0 ? undefined : wireNumber(usage.cacheWriteTokens)],
    ])],
    ["completion_tokens_details", usage.reasoningTokens === 0
      ? undefined
      : wireObject([["reasoning_tokens", wireNumber(usage.reasoningTokens)]])],
  ]);
}

function messagesUsageEnvelope(usage: Readonly<SemanticUsage>): WireJsonObject {
  return wireObject([
    ["input_tokens", wireNumber(Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens))],
    ["output_tokens", wireNumber(usage.outputTokens)],
    ["cache_read_input_tokens", usage.cacheReadTokens === 0 ? undefined : wireNumber(usage.cacheReadTokens)],
    ["cache_creation_input_tokens", usage.cacheWriteTokens === 0 ? undefined : wireNumber(usage.cacheWriteTokens)],
  ]);
}

function responsesUsageEnvelope(usage: Readonly<SemanticUsage>): WireJsonObject {
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

function chatTargetFinish(value: SemanticResponse["finishReason"]): string {
  return value === "refusal" ? "content_filter" : value;
}

function messagesTargetFinish(value: SemanticResponse["finishReason"]): string {
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

function parseObject(bytes: Uint8Array, maxBytes: number): WireJsonObject {
  try {
    const value = parseWireJson(bytes, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(value)) {
      upstreamInvalid();
    }
    return value;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({
      kind: "invalid_upstream_response",
      source: "converter",
      phase: "parse",
      cause: error,
    });
  }
}

function validateCompleteArguments(value: string): void {
  parseArgumentsObject(value);
}

function parseArgumentsObject(value: string): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(value);
    const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 32 });
    if (!isWireJsonObject(parsed)) {
      upstreamInvalid();
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({
      kind: "invalid_tool_arguments",
      source: "converter",
      phase: "convert",
      cause: error,
    });
  }
}

function singleMember(object: WireJsonObject, key: string): WireJson | undefined {
  const values = memberValues(object, key);
  if (values.length > 1) {
    upstreamInvalid();
  }
  return values[0];
}

function stringMember(object: WireJsonObject | undefined, key: string): string | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = singleMember(object, key);
  return typeof value === "string" ? value : undefined;
}

function stringOrNullMember(object: WireJsonObject, key: string): string | null | undefined {
  const value = singleMember(object, key);
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  upstreamInvalid();
}

function objectMember(object: WireJsonObject | undefined, key: string): WireJsonObject | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = singleMember(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonObject(value)) {
    upstreamInvalid();
  }
  return value;
}

function arrayMember(object: WireJsonObject, key: string) {
  const value = singleMember(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonArray(value)) {
    upstreamInvalid();
  }
  return value;
}

function nonnegativeIntegerMember(object: WireJsonObject | undefined, key: string): number {
  if (object === undefined) {
    return 0;
  }
  const value = singleMember(object, key);
  if (value === undefined) {
    return 0;
  }
  if (!isWireJsonNumber(value)) {
    upstreamInvalid();
  }
  const parsed = Number(value.lexeme);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    upstreamInvalid();
  }
  return parsed;
}

function upstreamInvalid(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "converter",
    phase: "convert",
  });
}
