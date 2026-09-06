import { canonicalizeWireJson } from "../../serialization/canonical_json.js";
import {
  ModelCapabilityUnavailableError,
  type ChatOutputTokenField,
} from "../../copilot/model_capabilities.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { ResponsesHistory } from "./history.js";
import type { ChatBridgePlan } from "./planner.js";
import { buildRequestToolContext, chatNameForSource, type RequestToolContext } from "./tool_context.js";
import type { ResponsesRequest } from "./dto.js";

export interface ReasoningConfig {
  readonly supportsThinking?: boolean;
  readonly supportsEffort?: boolean;
  readonly thinkingParam?: "thinking" | "enable_thinking" | "reasoning_split" | "none";
  readonly effortParam?: "reasoning_effort" | "reasoning.effort" | "none";
  readonly effortValueMode?: "passthrough" | "deepseek" | "low_high" | "openrouter" | "zen";
  readonly effortLevels?: readonly string[];
}

export interface ResponsesBridgeRequestContext {
  readonly resolvedModel: string;
  readonly toolContext: RequestToolContext;
  readonly reasoningConfig: ReasoningConfig | null;
  readonly upstreamHost?: string;
  readonly upstreamPath?: string;
  readonly promptCacheRouting?: "enabled" | "disabled" | "auto";
  readonly clientSessionId?: string;
  readonly chatOutputTokenField?: ChatOutputTokenField | null;
}

export interface PreparedChatBridgeRequest {
  readonly body: WireJsonObject;
  readonly toolContext: RequestToolContext;
}

export async function buildChatBridgeRequest(
  plan: Readonly<ChatBridgePlan>,
  history: ResponsesHistory,
  options: Omit<ResponsesBridgeRequestContext, "resolvedModel" | "toolContext">,
  signal: AbortSignal,
): Promise<WireJsonObject> {
  return (await prepareChatBridgeRequest(plan, history, options, signal)).body;
}

export async function prepareChatBridgeRequest(
  plan: Readonly<ChatBridgePlan>,
  history: ResponsesHistory,
  options: Omit<ResponsesBridgeRequestContext, "resolvedModel" | "toolContext">,
  signal: AbortSignal,
): Promise<PreparedChatBridgeRequest> {
  const explicitPromptCacheKey = stringMember(plan.originalRequest.body, "prompt_cache_key");
  const enriched = await history.enrich(plan.originalRequest, signal);
  const modeled = applyResolvedModel(enriched, plan.resolvedModel.upstreamModel);
  const toolContext = buildRequestToolContext(modeled);
  return {
    toolContext,
    body: convertResponsesRequest(modeled, {
      ...options,
      resolvedModel: plan.resolvedModel.upstreamModel,
      toolContext,
      chatOutputTokenField: plan.resolvedModel.capability.profile.chatOutputTokenField.value,
      ...(options.clientSessionId === undefined ? {} : { clientSessionId: options.clientSessionId }),
    }, explicitPromptCacheKey),
  };
}

export function convertResponsesRequest(
  request: Readonly<ResponsesRequest>,
  context: Readonly<ResponsesBridgeRequestContext>,
  explicitPromptCacheKey = stringMember(request.body, "prompt_cache_key"),
): WireJsonObject {
  const messages = convertMessages(request, context.toolContext);
  const members: Array<readonly [string, WireJson]> = [
    ["model", context.resolvedModel],
    ["messages", array(messages)],
  ];
  copyTopLevel(request.body, members, context.chatOutputTokenField ?? null);
  applyReasoning(request.body, context.reasoningConfig, members);
  if (context.toolContext.chatTools.length > 0) {
    members.push(["tools", array(context.toolContext.chatTools)]);
    const choice = convertToolChoice(memberValues(request.body, "tool_choice")[0], context.toolContext);
    if (choice !== undefined) {
      members.push(["tool_choice", choice]);
    }
  } else {
    removeMembers(members, "parallel_tool_calls");
  }
  const promptCacheKey = promptCacheKeyFor(context, explicitPromptCacheKey);
  if (promptCacheKey !== undefined) {
    members.push(["prompt_cache_key", promptCacheKey]);
  }

  function removeMembers(members: Array<readonly [string, WireJson]>, key: string): void {
    for (let index = members.length - 1; index >= 0; index -= 1) {
      if (members[index]?.[0] === key) {
        members.splice(index, 1);
      }
    }
  }
  return object(members);
}

