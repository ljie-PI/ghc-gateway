import { canonicalizeWireJson } from "../../../serialization/canonical_json.js";
import { isWireJsonArray, isWireJsonObject, memberValues, type WireJson, type WireJsonArray, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { projectKnownObject } from "../request_projection.js";
import { type ConversionDegradationRule, type ResponsesToolCallBinding, type ResponsesToolResultBinding, type ResponsesToolSourceBinding } from "../types.js";
import { invalid } from "../wire.js";

const EXTENDED_SENSITIVE_FIELDS = new Set([
  "allowed_callers", "caller", "container", "defer_loading", "encrypted_content", "output_schema",
  "previous_response_id", "reasoning_content", "reasoning_details", "reasoning_items", "tool_call_id", "tool_use_id",
]);

export interface MutableState {
  readonly degradations: Set<ConversionDegradationRule>;
  readonly discoveredTools: WeakMap<WireJsonObject, WireJsonArray>;
  readonly bindings: ResponsesToolSourceBinding[];
  readonly bySourceKey: Map<string, ResponsesToolSourceBinding>;
  readonly byChatName: Map<string, ResponsesToolSourceBinding>;
  readonly omittedSourceKeys: Set<string>;
  readonly tools: WireJsonObject[];
  readonly calls: ResponsesToolCallBinding[];
  readonly results: ResponsesToolResultBinding[];
}

export function replaceMember(objectValue: WireJsonObject, key: string, value: WireJson): WireJsonObject {
  return {
    kind: "object",
    members: objectValue.members.map((member) => member.key === key ? { key, value } : member),
  };
}

export function removeMember(objectValue: WireJsonObject, key: string): WireJsonObject {
  return {
    kind: "object",
    members: objectValue.members.filter((member) => member.key !== key),
  };
}

export function optionalCopied(value: WireJsonObject, keys: readonly string[]): Array<readonly [string, WireJson]> {
  return keys.flatMap((key) => {
    const found = single(value, key, `REQ-R-EXT-${key.toUpperCase()}`);
    return found === undefined ? [] : [[key, found] as const];
  });
}

export function sourceKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ""}\u0000${name}`;
}

export function canonicalString(value: WireJson): string {
  return new TextDecoder().decode(canonicalizeWireJson(value));
}

export function projectExtended(
  state: Pick<MutableState, "degradations">,
  value: WireJsonObject,
  allowed: ReadonlySet<string>,
  ruleId: string,
): WireJsonObject {
  return projectKnownObject(value, {
    knownKeys: allowed,
    sensitiveKeys: EXTENDED_SENSITIVE_FIELDS,
    omittedValueIsUnsafe: containsReasoningCarrier,
    ruleId,
    omission: "responses.extensions_omitted",
    degradations: state.degradations,
  });
}

export function looseObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) invalid(ruleId);
  return value;
}

export function single(value: WireJsonObject, key: string, _ruleId: string): WireJson | undefined {
  return memberValues(value, key)[0];
}

export function requiredObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) {
    invalid(ruleId);
  }
  return value;
}

export function requiredArray(value: WireJson | undefined, ruleId: string): WireJsonArray {
  if (!isWireJsonArray(value)) {
    invalid(ruleId);
  }
  return value;
}

export function requiredString(value: WireJson | undefined, ruleId: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalid(ruleId);
  }
  return value;
}

export function optionalExtendedString(
  state: Pick<MutableState, "degradations">,
  value: WireJson | undefined,
  ruleId: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  return omitMalformedExtended(state, value, ruleId);
}

export function optionalExtendedObject(
  state: Pick<MutableState, "degradations">,
  value: WireJson | undefined,
  ruleId: string,
): WireJsonObject | undefined {
  if (value === undefined) return undefined;
  if (isWireJsonObject(value)) return value;
  return omitMalformedExtended(state, value, ruleId);
}

export function omitMalformedExtended(
  state: Pick<MutableState, "degradations">,
  value: WireJson,
  ruleId: string,
): undefined {
  if (containsReasoningCarrier(value)) invalid(ruleId);
  state.degradations.add("request.option_omitted");
  return undefined;
}

export function immutableWire(value: WireJson): WireJson {
  if (isWireJsonArray(value)) {
    return Object.freeze({ kind: "array", items: Object.freeze(value.items.map(immutableWire)) });
  }
  if (isWireJsonObject(value)) {
    return Object.freeze({
      kind: "object",
      members: Object.freeze(value.members.map((member) => Object.freeze({
        key: member.key,
        value: immutableWire(member.value),
      }))),
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze({ ...value });
  }
  return value;
}

export function looksLikeNestedJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[") || value.startsWith("\"");
}
export function object(members: readonly (readonly [string, WireJson])[]): WireJsonObject {
  return { kind: "object", members: members.map(([key, value]) => ({ key, value })) };
}

export function array(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}
