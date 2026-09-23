import type { WireJson, WireJsonObject } from "../../serialization/wire_json.js";
import {
  type ConversionDegradationRecorder,
  type ConversionDegradationRule,
} from "./degradations.js";
import {
  ConversionContractError,
  type SemanticRequestItem,
  type SemanticTool,
  type SemanticToolCallItem,
  type SemanticToolChoice,
  type SemanticToolResultItem,
} from "./types.js";
import { RequestSequenceTracker, validateSemanticBindings } from "./request_sequence.js";
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

export type ToolHistoryProjectionItem =
  | { readonly kind: "item"; readonly item: SemanticRequestItem }
  | {
    readonly kind: "tool_call";
    readonly callId?: string | undefined;
    readonly bindingKey: string;
    readonly item?: SemanticToolCallItem | undefined;
  }
  | {
    readonly kind: "tool_result";
    readonly callId?: string | undefined;
    readonly bindingKey: string;
    readonly item?: SemanticToolResultItem | undefined;
  };

export function projectCompleteToolRounds(
  candidates: readonly ToolHistoryProjectionItem[],
  degradations: ConversionDegradationRecorder,
): readonly SemanticRequestItem[] {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  const omitted = new Set<number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (candidate.kind === "item") continue;
    if (
      candidate.callId === undefined
      || candidate.callId.length === 0
      || candidate.item === undefined
      || candidate.item.callId !== candidate.callId
    ) {
      omitted.add(index);
      continue;
    }
    const entries = candidate.kind === "tool_call" ? calls : results;
    const indexes = entries.get(candidate.callId) ?? [];
    indexes.push(index);
    entries.set(candidate.callId, indexes);
  }

  const identities = new Set([...calls.keys(), ...results.keys()]);
  for (const callId of identities) {
    const callIndexes = calls.get(callId) ?? [];
    const resultIndexes = results.get(callId) ?? [];
    const call = callIndexes.length === 1 ? candidates[callIndexes[0]!] : undefined;
    const result = resultIndexes.length === 1 ? candidates[resultIndexes[0]!] : undefined;
    if (
      callIndexes.length !== 1
      || resultIndexes.length !== 1
      || call?.kind !== "tool_call"
      || result?.kind !== "tool_result"
      || call.bindingKey !== result.bindingKey
    ) {
      for (const index of [...callIndexes, ...resultIndexes]) omitted.add(index);
    }
  }

  const roundBounds = toolRoundBounds(candidates);
  for (let index = 0; index < candidates.length; index += 1) {
    if (!omitted.has(index) || candidates[index]?.kind === "item") continue;
    const [start, end] = roundBounds.get(index) ?? [index, index];
    for (let runIndex = start; runIndex <= end; runIndex += 1) {
      if (candidates[runIndex]?.kind !== "item") omitted.add(runIndex);
    }
  }

  for (;;) {
    const invalidIds = invalidRoundIdentities(candidates, omitted);
    if (invalidIds.size === 0) break;
    let changed = false;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (candidate.kind !== "item" && candidate.callId !== undefined && invalidIds.has(candidate.callId)) {
        if (!omitted.has(index)) changed = true;
        omitted.add(index);
      }
    }
    if (!changed) break;
  }

  if (omitted.size > 0) degradations.add("tools.history_omitted");
  return candidates.flatMap((candidate, index) => {
    if (omitted.has(index)) return [];
    return candidate.item === undefined ? [] : [candidate.item];
  });
}

