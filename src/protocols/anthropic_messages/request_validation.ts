import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { isReasoningCarrier } from "../conversion/reasoning_carriers.js";
import { requestRuleFailure } from "../native_preflight.js";

/**
 * Security checks shared by native and converted Messages requests. Everything else is validated by
 * Copilot (native) or converted best-effort, like cc-switch. Gateway reasoning carriers are local
 * handles, so they may appear only in the thinking slots the carrier store resolves.
 */
const OWNERSHIP_FIELDS = new Set([
  "call_id", "data", "encrypted_content", "previous_response_id", "reasoning", "reasoning_content", "reasoning_details",
  "reasoning_items", "reasoning_text", "signature", "thinking_blocks", "tool_call_id", "tool_use_id",
  "thinking", "redacted_thinking",
]);

export function validateMessagesRequestSecurity(body: WireJsonObject): void {
  const duplicates = new Set(duplicateMemberNames(body));
  if ([...OWNERSHIP_FIELDS].some((key) => duplicates.has(key))) throw requestRuleFailure("REQ-M-OWNERSHIP-DUPLICATE");
  if (body.members.some((member) => OWNERSHIP_FIELDS.has(member.key) && member.key !== "thinking")) {
    throw requestRuleFailure("REQ-M-OWNERSHIP-FIELD");
  }
  rejectCarrierOutsideDocumentedSlots(body, new Set());
}

function rejectCarrierOutsideDocumentedSlots(value: WireJson, seen: Set<string>): void {
  if (!isWireJsonObject(value)) {
    rejectAnyCarrier(value);
    return;
  }
  for (const member of value.members) {
    if (member.key === "messages" && isWireJsonArray(member.value)) {
      for (const message of member.value.items) validateCarrierMessage(message, seen);
    } else {
      rejectAnyCarrier(member.value);
    }
  }
}

function validateCarrierMessage(value: WireJson, seen: Set<string>): void {
  if (!isWireJsonObject(value)) {
    rejectAnyCarrier(value);
    return;
  }
  const roles = memberValues(value, "role");
  const assistant = roles.length === 1 && roles[0] === "assistant";
  for (const member of value.members) {
    if (member.key === "content" && isWireJsonArray(member.value)) {
      for (const block of member.value.items) validateCarrierBlock(block, seen, assistant);
    } else {
      rejectAnyCarrier(member.value);
    }
  }
}

function validateCarrierBlock(value: WireJson, seen: Set<string>, assistant: boolean): void {
  if (!isWireJsonObject(value)) {
    rejectAnyCarrier(value);
    return;
  }
  const types = memberValues(value, "type");
  const type = types.length === 1 ? types[0] : undefined;
  for (const member of value.members) {
    const allowed = assistant && ((type === "thinking" && member.key === "signature")
      || (type === "redacted_thinking" && member.key === "data"));
    if (!allowed) {
      rejectAnyCarrier(member.value);
    } else if (typeof member.value === "string" && isReasoningCarrier(member.value)) {
      if (seen.has(member.value)) throw requestRuleFailure("REQ-M-CARRIER-DUPLICATE");
      seen.add(member.value);
    }
  }
}

function rejectAnyCarrier(value: WireJson): void {
  if (typeof value === "string") {
    if (isReasoningCarrier(value)) throw requestRuleFailure("REQ-M-CARRIER-SLOT");
    return;
  }
  if (isWireJsonArray(value)) {
    for (const item of value.items) rejectAnyCarrier(item);
    return;
  }
  if (!isWireJsonObject(value)) return;
  for (const member of value.members) rejectAnyCarrier(member.value);
}
