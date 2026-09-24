import { type EffectiveModelCapabilitySnapshot } from "../../../copilot/capability_registry.js";
import { chooseOutputTokenBudget, resolveModelReasoningEffort } from "../../../copilot/model_capabilities.js";
import { isWireJsonObject, memberValues, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier, isReasoningCarrier } from "../reasoning_carriers.js";
import { projectIndependentOption } from "../request_projection.js";
import { type ConversionDegradationRule, type InferenceProtocol, type SemanticReasoning, type SemanticRequest } from "../types.js";
import { invalid, oneMember, positiveInteger, unsupported } from "../wire.js";
import { optionalChoiceString, optionalProtocolObject, projectMessagesMembers, safeIndependentOption } from "./projection.js";

export function decodeMessagesThinking(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticReasoning | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-M-THINKING", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectMessagesMembers(
    rawObject,
    new Set(["type", "budget_tokens"]),
    "REQ-M-THINKING",
    degradations,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-M-THINKING-TYPE"),
    "REQ-M-THINKING-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type === "disabled") {
    return undefined;
  }
  if (type === "adaptive") {
    degradations.add("reasoning.budget_coarsened");
    return { effort: "xhigh" };
  }
  if (type !== "enabled") {
    degradations.add("messages.extensions_omitted");
    return undefined;
  }
  const budget = positiveInteger(oneMember(object, "budget_tokens", "REQ-M-THINKING-BUDGET"), "REQ-M-THINKING-BUDGET");
  if (budget === undefined) {
    degradations.add("request.option_omitted");
    return undefined;
  }
  degradations.add("reasoning.budget_coarsened");
  return { effort: effortFromBudget(budget) };
}

export function reasoningForTarget(
  capability: Readonly<EffectiveModelCapabilitySnapshot>,
  target: InferenceProtocol,
  reasoning: SemanticReasoning | undefined,
): {
  readonly reasoning: SemanticReasoning | undefined;
  readonly degradations: readonly ConversionDegradationRule[];
} {
  if (reasoning === undefined) return { reasoning: undefined, degradations: [] };
  const resolution = resolveModelReasoningEffort(capability.capabilities, target, reasoning.effort);
  if (resolution.kind === "exact") return { reasoning: { effort: resolution.effort }, degradations: [] };
  if (resolution.kind === "coarsened") {
    return { reasoning: { effort: resolution.effort }, degradations: ["reasoning.budget_coarsened"] };
  }
  return { reasoning: undefined, degradations: ["reasoning.presentation_omitted"] };
}

export function parallelCallsForTarget(
  request: Readonly<SemanticRequest>,
  capability: Readonly<EffectiveModelCapabilitySnapshot>,
): { readonly value?: boolean; readonly degradations: readonly ConversionDegradationRule[] } {
  if (request.parallelToolCalls === undefined || capability.capabilities.parallelToolCalling) {
    return {
      ...(request.parallelToolCalls === undefined ? {} : { value: request.parallelToolCalls }),
      degradations: [],
    };
  }
  if (request.parallelToolCalls) unsupported("REQ-TARGET-PARALLEL-CAPABILITY");
  return { degradations: ["tools.parallel_control_omitted"] };
}

