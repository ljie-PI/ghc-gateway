import { canonicalizeWireJson } from "../../../serialization/canonical_json.js";
import { isWireJsonArray, isWireJsonObject, memberValues, type WireJson, type WireJsonArray, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier, type ReasoningCarrierRecord } from "../reasoning_carriers.js";
import { decodeResponsesReasoningItem } from "../reasoning.js";
import { projectIndependentOption, projectKnownObject } from "../request_projection.js";
import { type ConversionDegradationRule, type EncodedConversionRequest, type InferenceProtocol, type SemanticRequest } from "../types.js";
import { encodeWireObject, invalid, oneMember, optionalString, requiredObject, wireArray, wireObject } from "../wire.js";

const MESSAGES_CONTINUATION_FIELDS = new Set(["previous_response_id"]);

const MESSAGES_TOOL_OWNERSHIP_FIELDS = new Set(["call_id", "tool_call_id", "tool_use_id"]);

const MESSAGES_REASONING_CARRIER_FIELDS = new Set([
  "data",
  "encrypted_content",
  "reasoning",
  "reasoning_items",
  "reasoning_content",
  "reasoning_details",
  "reasoning_text",
  "redacted_thinking",
  "signature",
  "thinking",
  "thinking_blocks",
]);

export const MESSAGES_SENSITIVE_EXTENSION_FIELDS = new Set([
  ...MESSAGES_CONTINUATION_FIELDS,
  ...MESSAGES_TOOL_OWNERSHIP_FIELDS,
  ...MESSAGES_REASONING_CARRIER_FIELDS,
]);

const REQUEST_SENSITIVE_EXTENSION_FIELDS = new Set([
  ...MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  "audio",
  "context_management",
  "conversation",
  "frequency_penalty",
  "function_call",
  "functions",
  "include",
  "logit_bias",
  "logprobs",
  "max_tool_calls",
  "modalities",
  "moderation",
  "prediction",
  "presence_penalty",
  "prompt",
  "seed",
  "service_tier",
  "top_logprobs",
  "truncation",
  "web_search_options",
]);

export const TOOL_SENSITIVE_EXTENSION_FIELDS = new Set([
  ...REQUEST_SENSITIVE_EXTENSION_FIELDS,
  "allowed_callers",
  "defer_loading",
  "output_schema",
]);

export function omitPresentationString(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): void {
  if (value === undefined) return;
  projectIndependentOption(safeIndependentOption(value, "REQ-R-PRESENTATION-ID"), (candidate) => (
    typeof candidate === "string" && candidate.length > 0
      ? { kind: "value", value: candidate }
      : { kind: "malformed" }
  ), { omission: "request.option_omitted", degradations });
  degradations.add("request.option_omitted");
}

export function omitPresentationStatus(
  value: WireJson | undefined,
  allowFailed: boolean,
  degradations: Set<ConversionDegradationRule>,
): void {
  if (value === undefined) return;
  projectIndependentOption(safeIndependentOption(value, "REQ-R-PRESENTATION-STATUS"), (candidate) => (
    candidate === "completed"
    || candidate === "incomplete"
    || candidate === "in_progress"
    || (allowFailed && candidate === "failed")
      ? { kind: "value", value: candidate }
      : { kind: "malformed" }
  ), { omission: "request.option_omitted", degradations });
  degradations.add("request.option_omitted");
}

export function independentResultStatus(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): "completed" | "incomplete" | "in_progress" | "failed" | undefined {
  if (value === undefined) return undefined;
  const status = projectIndependentOption<"completed" | "incomplete" | "in_progress" | "failed">(
    safeIndependentOption(value, "REQ-R-PRESENTATION-STATUS"),
    (candidate) => (
      candidate === "completed"
      || candidate === "incomplete"
      || candidate === "in_progress"
      || candidate === "failed"
        ? { kind: "value", value: candidate }
        : { kind: "malformed" }
    ),
    { omission: "request.option_omitted", degradations },
  );
  degradations.add("request.option_omitted");
  return status;
}

