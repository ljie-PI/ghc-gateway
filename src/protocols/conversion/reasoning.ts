import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { SemanticReasoningItem, SemanticReasoningPart } from "./types.js";

type Invalid = () => never;

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

export function decodeChatReasoning(object: WireJsonObject, invalid: Invalid): ChatReasoning {
  const reasoningText = nullableStringMember(object, "reasoning_text", invalid);
  const reasoningContent = nullableStringMember(object, "reasoning_content", invalid);
  const reasoning = decodeReasoningValue(singleMember(object, "reasoning", invalid), invalid);
  const reasoningDetails = decodeReasoningDetails(singleMember(object, "reasoning_details", invalid), invalid, 0);
  const thinking = decodeThinkingBlocks(singleMember(object, "thinking_blocks", invalid), invalid);
  const scalarText = consistentSubstantive(
    [reasoningText, reasoningContent, reasoning, reasoningDetails],
    invalid,
  );
  return {
    text: compatiblePresentation(scalarText, thinking.text, invalid),
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
): SemanticReasoningItem {
  assertAllowedKeys(
    item,
    new Set(["type", "id", "status", "summary", "content", "encrypted_content", "reasoning_text"]),
    invalid,
  );
  if (stringMember(item, "type", invalid) !== "reasoning") {
    invalid();
  }
  const itemId = stringMember(item, "id", invalid);
  if ((requireId && itemId === undefined) || itemId === "") {
    invalid();
  }
  const status = stringMember(item, "status", invalid);
  if (
    status !== undefined
    && status !== "completed"
    && status !== "incomplete"
    && status !== "in_progress"
  ) {
    invalid();
  }
  const summary = arrayMember(item, "summary", invalid);
  if (summary === undefined) {
    invalid();
  }
  const parts: SemanticReasoningPart[] = [];
  decodeReasoningParts(summary.items, "summary", "summary_text", parts, invalid);
  const content = arrayMember(item, "content", invalid);
  if (content !== undefined) {
    decodeReasoningParts(content.items, "content", "reasoning_text", parts, invalid);
  }
  const compatibilityText = nullableStringMember(item, "reasoning_text", invalid);
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
  const encryptedContent = singleMember(item, "encrypted_content", invalid);
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
): void {
  for (let index = 0; index < values.length; index += 1) {
    const part = values[index];
    if (!isWireJsonObject(part)) {
      invalid();
    }
    assertAllowedKeys(part, new Set(["type", "text"]), invalid);
    if (stringMember(part, "type", invalid) !== expectedType) {
      invalid();
    }
    const text = stringMember(part, "text", invalid);
    if (text === undefined) {
      invalid();
    }
    output.push({ presentation, index, text });
  }
}

function decodeReasoningValue(value: WireJson | undefined, invalid: Invalid): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (!isWireJsonObject(value)) {
    invalid();
  }
  assertAllowedKeys(value, new Set(["content", "text", "summary"]), invalid);
  return consistentSubstantive([
    nullableStringMember(value, "content", invalid),
    nullableStringMember(value, "text", invalid),
    nullableStringMember(value, "summary", invalid),
  ], invalid);
}

function decodeReasoningDetails(
  value: WireJson | undefined,
  invalid: Invalid,
  depth: number,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (depth > 8) {
    invalid();
  }
  if (typeof value === "string") {
    return value;
  }
  if (isWireJsonArray(value)) {
    return value.items.map((part) => decodeReasoningDetails(part, invalid, depth + 1) ?? "").join("");
  }
  if (!isWireJsonObject(value)) {
    invalid();
  }
  assertAllowedKeys(value, new Set(["type", "text", "content", "summary", "parts"]), invalid);
  const type = singleMember(value, "type", invalid);
  if (type !== undefined && typeof type !== "string") invalid();
  const direct = consistentSubstantive([
    nullableStringMember(value, "text", invalid),
    nullableStringMember(value, "content", invalid),
    nullableStringMember(value, "summary", invalid),
  ], invalid);
  const nested = singleMember(value, "parts", invalid);
  if (nested !== undefined && !isWireJsonArray(nested)) {
    invalid();
  }
  const nestedText = isWireJsonArray(nested)
    ? nested.items.map((part) => decodeReasoningDetails(part, invalid, depth + 1) ?? "").join("")
    : "";
  return consistentSubstantive([direct, nestedText], invalid);
}

function decodeThinkingBlocks(
  value: WireJson | undefined,
  invalid: Invalid,
): { readonly text: string; readonly hasOpaqueState: boolean; readonly blocks: readonly ChatThinkingBlock[] } {
  if (value === undefined || value === null) {
    return { text: "", hasOpaqueState: false, blocks: [] };
  }
  if (!isWireJsonArray(value)) {
    invalid();
  }
  const text: string[] = [];
  const blocks: ChatThinkingBlock[] = [];
  let hasOpaqueState = false;
  for (const block of value.items) {
    if (!isWireJsonObject(block)) {
      invalid();
    }
    const type = stringMember(block, "type", invalid);
    if (type === "thinking") {
      assertAllowedKeys(block, new Set(["type", "thinking", "signature"]), invalid);
      const thinking = stringMember(block, "thinking", invalid);
      if (thinking === undefined) {
        invalid();
      }
      text.push(thinking);
      const signature = nullableStringMember(block, "signature", invalid);
      hasOpaqueState ||= signature !== undefined && signature.length > 0;
      blocks.push({ type: "thinking", thinking, ...(signature === undefined ? {} : { signature }) });
      continue;
    }
    if (type === "redacted_thinking") {
      assertAllowedKeys(block, new Set(["type", "data"]), invalid);
      const data = stringMember(block, "data", invalid);
      if (data === undefined) {
        invalid();
      }
      hasOpaqueState ||= data.length > 0;
      blocks.push({ type: "redacted_thinking", data });
      continue;
    }
    invalid();
  }
  return { text: text.join(""), hasOpaqueState, blocks };
}

function consistentSubstantive(values: readonly (string | undefined)[], invalid: Invalid): string {
  const substantive = values.filter((value): value is string => value !== undefined && value.length > 0);
  const first = substantive[0] ?? "";
  if (substantive.some((value) => value !== first)) invalid();
  return first;
}

function compatiblePresentation(left: string, right: string, invalid: Invalid): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (left.startsWith(right)) return left;
  if (right.startsWith(left)) return right;
  invalid();
}

function nullableStringMember(
  object: WireJsonObject,
  key: string,
  invalid: Invalid,
): string | undefined {
  const value = singleMember(object, key, invalid);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    invalid();
  }
  return value;
}

function stringMember(
  object: WireJsonObject,
  key: string,
  invalid: Invalid,
): string | undefined {
  const value = singleMember(object, key, invalid);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    invalid();
  }
  return value;
}

function arrayMember(object: WireJsonObject, key: string, invalid: Invalid) {
  const value = singleMember(object, key, invalid);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonArray(value)) {
    invalid();
  }
  return value;
}

function singleMember(object: WireJsonObject, key: string, invalid: Invalid): WireJson | undefined {
  const values = memberValues(object, key);
  if (values.length > 1) {
    invalid();
  }
  return values[0];
}

function assertAllowedKeys(object: WireJsonObject, allowed: ReadonlySet<string>, invalid: Invalid): void {
  const seen = new Set<string>();
  for (const member of object.members) {
    if (!allowed.has(member.key) || seen.has(member.key)) invalid();
    seen.add(member.key);
  }
}
