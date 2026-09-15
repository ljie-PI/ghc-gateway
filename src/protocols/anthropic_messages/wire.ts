export type AnthropicMessagesErrorType =
  | "invalid_request_error"
  | "request_too_large"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "overloaded_error"
  | "api_error"
  | "timeout_error"
  | "billing_error"
  | "rate_limit_error";

export interface AnthropicMessagesEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function serializeAnthropicMessagesErrorBody(type: AnthropicMessagesErrorType, message: string, requestId: string): string {
  return JSON.stringify({
    type: "error",
    error: { type, message },
    request_id: requestId,
  });
}

export function encodeAnthropicMessagesSseEvent(event: AnthropicMessagesEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${pythonJsonDumps(event)}\n\n`);
}

export function pythonJsonDumps(value: unknown): string {
  return ensureAscii(writePythonJson(value));
}

function writePythonJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => writePythonJson(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined);
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}: ${writePythonJson(entryValue)}`).join(", ")}}`;
  }
  return "null";
}

function ensureAscii(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += value[index];
    }
  }
  return escaped;
}
