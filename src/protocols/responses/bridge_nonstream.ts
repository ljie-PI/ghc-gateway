import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { ResponsesHistoryRecord } from "./history.js";
import type { RequestToolContext, ToolBinding } from "./tool_context.js";
import type { ResponsesRequest } from "./dto.js";

export interface ResponsesBridgeResponseContext {
  readonly originalRequest: ResponsesRequest;
  readonly toolContext: RequestToolContext;
  readonly customLlmProvider?: string;
  readonly modelId?: string;
  readonly createUuid: () => string;
}

export interface ResponsesBridgeNonstreamResult {
  readonly response: WireJsonObject;
  readonly historyRecord: ResponsesHistoryRecord;
}

export function convertChatResponseToResponses(
  chat: WireJsonObject,
  context: Readonly<ResponsesBridgeResponseContext>,
): ResponsesBridgeNonstreamResult {
  const choices = arrayMember(chat, "choices")?.items ?? [];
  const firstChoice = choices.find(isWireJsonObject);
  const status = responseStatus(firstChoice);
  const output = responseOutput(choices, context);
  const rawResponseId = stringMember(chat, "id") ?? "";
  const responseId = managedResponseId(rawResponseId, context.customLlmProvider, context.modelId);
  const response = object([
    ["id", responseId],
    ["object", "response"],
    ["created_at", memberValues(chat, "created")[0] ?? number(0)],
    ["status", status],
    ["error", memberValues(chat, "error")[0] ?? null],
    ["incomplete_details", memberValues(chat, "incomplete_details")[0] ?? null],
    ["instructions", memberValues(chat, "instructions")[0] ?? null],
    ["metadata", memberValues(chat, "metadata")[0] ?? object([])],
    ["model", memberValues(chat, "model")[0] ?? ""],
    ["output", array(output)],
    ["parallel_tool_calls", memberValues(chat, "parallel_tool_calls")[0] ?? false],
    ["temperature", memberValues(chat, "temperature")[0] ?? number(0)],
    ["tool_choice", memberValues(chat, "tool_choice")[0] ?? "auto"],
    ["tools", memberValues(chat, "tools")[0] ?? array([])],
    ["top_p", memberValues(chat, "top_p")[0] ?? null],
    ["max_output_tokens", memberValues(chat, "max_output_tokens")[0] ?? null],
    ["previous_response_id", memberValues(chat, "previous_response_id")[0] ?? null],
    ["reasoning", null],
    ["text", object([])],
    ["truncation", memberValues(chat, "truncation")[0] ?? null],
    ["user", memberValues(chat, "user")[0] ?? null],
    ["usage", usage(memberValues(chat, "usage")[0])],
    ...providerFields(chat),
  ]);
  return {
    response,
    historyRecord: { responseId, output },
  };
}

export function managedResponseId(
  id: string,
  customLlmProvider: string | undefined,
  modelId: string | undefined,
): string {
  if (id.length === 0 || isGatewayManagedResponseId(id)) {
    return id;
  }
  const provider = customLlmProvider ?? "None";
  const model = modelId ?? "None";
  const encoded = Buffer.from(`litellm:custom_llm_provider:${provider};model_id:${model};response_id:${id}`, "utf8").toString("base64");
  return `resp_${encoded}`;
}

function responseOutput(
  choices: readonly WireJson[],
  context: Readonly<ResponsesBridgeResponseContext>,
): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  const reasoning = reasoningItem(choices, context);
  if (reasoning !== undefined) {
    output.push(reasoning);
  }
  for (const choice of choices) {
    if (!isWireJsonObject(choice)) {
      continue;
    }
    output.push(...messageOrImages(choice, context));
  }
  for (const choice of choices) {
    if (!isWireJsonObject(choice)) {
      continue;
    }
    output.push(...toolCalls(choice, context));
  }
  return output;
}

function reasoningItem(
  choices: readonly WireJson[],
  context: Readonly<ResponsesBridgeResponseContext>,
): WireJsonObject | undefined {
  for (const choice of choices) {
    if (!isWireJsonObject(choice)) {
      continue;
    }
    const message = objectMember(choice, "message");
    if (message === undefined) {
      continue;
    }
    const text = stringMember(message, "reasoning_content");
    const encrypted = encryptedThinkingContent(message);
    if ((text === undefined || text.length === 0) && encrypted === undefined) {
      continue;
    }
    return object([
      ["type", "reasoning"],
      ["id", `rs_${context.createUuid()}`],
      ["status", itemStatus(choice)],
      ["content", text === undefined || text.length === 0 ? array([]) : array([object([["type", "reasoning_text"], ["text", text]])])],
      ["summary", array([])],
      ...(encrypted === undefined ? [] : [["encrypted_content", encrypted] as const]),
    ]);
  }
  return undefined;
}