export function validateConditionalTargetParameters(
  request: Readonly<SemanticRequest>,
  capability: Readonly<EffectiveModelCapabilitySnapshot>,
  target: InferenceProtocol,
): void {
  const supported = capability.profile.supportedParameters.value;
  const hasToolSemantics = request.tools.length > 0
    || request.toolChoice?.kind === "required"
    || request.toolChoice?.kind === "tool"
    || request.items.some((item) => item.type === "tool_call" || item.type === "tool_result");
  if (hasToolSemantics && !capability.capabilities.toolCalling) {
    unsupported("REQ-TARGET-TOOL-CAPABILITY");
  }
  if (request.parallelToolCalls === true && !capability.capabilities.parallelToolCalling) {
    unsupported("REQ-TARGET-PARALLEL-CAPABILITY");
  }
  const hasImages = request.instructions.some((part) => part.type === "image")
    || request.items.some((item) => (
      (item.type === "message" || item.type === "tool_result")
      && item.content.some((part) => part.type === "image")
    ));
  if (hasImages && !capability.capabilities.inputModalities.includes("image")) {
    unsupported("REQ-TARGET-IMAGE-CAPABILITY");
  }
  if (request.temperature !== undefined && supported?.includes("temperature") !== true) {
    unsupported("REQ-TARGET-TEMPERATURE-CAPABILITY");
  }
  if (request.topP !== undefined && supported?.includes("top_p") !== true) {
    unsupported("REQ-TARGET-TOP-P-CAPABILITY");
  }
  if (request.outputFormat === undefined) {
    return;
  }
  const formatKeys = target === "chat"
    ? ["response_format"]
    : target === "responses"
      ? ["text.format", "response_format"]
      : ["output_config.format", "output_config"];
  if (!formatKeys.some((key) => supported?.includes(key) === true)) {
    unsupported("REQ-TARGET-FORMAT-CAPABILITY");
  }
}

export function outputBudget(explicit: number | undefined, capability: EffectiveModelCapabilitySnapshot): number {
  try {
    return chooseOutputTokenBudget(explicit, capability.defaultOutputTokens);
  } catch {
    invalid("REQ-TARGET-M-LIMIT");
  }
}

export function validateSingleChoice(
  value: WireJson | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): void {
  if (value === undefined) {
    return;
  }
  const parsed = positiveInteger(value, ruleId);
  if (parsed === undefined) {
    if (containsReasoningCarrier(value)) invalid(ruleId);
    degradations.add("request.option_omitted");
    return;
  }
  if (parsed !== 1) {
    unsupported(ruleId);
  }
}

export function aliasedPositiveInteger(
  object: WireJsonObject,
  keys: readonly string[],
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): number | undefined {
  for (const member of object.members) {
    if (!keys.includes(member.key)) continue;
    const value = positiveInteger(member.value, ruleId);
    if (value === undefined) {
      if (containsReasoningCarrier(member.value)) invalid(ruleId);
      degradations.add("request.option_omitted");
    }
    return value;
  }
  return undefined;
}

export function reasoningFromEffort(
  value: string | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
  allowNone = false,
): SemanticReasoning | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "none" && allowNone) {
    return { effort: "none" };
  }
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return { effort: value };
  }
  if (isReasoningCarrier(value)) invalid(ruleId);
  degradations.add("request.option_omitted");
  return undefined;
}

export function mergeReasoning(
  first: SemanticReasoning | undefined,
  second: SemanticReasoning | undefined,
): SemanticReasoning | undefined {
  if (first?.effort !== undefined) {
    return first;
  }
  return second;
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

export function decodeIndependentStreamOptions(
  value: WireJson | undefined,
  omission: "chat.extensions_omitted" | "responses.extensions_omitted",
  degradations: Set<ConversionDegradationRule>,
): WireJsonObject | undefined {
  const projected = projectIndependentOption(safeIndependentOption(value, "REQ-STREAM-OPTIONS"), (candidate) => {
    if (!isWireJsonObject(candidate)) return { kind: "malformed" };
    const includeUsage = memberValues(candidate, "include_usage")[0];
    if (includeUsage !== undefined && typeof includeUsage !== "boolean") {
      return { kind: "malformed" };
    }
    if (candidate.members.some((member) => member.key !== "include_usage")) degradations.add(omission);
    return {
      kind: "value",
      value: {
        kind: "object" as const,
        members: includeUsage === undefined ? [] : [{ key: "include_usage", value: includeUsage }],
      },
    };
  }, { omission: "request.option_omitted", degradations });
  if (value !== undefined) degradations.add("request.option_omitted");
  return projected;
}