function applyResolvedModel(request: Readonly<ResponsesRequest>, model: string): ResponsesRequest {
  let replaced = false;
  const members = request.body.members.map((member) => {
    if (member.key !== "model") {
      return member;
    }
    replaced = true;
    return { key: "model", value: model };
  });
  if (!replaced) {
    members.push({ key: "model", value: model });
  }
  return {
    body: { kind: "object", members },
    model,
    stream: request.stream,
    ...(request.store === undefined ? {} : { store: request.store }),
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.previousResponseId === undefined ? {} : { previousResponseId: request.previousResponseId }),
  };
}

const DIRECT_COPY_FIELDS = new Set([
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "metadata",
  "n",
  "parallel_tool_calls",
  "presence_penalty",
  "response_format",
  "seed",
  "service_tier",
  "stop",
  "temperature",
  "top_logprobs",
  "top_p",
  "user",
]);

function copyTopLevel(
  source: WireJsonObject,
  members: Array<readonly [string, WireJson]>,
  chatOutputTokenField: ChatOutputTokenField | null,
): void {
  const maxOutputTokens = memberValues(source, "max_output_tokens")[0];
  if (maxOutputTokens !== undefined) {
    if (chatOutputTokenField === null) {
      throw new GatewayFailureError({
        kind: "unsupported_semantics",
        cause: new ModelCapabilityUnavailableError(),
      });
    }
    members.push([chatOutputTokenField, maxOutputTokens]);
  }
  for (const member of source.members) {
    if (member.key === "max_tokens" || member.key === "max_completion_tokens" || DIRECT_COPY_FIELDS.has(member.key)) {
      members.push([member.key, member.value]);
    }
    if (member.key === "stream") {
      members.push(["stream", member.value]);
    }
  }
  if (memberValues(source, "stream")[0] === true) {
    const streamOptions = memberValues(source, "stream_options")[0];
    const existing = isWireJsonObject(streamOptions)
      ? streamOptions.members.filter((member) => member.key !== "include_usage")
      : [];
    members.push(["stream_options", { kind: "object", members: [...existing, { key: "include_usage", value: true }] }]);
  } else {
    const streamOptions = memberValues(source, "stream_options")[0];
    if (streamOptions !== undefined) {
      members.push(["stream_options", streamOptions]);
    }
  }
}

function convertMessages(request: Readonly<ResponsesRequest>, toolContext: RequestToolContext): WireJsonObject[] {
  const state: MessageState = { output: [], pendingReasoning: [] };
  for (const system of instructionMessages(memberValues(request.body, "instructions")[0])) {
    state.output.push(system);
  }
  const input = request.input;
  if (typeof input === "string") {
    flushBeforeUserBoundary(state);
    state.output.push(chatMessage("user", input));
  } else if (isWireJsonArray(input)) {
    convertInputItems(input.items, state, toolContext);
  } else if (isWireJsonObject(input)) {
    convertInputItems([input], state, toolContext);
  }
  flushPendingReasoning(state);
  return mergeSystemMessages(state.output);
}

interface MessageState {
  readonly output: WireJsonObject[];
  readonly pendingReasoning: string[];
}

function convertInputItems(items: readonly WireJson[], state: MessageState, toolContext: RequestToolContext): void {
  let calls: WireJsonObject[] = [];
  const flushCalls = (): void => {
    if (calls.length === 0) {
      return;
    }
    const reasoning = consumeReasoning(state);
    const members: Array<readonly [string, WireJson]> = [
      ["role", "assistant"],
      ["content", null],
      ["tool_calls", array(calls)],
    ];
    if (reasoning.length > 0) {
      members.push(["reasoning_content", reasoning]);
    } else {
      members.push(["reasoning_content", "tool call"]);
    }
    state.output.push(object(members));
    calls = [];
  };

  for (const item of items) {
    if (!isWireJsonObject(item)) {
      flushCalls();
      continue;
    }
    const type = stringMember(item, "type");
    if (type === "reasoning") {
      appendReasoning(state.pendingReasoning, reasoningFromItem(item));
      continue;
    }
    const call = callTool(item, toolContext);
    if (call !== undefined) {
      appendReasoning(state.pendingReasoning, reasoningFromItem(item));
      calls.push(call);
      continue;
    }
    flushCalls();
    if (type === "function_call_output") {
      state.output.push(toolMessage(callId(item), functionOutputContent(item)));
      continue;
    }
    if (type === "custom_tool_call_output" || type === "tool_search_output") {
      const extracted = extractMediaFromToolOutput(item);
      state.output.push(toolMessage(callId(item), canonicalString(extracted.value)));
      if (extracted.media.length > 0) {
        state.output.push(mediaMessage(callId(item), extracted.media));
      }
      continue;
    }
    const message = messageFromItem(item);
    if (message !== undefined) {
      if (chatRole(item) !== "assistant") {
        flushBeforeUserBoundary(state);
      } else {
        appendReasoning(state.pendingReasoning, reasoningFromItem(item));
      }
      state.output.push(message);
    }
  }
  flushCalls();
}

