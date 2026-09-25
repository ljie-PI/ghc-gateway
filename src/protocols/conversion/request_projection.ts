import { containsReasoningCarrier } from "./reasoning_carriers.js";
import type { WireJson, WireJsonObject } from "../../serialization/wire_json.js";
import {
  type ConversionDegradationRecorder,
  type ConversionDegradationRule,
} from "./degradations.js";
import {
  type SemanticRequestItem,
  type SemanticTool,
  type SemanticToolChoice,
} from "./types.js";
import { invalid } from "./wire.js";

export function projectKnownObject(
  object: WireJsonObject,
  policy: Readonly<{
    readonly knownKeys: ReadonlySet<string>;
    readonly sensitiveKeys?: ReadonlySet<string> | undefined;
    readonly omittedValueIsUnsafe?: ((value: WireJson) => boolean) | undefined;
    readonly ruleId: string;
    readonly omission: ConversionDegradationRule;
    readonly degradations: ConversionDegradationRecorder;
  }>,
): WireJsonObject {
  const members: WireJsonObject["members"][number][] = [];
  const seen = new Set<string>();
  let omitted = false;
  for (const member of object.members) {
    if (policy.knownKeys.has(member.key)) {
      if (seen.has(member.key)) {
        if (policy.omittedValueIsUnsafe?.(member.value) === true) invalid(policy.ruleId);
        continue;
      }
      seen.add(member.key);
      members.push(member);
      continue;
    }
    if (
      policy.sensitiveKeys?.has(member.key) === true
      || policy.omittedValueIsUnsafe?.(member.value) === true
    ) invalid(policy.ruleId);
    omitted = true;
  }
  if (omitted) policy.degradations.add(policy.omission);
  return { kind: "object", members };
}

export type IndependentOptionParse<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "malformed" };

export function projectIndependentOption<T>(
  value: WireJson | undefined,
  parse: (value: WireJson) => IndependentOptionParse<T>,
  policy: Readonly<{
    readonly omission: ConversionDegradationRule;
    readonly degradations: ConversionDegradationRecorder;
  }>,
): T | undefined {
  if (value === undefined) return undefined;
  const parsed = parse(value);
  if (parsed.kind === "value") return parsed.value;
  policy.degradations.add(policy.omission);
  return undefined;
}

export function reconcileProjectedToolControls(input: Readonly<{
  readonly tools: readonly SemanticTool[];
  readonly toolChoice?: SemanticToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly degradations: ConversionDegradationRecorder;
}>): { readonly toolChoice?: SemanticToolChoice; readonly parallelToolCalls?: boolean } {
  const names = new Set(input.tools.map((tool) => tool.name));
  const unresolvedNamedChoice = input.toolChoice?.kind === "tool" && !names.has(input.toolChoice.name);
  if (unresolvedNamedChoice && containsReasoningCarrier(input.toolChoice.name)) invalid("REQ-TOOL-CHOICE-MISSING");
  const toolChoice = (
    unresolvedNamedChoice
    || (input.toolChoice?.kind === "required" && names.size === 0)
  ) ? undefined : input.toolChoice;
  if (input.toolChoice !== undefined && toolChoice === undefined) input.degradations.add("request.option_omitted");
  const parallelToolCalls = names.size === 0 ? undefined : input.parallelToolCalls;
  if (input.parallelToolCalls !== undefined && parallelToolCalls === undefined) {
    input.degradations.add("tools.parallel_control_omitted");
  }
  return {
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
  };
}

export function projectToolRequest(input: Readonly<{
  readonly items: readonly SemanticRequestItem[];
  readonly tools: readonly SemanticTool[];
  readonly toolChoice?: SemanticToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly degradations: ConversionDegradationRecorder;
}>): {
  readonly items: readonly SemanticRequestItem[];
  readonly tools: readonly SemanticTool[];
  readonly toolChoice?: SemanticToolChoice;
  readonly parallelToolCalls?: boolean;
} {
  const items = input.items;
  const seen = new Set<string>();
  const tools = input.tools.filter((tool) => {
    if (seen.has(tool.name)) {
      if ([tool.name, tool.description, tool.sourceName, tool.namespace, tool.parameters]
        .some((value) => value !== undefined && containsReasoningCarrier(value))) invalid("REQ-TOOL-DUPLICATE");
      input.degradations.add("request.option_omitted");
      return false;
    }
    seen.add(tool.name);
    return true;
  });
  const controls = reconcileProjectedToolControls({ ...input, tools });
  return { items, tools, ...controls };
}
