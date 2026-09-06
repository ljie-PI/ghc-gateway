import { GatewayFailureError } from "../../gateway/failures.js";
import type { ChatOutputTokenField } from "../../copilot/model_capabilities.js";
import { canonicalizeWireJson } from "../../serialization/canonical_json.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  parseWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { asRecord, emptyWireObject, firstMember, isTextPart, unsignedInteger, wireToJson } from "./common.js";
export interface ChatRequestBody {
  [key: string]: unknown;
  model: string;
  messages: unknown[];
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  stream?: unknown;
  stream_options?: { include_usage: true };
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: string;
}

export function convertAnthropicRequest(
  request: WireJsonObject,
  resolvedModel: string,
  chatOutputTokenField: ChatOutputTokenField | null,
): ChatRequestBody {
  const messagesValue = firstMember(request, "messages");
  if (!isWireJsonArray(messagesValue)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const result: ChatRequestBody = {
    model: resolvedModel,
    messages: convertMessages(request, messagesValue, resolvedModel),
  };
  copyMaxTokens(request, result, chatOutputTokenField);
  copyIfPresent(request, "temperature", result, "temperature");
  copyIfPresent(request, "top_p", result, "top_p");
  copyIfPresent(request, "stop_sequences", result, "stop");
  copyIfPresent(request, "stream", result, "stream");
  if (result.stream === true) {
    result.stream_options = { include_usage: true };
  }
  const tools = convertTools(firstMember(request, "tools"));
  if (tools.length > 0) {
    result.tools = tools;
  }
  const toolChoice = convertToolChoice(firstMember(request, "tool_choice"));
  if (toolChoice !== undefined) {
    result.tool_choice = toolChoice;
  }
  const reasoning = convertReasoning(request, resolvedModel);
  if (reasoning !== undefined) {
    result.reasoning_effort = reasoning;
  }
  return result;
}

function copyIfPresent(
  source: WireJsonObject,
  sourceKey: string,
  target: Record<string, unknown>,
  targetKey: string,
): void {
  const value = firstMember(source, sourceKey);
  if (value !== undefined) {
    target[targetKey] = wireToJson(value);
  }
}

function copyMaxTokens(
  source: WireJsonObject,
  target: ChatRequestBody,
  chatOutputTokenField: ChatOutputTokenField | null,
): void {
  const value = firstMember(source, "max_tokens");
  if (value === undefined) {
    return;
  }
  if (chatOutputTokenField === null) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (chatOutputTokenField === "max_completion_tokens") {
    target.max_completion_tokens = wireToJson(value);
    return;
  }
  target.max_tokens = wireToJson(value);
}

function convertMessages(
  request: WireJsonObject,
  messages: WireJsonArray,
  model: string,
): unknown[] {
  const converted: unknown[] = [];
  const systemMessages = systemChatMessages(firstMember(request, "system"));
  for (const item of messages.items) {
    converted.push(...convertMessage(item, model));
  }
  if (systemMessages.length === 1) {
    return [systemMessages[0], ...converted];
  }
  if (systemMessages.length > 1) {
    const content = systemMessages
      .map((message) => typeof message.content === "string" ? message.content : "")
      .filter((text) => text.length > 0)
      .join("\n");
    if (content.length > 0) {
      return [{ role: "system", content }, ...converted];
    }
  }
  return converted;
}

function systemChatMessages(system: WireJson | undefined): Array<{ role: "system"; content: unknown }> {
  if (typeof system === "string") {
    const text = stripBillingHeader(system);
    return text.length === 0 ? [] : [{ role: "system", content: text }];
  }
  if (!isWireJsonArray(system)) {
    return [];
  }
  const messages: Array<{ role: "system"; content: unknown }> = [];
  for (const item of system.items) {
    if (!isWireJsonObject(item)) {
      continue;
    }
    const text = firstMember(item, "text");
    if (typeof text !== "string") {
      continue;
    }
    const stripped = stripBillingHeader(text);
    if (stripped.length > 0) {
      messages.push({ role: "system", content: stripped });
    }
  }
  return messages;
}

function stripBillingHeader(text: string): string {
  const prefix = "x-anthropic-billing-header:";
  if (!text.startsWith(prefix)) {
    return text;
  }
  let rest = text.slice(prefix.length);
  const firstLineBreak = rest.match(/\r\n|\n|\r/u);
  if (firstLineBreak === null || firstLineBreak.index === undefined) {
    return "";
  }
  rest = rest.slice(firstLineBreak.index + firstLineBreak[0].length);
  if (rest.startsWith("\r\n")) {
    return rest.slice(2);
  }
  if (rest.startsWith("\n") || rest.startsWith("\r")) {
    return rest.slice(1);
  }
  return rest;
}

function convertMessage(value: WireJson, model: string): unknown[] {
  if (!isWireJsonObject(value)) {
    return [];
  }
  const role = typeof firstMember(value, "role") === "string" ? firstMember(value, "role") as string : "user";
  const content = firstMember(value, "content");
  if (content === undefined) {
    return [{ role, content: null }];
  }
  if (typeof content === "string") {
    return [{ role, content }];
  }
  if (!isWireJsonArray(content)) {
    return [{ role, content: wireToJson(content) }];
  }

  const toolMessages: unknown[] = [];
  const parts: unknown[] = [];
  const toolCalls: unknown[] = [];
  const thinking: string[] = [];
  for (const block of content.items) {
    if (!isWireJsonObject(block)) {
      continue;
    }
    const type = firstMember(block, "type");
    if (type === "text") {
      const text = firstMember(block, "text");
      if (typeof text === "string") {
        parts.push({ type: "text", text });
      }
      continue;
    }
    if (type === "image") {
      const image = convertImage(block);
      if (image !== undefined) {
        parts.push(image);
      }
      continue;
    }
    if (type === "tool_use") {
      toolCalls.push(convertToolUse(block));
      continue;
    }
    if (type === "tool_result") {
      toolMessages.push(convertToolResult(block));
      continue;
    }
    if (type === "thinking") {
      const text = firstMember(block, "thinking");
      if (typeof text === "string" && text.length > 0) {
        thinking.push(text);
      }
      continue;
    }
    if (type === "redacted_thinking") {
      thinking.push("[redacted thinking]");
    }
  }
  const output: unknown[] = [...toolMessages];
  const mediaMessage = mediaUserMessage(toolMessages);
  if (mediaMessage !== undefined) {
    output.push(mediaMessage);
  }
  if (parts.length > 0 || toolCalls.length > 0) {
    const message: Record<string, unknown> = {
      role,
      content: parts.length === 1 && isTextPart(parts[0])
        ? parts[0].text
        : parts.length === 0
          ? null
          : parts,
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      if (role === "assistant" && preservesThinkingHistory(model)) {
        message.reasoning_content = thinking.length > 0 ? thinking.join("\n") : "tool call";
      }
    }
    output.push(message);
  }
  return output;
}

function convertImage(block: WireJsonObject): unknown | undefined {
  const source = firstMember(block, "source");
  if (!isWireJsonObject(source)) {
    return undefined;
  }
  const sourceType = firstMember(source, "type");
  if (sourceType === "base64") {
    const mediaType = firstMember(source, "media_type");
    const data = firstMember(source, "data");
    if (typeof mediaType === "string" && typeof data === "string") {
      return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
    }
  }
  if (sourceType === "url") {
    const url = firstMember(source, "url");
    if (typeof url === "string") {
      return { type: "image_url", image_url: { url } };
    }
  }
  return undefined;
}

function convertToolUse(block: WireJsonObject): unknown {
  const id = firstMember(block, "id");
  const name = firstMember(block, "name");
  const input = firstMember(block, "input") ?? emptyWireObject();
  return {
    id: typeof id === "string" ? id : "",
    type: "function",
    function: {
      name: typeof name === "string" ? name : "",
      arguments: new TextDecoder().decode(canonicalizeWireJson(input)),
    },
  };
}

function convertToolResult(block: WireJsonObject): unknown {
  const id = firstMember(block, "tool_use_id");
  const content = firstMember(block, "content");
  const callId = typeof id === "string" ? id : "";
  let text = "";
  let media: unknown[] = [];
  if (typeof content === "string") {
    const extracted = extractMediaFromString(content);
    text = extracted.text;
    media = extracted.media;
  } else if (content !== undefined) {
    const extracted = extractToolResultMedia(content);
    text = new TextDecoder().decode(canonicalizeWireJson(extracted.value));
    media = extracted.media;
  }
  return {
    role: "tool",
    tool_call_id: callId,
    content: text,
    ...(media.length === 0 ? {} : { __anthropicMedia: { callId, media } }),
  };
}

function mediaUserMessage(toolMessages: unknown[]): unknown | undefined {
  const content: unknown[] = [];
  for (const message of toolMessages) {
    const record = asRecord(message);
    const mediaRecord = asRecord(record?.__anthropicMedia);
    if (mediaRecord === undefined || !Array.isArray(mediaRecord.media)) {
      continue;
    }
    content.push({
      type: "text",
      text: `[cc-switch: media output of tool call ${String(mediaRecord.callId ?? "")}]`,
    });
    content.push(...mediaRecord.media);
    delete record?.__anthropicMedia;
  }
  return content.length === 0 ? undefined : { role: "user", content };
}

function extractMediaFromString(content: string): { readonly text: string; readonly media: unknown[] } {
  const trimmed = content.trim();
  if (trimmed.startsWith("data:image/") && trimmed.length >= 8192) {
    return {
      text: "[cc-switch: tool result media moved to the following user message]",
      media: [{ type: "image_url", image_url: { url: trimmed } }],
    };
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = parseWireJson(new TextEncoder().encode(trimmed), { maxBytes: trimmed.length, maxDepth: 32 });
      const extracted = extractToolResultMedia(parsed);
      if (extracted.media.length > 0) {
        return { text: new TextDecoder().decode(canonicalizeWireJson(extracted.value)), media: extracted.media };
      }
    } catch (_error: unknown) {
      return { text: content, media: [] };
    }
  }
  return { text: content, media: [] };
}