function instructionMessages(value: WireJson | undefined): WireJsonObject[] {
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
    return isWireJsonObject(item) ? stringMember(item, "text") ?? "" : "";
  }).filter((item) => item.length > 0).join("\n\n");
  return text.length === 0 ? [] : [chatMessage("system", text)];
}

function mergeSystemMessages(messages: readonly WireJsonObject[]): WireJsonObject[] {
  const systemText: string[] = [];
  const rest: WireJsonObject[] = [];
  for (const message of messages) {
    if (memberValues(message, "role")[0] === "system") {
      const content = memberValues(message, "content")[0];
      if (typeof content === "string" && content.length > 0) {
        systemText.push(content);
      }
    } else {
      rest.push(message);
    }
  }
  return systemText.length === 0 ? rest : [chatMessage("system", systemText.join("\n\n")), ...rest];
}

function messageFromItem(item: WireJsonObject): WireJsonObject | undefined {
  const type = stringMember(item, "type");
  const role = chatRole(item);
  if (type !== undefined && !["message", "input_text", "input_image", "input_file", "input_audio"].includes(type)
    && memberValues(item, "role").length === 0 && memberValues(item, "content").length === 0) {
    return undefined;
  }
  if (type === "input_text" || type === "input_image" || type === "input_file" || type === "input_audio") {
    const part = convertContentPart(item);
    if (part === undefined) {
      return undefined;
    }
    return chatMessage(role, contentFromParts([part]));
  }
  const content = memberValues(item, "content")[0];
  if (isWireJsonArray(content)) {
    const parts = content.items.map(convertContentPart).filter((part): part is WireJsonObject => part !== undefined);
    return chatMessage(role, contentFromParts(parts));
  }
  return chatMessage(role, content === undefined ? null : content);
}

function convertContentPart(value: WireJson): WireJsonObject | undefined {
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const type = stringMember(value, "type");
  if (type === "input_text" || type === "output_text" || type === "text") {
    const text = stringMember(value, "text");
    return text === undefined || text.length === 0 ? undefined : object([["type", "text"], ["text", text]]);
  }
  if (type === "refusal") {
    const text = stringMember(value, "refusal");
    return text === undefined || text.length === 0 ? undefined : object([["type", "text"], ["text", text]]);
  }
  if (type === "input_image") {
    const image = memberValues(value, "image_url")[0];
    return object([["type", "image_url"], ["image_url", isWireJsonObject(image) ? image : object([["url", typeof image === "string" ? image : ""]])]]);
  }
  if (type === "input_file") {
    const fields = ["file_id", "file_data", "filename"]
      .map((key): readonly [string, WireJson] | undefined => {
        const member = memberValues(value, key)[0];
        return member === undefined ? undefined : [key, member];
      })
      .filter((field): field is readonly [string, WireJson] => field !== undefined);
    if (!fields.some(([key]) => key === "file_id" || key === "file_data")) {
      return undefined;
    }
    return object([["type", "file"], ["file", object(fields)]]);
  }
  if (type === "input_audio") {
    const audio = memberValues(value, "input_audio")[0];
    return audio === undefined ? undefined : object([["type", "input_audio"], ["input_audio", audio]]);
  }
  return undefined;
}

function contentFromParts(parts: readonly WireJsonObject[]): WireJson {
  const nonText = parts.some((part) => memberValues(part, "type")[0] !== "text");
  if (!nonText) {
    return parts.map((part) => stringMember(part, "text") ?? "").join("\n");
  }
  return array(parts);
}

