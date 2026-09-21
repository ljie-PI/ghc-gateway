import {
  isWireJsonArray, isWireJsonNumber, isWireJsonObject, type WireJson,
} from "../../serialization/wire_json.js";
import { DIAGNOSTIC_FIELDS, DIAGNOSTIC_LIMITS, type DiagnosticShape } from "../../telemetry/diagnostics.js";

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
