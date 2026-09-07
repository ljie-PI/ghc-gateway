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
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const encoder = new TextEncoder();
  const line = new FragmentAccumulator();
  let recordLines: string[] = [];
  let recordBytes = 0;
  let pendingCr = false;
  const ready: SseRecord[] = [];

  const reserve = (value: string): void => {
    recordBytes += encoder.encode(value).byteLength;
    if (recordBytes > eventLimitBytes) {
      throw new ChatSseError("event_too_large", "SSE event exceeds limit");
    }
  };
  const finishLine = (): void => {
    const value = line.take();
    if (value.length > 0) {
      recordLines.push(value);
      return;
    }
    const parsed = parseRecordLines(recordLines);
    recordLines = [];
    recordBytes = 0;
    if (parsed !== undefined) {
      ready.push(parsed);
    }
  };
  const consume = (value: string): void => {
    let start = 0;
    if (pendingCr) {
      pendingCr = false;
      if (value.startsWith("\n")) {
        reserve("\r\n");
        finishLine();
        start = 1;
      } else {
        reserve("\r");
        finishLine();
      }
    }
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (character !== "\n" && character !== "\r") {
        continue;
      }
      const content = value.slice(start, index);
      line.append(content);
      reserve(content);
      if (character === "\r" && index + 1 >= value.length) {
        pendingCr = true;
        start = value.length;
        break;
      }
      if (character === "\r" && value[index + 1] === "\n") {
        reserve("\r\n");
        index += 1;
      } else {
        reserve(character);
      }
      finishLine();
      start = index + 1;
    }
    const trailing = value.slice(start);
    line.append(trailing);
    reserve(trailing);
  };
  try {
    for await (const chunk of bytes) {
      consume(decoder.decode(chunk, { stream: true }));
      while (ready.length > 0) {
        yield ready.shift() as SseRecord;
      }
    }
    consume(decoder.decode());
    if (pendingCr) {
      pendingCr = false;
      reserve("\r");
      finishLine();
    }
    while (ready.length > 0) {
      yield ready.shift() as SseRecord;
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
  if (recordLines.some((value) => value.trim().length > 0) || line.peek().trim().length > 0) {
    throw new GatewayFailureError({
      kind: "upstream_stream_truncated",
      source: "parser",
      phase: "stream",
    });
  }

}

class FragmentAccumulator {
  private readonly chunks: string[] = [];
  private fragments: string[] = [];

  append(value: string): void {
    if (value.length === 0) {
      return;
    }
    this.fragments.push(value);
    if (this.fragments.length >= 1_024) {
      this.chunks.push(this.fragments.join(""));
      this.fragments = [];
    }
  }

  peek(): string {
    return [...this.chunks, ...this.fragments].join("");
  }

  take(): string {
    const value = this.peek();
    this.chunks.length = 0;
    this.fragments = [];
    return value;
  }
}

export function takeSseRecord(value: string, final = false, startIndex = 0): {
  readonly raw: string;
  readonly consumed: string;
  readonly rest: string;
} | undefined {
  for (let index = startIndex; index < value.length; index += 1) {
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

function parseRecordLines(lines: readonly string[]): SseRecord | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
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