function extractToolResultMedia(value: WireJson, depth = 0): { readonly value: WireJson; readonly media: unknown[] } {
  if (depth > 32) {
    return { value, media: [] };
  }
  const media = mediaPartFromWire(value);
  if (media !== undefined) {
    return {
      value: "[cc-switch: tool result media moved to the following user message]",
      media: [media],
    };
  }
  if (isWireJsonArray(value)) {
    const items: WireJson[] = [];
    const mediaParts: unknown[] = [];
    for (const item of value.items) {
      const extracted = extractToolResultMedia(item, depth + 1);
      items.push(extracted.value);
      mediaParts.push(...extracted.media);
    }
    return { value: { kind: "array", items }, media: mediaParts };
  }
  if (isWireJsonObject(value)) {
    const members: Array<{ key: string; value: WireJson }> = [];
    const mediaParts: unknown[] = [];
    for (const member of value.members) {
      const extracted = extractToolResultMedia(member.value, depth + 1);
      members.push({ key: member.key, value: extracted.value });
      mediaParts.push(...extracted.media);
    }
    return { value: { kind: "object", members }, media: mediaParts };
  }
  return { value, media: [] };
}

function mediaPartFromWire(value: WireJson): unknown | undefined {
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const type = firstMember(value, "type");
  if (type === "image") {
    const source = firstMember(value, "source");
    if (isWireJsonObject(source)) {
      const mediaType = firstMember(source, "media_type") ?? firstMember(source, "mimeType");
      const data = firstMember(source, "data");
      const url = firstMember(source, "url");
      if (typeof url === "string") {
        return { type: "image_url", image_url: { url } };
      }
      if (typeof mediaType === "string" && typeof data === "string") {
        return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
      }
    }
    const mimeType = firstMember(value, "mimeType");
    const data = firstMember(value, "data");
    if (typeof mimeType === "string" && typeof data === "string") {
      return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
    }
  }
  if (type === "image_url") {
    const imageUrl = firstMember(value, "image_url");
    return { type: "image_url", image_url: wireToJson(imageUrl ?? emptyWireObject()) };
  }
  if (type === "input_file" && (firstMember(value, "file_id") !== undefined || firstMember(value, "file_data") !== undefined)) {
    const file: Record<string, unknown> = {};
    copyMediaField(value, file, "file_id");
    copyMediaField(value, file, "file_data");
    copyMediaField(value, file, "filename");
    return { type: "file", file };
  }
  if (type === "input_audio") {
    const inputAudio = firstMember(value, "input_audio");
    if (inputAudio !== undefined) {
      return { type: "input_audio", input_audio: wireToJson(inputAudio) };
    }
  }
  return undefined;
}

