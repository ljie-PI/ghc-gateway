import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  serializeWireJson,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
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
  assertNoDuplicates(value, ruleId);
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
  return requiredString(value, ruleId);
}

export function optionalBoolean(value: WireJson | undefined, ruleId: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    invalid(ruleId);
  }
  return value;
}

export function positiveInteger(value: WireJson | undefined, ruleId: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonNumber(value)) {
    invalid(ruleId);
  }
  const parsed = Number(value.lexeme);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    invalid(ruleId);
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
    invalid(ruleId);
  }
  const parsed = Number(value.lexeme);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    invalid(ruleId);
  }
  return parsed;
}

export function oneMember(object: WireJsonObject, key: string, ruleId: string): WireJson | undefined {
  const values = memberValues(object, key);
  if (values.length > 1) {
    invalid(ruleId);
  }
  return values[0];
}

export function assertNoDuplicates(object: WireJsonObject, ruleId: string): void {
  if (duplicateMemberNames(object).length > 0) {
    invalid(ruleId);
  }
}

export function assertAllowedKeys(
  object: WireJsonObject,
  allowed: ReadonlySet<string>,
  ruleId: string,
): void {
  assertNoDuplicates(object, ruleId);
  if (object.members.some((member) => !allowed.has(member.key))) {
    unsupported(ruleId);
  }
}

export function jsonObjectString(value: WireJson, ruleId: string): string {
  if (!isWireJsonObject(value)) {
    invalid(ruleId);
  }
  assertNoDuplicates(value, ruleId);
  return new TextDecoder().decode(serializeWireJson(value));
}

export function parseStringList(value: WireJson | undefined, ruleId: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return [value];
  }
  const array = requiredArray(value, ruleId);
  return array.items.map((item) => requiredString(item, ruleId));
}

export function invalid(ruleId: string): never {
  throw new ConversionContractError("invalid_request", ruleId);
}

export function unsupported(ruleId: string): never {
  throw new ConversionContractError("unsupported_semantics", ruleId);
}
