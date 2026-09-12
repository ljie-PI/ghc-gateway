import {
  ModelCapabilityUnavailableError,
  type ChatOutputTokenField,
} from "../../copilot/model_capabilities.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import {
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { ResponsesHistory } from "./history.js";
import type { ChatBridgePlan } from "./planner.js";
import { buildRequestToolContext, chatNameForSource, type RequestToolContext } from "./tool_context.js";
import {
  projectResponsesMessagesForCompatibility,
  projectResponsesToolChoiceForCompatibility,
} from "../conversion/responses_extended_tools.js";
import { consumeResponsesPreviousResponseId, type ResponsesRequest } from "./dto.js";

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
  const enriched = plan.continuation === undefined
    ? plan.originalRequest
    : await history.enrich(plan.originalRequest, plan.continuation, signal);
  const modeled = applyResolvedModel(
    consumeResponsesPreviousResponseId(enriched),
    plan.resolvedModel.upstreamModel,
  );
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

function convertMessages(request: Readonly<ResponsesRequest>, _toolContext: RequestToolContext): readonly WireJsonObject[] {
  return projectResponsesMessagesForCompatibility(request.body);
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
  return projectResponsesToolChoiceForCompatibility(
    value,
    (namespace, name) => chatNameForSource(context, namespace, name),
  );
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
  return context.upstreamHost === "api.openai.com";
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