function encryptedThinkingContent(message: WireJsonObject): string | undefined {
  const blocks = arrayMember(message, "thinking_blocks");
  if (blocks === undefined) {
    return undefined;
  }
  const keep = blocks.items.filter((item) => {
    if (!isWireJsonObject(item)) {
      return false;
    }
    return memberValues(item, "signature")[0] !== undefined || memberValues(item, "data")[0] !== undefined;
  });
  return keep.length === 0 ? undefined : new TextDecoder().decode(serializeWireJson(array(keep)));
}

function messageOrImages(
  choice: WireJsonObject,
  context: Readonly<ResponsesBridgeResponseContext>,
): WireJsonObject[] {
  const message = objectMember(choice, "message");
  if (message === undefined) {
    return [];
  }
  const images = arrayMember(message, "images");
  if (images !== undefined) {
    return images.items.map((image) => imageCall(image, choice, context)).filter((item): item is WireJsonObject => item !== undefined);
  }
  return [object([
    ["type", "message"],
    ["id", `msg_${context.createUuid()}`],
    ["status", itemStatus(choice)],
    ["role", stringMember(message, "role") ?? "assistant"],
    ["content", array([object([
      ["type", "output_text"],
      ["text", messageText(message)],
      ["annotations", array(annotations(message))],
    ])])],
  ])];
}

function imageCall(
  image: WireJson,
  choice: WireJsonObject,
  context: Readonly<ResponsesBridgeResponseContext>,
): WireJsonObject | undefined {
  if (typeof image !== "string" || image.length === 0) {
    return undefined;
  }
  const comma = image.startsWith("data:") ? image.indexOf(",") : -1;
  if (image.startsWith("data:") && comma === -1) {
    return undefined;
  }
  return object([
    ["type", "image_generation_call"],
    ["id", `ig_${context.createUuid()}`],
    ["status", imageStatus(choice)],
    ["result", comma === -1 ? image : image.slice(comma + 1)],
  ]);
}

function toolCalls(
  choice: WireJsonObject,
  context: Readonly<ResponsesBridgeResponseContext>,
): WireJsonObject[] {
  const calls = arrayMember(objectMember(choice, "message"), "tool_calls");
  if (calls === undefined) {
    return [];
  }
  return calls.items.map((call) => toolCall(call, context)).filter((call): call is WireJsonObject => call !== undefined);
}

function toolCall(value: WireJson, context: Readonly<ResponsesBridgeResponseContext>): WireJsonObject | undefined {
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const fn = objectMember(value, "function");
  if (fn === undefined) {
    return undefined;
  }
  const chatName = stringMember(fn, "name") ?? "";
  const id = stringMember(value, "id") ?? "";
  const args = stringMember(fn, "arguments") ?? "";
  const binding = context.toolContext.chatNameToBinding.get(chatName);
  const status = stringMember(fn, "status") ?? "completed";
  if (binding?.kind === "custom") {
    return object([
      ["type", "custom_tool_call"],
      ["id", id],
      ["call_id", id],
      ["name", binding.originalName],
      ["status", status],
      ["input", customInput(args)],
    ]);
  }
  if (binding?.kind === "tool_search") {
    return object([
      ["type", "tool_search_call"],
      ["call_id", id],
      ["status", status],
      ["execution", "client"],
      ["arguments", toolSearchArguments(args)],
    ]);
  }
  const normal = object([
    ["type", "function_call"],
    ["id", id],
    ["call_id", id],
    ["name", binding?.kind === "namespace" ? binding.originalName : chatName],
    ...(binding?.kind === "namespace" && binding.namespace !== undefined ? [["namespace", binding.namespace] as const] : []),
    ["arguments", args],
    ["status", status],
    ...providerSpecificFields(value, fn, binding),
  ]);
  return normal;
}

function customInput(argumentsText: string): string {
  if (argumentsText.trim().length === 0) {
    return "";
  }
  const parsed = parseJsonString(argumentsText);
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
  const parsed = parseJsonString(argumentsText);
  if (isWireJsonObject(parsed)) {
    return parsed;
  }
  return object([["query", argumentsText]]);
}

function usage(value: WireJson | undefined): WireJsonObject {
  const input = isWireJsonObject(value) ? value : object([]);
  const prompt = memberValues(input, "prompt_tokens")[0] ?? number(0);
  const completion = memberValues(input, "completion_tokens")[0] ?? number(0);
  const total = memberValues(input, "total_tokens")[0] ?? number(0);
  const members: Array<readonly [string, WireJson]> = [
    ["input_tokens", prompt],
    ["output_tokens", completion],
    ["total_tokens", total],
  ];
  const promptDetails = objectMember(input, "prompt_tokens_details");
  if (promptDetails !== undefined) {
    const cacheWriteTokens = memberValues(promptDetails, "cache_write_tokens")[0];
    members.push(["input_tokens_details", object([
      ["cached_tokens", memberValues(promptDetails, "cached_tokens")[0] ?? number(0)],
      ...optionalMember(promptDetails, "text_tokens"),
      ...optionalMember(promptDetails, "audio_tokens"),
      ["cache_creation_tokens", isTruthyWireJson(cacheWriteTokens) ? cacheWriteTokens : memberValues(promptDetails, "cache_creation_tokens")[0] ?? number(0)],
    ])]);
  }
  const completionDetails = objectMember(input, "completion_tokens_details");
  if (completionDetails !== undefined) {
    members.push(["output_tokens_details", object([
      ["reasoning_tokens", memberValues(completionDetails, "reasoning_tokens")[0] ?? number(0)],
      ...optionalMember(completionDetails, "audio_tokens"),
      ...optionalMember(completionDetails, "text_tokens"),
      ...optionalMember(completionDetails, "image_tokens"),
    ])]);
  }
  const cost = memberValues(input, "cost")[0];
  if (cost !== undefined) {
    members.push(["cost", cost]);
  }
  return object(members);
}