function callTool(item: WireJsonObject, toolContext: RequestToolContext): WireJsonObject | undefined {
  const type = stringMember(item, "type");
  if (type === "function_call") {
    const originalName = stringMember(item, "name") ?? "";
    const chatName = chatNameForSource(toolContext, stringMember(item, "namespace"), originalName) ?? originalName;
    return chatToolCall(callId(item), chatName, normalizedArguments(memberValues(item, "arguments")[0]));
  }
  if (type === "custom_tool_call") {
    return chatToolCall(callId(item), stringMember(item, "name") ?? "", canonicalString(object([["input", memberValues(item, "input")[0] ?? ""]])));
  }
  if (type === "tool_search_call") {
    return chatToolCall(callId(item), "tool_search", canonicalString(memberValues(item, "arguments")[0] ?? object([])));
  }
  return undefined;
}

function chatToolCall(id: string, name: string, args: string): WireJsonObject {
  return object([
    ["id", id],
    ["type", "function"],
    ["function", object([
      ["name", name],
      ["arguments", args],
    ])],
  ]);
}

function functionOutputContent(item: WireJsonObject): string {
  const value = memberValues(item, "output")[0];
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    return parsed === undefined ? value : canonicalString(parsed);
  }
  return value === undefined ? "" : canonicalString(value);
}

function normalizedArguments(value: WireJson | undefined): string {
  if (value === undefined) {
    return "{}";
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return "{}";
    }
    const parsed = parseJsonString(value);
    return parsed === undefined ? value : canonicalString(parsed);
  }
  return canonicalString(value);
}

function reasoningFromItem(item: WireJsonObject): string | undefined {
  for (const key of ["reasoning_content", "reasoning"]) {
    const value = memberValues(item, key)[0];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (isWireJsonObject(value)) {
      const nested = stringMember(value, "content") ?? stringMember(value, "text") ?? stringMember(value, "summary");
      if (nested !== undefined && nested.length > 0) {
        return nested;
      }
    }
  }
  const details = memberValues(item, "reasoning_details")[0];
  if (typeof details === "string" && details.length > 0) {
    return details;
  }
  if (isWireJsonArray(details)) {
    const text = details.items.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return isWireJsonObject(part) ? stringMember(part, "text") ?? stringMember(part, "content") ?? "" : "";
    }).filter((part) => part.length > 0).join("\n\n");
    return text.length === 0 ? undefined : text;
  }
  const summary = memberValues(item, "summary")[0];
  if (typeof summary === "string" && summary.length > 0) {
    return summary;
  }
  if (isWireJsonArray(summary)) {
    const text = summary.items.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return isWireJsonObject(part) ? stringMember(part, "text") ?? stringMember(part, "content") ?? "" : "";
    }).filter((part) => part.length > 0).join("\n\n");
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}

function consumeReasoning(state: MessageState): string {
  const text = state.pendingReasoning.join("\n\n");
  state.pendingReasoning.length = 0;
  return text;
}

function appendReasoning(target: string[], value: string | undefined): void {
  if (value !== undefined && value.length > 0 && !target.includes(value)) {
    target.push(value);
  }
}

function flushBeforeUserBoundary(state: MessageState): void {
  flushPendingReasoning(state);
}

function flushPendingReasoning(state: MessageState): void {
  if (state.pendingReasoning.length === 0) {
    return;
  }
  const previousIndex = state.output.findLastIndex((message) => memberValues(message, "role")[0] === "assistant");
  const previous = state.output[previousIndex];
  if (previous !== undefined && memberValues(previous, "reasoning_content").length === 0) {
    state.output[previousIndex] = {
      kind: "object",
      members: [...previous.members, { key: "reasoning_content", value: state.pendingReasoning.join("\n\n") }],
    };
  }
  state.pendingReasoning.length = 0;
}

function applyReasoning(
  body: WireJsonObject,
  config: ReasoningConfig | null,
  members: Array<readonly [string, WireJson]>,
): void {
  const requested = requestedReasoning(body);
  if (config === null) {
    const effort = requested.effort;
    if (requested.enabled === true && effort !== undefined && ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
      members.push(["reasoning_effort", effort]);
    }
    return;
  }
  const supportsEffort = config.supportsEffort === true;
  const supportsThinking = supportsEffort || config.supportsThinking === true;
  if (requested.enabled !== undefined && supportsThinking) {
    const thinkingParam = config.thinkingParam ?? "thinking";
    if (thinkingParam === "thinking") {
      members.push(["thinking", object([["type", requested.enabled ? "enabled" : "disabled"]])]);
    } else if (thinkingParam === "enable_thinking" || thinkingParam === "reasoning_split") {
      members.push([thinkingParam, requested.enabled]);
    }
  }
  if (requested.enabled === true && supportsEffort) {
    const effort = mappedEffort(requested.effort, config);
    const effortParam = config.effortParam ?? "reasoning_effort";
    if (effort !== undefined && effortParam === "reasoning_effort") {
      members.push(["reasoning_effort", effort]);
    } else if (effort !== undefined && effortParam === "reasoning.effort") {
      members.push(["reasoning", object([["effort", effort]])]);
    }
  } else if (requested.enabled === false && config.effortParam === "reasoning.effort") {
    members.push(["reasoning", object([["effort", "none"]])]);
  }
}

