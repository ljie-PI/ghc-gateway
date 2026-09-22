import {
  isWireJsonArray, isWireJsonNumber, isWireJsonObject, memberValues, type WireJson, type WireJsonObject,
} from "../../serialization/wire_json.js";
import { DIAGNOSTIC_FIELDS, DIAGNOSTIC_LIMITS, type DiagnosticShape, type RequestDiagnostics } from "../../telemetry/diagnostics.js";
import type { DiagnosticFields } from "../../telemetry/diagnostics.js";
import type { InferenceProtocol } from "./types.js";

const KNOWN_FIELDS: ReadonlySet<string> = new Set(DIAGNOSTIC_FIELDS);
const SHAPE_CHILDREN = new Set(["messages", "input", "output", "choices", "content", "message", "delta", "response", "item", "part", "content_block"]);
const BLOCKS = [
  "text", "input_text", "output_text", "image", "input_image", "image_url", "document",
  "tool_use", "tool_result", "tool_call", "function_call", "function_call_output",
  "thinking", "redacted_thinking", "reasoning", "message", "refusal",
] as const;

export function diagnosticShape(value: WireJson): DiagnosticShape {
  const fields: DiagnosticShape["fields"] = {};
  const counts: { messages?: number; tools?: number; input?: number; output?: number; choices?: number; unknownFields?: number } = {};
  const blocks: DiagnosticShape["blocks"] = {};
  let visited = 0;
  let truncated = false;
  const take = (): boolean => {
    if (visited >= DIAGNOSTIC_LIMITS.shapeNodes) { truncated = true; return false; }
    visited++;
    return true;
  };
  const visit = (current: WireJson, depth: number): void => {
    if (depth > DIAGNOSTIC_LIMITS.shapeDepth || !take()) {
      truncated = true;
      return;
    }
    if (isWireJsonArray(current)) {
      for (const item of current.items) {
        if (visited >= DIAGNOSTIC_LIMITS.shapeNodes) { truncated = true; break; }
        visit(item, depth + 1);
      }
    } else if (isWireJsonObject(current)) {
      for (const field of current.members) {
        if (!take()) break;
        if (depth === 0) {
          if (!KNOWN_FIELDS.has(field.key)) counts.unknownFields = (counts.unknownFields ?? 0) + 1;
          else {
            const key = DIAGNOSTIC_FIELDS.find((candidate) => candidate === field.key)!;
            fields[key] = fields[key] === undefined ? valueType(field.value) : "duplicate";
          }
          const count = (["messages", "tools", "input", "output", "choices"] as const).find((key) => key === field.key);
          if (count !== undefined && isWireJsonArray(field.value)) counts[count] = field.value.items.length;
        }
        if (field.key === "type" && typeof field.value === "string") {
          const key = BLOCKS.find((candidate) => candidate === field.value) ?? "unknown";
          blocks[key] = (blocks[key] ?? 0) + 1;
        }
        if (SHAPE_CHILDREN.has(field.key)) visit(field.value, depth + 1);
      }
    }
  };
  visit(value, 0);
  return { fields, counts, blocks, truncated };
}

function valueType(value: WireJson): NonNullable<DiagnosticShape["fields"]["model"]> {
  if (value === null) return "null";
  if (isWireJsonArray(value)) return "array";
  if (isWireJsonObject(value)) return "object";
  if (isWireJsonNumber(value)) return "number";
  return typeof value === "boolean" ? "boolean" : "string";
}

export function diagnosticObjectShape(value: Readonly<Record<string, unknown>>): DiagnosticShape {
  const fields: DiagnosticShape["fields"] = {};
  const blocks: DiagnosticShape["blocks"] = {};
  let truncated = false;
  for (const key of DIAGNOSTIC_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const current = value[key];
    fields[key] = current === null ? "null"
      : Array.isArray(current) ? "array"
        : typeof current === "object" ? "object"
          : typeof current === "number" ? "number"
            : typeof current === "boolean" ? "boolean" : "string";
    truncated ||= current !== null && typeof current === "object";
  }
  if (typeof value.type === "string") blocks[BLOCKS.find((candidate) => candidate === value.type) ?? "unknown"] = 1;
  return { fields, counts: {}, blocks, truncated };
}