function copyMediaField(source: WireJsonObject, target: Record<string, unknown>, key: string): void {
  const value = firstMember(source, key);
  if (value !== undefined) {
    target[key] = wireToJson(value);
  }
}

function convertTools(value: WireJson | undefined): unknown[] {
  if (!isWireJsonArray(value)) {
    return [];
  }
  const tools: unknown[] = [];
  for (const item of value.items) {
    if (!isWireJsonObject(item) || firstMember(item, "type") === "BatchTool") {
      continue;
    }
    const name = firstMember(item, "name");
    const description = firstMember(item, "description");
    const inputSchema = firstMember(item, "input_schema") ?? emptyWireObject();
    tools.push({
      type: "function",
      function: {
        name: typeof name === "string" ? name : "",
        description: description === undefined ? null : wireToJson(description),
        parameters: cleanupSchema(wireToJson(inputSchema)),
      },
    });
  }
  return tools;
}

function cleanupSchema(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!("type" in record)) {
    record.type = "object";
    if (!("properties" in record)) {
      record.properties = {};
    }
  }
  if (record.format === "uri") {
    delete record.format;
  }
  if (record.properties !== null && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const child of Object.values(record.properties as Record<string, unknown>)) {
      cleanupSchema(child);
    }
  }
  cleanupSchema(record.items);
  return record;
}

