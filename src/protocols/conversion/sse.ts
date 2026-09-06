import { ChatSseError } from "../../copilot/chat_sse.js";
import { GatewayFailureError } from "../../gateway/failures.js";

export interface SseRecord {
  readonly eventName?: string;
  readonly data: string;
}

export async function* decodeSseRecords(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
): AsyncIterable<SseRecord> {
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of bytes) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const normalized = pending.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        const boundary = normalized.indexOf("\n\n");
        if (boundary === -1) {
          if (new TextEncoder().encode(normalized).byteLength > eventLimitBytes) {
            throw new ChatSseError("event_too_large", "SSE event exceeds limit");
          }
          pending = normalized;
          break;
        }
        const raw = normalized.slice(0, boundary);
        if (new TextEncoder().encode(`${raw}\n\n`).byteLength > eventLimitBytes) {
          throw new ChatSseError("event_too_large", "SSE event exceeds limit");
        }
        pending = normalized.slice(boundary + 2);
        const parsed = parseRecord(raw);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }
    pending += decoder.decode();
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError || error instanceof ChatSseError) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new ChatSseError("invalid_utf8", "invalid UTF-8 in SSE stream");
    }
    throw error;
  }
  if (pending.trim().length > 0) {
    throw new GatewayFailureError({
      kind: "upstream_stream_truncated",
      source: "parser",
      phase: "stream",
    });
  }
}

function parseRecord(raw: string): SseRecord | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (name === "event") {
      eventName = value;
    } else if (name === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  const joined = data.join("\n");
  return eventName === undefined ? { data: joined } : { eventName, data: joined };
}
