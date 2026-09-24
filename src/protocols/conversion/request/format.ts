import { isWireJsonObject, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { isOpenaiStrictSchemaCompatible } from "../strict_schema.js";
import { type ConversionDegradationRule, type SemanticOutputFormat, type SemanticReasoning } from "../types.js";
import { invalid, oneMember, optionalBoolean, optionalString, unsupported, wireObject } from "../wire.js";
import { optionalChoiceString, optionalProtocolObject, projectMessagesMembers, projectRequestMembers, replaceOptionalMember } from "./projection.js";

export function decodeChatOutputFormat(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticOutputFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-C-FORMAT", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectRequestMembers(
    rawObject,
    new Set(["type", "json_schema"]),
    "REQ-C-FORMAT",
    "chat.extensions_omitted",
    degradations,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-C-FORMAT-TYPE"),
    "REQ-C-FORMAT-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type === "json_object") {
    return { kind: "json_object" };
  }
  if (type !== "json_schema") {
    degradations.add("chat.extensions_omitted");
    return undefined;
  }
  const schemaValue = oneMember(object, "json_schema", "REQ-C-FORMAT-SCHEMA");
  const schemaObject = optionalProtocolObject(schemaValue, "REQ-C-FORMAT-SCHEMA", degradations);
  if (schemaObject === undefined) return undefined;
  return decodeNamedSchema(
    projectRequestMembers(
      schemaObject,
      new Set(["name", "description", "schema", "strict"]),
      "REQ-C-FORMAT-SCHEMA",
      "chat.extensions_omitted",
      degradations,
    ),
    "REQ-C-FORMAT-SCHEMA",
    degradations,
  );
}

export function decodeMessagesOutputFormat(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): SemanticOutputFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawObject = optionalProtocolObject(value, "REQ-M-FORMAT", degradations);
  if (rawObject === undefined) return undefined;
  const object = projectMessagesMembers(
    rawObject,
    new Set(["type", "name", "description", "schema", "strict"]),
    "REQ-M-FORMAT",
    degradations,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-M-FORMAT-TYPE"),
    "REQ-M-FORMAT-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type === "json_object") {
    return { kind: "json_object" };
  }
  if (type !== "json_schema") {
    degradations.add("messages.extensions_omitted");
    return undefined;
  }
  const description = optionalString(
    oneMember(object, "description", "REQ-M-FORMAT-DESCRIPTION"),
    "REQ-M-FORMAT-DESCRIPTION",
  );
  const strict = optionalBoolean(oneMember(object, "strict", "REQ-M-FORMAT-STRICT"), "REQ-M-FORMAT-STRICT");
  if (strict === false) {
    degradations.add("request.option_omitted");
    return undefined;
  }
  const schema = optionalProtocolObject(
    oneMember(object, "schema", "REQ-M-FORMAT-SCHEMA"),
    "REQ-M-FORMAT-SCHEMA",
    degradations,
  );
  if (schema === undefined) return undefined;
  validateOpenaiStrictSchema(schema, true);
  return {
    kind: "json_schema",
    name: optionalString(oneMember(object, "name", "REQ-M-FORMAT-NAME"), "REQ-M-FORMAT-NAME") ?? "response",
    ...(description === undefined ? {} : { description }),
    schema,
    strict: true,
  };
}

function validateOpenaiStrictSchema(schema: WireJsonObject, root = false, depth = 0): void {
  if (!isOpenaiStrictSchemaCompatible(schema, root, depth)) {
    unsupported("REQ-M-FORMAT-STRICT-SCHEMA");
  }
}

export function decodeResponsesOutputFormat(
  body: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): SemanticOutputFormat | undefined {
  const textValue = oneMember(body, "text", "REQ-R-TEXT-FORMAT");
  const textObject = textValue === undefined
    ? undefined
    : optionalProtocolObject(textValue, "REQ-R-TEXT-FORMAT", degradations);
  const text = textObject === undefined ? undefined : projectRequestMembers(
    textObject,
    new Set(["format"]),
    "REQ-R-TEXT-FORMAT",
    "responses.extensions_omitted",
    degradations,
  );
  const responseFormat = oneMember(body, "response_format", "REQ-R-FORMAT");
  const textFormatValue = text === undefined ? undefined : oneMember(text, "format", "REQ-R-TEXT-FORMAT");
  const textFormat = textFormatValue === undefined
    ? undefined
    : optionalProtocolObject(textFormatValue, "REQ-R-TEXT-FORMAT", degradations);
  const responseFormatObject = responseFormat === undefined
    ? undefined
    : optionalProtocolObject(responseFormat, "REQ-R-FORMAT", degradations);
  if (textFormat !== undefined && responseFormatObject !== undefined) {
    invalid("REQ-R-FORMAT-CONFLICT");
  }
  const value = textFormat ?? responseFormatObject;
  if (value === undefined) {
    return undefined;
  }
  const object = projectRequestMembers(
    value,
    new Set(["type", "name", "description", "schema", "strict"]),
    "REQ-R-FORMAT",
    "responses.extensions_omitted",
    degradations,
  );
  const type = optionalChoiceString(
    oneMember(object, "type", "REQ-R-FORMAT-TYPE"),
    "REQ-R-FORMAT-TYPE",
    degradations,
  );
  if (type === undefined) return undefined;
  if (type === "json_object") {
    return { kind: "json_object" };
  }
  if (type !== "json_schema") {
    degradations.add("responses.extensions_omitted");
    return undefined;
  }
  return decodeNamedSchema(object, "REQ-R-FORMAT", degradations);
}