function toolRoundBounds(
  candidates: readonly ToolHistoryProjectionItem[],
): ReadonlyMap<number, readonly [number, number]> {
  const bounds = new Map<number, readonly [number, number]>();
  let start: number | undefined;
  let calls = new Set<string>();
  let results = new Set<string>();
  let hasUnboundCall = false;
  const close = (end: number): void => {
    if (start === undefined) return;
    for (let index = start; index <= end; index += 1) bounds.set(index, [start, end]);
    start = undefined;
    calls = new Set();
    results = new Set();
    hasUnboundCall = false;
  };
  const complete = (): boolean => (
    !hasUnboundCall
    && calls.size > 0
    && [...calls].every((callId) => results.has(callId))
  );

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (candidate.kind === "item") {
      close(index - 1);
      continue;
    }
    if (start !== undefined && (complete() || (candidate.kind === "tool_call" && calls.size === 0))) {
      close(index - 1);
    }
    start ??= index;
    if (candidate.kind === "tool_call") {
      if (candidate.callId === undefined || candidate.callId.length === 0) hasUnboundCall = true;
      else calls.add(candidate.callId);
    } else if (candidate.callId !== undefined && candidate.callId.length > 0) {
      results.add(candidate.callId);
    }
  }
  close(candidates.length - 1);
  return bounds;
}

function invalidRoundIdentities(
  candidates: readonly ToolHistoryProjectionItem[],
  omitted: ReadonlySet<number>,
): ReadonlySet<string> {
  const invalidIds = new Set<string>();
  const activeIds = new Set<string>();
  const roundIds = new Set<string>();
  const reject = (): never => {
    for (const callId of roundIds) invalidIds.add(callId);
    throw new RoundProjectionError();
  };
  const sequence = new RequestSequenceTracker<string>(reject);
  for (let index = 0; index < candidates.length; index += 1) {
    if (omitted.has(index)) continue;
    const candidate = candidates[index]!;
    try {
      if (candidate.kind === "item") {
        if (candidate.item.type === "reasoning") sequence.observeReasoning();
        else if (candidate.item.type === "message") sequence.observeMessage(candidate.item.role);
        continue;
      }
      const callId = candidate.callId;
      if (callId === undefined || candidate.item === undefined) continue;
      if (candidate.kind === "tool_call") {
        activeIds.add(callId);
        roundIds.add(callId);
        sequence.observeToolCall(callId, candidate.bindingKey);
      } else {
        sequence.observeToolResult(callId, (binding) => {
          if (binding !== candidate.bindingKey) reject();
        });
        activeIds.delete(callId);
        if (!sequence.hasOpenCalls()) roundIds.clear();
      }
    } catch (error: unknown) {
      if (!(error instanceof RoundProjectionError)) throw error;
      if (candidate.kind !== "item" && candidate.callId !== undefined) invalidIds.add(candidate.callId);
    }
  }
  try {
    sequence.finish();
  } catch (error: unknown) {
    if (!(error instanceof RoundProjectionError)) throw error;
  }
  return invalidIds;
}

class RoundProjectionError extends Error {}

export function reconcileProjectedToolControls(input: Readonly<{
  readonly tools: readonly SemanticTool[];
  readonly toolChoice?: SemanticToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly degradations: ConversionDegradationRecorder;
}>): { readonly toolChoice?: SemanticToolChoice; readonly parallelToolCalls?: boolean } {
  const names = new Set(input.tools.map((tool) => tool.name));
  if (
    (input.toolChoice?.kind === "tool" && !names.has(input.toolChoice.name))
    || (input.toolChoice?.kind === "required" && names.size === 0)
  ) {
    throw new ConversionContractError("invalid_request", "REQ-TOOL-CHOICE-REMOVED");
  }
  const parallelToolCalls = names.size === 0 ? undefined : input.parallelToolCalls;
  if (input.parallelToolCalls !== undefined && parallelToolCalls === undefined) {
    input.degradations.add("tools.parallel_control_omitted");
  }
  return {
    ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
  };
}

export function projectToolRequest(input: Readonly<{
  readonly source: "chat" | "messages" | "responses";
  readonly candidates: readonly ToolHistoryProjectionItem[];
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
  const items = projectCompleteToolRounds(input.candidates, input.degradations);
  const controls = reconcileProjectedToolControls(input);
  validateSemanticBindings({
    source: input.source,
    stream: false,
    instructions: [],
    items,
    tools: input.tools,
    ...controls,
    degradations: [],
  });
  return { items, tools: input.tools, ...controls };
}
