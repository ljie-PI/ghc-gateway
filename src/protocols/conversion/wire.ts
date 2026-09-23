import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  serializeWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { containsReasoningCarrier } from "./reasoning_carriers.js";
import { ConversionContractError } from "./types.js";

export function wireObject(entries: readonly (readonly [string, WireJson | undefined])[]): WireJsonObject {
  return {
    kind: "object",
    members: entries
      .filter((entry): entry is readonly [string, WireJson] => entry[1] !== undefined)
      .map(([key, value]) => ({ key, value })),
  };
}

export function wireArray(items: readonly WireJson[]): WireJsonArray {
  return { kind: "array", items };
}

export function wireNumber(value: number): WireJson {
  return { kind: "number", lexeme: String(value) };
}

export function encodeWireObject(value: WireJsonObject): Uint8Array {
  return serializeWireJson(value);
}

export function requiredObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) {
    invalid(ruleId);
  }
  return value;
}

export function optionalObject(value: WireJson | undefined, ruleId: string): WireJsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredObject(value, ruleId);
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

export function optionalString(value: WireJson | undefined, ruleId: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.length > 0) return value;
  if (containsReasoningCarrier(value)) invalid(ruleId);
  return undefined;
}

export function optionalBoolean(value: WireJson | undefined, ruleId: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") return value;
  if (containsReasoningCarrier(value)) invalid(ruleId);
  return undefined;
}

export function positiveInteger(value: WireJson | undefined, ruleId: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonNumber(value)) {
    if (containsReasoningCarrier(value)) invalid(ruleId);
    return undefined;
  }
  const parsed = Number(value.lexeme);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function finiteNumber(
  value: WireJson | undefined,
  ruleId: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonNumber(value)) {
    if (containsReasoningCarrier(value)) invalid(ruleId);
    return undefined;
  }
  const parsed = Number(value.lexeme);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return undefined;
  }
  return parsed;
}

export function oneMember(object: WireJsonObject, key: string, _ruleId: string): WireJson | undefined {
  return memberValues(object, key)[0];
}

export function jsonObjectString(value: WireJson, ruleId: string): string {
  if (!isWireJsonObject(value)) {
    invalid(ruleId);
  }
  return new TextDecoder().decode(serializeWireJson(value));
}

export function parseStringList(value: WireJson | undefined, ruleId: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.length > 0 ? [value] : undefined;
  }
  if (!isWireJsonArray(value)) {
    if (containsReasoningCarrier(value)) invalid(ruleId);
    return undefined;
  }
  const items = value.items.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (items.length === value.items.length) return items;
  if (containsReasoningCarrier(value)) invalid(ruleId);
  return undefined;
}

export function invalid(ruleId: string): never {
  throw new ConversionContractError("invalid_request", ruleId);
}

export function unsupported(ruleId: string): never {
  throw new ConversionContractError("unsupported_semantics", ruleId);
}
