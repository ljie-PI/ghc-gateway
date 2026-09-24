import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { containsReasoningCarrier } from "./reasoning_carriers.js";
import { invalid } from "./wire.js";

export function isOpenaiStrictSchemaCompatible(
  schema: WireJsonObject,
  root = true,
  depth = 0,
): boolean {
  if (depth > 32 || duplicateMemberNames(schema).length > 0) {
    return false;
  }
  const types = memberValues(schema, "type");
  if (types.length > 1) {
    return false;
  }
  const type = types[0];
  const objectType = type === "object"
    || (isWireJsonArray(type) && type.items.includes("object"));
  if (root && !objectType) {
    return false;
  }
  if (objectType) {
    const propertyValues = memberValues(schema, "properties");
    if (propertyValues.length > 1) {
      return false;
    }
    const properties = propertyValues[0];
    if (properties !== undefined && !isWireJsonObject(properties)) {
      return false;
    }
    const propertyObject = isWireJsonObject(properties)
      ? properties
      : { kind: "object" as const, members: [] };
    if (duplicateMemberNames(propertyObject).length > 0) {
      return false;
    }
    const additional = memberValues(schema, "additionalProperties");
    if (additional.length !== 1 || additional[0] !== false) {
      return false;
    }
    const required = memberValues(schema, "required");
    if (required.length > 1 || (required[0] !== undefined && !isWireJsonArray(required[0]))) {
      return false;
    }
    const requiredItems = isWireJsonArray(required[0]) ? required[0].items : [];
    if (
      requiredItems.some((item) => typeof item !== "string")
      || new Set(requiredItems).size !== requiredItems.length
    ) {
      return false;
    }
    const requiredNames = new Set(requiredItems);
    const propertyNames = propertyObject.members.map((member) => member.key);
    if (
      propertyNames.length !== requiredItems.length
      || propertyNames.some((name) => !requiredNames.has(name))
      || propertyObject.members.some((member) => (
        !isWireJsonObject(member.value)
        || !isOpenaiStrictSchemaCompatible(member.value, false, depth + 1)
      ))
    ) {
      return false;
    }
  }
  const items = memberValues(schema, "items");
  if (
    items.length > 1
    || (items[0] !== undefined
      && (!isWireJsonObject(items[0])
        || !isOpenaiStrictSchemaCompatible(items[0], false, depth + 1)))
  ) {
    return false;
  }
  const anyOf = memberValues(schema, "anyOf");
  if (
    anyOf.length > 1
    || (anyOf[0] !== undefined
      && (!isWireJsonArray(anyOf[0])
        || anyOf[0].items.some((branch) => (
          !isWireJsonObject(branch)
          || !isOpenaiStrictSchemaCompatible(branch, false, depth + 1)
        ))))
  ) {
    return false;
  }
  const definitions = memberValues(schema, "$defs");
  if (definitions.length > 1 || (definitions[0] !== undefined && !isWireJsonObject(definitions[0]))) {
    return false;
  }
  if (isWireJsonObject(definitions[0])) {
    if (
      duplicateMemberNames(definitions[0]).length > 0
      || definitions[0].members.some((definition) => (
        !isWireJsonObject(definition.value)
        || !isOpenaiStrictSchemaCompatible(definition.value, false, depth + 1)
      ))
    ) {
      return false;
    }
  }
  return true;
}

export function cleanChatToolSchema(schema: WireJsonObject): { readonly schema: WireJsonObject; readonly changed: boolean } {
  const result = cleanSchemaValue(schema, true, 0);
  return { schema: result.value as WireJsonObject, changed: result.changed };
}

function cleanSchemaValue(value: WireJson, root: boolean, depth: number): { readonly value: WireJson; readonly changed: boolean } {
  if (depth > 32) invalid("REQ-TARGET-C-TOOL-SCHEMA");
  if (isWireJsonArray(value)) {
    let changed = false;
    const items = value.items.map((item) => { const cleaned = cleanSchemaValue(item, false, depth + 1); changed ||= cleaned.changed; return cleaned.value; });
    return { value: changed ? { ...value, items } : value, changed };
  }
  if (!isWireJsonObject(value)) return { value, changed: false };
  let changed = false;
  let hasType = false;
  let hasProperties = false;
  const members: Array<{ readonly key: string; readonly value: WireJson }> = [];
  for (const member of value.members) {
    if (member.key === "propertyNames" || (member.key === "format" && member.value === "uri")) {
      if (containsReasoningCarrier(member.value)) invalid("REQ-TARGET-C-TOOL-SCHEMA");
      changed = true;
      continue;
    }
    if (member.key === "type") hasType = true;
    if (member.key === "properties") hasProperties = true;
    let child = cleanSchemaValue(member.value, false, depth + 1);
    if (member.key === "properties" && !isWireJsonObject(child.value)) {
      if (containsReasoningCarrier(child.value)) invalid("REQ-TARGET-C-TOOL-SCHEMA");
      child = { value: { kind: "object", members: [] }, changed: true };
    }
    changed ||= child.changed;
    members.push({ key: member.key, value: child.value });
  }
  if (root && !hasType) { members.unshift({ key: "type", value: "object" }); changed = true; }
  if (root && !hasProperties) { members.push({ key: "properties", value: { kind: "object", members: [] } }); changed = true; }
  return { value: changed ? Object.freeze({ kind: "object", members: Object.freeze(members) }) : value, changed };
}