function requestedReasoning(body: WireJsonObject): { readonly enabled?: boolean; readonly effort?: string } {
  const reasoning = memberValues(body, "reasoning")[0];
  if (isWireJsonObject(reasoning)) {
    const effort = stringMember(reasoning, "effort")?.trim().toLowerCase();
    if (effort !== undefined) {
      if (["none", "off", "disabled"].includes(effort)) {
        return { enabled: false, effort };
      }
      return { enabled: true, effort };
    }
    return { enabled: true };
  }
  if (reasoning === null) {
    return { enabled: false };
  }
  if (reasoning !== undefined) {
    return { enabled: true };
  }
  return {};
}

function mappedEffort(effort: string | undefined, config: ReasoningConfig): string | undefined {
  if (effort === undefined) {
    return undefined;
  }
  const mode = config.effortValueMode ?? "passthrough";
  if (mode === "deepseek") {
    return ["max", "xhigh", "ultra"].includes(effort) ? "max" : "high";
  }
  if (mode === "low_high") {
    return ["minimal", "low"].includes(effort) ? "low" : "high";
  }
  if (mode === "openrouter") {
    return ["max", "xhigh", "ultra"].includes(effort) ? "xhigh" : ["high", "medium", "low", "minimal"].includes(effort) ? effort : undefined;
  }
  if (mode === "zen") {
    return zenEffort(effort, config.effortLevels ?? []);
  }
  return ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort) ? effort : undefined;
}

function zenEffort(effort: string, levels: readonly string[]): string | undefined {
  const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const requested = order.indexOf(effort);
  if (requested === -1 || levels.length === 0) {
    return undefined;
  }
  return levels.find((level) => order.indexOf(level) >= requested) ?? levels.at(-1);
}

function convertToolChoice(value: WireJson | undefined, context: RequestToolContext): WireJson | undefined {
  if (isWireJsonObject(value)) {
    const type = stringMember(value, "type");
    if (type === "function") {
      const originalName = stringMember(value, "name") ?? "";
      const chatName = chatNameForSource(context, stringMember(value, "namespace"), originalName) ?? originalName;
      return object([["type", "function"], ["function", object([["name", chatName]])]]);
    }
    if (type === "tool_search") {
      return object([["type", "function"], ["function", object([["name", "tool_search"]])]]);
    }
    if (type === "custom") {
      const name = stringMember(value, "name") ?? "";
      return object([["type", "function"], ["function", object([["name", name]])]]);
    }
  }
  return value;
}

interface ExtractedMedia {
  readonly value: WireJson;
  readonly media: readonly WireJsonObject[];
}

function extractMediaFromToolOutput(value: WireJson, depth = 0): ExtractedMedia {
  if (depth > 32) {
    return { value, media: [] };
  }
  if (typeof value === "string") {
    const parsed = parseJsonString(value.trim());
    if (parsed !== undefined) {
      const extracted = extractMediaFromToolOutput(parsed, depth + 1);
      if (extracted.media.length > 0) {
        return { value: canonicalString(omitLongResidualStrings(extracted.value)), media: extracted.media };
      }
    }
  }
  const media = mediaPart(value);
  if (media !== undefined) {
    return { value: "[cc-switch: tool result media moved to the following user message]", media: [media] };
  }
  if (isWireJsonArray(value)) {
    const items: WireJson[] = [];
    const mediaItems: WireJsonObject[] = [];
    for (const item of value.items) {
      const extracted = extractMediaFromToolOutput(item, depth + 1);
      items.push(extracted.value);
      mediaItems.push(...extracted.media);
    }
    return { value: array(items), media: mediaItems };
  }
  if (isWireJsonObject(value)) {
    const members: Array<readonly [string, WireJson]> = [];
    const mediaItems: WireJsonObject[] = [];
    for (const member of value.members) {
      const extracted = extractMediaFromToolOutput(member.value, depth + 1);
      members.push([member.key, extracted.value]);
      mediaItems.push(...extracted.media);
    }
    return { value: object(members), media: mediaItems };
  }
  return { value, media: [] };
}