export function diagnosticResponsesReasoning(
  body: WireJsonObject,
): Pick<DiagnosticFields, "reasoningEffort" | "reasoningSummary"> {
  const reasoningValues = memberValues(body, "reasoning");
  if (reasoningValues.length === 0 || reasoningValues[0] === null) {
    return { reasoningEffort: "missing", reasoningSummary: "missing" };
  }
  if (reasoningValues.length !== 1 || !isWireJsonObject(reasoningValues[0])) {
    return { reasoningEffort: "unknown", reasoningSummary: "unknown" };
  }
  const reasoning = reasoningValues[0];
  return {
    reasoningEffort: diagnosticEnum(
      memberValues(reasoning, "effort"),
      ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
    ),
    reasoningSummary: diagnosticEnum(
      memberValues(reasoning, "summary"),
      ["auto", "concise", "detailed"] as const,
    ),
  };
}

export function observeDiagnosticProtocolStatus(
  diagnostics: RequestDiagnostics | undefined,
  protocol: InferenceProtocol,
  payload: WireJson,
): void {
  diagnostics?.observe(() => {
    if (!isWireJsonObject(payload)) return;
    let remaining = DIAGNOSTIC_LIMITS.shapeNodes;
    const field = (value: WireJson | undefined, key: string): WireJson | undefined => {
      if (!isWireJsonObject(value)) return undefined;
      let found: WireJson | undefined;
      for (const entry of value.members) {
        if (remaining-- <= 0) return undefined;
        if (entry.key !== key) continue;
        if (found !== undefined) return undefined;
        found = entry.value;
      }
      return found;
    };
    const type = field(payload, "type");
    if (type === "error") { diagnostics.set({ protocolStatus: "error" }); return; }
    if (protocol === "responses") {
      const response = field(payload, "response");
      const status = field(isWireJsonObject(response) ? response : payload, "status");
      if (status === "completed" || status === "incomplete" || status === "failed"
        || status === "in_progress" || status === "queued" || status === "cancelled") {
        diagnostics.set({ protocolStatus: status });
      } else if (type === "response.completed") diagnostics.set({ protocolStatus: "completed" });
      else if (type === "response.incomplete") diagnostics.set({ protocolStatus: "incomplete" });
      else if (type === "response.failed") diagnostics.set({ protocolStatus: "failed" });
      else if (remaining <= 0) diagnostics.set({ protocolStatus: "unknown" });
      return;
    }
    let reason: WireJson | undefined;
    if (protocol === "chat") {
      const choices = field(payload, "choices");
      if (!isWireJsonArray(choices) || choices.items.length !== 1 || !isWireJsonObject(choices.items[0])) return;
      reason = field(choices.items[0], "finish_reason");
    } else {
      const delta = field(payload, "delta");
      reason = field(isWireJsonObject(delta) ? delta : payload, "stop_reason");
    }
    if (reason === "length" || reason === "content_filter" || reason === "max_tokens" || reason === "model_context_window_exceeded") {
      diagnostics.set({ protocolStatus: "incomplete" });
    } else if (reason === "stop" || reason === "tool_calls" || reason === "end_turn"
      || reason === "tool_use" || reason === "stop_sequence") {
      diagnostics.set({ protocolStatus: "completed" });
    } else if (remaining <= 0) diagnostics.set({ protocolStatus: "unknown" });
  });
}

function diagnosticEnum<T extends string>(
  values: readonly WireJson[],
  allowed: readonly T[],
): T | "missing" | "unknown" {
  if (values.length === 0 || values[0] === null) return "missing";
  if (values.length !== 1 || typeof values[0] !== "string") return "unknown";
  return allowed.find((candidate) => candidate === values[0]) ?? "unknown";
}
