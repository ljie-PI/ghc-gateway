import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonArray,
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
  return cleanSchemaNode(schema, true, 0);
}

const SCHEMA_CHILD_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function cleanSchemaNode(schema: WireJsonObject, root: boolean, depth: number): { readonly schema: WireJsonObject; readonly changed: boolean } {
  if (depth > 32) invalid("REQ-TARGET-C-TOOL-SCHEMA");
  let changed = false;
  let sawType = false;
  let sawProperties = false;
  const members: Array<{ readonly key: string; readonly value: WireJson }> = [];
  for (const member of schema.members) {
    if (member.key === "propertyNames" || (member.key === "format" && member.value === "uri")) {
      if (containsReasoningCarrier(member.value)) invalid("REQ-TARGET-C-TOOL-SCHEMA");
      changed = true;
      continue;
    }
    let value = member.value;
    if (member.key === "type") {
      sawType = true;
      const objectType = value === "object" || (isWireJsonArray(value) && value.items.includes("object"));
      if (root && !objectType) {
        if (containsReasoningCarrier(value)) invalid("REQ-TARGET-C-TOOL-SCHEMA");
        value = "object";
        changed = true;
      }
    } else if (SCHEMA_MAP_KEYS.has(member.key)) {
      if (member.key === "properties") {
        sawProperties = true;
        if (!isWireJsonObject(value)) {
          if (containsReasoningCarrier(value)) invalid("REQ-TARGET-C-TOOL-SCHEMA");
          value = { kind: "object", members: [] };
          changed = true;
        }
      }
      if (isWireJsonObject(value)) {
        const cleaned = cleanSchemaMap(value, depth);
        value = cleaned.value;
        changed ||= cleaned.changed;
      }
    } else if (SCHEMA_ARRAY_KEYS.has(member.key) && isWireJsonArray(value)) {
      const cleaned = cleanSchemaArray(value, depth);
      value = cleaned.value;
      changed ||= cleaned.changed;
    } else if (SCHEMA_CHILD_KEYS.has(member.key)) {
      if (isWireJsonObject(value)) {
        const cleaned = cleanSchemaNode(value, false, depth + 1);
        value = cleaned.schema;
        changed ||= cleaned.changed;
      } else if (member.key === "items" && isWireJsonArray(value)) {
        const cleaned = cleanSchemaArray(value, depth);
        value = cleaned.value;
        changed ||= cleaned.changed;
      }
    }
    members.push({ key: member.key, value });
  }
  if (root && !sawType) { members.unshift({ key: "type", value: "object" }); changed = true; }
  if (root && !sawProperties) { members.push({ key: "properties", value: { kind: "object", members: [] } }); changed = true; }
  return { schema: changed ? Object.freeze({ kind: "object", members: Object.freeze(members) }) : schema, changed };
}

function cleanSchemaMap(value: WireJsonObject, depth: number): { readonly value: WireJsonObject; readonly changed: boolean } {
  let changed = false;
  const members = value.members.map((member) => {
    if (!isWireJsonObject(member.value)) return member;
    const cleaned = cleanSchemaNode(member.value, false, depth + 1);
    changed ||= cleaned.changed;
    return cleaned.changed ? { key: member.key, value: cleaned.schema } : member;
  });
  return { value: changed ? Object.freeze({ kind: "object", members: Object.freeze(members) }) : value, changed };
}

function cleanSchemaArray(
  value: WireJsonArray,
  depth: number,
): { readonly value: WireJsonArray; readonly changed: boolean } {
  let changed = false;
  const items = value.items.map((item) => {
    if (!isWireJsonObject(item)) return item;
    const cleaned = cleanSchemaNode(item, false, depth + 1);
    changed ||= cleaned.changed;
    return cleaned.schema;
  });
  return { value: changed ? Object.freeze({ kind: "array", items: Object.freeze(items) }) : value, changed };
}
