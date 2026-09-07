import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJsonObject,
} from "../../serialization/wire_json.js";

export function isOpenAiStrictSchemaCompatible(
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
    const propertyNames = propertyObject.members.map((member) => member.key);
    if (
      propertyNames.length !== requiredItems.length
      || propertyNames.some((name) => !requiredItems.includes(name))
      || propertyObject.members.some((member) => (
        !isWireJsonObject(member.value)
        || !isOpenAiStrictSchemaCompatible(member.value, false, depth + 1)
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
        || !isOpenAiStrictSchemaCompatible(items[0], false, depth + 1)))
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
          || !isOpenAiStrictSchemaCompatible(branch, false, depth + 1)
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
        || !isOpenAiStrictSchemaCompatible(definition.value, false, depth + 1)
      ))
    ) {
      return false;
    }
  }
  return true;
}