function convertToolChoice(value: WireJson | undefined): unknown | undefined {
  if (typeof value === "string") {
    if (value === "auto") {
      return "auto";
    }
    if (value === "any") {
      return "required";
    }
    if (value === "none") {
      return "none";
    }
    return value;
  }
  if (!isWireJsonObject(value)) {
    return value === undefined ? undefined : wireToJson(value);
  }
  const type = firstMember(value, "type");
  if (type === "auto") {
    return "auto";
  }
  if (type === "any") {
    return "required";
  }
  if (type === "none") {
    return "none";
  }
  if (type === "tool") {
    const name = firstMember(value, "name");
    return { type: "function", function: { name: typeof name === "string" ? name : "" } };
  }
  return wireToJson(value);
}

function convertReasoning(request: WireJsonObject, model: string): string | undefined {
  if (!supportsReasoning(model)) {
    return undefined;
  }
  const outputConfig = firstMember(request, "output_config");
  if (isWireJsonObject(outputConfig)) {
    const effort = firstMember(outputConfig, "effort");
    if (typeof effort === "string") {
      if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
        return effort;
      }
      if (effort === "max") {
        return "xhigh";
      }
      return undefined;
    }
  }
  const thinking = firstMember(request, "thinking");
  if (!isWireJsonObject(thinking)) {
    return undefined;
  }
  if (firstMember(thinking, "type") === "adaptive") {
    return "xhigh";
  }
  if (firstMember(thinking, "type") !== "enabled") {
    return undefined;
  }
  const budget = unsignedInteger(firstMember(thinking, "budget_tokens"));
  if (budget === undefined) {
    return "high";
  }
  if (budget < 4000) {
    return "low";
  }
  if (budget < 16000) {
    return "medium";
  }
  return "high";
}

function supportsReasoning(model: string): boolean {
  const lower = model.toLowerCase();
  return /^o[0-9]/u.test(lower)
    || /^gpt-[5-9]/u.test(lower)
    || lower === "grok-4.5"
    || lower.startsWith("grok-4.5-")
    || lower.startsWith("grok-build-");
}

function preservesThinkingHistory(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("deepseek") || lower.includes("mimo") || lower.includes("xiaomimimo");
}
