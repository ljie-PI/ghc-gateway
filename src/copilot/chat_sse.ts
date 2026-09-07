import { isWireJsonArray, isWireJsonObject, memberValues, parseWireJson } from "../serialization/wire_json.js";
import type { ChatStreamFrame } from "../protocols/chat_completions/types.js";

const DEFAULT_EVENT_LIMIT = 4 * 1024 * 1024;

export class ChatSseError extends Error {
  readonly code: "event_too_large" | "invalid_utf8" | "truncated";

  constructor(code: ChatSseError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChatSseError";
    this.code = code;
  }
}

export async function* parseChatSse(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes = DEFAULT_EVENT_LIMIT,
  measureEvent?: (<T>(work: () => T) => T) | undefined,
): AsyncGenerator<ChatStreamFrame> {
  let lineBytes: number[] = [];
  let pendingCr = false;
  let eventLines: string[] = [];
  let eventBytes = 0;
  let terminal = false;
  let lineMayStartWithBom = true;

  const finishLine = function* (): Generator<ChatStreamFrame> {
    if (lineBytes.length === 0) {
      lineMayStartWithBom = false;
      const frame = measureEvent === undefined
        ? parseEvent(eventLines)
        : measureEvent(() => parseEvent(eventLines));
      eventLines = [];
      eventBytes = 0;
      if (frame !== undefined) {
        yield frame;
        if (frame.kind === "done" || frame.kind === "error") {
          terminal = true;
        }
      }
      return;
    }
    eventLines.push(decodeLine(lineBytes, lineMayStartWithBom));
    lineMayStartWithBom = false;
    lineBytes = [];
  };

  const pushByte = function* (byte: number): Generator<ChatStreamFrame> {
    if (pendingCr) {
      pendingCr = false;
      if (byte === 0x0a) {
        countEventByte();
        yield* finishLine();
        return;
      }
      yield* finishLine();
      if (terminal) {
        return;
      }
    }
    countEventByte();
    if (byte === 0x0d) {
      pendingCr = true;
      return;
    }
    if (byte === 0x0a) {
      yield* finishLine();
      return;
    }
    lineBytes.push(byte);
  };

  const countEventByte = (): void => {
    eventBytes += 1;
    if (eventBytes > eventLimitBytes) {
      throw new ChatSseError("event_too_large", "SSE event exceeds limit");
    }
  };

  for await (const part of bytes) {
    for (const byte of part) {
      yield* pushByte(byte);
      if (terminal) {
        return;
      }
    }
  }
  if (pendingCr) {
    yield* finishLine();
  }
  if (lineBytes.length > 0 || eventLines.length > 0 || !terminal) {
    throw new ChatSseError("truncated", "truncated SSE stream");
  }
}

function decodeLine(bytes: readonly number[], stripInitialBom: boolean): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    if (stripInitialBom && text.startsWith("\uFEFF")) {
      return text.slice(1);
    }
    return text;
  } catch (error: unknown) {
    throw new ChatSseError("invalid_utf8", "invalid UTF-8 in SSE line", { cause: error });
  }
}

function parseEvent(lines: readonly string[]): ChatStreamFrame | undefined {
  const dataLines: string[] = [];
  let eventName = "message";
  for (const raw of lines) {
    if (raw.length === 0 || raw.startsWith(":")) {
      continue;
    }
    const separator = raw.indexOf(":");
    const name = separator === -1 ? raw : raw.slice(0, separator);
    const value = separator === -1 ? "" : raw.slice(separator + 1).replace(/^ /u, "");
    if (name === "event") {
      eventName = value;
      continue;
    }
    if (name === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return { kind: "done" };
  }
  if (eventName === "error") {
    return { kind: "error", value: data };
  }
  try {
    const jsonBytes = new TextEncoder().encode(data);
    const payload = parseWireJson(jsonBytes, {
      maxBytes: Math.max(jsonBytes.byteLength, 1),
      maxDepth: 64,
    });
    if (!isWireJsonObject(payload)) {
      return { kind: "error", value: data };
    }
    if (memberValues(payload, "error").length > 0 || !isValidChatChunk(payload)) {
      return { kind: "error", value: payload };
    }
    return { kind: "chunk", chunk: { payload } };
  } catch (_error) {
    return { kind: "error", value: data };
  }
}

function isValidChatChunk(payload: Parameters<typeof memberValues>[0]): boolean {
  const choices = memberValues(payload, "choices");
  return choices.length === 1 && isWireJsonArray(choices[0]);
}
