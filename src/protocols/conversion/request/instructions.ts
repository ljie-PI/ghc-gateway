import { isWireJsonObject, type WireJson } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier } from "../reasoning_carriers.js";
import { type ConversionDegradationRule, type SemanticContent, type SemanticRequest, type SemanticRequestItem } from "../types.js";
import { invalid, oneMember, requiredString, wireArray, wireObject } from "../wire.js";
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
    if (typeof item === "string") {
      return item.length === 0 ? [] : [{ type: "text", text: item }];
    }
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

export function collectTargetInstructions(
  request: Readonly<SemanticRequest>,
  omission: "chat.extensions_omitted" | "messages.extensions_omitted",
): {
  readonly instructions: readonly SemanticContent[];
  readonly items: readonly SemanticRequestItem[];
  readonly degradations: readonly ConversionDegradationRule[];
} {
  const chunks: string[] = [];
  const degradations = new Set<ConversionDegradationRule>();
  const collect = (content: readonly SemanticContent[]): void => {
    for (const part of content) {
      if (part.type === "text" || part.type === "refusal") {
        if (part.text.trim().length > 0) chunks.push(part.text);
      } else {
        degradations.add(omission);
      }
    }
  };
  collect(request.instructions);
  const items = request.items.filter((item) => {
    if (item.type !== "message" || (item.role !== "system" && item.role !== "developer")) {
      return true;
    }
    collect(item.content);
    return false;
  });
  return {
    instructions: chunks.length === 0 ? [] : [{ type: "text", text: chunks.join("\n\n") }],
    items,
    degradations: [...degradations],
  };
}

export function encodeMessagesSystem(content: readonly SemanticContent[]): WireJson | undefined {
  const blocks = content.flatMap((part): WireJson[] => (
    part.type === "text" || part.type === "refusal"
      ? [wireObject([["type", "text"], ["text", part.text]])]
      : []
  ));
  return blocks.length === 0 ? undefined : wireArray(blocks);
}
