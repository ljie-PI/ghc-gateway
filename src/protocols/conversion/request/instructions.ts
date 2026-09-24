import { isWireJsonObject, type WireJson } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { type ConversionDegradationRule, type SemanticContent, type SemanticRequest, type SemanticRequestItem } from "../types.js";
import { invalid, oneMember, requiredString, unsupported, wireArray, wireObject } from "../wire.js";
import { MESSAGES_SENSITIVE_EXTENSION_FIELDS, optionalDiscriminator, optionalProtocolArray, projectMessagesMembers, validateCacheControl } from "./projection.js";

export function decodeMessagesSystem(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticContent[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  const system = optionalProtocolArray(value, "REQ-M-SYSTEM", degradations);
  if (system === undefined) return [];
  return system.items.flatMap((item): readonly SemanticContent[] => {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-M-SYSTEM-BLOCK");
      degradations.add("messages.extensions_omitted");
      return [];
    }
    const block = item;
    const projected = projectMessagesMembers(
      block,
      new Set(["type", "text", "cache_control"]),
      "REQ-M-SYSTEM-BLOCK",
      degradations,
      MESSAGES_SENSITIVE_EXTENSION_FIELDS,
    );
    const type = optionalDiscriminator(
      oneMember(projected, "type", "REQ-M-SYSTEM-TYPE"),
      "REQ-M-SYSTEM-TYPE",
      degradations,
    );
    if (type === undefined || type !== "text") {
      degradations.add("messages.extensions_omitted");
      return [];
    }
    if (oneMember(projected, "cache_control", "REQ-M-SYSTEM-CACHE") !== undefined) {
      validateCacheControl(oneMember(projected, "cache_control", "REQ-M-SYSTEM-CACHE"), degradations);
      degradations.add("cache.control_omitted");
    }
    return [{
      type: "text",
      text: requiredString(oneMember(projected, "text", "REQ-M-SYSTEM-TEXT"), "REQ-M-SYSTEM-TEXT", true),
    } as const];
  });
}

export function decodeResponsesInstructions(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): readonly SemanticContent[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value !== "string") {
    if (containsReasoningCarrier(value)) invalid("REQ-R-INSTRUCTIONS");
    degradations.add("request.option_omitted");
    return [];
  }
  return [{ type: "text", text: value }];
}

export function splitMessagesInstructions(request: Readonly<SemanticRequest>): {
  readonly instructions: readonly SemanticContent[];
  readonly items: readonly SemanticRequestItem[];
} {
  if (request.items.some((item) => item.type === "message" && item.role === "developer")) {
    unsupported("REQ-TARGET-M-DEVELOPER-AUTHORITY");
  }
  const instructions = [...request.instructions];
  let index = 0;
  for (; index < request.items.length; index += 1) {
    const item = request.items[index];
    if (item?.type !== "message" || (item.role !== "system" && item.role !== "developer")) {
      break;
    }
    instructions.push(...item.content);
  }
  if (request.items.slice(index).some((item) => (
    item.type === "message" && (item.role === "system" || item.role === "developer")
  ))) {
    unsupported("REQ-TARGET-M-MIDSTREAM-INSTRUCTION");
  }
  return { instructions, items: request.items.slice(index) };
}

export function encodeMessagesSystem(content: readonly SemanticContent[]): WireJson | undefined {
  if (content.length === 0) {
    return undefined;
  }
  return wireArray(content.map((part) => {
    if (part.type !== "text") {
      unsupported("REQ-TARGET-M-SYSTEM-CONTENT");
    }
    return wireObject([["type", "text"], ["text", part.text]]);
  }));
}