function providerFields(chat: WireJsonObject): Array<readonly [string, WireJson]> {
  const hidden = objectMember(chat, "_hidden_params");
  if (hidden === undefined) {
    return [];
  }
  const fields: Array<readonly [string, WireJson]> = [["_hidden_params", hidden]];
  const provider = objectMember(hidden, "provider_specific_fields");
  if (provider !== undefined) {
    for (const member of provider.members) {
      fields.push([member.key, member.value]);
    }
  }
  return fields;
}

function providerSpecificFields(
  outer: WireJsonObject,
  fn: WireJsonObject,
  binding: ToolBinding | undefined,
): Array<readonly [string, WireJson]> {
  if (binding?.kind === "custom") {
    return [];
  }
  const source = truthyObject(outer) ?? truthyObject(fn);
  if (source === undefined) {
    return [];
  }
  const provider = objectMember(source, "provider_specific_fields");
  return provider === undefined ? [] : [["provider_specific_fields", provider]];
}

function truthyObject(value: WireJsonObject): WireJsonObject | undefined {
  return value.members.length === 0 ? undefined : value;
}

function responseStatus(choice: WireJsonObject | undefined): string {
  const finish = choice === undefined ? undefined : memberValues(choice, "finish_reason")[0];
  return finish === "length" || finish === "content_filter" || finish === "refusal" ? "incomplete" : "completed";
}

function itemStatus(choice: WireJsonObject): string {
  return responseStatus(choice);
}

function imageStatus(choice: WireJsonObject): string {
  const finish = memberValues(choice, "finish_reason")[0];
  if (finish === "length") {
    return "incomplete";
  }
  if (finish === "content_filter" || finish === "error") {
    return "failed";
  }
  return "completed";
}

function messageText(message: WireJsonObject): string {
  const content = memberValues(message, "content")[0];
  return typeof content === "string" ? content : "";
}

function annotations(message: WireJsonObject): WireJsonObject[] {
  const values = arrayMember(message, "annotations");
  if (values === undefined) {
    return [];
  }
  return values.items.filter(isWireJsonObject).filter((item) => memberValues(item, "type")[0] === "url_citation").map((item) => {
    const members: Array<readonly [string, WireJson]> = [["type", "url_citation"]];
    for (const key of ["start_index", "end_index", "url", "title"]) {
      const value = memberValues(item, key)[0];
      if (value !== undefined) {
        members.push([key, value]);
      }
    }
    return object(members);
  });
}

function parseJsonString(value: string): WireJson | undefined {
  try {
    const bytes = new TextEncoder().encode(value);
    return parseWireJson(bytes, { maxBytes: Math.max(bytes.byteLength, 1), maxDepth: 64 });
  } catch (_error: unknown) {
    return undefined;
  }
}

export function isGatewayManagedResponseId(id: string): boolean {
  if (!id.startsWith("resp_")) {
    return false;
  }
  try {
    return Buffer.from(id.slice("resp_".length), "base64").toString("utf8").startsWith("litellm:custom_llm_provider:");
  } catch (_error: unknown) {
    return false;
  }
}

function optionalMember(objectValue: WireJsonObject, key: string): Array<readonly [string, WireJson]> {
  const value = memberValues(objectValue, key)[0];
  return value === undefined ? [] : [[key, value]];
}

function objectMember(value: WireJson | undefined, key: string): WireJsonObject | undefined {
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const member = memberValues(value, key)[0];
  return isWireJsonObject(member) ? member : undefined;
}

function arrayMember(value: WireJson | undefined, key: string): WireJsonArray | undefined {
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const member = memberValues(value, key)[0];
  return isWireJsonArray(member) ? member : undefined;
}

function stringMember(objectValue: WireJsonObject, key: string): string | undefined {
  const value = memberValues(objectValue, key)[0];
  return typeof value === "string" ? value : undefined;
}

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}

function number(lexeme: number): WireJson {
  return { kind: "number", lexeme: String(lexeme) };
}

function isTruthyWireJson(value: WireJson | undefined): value is WireJson {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (isWireJsonNumber(value)) {
    return Number(value.lexeme) !== 0;
  }
  if (isWireJsonArray(value)) {
    return value.items.length > 0;
  }
  if (isWireJsonObject(value)) {
    return value.members.length > 0;
  }
  return typeof value === "string" ? value.length > 0 : true;
}
