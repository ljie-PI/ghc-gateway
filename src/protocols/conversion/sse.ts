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
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    for await (const chunk of bytes) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const extracted = takeSseRecord(pending);
        if (extracted === undefined) {
          if (new TextEncoder().encode(pending).byteLength > eventLimitBytes) {
            throw new ChatSseError("event_too_large", "SSE event exceeds limit");
          }
          break;
        }
        if (new TextEncoder().encode(extracted.consumed).byteLength > eventLimitBytes) {
          throw new ChatSseError("event_too_large", "SSE event exceeds limit");
        }
        pending = extracted.rest;
        const parsed = parseRecord(normalizeSseNewlines(extracted.raw));
        if (parsed !== undefined) {
          yield parsed;
        }

      }
    }
    pending += decoder.decode();
    for (;;) {
      const extracted = takeSseRecord(pending, true);
      if (extracted === undefined) {
        break;
      }
      if (new TextEncoder().encode(extracted.consumed).byteLength > eventLimitBytes) {
        throw new ChatSseError("event_too_large", "SSE event exceeds limit");
      }
      pending = extracted.rest;
      const parsed = parseRecord(normalizeSseNewlines(extracted.raw));
      if (parsed !== undefined) {
        yield parsed;
      }
    }
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

export function takeSseRecord(value: string, final = false): {
  readonly raw: string;
  readonly consumed: string;
  readonly rest: string;
} | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const first = lineBreakLength(value, index, final);
    if (first === 0) {
      continue;
    }
    const second = lineBreakLength(value, index + first, final);
    if (second === 0) {
      continue;
    }
    const end = index + first + second;
    return {
      raw: value.slice(0, index),
      consumed: value.slice(0, end),
      rest: value.slice(end),
    };
  }
  return undefined;
}

function lineBreakLength(value: string, index: number, final: boolean): number {
  if (value[index] === "\n") {
    return 1;
  }
  if (value[index] !== "\r") {
    return 0;
  }
  if (index + 1 >= value.length) {
    return final ? 1 : 0;
  }
  return value[index + 1] === "\n" ? 2 : 1;
}

function normalizeSseNewlines(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
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
