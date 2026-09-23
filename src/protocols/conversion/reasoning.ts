import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { containsReasoningCarrier } from "./reasoning_carriers.js";
import type { SemanticReasoningItem, SemanticReasoningPart } from "./types.js";

type Invalid = () => never;
type Omitted = () => void;

export interface ChatReasoning {
  readonly text: string;
  readonly scalarText: string;
  readonly thinkingText: string;
  readonly hasOpaqueState: boolean;
  readonly thinkingBlocks: readonly ChatThinkingBlock[];
}

export type ChatThinkingBlock =
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string | undefined }
  | { readonly type: "redacted_thinking"; readonly data: string };

export function decodeChatReasoning(
  object: WireJsonObject,
  invalid: Invalid,
  tolerant = false,
  omitted?: Omitted,
): ChatReasoning {
  const reasoningText = nullableStringMember(object, "reasoning_text", invalid, tolerant, omitted);
  const reasoningContent = nullableStringMember(object, "reasoning_content", invalid, tolerant, omitted);
  const reasoning = decodeReasoningValue(singleMember(object, "reasoning", invalid, tolerant), invalid, tolerant, omitted);
  const reasoningDetails = decodeReasoningDetails(
    singleMember(object, "reasoning_details", invalid, tolerant),
    invalid,
    0,
    tolerant,
    omitted,
  );
  const thinking = decodeThinkingBlocks(
    singleMember(object, "thinking_blocks", invalid, tolerant),
    invalid,
    tolerant,
    omitted,
  );
  const scalarText = consistentSubstantive(
    [reasoningText, reasoningContent, reasoning, reasoningDetails],
    invalid,
    tolerant,
  );
  return {
    text: compatiblePresentation(scalarText, thinking.text, invalid, tolerant),
    scalarText,
    thinkingText: thinking.text,
    hasOpaqueState: thinking.hasOpaqueState,
    thinkingBlocks: thinking.blocks,
  };
}

export function decodeResponsesReasoningItem(
  item: WireJsonObject,
  invalid: Invalid,
  requireId = true,
  tolerant = false,
  omitted?: Omitted,
): SemanticReasoningItem {
  assertAllowedKeys(
    item,
    new Set(["type", "id", "status", "summary", "content", "encrypted_content", "reasoning_text"]),
    invalid,
    tolerant,
    omitted,
  );
  if (stringMember(item, "type", invalid, tolerant) !== "reasoning") {
    invalid();
  }
  const itemId = stringMember(item, "id", invalid, tolerant, omitted);
  if ((requireId && itemId === undefined) || itemId === "") {
    invalid();
  }
  const status = stringMember(item, "status", invalid, tolerant, omitted);
  if (
    status !== undefined
    && status !== "completed"
    && status !== "incomplete"
    && status !== "in_progress"
  ) {
    invalid();
  }
  const summary = arrayMember(item, "summary", invalid, tolerant, omitted);
  if (summary === undefined) {
    invalid();
  }
  const parts: SemanticReasoningPart[] = [];
  decodeReasoningParts(summary.items, "summary", "summary_text", parts, invalid, tolerant, omitted);
  const content = arrayMember(item, "content", invalid, tolerant, omitted);
  if (content !== undefined) {
    decodeReasoningParts(content.items, "content", "reasoning_text", parts, invalid, tolerant, omitted);
  }
  const compatibilityText = nullableStringMember(item, "reasoning_text", invalid, tolerant, omitted);
  if (compatibilityText !== undefined && compatibilityText.length > 0) {
    const contentText = parts
      .filter((part) => part.presentation === "content")
      .map((part) => part.text)
      .join("");
    if (contentText.length === 0) {
      parts.push({ presentation: "content", index: 0, text: compatibilityText });
    } else if (contentText !== compatibilityText) {
      invalid();
    }
  }
  const encryptedContent = singleMember(item, "encrypted_content", invalid, tolerant);
  if (encryptedContent !== undefined && encryptedContent !== null && typeof encryptedContent !== "string") {
    invalid();
  }
  return {
    type: "reasoning",
    ...(itemId === undefined ? {} : { itemId }),
    parts,
    ...(status === undefined ? {} : { status }),
    hasOpaqueState: typeof encryptedContent === "string" && encryptedContent.length > 0,
    ...(typeof encryptedContent === "string" && encryptedContent.length > 0
      ? { opaqueState: { kind: "responses_item" as const, item } }
      : {}),
  };
}