export function encodedRequest(
  request: Readonly<SemanticRequest>,
  body: WireJsonObject,
  additionalDegradations: readonly ConversionDegradationRule[] = [],
): EncodedConversionRequest {
  const firstItem = request.items[0];
  return Object.freeze({
    body,
    bytes: encodeWireObject(body),
    stream: request.stream,
    hasVisionInput: request.instructions.some((part) => part.type === "image")
      || request.items.some((item) => (
        (item.type === "message" || item.type === "tool_result")
        && item.content.some((part) => part.type === "image")
      )),
    initiator: firstItem?.type === "message" && firstItem.role === "assistant" ? "agent" : "user",
    messagesBetaFeatures: [],
    degradations: [...new Set([...request.degradations, ...additionalDegradations])],
    ...(request.responseBindings === undefined ? {} : { responseBindings: request.responseBindings }),
    ...(request.carrierRecords === undefined ? {} : { carrierRecords: request.carrierRecords }),
  });
}

export function requiredCarrier(
  records: ReadonlyMap<string, ReasoningCarrierRecord> | undefined,
  token: string,
  sourceKind: ReasoningCarrierRecord["sourceKind"] | undefined,
  ruleId: string,
): ReasoningCarrierRecord {
  const record = records?.get(token);
  if (record === undefined || (sourceKind !== undefined && record.sourceKind !== sourceKind) || record.state !== "complete") invalid(ruleId);
  return record;
}

export function carrierState(record: ReasoningCarrierRecord, ruleId: string): WireJsonObject {
  const values = memberValues(record.payload, "state");
  if (values.length !== 1 || !isWireJsonObject(values[0])) invalid(ruleId);
  return values[0];
}

export function requireProjection(
  record: ReasoningCarrierRecord,
  projection: WireJsonObject,
  ruleId: string,
): void {
  const expected = canonicalizeWireJson(record.projection);
  const observed = canonicalizeWireJson(projection);
  if (expected.byteLength !== observed.byteLength || expected.some((value, index) => value !== observed[index])) invalid(ruleId);
}

export function reasoningProjection(item: WireJsonObject): WireJsonObject {
  const type = oneMember(item, "type", "REQ-INTERNAL");
  if (type === "reasoning") {
    const reasoning = decodeResponsesReasoningItem(item, () => invalid("REQ-INTERNAL"), false);
    return wireObject([["type", "reasoning"], ["text", reasoning.parts.map((part) => part.text).join("")]]);
  }
  const text = oneMember(item, "reasoning_text", "REQ-INTERNAL")
    ?? oneMember(item, "reasoning_content", "REQ-INTERNAL");
  return wireObject([["type", "reasoning"], ["text", typeof text === "string" ? text : ""]]);
}

export function messagesReasoningProjection(block: WireJsonObject): WireJsonObject {
  const type = oneMember(block, "type", "REQ-INTERNAL");
  const text = type === "thinking" ? oneMember(block, "thinking", "REQ-INTERNAL") : "";
  if (typeof text !== "string") invalid("REQ-INTERNAL");
  return wireObject([["type", "reasoning"], ["text", text]]);
}

export function validateCacheControl(
  value: WireJson | undefined,
  degradations?: Set<ConversionDegradationRule>,
): void {
  if (value === undefined) return;
  if (!isWireJsonObject(value)) {
    if (containsReasoningCarrier(value)) invalid("REQ-M-CACHE-CONTROL");
    degradations?.add("request.option_omitted");
    return;
  }
  let object = value;
  if (degradations !== undefined) {
    object = projectMessagesMembers(
      object,
      new Set(["type", "ttl"]),
      "REQ-M-CACHE-CONTROL",
      degradations,
      MESSAGES_SENSITIVE_EXTENSION_FIELDS,
    );
  }
  if (oneMember(object, "type", "REQ-M-CACHE-CONTROL-TYPE") !== "ephemeral") {
    degradations?.add("request.option_omitted");
    return;
  }
  const ttl = optionalString(oneMember(object, "ttl", "REQ-M-CACHE-CONTROL-TTL"), "REQ-M-CACHE-CONTROL-TTL");
  if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") {
    degradations?.add("request.option_omitted");
  }
}

export function projectMessagesMembers(
  object: WireJsonObject,
  allowed: ReadonlySet<string>,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
  forbidden: ReadonlySet<string> = MESSAGES_SENSITIVE_EXTENSION_FIELDS,
): WireJsonObject {
  return projectKnownObject(object, {
    knownKeys: allowed,
    sensitiveKeys: forbidden,
    omittedValueIsUnsafe: containsReasoningCarrier,
    ruleId,
    omission: "messages.extensions_omitted",
    degradations,
  });
}