function mediaPart(value: WireJson): WireJsonObject | undefined {
  if (typeof value === "string" && value.trim().startsWith("data:image/") && new TextEncoder().encode(value.trim()).byteLength >= 8192) {
    return object([["type", "image_url"], ["image_url", object([["url", value.trim()]])]]);
  }
  if (!isWireJsonObject(value)) {
    return undefined;
  }
  const type = stringMember(value, "type");
  if (type === "input_image" || type === "image_url") {
    const image = memberValues(value, "image_url")[0] ?? memberValues(value, "source")[0];
    return object([["type", "image_url"], ["image_url", isWireJsonObject(image) ? image : object([["url", typeof image === "string" ? image : ""]])]]);
  }
  if (type === "input_file" && (memberValues(value, "file_id")[0] !== undefined || memberValues(value, "file_data")[0] !== undefined)) {
    return convertContentPart(value);
  }
  if (type === "input_audio") {
    return convertContentPart(value);
  }
  return undefined;
}

function omitLongResidualStrings(value: WireJson): WireJson {
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes >= 8192 && value !== "[cc-switch: tool result media moved to the following user message]") {
      return `[cc-switch: omitted ${bytes} bytes]`;
    }
    return value;
  }
  if (isWireJsonArray(value)) {
    return { kind: "array", items: value.items.map(omitLongResidualStrings) };
  }
  if (isWireJsonObject(value)) {
    return {
      kind: "object",
      members: value.members.map((member) => ({ key: member.key, value: omitLongResidualStrings(member.value) })),
    };
  }
  return value;
}

function mediaMessage(callIdValue: string, media: readonly WireJsonObject[]): WireJsonObject {
  return chatMessage("user", array([
    object([["type", "text"], ["text", `[cc-switch: media output of tool call ${callIdValue}]`]]),
    ...media,
  ]));
}

function promptCacheKeyFor(
  context: Readonly<ResponsesBridgeRequestContext>,
  explicit: string | undefined,
): string | undefined {
  if (context.promptCacheRouting === "disabled") {
    return undefined;
  }
  const allowed = context.promptCacheRouting === "enabled" || defaultPromptCacheAllowed(context);
  if (!allowed) {
    return undefined;
  }
  const key = explicit?.trim() || context.clientSessionId?.trim();
  return key === undefined || key.length === 0 ? undefined : key;
}

function defaultPromptCacheAllowed(context: Readonly<ResponsesBridgeRequestContext>): boolean {
  if (context.promptCacheRouting !== undefined && context.promptCacheRouting !== "auto") {
    return false;
  }
  if (context.upstreamHost === "api.openai.com") {
    return true;
  }
  return context.upstreamHost === "api.kimi.com" && (context.upstreamPath === "/coding" || context.upstreamPath?.startsWith("/coding/") === true);
}

function chatRole(item: WireJsonObject): string {
  const role = stringMember(item, "role");
  if (role === "system" || role === "developer") {
    return "system";
  }
  if (role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

function chatMessage(role: string, content: WireJson): WireJsonObject {
  return object([["role", role], ["content", content]]);
}

function toolMessage(id: string, content: string): WireJsonObject {
  return object([["role", "tool"], ["tool_call_id", id], ["content", content]]);
}

function callId(item: WireJsonObject): string {
  return stringMember(item, "call_id")?.trim() || stringMember(item, "id")?.trim() || "";
}

function canonicalString(value: WireJson): string {
  return new TextDecoder().decode(canonicalizeWireJson(value));
}

function parseJsonString(value: string): WireJson | undefined {
  try {
    return parseWireJson(new TextEncoder().encode(value), { maxBytes: Math.max(1, new TextEncoder().encode(value).byteLength), maxDepth: 64 });
  } catch (_error: unknown) {
    return undefined;
  }
}

function stringMember(object: WireJsonObject, key: string): string | undefined {
  const value = memberValues(object, key)[0];
  return typeof value === "string" ? value : undefined;
}

function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}