export function chatReasoningState(object: WireJsonObject, invalid: Invalid): WireJsonObject | undefined {
  const keep = new Set(["reasoning_text", "reasoning_content", "reasoning", "reasoning_details", "reasoning_opaque"]);
  const members = object.members.filter((member) => keep.has(member.key));
  if (members.length === 0) return undefined;
  for (const member of members) {
    if (member.key === "reasoning_opaque" && typeof member.value !== "string") invalid();
  }
  return { kind: "object", members };
}

function decodeReasoningParts(
  values: readonly WireJson[],
  presentation: SemanticReasoningPart["presentation"],
  expectedType: "summary_text" | "reasoning_text",
  output: SemanticReasoningPart[],
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
): void {
  for (let index = 0; index < values.length; index += 1) {
    const part = values[index];
    if (!isWireJsonObject(part)) {
      if (tolerant) {
        if (part !== undefined) rejectCarrier(part, invalid);
        omitted?.();
        continue;
      }
      invalid();
    }
    assertAllowedKeys(part, new Set(["type", "text"]), invalid, tolerant, omitted);
    if (stringMember(part, "type", invalid, tolerant, omitted) !== expectedType) {
      if (tolerant) {
        rejectCarrier(part, invalid);
        omitted?.();
        continue;
      }
      invalid();
    }
    const text = stringMember(part, "text", invalid, tolerant, omitted);
    if (text === undefined) {
      invalid();
    }
    output.push({ presentation, index, text });
  }
}

function decodeReasoningValue(
  value: WireJson | undefined,
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (!isWireJsonObject(value)) {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return undefined;
    }
    invalid();
  }
  assertAllowedKeys(value, new Set(["content", "text", "summary"]), invalid, tolerant, omitted);
  return consistentSubstantive([
    nullableStringMember(value, "content", invalid, tolerant, omitted),
    nullableStringMember(value, "text", invalid, tolerant, omitted),
    nullableStringMember(value, "summary", invalid, tolerant, omitted),
  ], invalid, tolerant);
}

function decodeReasoningDetails(
  value: WireJson | undefined,
  invalid: Invalid,
  depth: number,
  tolerant: boolean,
  omitted?: Omitted,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (depth > 8) {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return undefined;
    }
    invalid();
  }
  if (typeof value === "string") {
    return value;
  }
  if (isWireJsonArray(value)) {
    return value.items
      .map((part) => decodeReasoningDetails(part, invalid, depth + 1, tolerant, omitted) ?? "")
      .join("");
  }
  if (!isWireJsonObject(value)) {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return undefined;
    }
    invalid();
  }
  assertAllowedKeys(value, new Set(["type", "text", "content", "summary", "parts"]), invalid, tolerant, omitted);
  const type = singleMember(value, "type", invalid, tolerant);
  if (type !== undefined && typeof type !== "string") {
    if (!tolerant) invalid();
    rejectCarrier(type, invalid);
    omitted?.();
  }
  const direct = consistentSubstantive([
    nullableStringMember(value, "text", invalid, tolerant, omitted),
    nullableStringMember(value, "content", invalid, tolerant, omitted),
    nullableStringMember(value, "summary", invalid, tolerant, omitted),
  ], invalid, tolerant);
  const nested = singleMember(value, "parts", invalid, tolerant);
  if (nested !== undefined && !isWireJsonArray(nested)) {
    if (tolerant) {
      rejectCarrier(nested, invalid);
      omitted?.();
      return direct;
    }
    invalid();
  }
  const nestedText = isWireJsonArray(nested)
    ? nested.items.map((part) => decodeReasoningDetails(part, invalid, depth + 1, tolerant, omitted) ?? "").join("")
    : "";
  return consistentSubstantive([direct, nestedText], invalid, tolerant);
}