export function sanitizeResponsesOutputFormatMembers(
  body: WireJsonObject,
  degradations: Set<ConversionDegradationRule>,
): WireJsonObject {
  const textValue = oneMember(body, "text", "REQ-R-TEXT-FORMAT");
  let textFormat: WireJsonObject | undefined;
  if (isWireJsonObject(textValue)) {
    const text = projectRequestMembers(
      textValue,
      new Set(["format"]),
      "REQ-R-TEXT-FORMAT",
      "responses.extensions_omitted",
      degradations,
    );
    textFormat = validResponsesFormatCandidate(
      oneMember(text, "format", "REQ-R-TEXT-FORMAT"),
      "REQ-R-TEXT-FORMAT",
      degradations,
    );
  }
  const responseFormat = validResponsesFormatCandidate(
    oneMember(body, "response_format", "REQ-R-FORMAT"),
    "REQ-R-FORMAT",
    degradations,
  );
  body = replaceOptionalMember(
    body,
    "text",
    textFormat === undefined ? undefined : wireObject([["format", textFormat]]),
  );
  return replaceOptionalMember(body, "response_format", responseFormat);
}

function validResponsesFormatCandidate(
  value: WireJson | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): WireJsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isWireJsonObject(value)) {
    if (containsReasoningCarrier(value)) invalid(ruleId);
    degradations.add("request.option_omitted");
    return undefined;
  }
  const type = oneMember(value, "type", `${ruleId}-TYPE`);
  if (typeof type !== "string" || type.length === 0) {
    if (containsReasoningCarrier(value)) invalid(`${ruleId}-TYPE`);
    degradations.add("request.option_omitted");
    return undefined;
  }
  if (type !== "json_object" && type !== "json_schema") {
    if (containsReasoningCarrier(value)) invalid(`${ruleId}-TYPE`);
    degradations.add("responses.extensions_omitted");
    return undefined;
  }
  return value;
}

function decodeNamedSchema(
  object: WireJsonObject,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): SemanticOutputFormat | undefined {
  const description = optionalString(oneMember(object, "description", `${ruleId}-DESCRIPTION`), `${ruleId}-DESCRIPTION`);
  const strict = optionalBoolean(oneMember(object, "strict", `${ruleId}-STRICT`), `${ruleId}-STRICT`);
  const name = optionalString(oneMember(object, "name", `${ruleId}-NAME`), `${ruleId}-NAME`);
  const schema = optionalProtocolObject(oneMember(object, "schema", `${ruleId}-VALUE`), `${ruleId}-VALUE`, degradations);
  if (name === undefined || schema === undefined) {
    degradations.add("request.option_omitted");
    return undefined;
  }
  return {
    kind: "json_schema",
    name,
    ...(description === undefined ? {} : { description }),
    schema,
    ...(strict === undefined ? {} : { strict }),
  };
}

export function encodeChatOutputFormat(format: SemanticOutputFormat | undefined): WireJson | undefined {
  if (format === undefined || format.kind === "json_object") {
    return format === undefined ? undefined : wireObject([["type", "json_object"]]);
  }
  return wireObject([
    ["type", "json_schema"],
    ["json_schema", encodeNamedSchema(format)],
  ]);
}

export function encodeResponsesOutputFormat(format: SemanticOutputFormat): WireJsonObject {
  return format.kind === "json_object"
    ? wireObject([["type", "json_object"]])
    : wireObject([["type", "json_schema"], ...namedSchemaEntries(format)]);
}

export function encodeMessagesOutputConfig(
  format: SemanticOutputFormat | undefined,
  reasoning: SemanticReasoning | undefined,
): WireJson | undefined {
  if (format === undefined && reasoning?.effort === undefined) {
    return undefined;
  }
  return wireObject([
    ["effort", reasoning?.effort],
    ["format", format === undefined
      ? undefined
      : format.kind === "json_object"
        ? undefined
        : wireObject([["type", "json_schema"], ["schema", format.schema]])],
  ]);
}

function encodeNamedSchema(format: Extract<SemanticOutputFormat, { readonly kind: "json_schema" }>): WireJsonObject {
  return wireObject(namedSchemaEntries(format));
}

function namedSchemaEntries(
  format: Extract<SemanticOutputFormat, { readonly kind: "json_schema" }>,
): readonly (readonly [string, WireJson | undefined])[] {
  return [
    ["name", format.name],
    ["description", format.description],
    ["schema", format.schema],
    ["strict", format.strict],
  ];
}