export function projectRequestMembers(
  object: WireJsonObject,
  allowed: ReadonlySet<string>,
  ruleId: string,
  omission: "chat.extensions_omitted" | "responses.extensions_omitted",
  degradations: Set<ConversionDegradationRule>,
  sensitiveKeys: ReadonlySet<string> = REQUEST_SENSITIVE_EXTENSION_FIELDS,
): WireJsonObject {
  return projectKnownObject(object, {
    knownKeys: allowed,
    sensitiveKeys,
    omittedValueIsUnsafe: containsReasoningCarrier,
    ruleId,
    omission,
    degradations,
  });
}

export function validatedMetadata(
  value: WireJson | undefined,
  source: InferenceProtocol,
  degradations?: Set<ConversionDegradationRule>,
): WireJson | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (source === "messages") {
    if (degradations === undefined) invalid("REQ-M-METADATA");
    const object = optionalProtocolObject(value, "REQ-M-METADATA", degradations);
    if (object === undefined) return undefined;
    const projected = projectMessagesMembers(object, new Set(["user_id"]), "REQ-M-METADATA", degradations);
    const userId = projected.members.filter((member) => member.key === "user_id");
    for (const member of userId) {
      if (typeof member.value !== "string") {
        if (containsReasoningCarrier(member.value)) invalid("REQ-M-METADATA");
        degradations.add("request.option_omitted");
        return undefined;
      }
    }
    return userId.length === 0 ? undefined : { kind: "object", members: userId };
  }
  const object = requiredObject(value, `REQ-${source.toUpperCase()}-METADATA`);
  for (const member of object.members) {
    if (typeof member.value !== "string") {
      invalid(`REQ-${source.toUpperCase()}-METADATA`);
    }
  }
  return object;
}

export function independentMetadata(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): WireJson | undefined {
  return projectIndependentOption(safeIndependentOption(value, "REQ-METADATA"), (candidate) => {
    if (!isWireJsonObject(candidate)) return { kind: "malformed" };
    const seen = new Set<string>();
    return {
      kind: "value",
      value: {
        kind: "object" as const,
        members: candidate.members.filter((member) => {
          if (seen.has(member.key)) return false;
          seen.add(member.key);
          return true;
        }),
      },
    };
  }, { omission: "request.option_omitted", degradations });
}

export function safeIndependentOption(value: WireJson | undefined, ruleId: string): WireJson | undefined {
  if (value !== undefined && containsReasoningCarrier(value)) invalid(ruleId);
  return value;
}

export function optionalProtocolObject(
  value: WireJson | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): WireJsonObject | undefined {
  if (value === undefined) return undefined;
  if (containsReasoningCarrier(value)) invalid(ruleId);
  if (!isWireJsonObject(value)) {
    degradations.add("request.option_omitted");
    return undefined;
  }
  return value;
}

export function optionalProtocolArray(
  value: WireJson | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): WireJsonArray | undefined {
  if (value === undefined) return undefined;
  if (containsReasoningCarrier(value)) invalid(ruleId);
  if (!isWireJsonArray(value)) {
    degradations.add("request.option_omitted");
    return undefined;
  }
  return value;
}

export function optionalChoiceString(
  value: WireJson | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== undefined && containsReasoningCarrier(value)) invalid(ruleId);
  degradations.add("request.option_omitted");
  return undefined;
}

export function optionalDiscriminator(
  value: WireJson | undefined,
  ruleId: string,
  degradations: Set<ConversionDegradationRule>,
): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== undefined && containsReasoningCarrier(value)) invalid(ruleId);
  degradations.add("request.option_omitted");
  return undefined;
}

export function replaceOptionalMember(
  object: WireJsonObject,
  key: string,
  value: WireJson | undefined,
): WireJsonObject {
  return {
    kind: "object",
    members: object.members.flatMap((member) => member.key !== key
      ? [member]
      : value === undefined ? [] : [{ key, value }]),
  };
}

export function messagesObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) invalid(ruleId);
  return value;
}

export function requestObject(value: WireJson | undefined, ruleId: string): WireJsonObject {
  if (!isWireJsonObject(value)) invalid(ruleId);
  return value;
}

export function appendMember(object: WireJsonObject, key: string, value: WireJson): void {
  (object.members as Array<{ key: string; value: WireJson }>).push({ key, value });
}

export function appendObjectArrayMember(object: WireJsonObject, key: string, value: WireJsonObject): void {
  const existing = oneMember(object, key, "REQ-INTERNAL");
  if (isWireJsonArray(existing)) {
    (existing.items as WireJson[]).push(value);
    return;
  }
  appendMember(object, key, wireArray([value]));
}