function decodeThinkingBlocks(
  value: WireJson | undefined,
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
): { readonly text: string; readonly hasOpaqueState: boolean; readonly blocks: readonly ChatThinkingBlock[] } {
  if (value === undefined || value === null) {
    return { text: "", hasOpaqueState: false, blocks: [] };
  }
  if (!isWireJsonArray(value)) {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return { text: "", hasOpaqueState: false, blocks: [] };
    }
    invalid();
  }
  const text: string[] = [];
  const blocks: ChatThinkingBlock[] = [];
  let hasOpaqueState = false;
  for (const block of value.items) {
    if (!isWireJsonObject(block)) {
      if (tolerant) {
        rejectCarrier(block, invalid);
        omitted?.();
        continue;
      }
      invalid();
    }
    const type = stringMember(block, "type", invalid, tolerant, omitted);
    if (type === "thinking") {
      assertAllowedKeys(block, new Set(["type", "thinking", "signature"]), invalid, tolerant, omitted);
      const thinking = stringMember(block, "thinking", invalid, tolerant, omitted);
      if (thinking === undefined) {
        if (tolerant) {
          rejectCarrier(block, invalid);
          omitted?.();
          continue;
        }
        invalid();
      }
      text.push(thinking);
      const signature = nullableStringMember(block, "signature", invalid, tolerant, omitted);
      hasOpaqueState ||= signature !== undefined && signature.length > 0;
      blocks.push({ type: "thinking", thinking, ...(signature === undefined ? {} : { signature }) });
      continue;
    }
    if (type === "redacted_thinking") {
      assertAllowedKeys(block, new Set(["type", "data"]), invalid, tolerant, omitted);
      const data = stringMember(block, "data", invalid, tolerant, omitted);
      if (data === undefined) {
        if (tolerant) {
          rejectCarrier(block, invalid);
          omitted?.();
          continue;
        }
        return invalid();
      }
      hasOpaqueState ||= data.length > 0;
      blocks.push({ type: "redacted_thinking", data });
      continue;
    }
    if (!tolerant) invalid();
    rejectCarrier(block, invalid);
    omitted?.();
  }
  return { text: text.join(""), hasOpaqueState, blocks };
}

function consistentSubstantive(
  values: readonly (string | undefined)[],
  invalid: Invalid,
  tolerant: boolean,
): string {
  const substantive = values.filter((value): value is string => value !== undefined && value.length > 0);
  const first = substantive[0] ?? "";
  if (!tolerant && substantive.some((value) => value !== first)) invalid();
  return first;
}

function compatiblePresentation(left: string, right: string, invalid: Invalid, tolerant: boolean): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (left.startsWith(right)) return left;
  if (right.startsWith(left)) return right;
  if (tolerant) return left;
  invalid();
}

function nullableStringMember(
  object: WireJsonObject,
  key: string,
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
): string | undefined {
  const value = singleMember(object, key, invalid, tolerant);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return undefined;
    }
    invalid();
  }
  return value;
}

function stringMember(
  object: WireJsonObject,
  key: string,
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
): string | undefined {
  const value = singleMember(object, key, invalid, tolerant);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return undefined;
    }
    invalid();
  }
  return value;
}

function arrayMember(
  object: WireJsonObject,
  key: string,
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
) {
  const value = singleMember(object, key, invalid, tolerant);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonArray(value)) {
    if (tolerant) {
      rejectCarrier(value, invalid);
      omitted?.();
      return undefined;
    }
    invalid();
  }
  return value;
}

function singleMember(object: WireJsonObject, key: string, invalid: Invalid, tolerant: boolean): WireJson | undefined {
  const values = memberValues(object, key);
  if (!tolerant && values.length > 1) {
    invalid();
  }
  return values[0];
}

function assertAllowedKeys(
  object: WireJsonObject,
  allowed: ReadonlySet<string>,
  invalid: Invalid,
  tolerant: boolean,
  omitted?: Omitted,
): void {
  const seen = new Set<string>();
  for (const member of object.members) {
    if (!allowed.has(member.key) || seen.has(member.key)) {
      if (!tolerant) invalid();
      rejectCarrier(member.value, invalid);
      omitted?.();
    }
    seen.add(member.key);
  }
}

function rejectCarrier(value: WireJson, invalid: Invalid): void {
  if (containsReasoningCarrier(value)) invalid();
}
