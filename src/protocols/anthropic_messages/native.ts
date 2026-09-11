import { GatewayFailureError } from "../../gateway/failures.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import {
  createStreamExecutionResponse,
  withByteIdleDeadlines,
  type StreamExecutionEmission,
} from "../../gateway/stream_execution.js";
import {
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { UpstreamByteStream } from "../../copilot/upstream_types.js";
import type { SemanticUsage } from "../conversion/types.js";
import { mergeMessagesUsage } from "../conversion/usage.js";

export function serializeNativeMessagesRequest(body: WireJsonObject, model: string): Uint8Array {
  let replaced = false;
  const members = body.members.map((member) => {
    if (member.key !== "model") {
      return member;
    }
    replaced = true;
    return { key: member.key, value: model };
  });
  if (!replaced) {
    members.push({ key: "model", value: model });
  }
  return serializeWireJson({ kind: "object", members });
}

export function validatedNativeMessagesBody(bytes: Uint8Array, maxBytes: number): Uint8Array {
  try {
    const parsed = parseWireJson(bytes, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      invalid();
    }
    const types = memberValues(parsed, "type");
    if (
      types.length !== 1
      || typeof types[0] !== "string"
      || types[0] === "error"
      || memberValues(parsed, "error").length > 0
    ) {
      invalid();
    }
    return bytes;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({
      kind: "invalid_upstream_response",
      source: "parser",
      phase: "body",
      cause: error,
    });
  }
}

export function nativeMessagesUsage(bytes: Uint8Array, maxBytes: number): SemanticUsage {
  const parsed = parseWireJson(bytes, { maxBytes, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) {
    invalid();
  }
  const usage = objectMember(parsed, "usage");
  if (usage === undefined) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
  }
  const read = integerMember(usage, "cache_read_input_tokens");
  const write = integerMember(usage, "cache_creation_input_tokens");
  return {
    inputTokens: integerMember(usage, "input_tokens") + read + write,
    outputTokens: integerMember(usage, "output_tokens"),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    reasoningTokens: 0,
  };
}

export async function createNativeMessagesStreamResponse(input: {
  readonly upstream: UpstreamByteStream;
  readonly scope: Readonly<RequestScope>;
  readonly onTerminal: (result: Readonly<
    | { readonly kind: "success"; readonly usage: SemanticUsage }
    | { readonly kind: "failure"; readonly error: unknown }
  >) => void;
}): Promise<Response> {
  const timed = withByteIdleDeadlines(
    input.upstream.bytes,
    input.scope.signal,
    input.scope.config.timeouts.firstByteMs,
    input.scope.config.timeouts.streamIdleMs,
  );
  return await createStreamExecutionResponse({
    upstream: input.upstream,
    emissions: nativeMessagesEmissions(
      timed,
      input.scope.config.limits.sseEventBytes,
      input.scope.config.limits.accumulatorBytes,
    ),
    signal: input.scope.signal,
    deliverySignal: input.scope.deliverySignal,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "request-id": input.scope.requestId,
    },
    firstEmissionTimeoutMs: input.scope.config.timeouts.firstByteMs,
    normalizeFailure: (error) => error,
    onTerminal: (result) => result.kind === "success"
      ? observe(input.onTerminal, { kind: "success", usage: result.value })
      : observe(input.onTerminal, { kind: "failure", error: result.error }),
  });
}

async function* nativeMessagesEmissions(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
): AsyncIterable<StreamExecutionEmission<SemanticUsage>> {
  const iterator = bytes[Symbol.asyncIterator]();
  const observer = new NativeMessagesObserver(eventLimitBytes);
  const presemanticRecords: Uint8Array[] = [];
  let prefetchedBytes = 0;
  try {
    while (!observer.hasSemantic) {
      const next = await iterator.next();
      if (next.done === true) {
        throw truncated();
      }
      prefetchedBytes += next.value.byteLength;
      if (prefetchedBytes > accumulatorBytes) {
        invalid();
      }
      presemanticRecords.push(...observer.consume(next.value));
    }
    for (const record of presemanticRecords) {
      yield { kind: "wire", bytes: record };
    }
    if (observer.isTerminal) {
      yield { kind: "terminal", value: observer.observedUsage };
      return;
    }
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        const finished = observer.finish();
        for (const record of finished.records) {
          yield { kind: "wire", bytes: record };
        }
        yield { kind: "terminal", value: finished.usage };
        return;
      }
      for (const record of observer.consume(next.value)) {
        yield { kind: "wire", bytes: record };
      }
      if (observer.isTerminal) {
        yield { kind: "terminal", value: observer.observedUsage };
        return;
      }
    }
  } finally {
    if (iterator.return !== undefined) {
      await iterator.return();
    }
  }
}

class NativeRecordAccumulator {
  private readonly chunks: Uint8Array[] = [];
  private fragments: Uint8Array[] = [];
  byteLength = 0;

  append(value: Uint8Array): void {
    if (value.byteLength === 0) {
      return;
    }
    this.fragments.push(value);
    this.byteLength += value.byteLength;
    if (this.fragments.length >= 1_024) {
      this.chunks.push(Buffer.concat(this.fragments));
      this.fragments = [];
    }
  }

  peek(): Uint8Array {
    return Buffer.concat([...this.chunks, ...this.fragments], this.byteLength);
  }

  take(): Uint8Array {
    const value = this.peek();
    this.chunks.length = 0;
    this.fragments = [];
    this.byteLength = 0;
    return value;
  }
}

class NativeMessagesObserver {
  private readonly pending = new NativeRecordAccumulator();
  private readonly utf8Validator = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private pendingCr = false;
  private completeOnPendingCr = false;
  private lineEmpty = true;
  private terminal = false;
  private semantic = false;
  private usage: SemanticUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };

  constructor(private readonly eventLimitBytes: number) {}

  get hasSemantic(): boolean {
    return this.semantic;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  get observedUsage(): SemanticUsage {
    return this.usage;
  }

  consume(bytes: Uint8Array): readonly Uint8Array[] {
    try {
      this.utf8Validator.decode(bytes, { stream: true });
    } catch {
      invalid();
    }
    const records: Uint8Array[] = [];
    let index = 0;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (bytes[0] === 0x0a) {
        this.append(bytes.subarray(0, 1));
        index = 1;
      }
      if (this.completeOnPendingCr) {
        this.completeOnPendingCr = false;
        this.emitRecord(records);
        if (this.terminal) {
          return records;
        }
      }
    }
    while (index < bytes.byteLength) {
      let boundary = index;
      while (boundary < bytes.byteLength && bytes[boundary] !== 0x0a && bytes[boundary] !== 0x0d) {
        boundary += 1;
      }
      if (boundary > index) {
        this.append(bytes.subarray(index, boundary));
        this.lineEmpty = false;
      }
      if (boundary >= bytes.byteLength) {
        break;
      }
      const character = bytes[boundary];
      this.append(bytes.subarray(boundary, boundary + 1));
      const complete = this.finishLine();
      if (character === 0x0d) {
        if (boundary + 1 >= bytes.byteLength) {
          this.pendingCr = true;
          this.completeOnPendingCr = complete;
          break;
        }
        if (bytes[boundary + 1] === 0x0a) {
          this.append(bytes.subarray(boundary + 1, boundary + 2));
          boundary += 1;
        }
      }
      if (complete) {
        this.emitRecord(records);
        if (this.terminal) {
          return records;
        }
      }
      index = boundary + 1;
    }
    return records;
  }

  finish(): { readonly usage: SemanticUsage; readonly records: readonly Uint8Array[] } {
    try {
      this.utf8Validator.decode();
    } catch {
      invalid();
    }
    const records: Uint8Array[] = [];
    if (this.pendingCr) {
      this.pendingCr = false;
      if (this.completeOnPendingCr) {
        this.completeOnPendingCr = false;
        this.emitRecord(records);
      }
    }
    const trailing = this.pending.peek();
    if (trailing.byteLength > 0) {
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(trailing);
      } catch {
        invalid();
      }
      if (decoded.trim().length > 0) {
        throw truncated();
      }
    }
    if (!this.terminal) {
      throw truncated();
    }
    return { usage: this.usage, records };
  }

  private append(bytes: Uint8Array): void {
    this.pending.append(bytes);
    if (this.pending.byteLength > this.eventLimitBytes) {
      invalid();
    }
  }

  private finishLine(): boolean {
    if (this.lineEmpty) {
      return true;
    }
    this.lineEmpty = true;
    return false;
  }

  private emitRecord(records: Uint8Array[]): void {
    const bytes = this.pending.take();
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid();
    }
    this.observeRecord(raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"));
    records.push(bytes);
    this.lineEmpty = true;
  }

  private observeRecord(raw: string): void {
    const observed = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
    const event = observed.split("\n")
      .filter((line) => line.startsWith("event:"))
      .map((line) => line.slice(6).trim())
      .at(-1);
    if (event === "error") {
      this.semantic = true;
      throw new GatewayFailureError({
        kind: "upstream_stream_error",
        source: "parser",
        phase: "stream",
      });
    }
    const data = observed.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data.length === 0) {
      return;
    }
    let payload: WireJson;
    try {
      const bytes = new TextEncoder().encode(data);
      payload = parseWireJson(bytes, { maxBytes: Math.max(1, bytes.byteLength), maxDepth: 64 });
    } catch {
      invalid();
    }
    if (!isWireJsonObject(payload)) {
      invalid();
    }
    const types = memberValues(payload, "type");
    if (
      types.length !== 1
      || typeof types[0] !== "string"
      || memberValues(payload, "error").length > 0
    ) {
      invalid();
    }
    const type = types[0];
    if (type === "error") {
      this.semantic = true;
      throw new GatewayFailureError({
        kind: "upstream_stream_error",
        source: "parser",
        phase: "stream",
      });
    }
    if (type === "message_start") {
      this.semantic = true;
      this.mergeUsage(objectMember(objectMember(payload, "message"), "usage"));
    } else if (type === "message_delta") {
      this.semantic = true;
      this.mergeUsage(objectMember(payload, "usage"));
    } else if (type === "message_stop") {
      this.semantic = true;
      this.terminal = true;
    } else if (type === "content_block_start" || type === "content_block_delta" || type === "content_block_stop") {
      this.semantic = true;
    }
  }

  private mergeUsage(value: WireJsonObject | undefined): void {
    if (value === undefined) {
      return;
    }
    this.usage = mergeMessagesUsage(this.usage, {
      inputTokens: optionalIntegerMember(value, "input_tokens"),
      outputTokens: optionalIntegerMember(value, "output_tokens"),
      cacheReadTokens: optionalIntegerMember(value, "cache_read_input_tokens"),
      cacheWriteTokens: optionalIntegerMember(value, "cache_creation_input_tokens"),
    });
  }
}

function objectMember(object: WireJsonObject | undefined, key: string): WireJsonObject | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = memberValues(object, key)[0];
  return isWireJsonObject(value) ? value : undefined;
}

function integerMember(object: WireJsonObject, key: string): number {
  return optionalIntegerMember(object, key) ?? 0;
}

function optionalIntegerMember(object: WireJsonObject, key: string): number | undefined {
  const value = memberValues(object, key)[0];
  if (!isWireJsonNumber(value)) {
    return undefined;
  }
  const parsed = Number(value.lexeme);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function observe(
  observer: Parameters<typeof createNativeMessagesStreamResponse>[0]["onTerminal"],
  value: Parameters<Parameters<typeof createNativeMessagesStreamResponse>[0]["onTerminal"]>[0],
): void {
  try {
    observer(value);
  } catch {
    // Observability cannot alter native stream bytes.
  }
}

function invalid(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "parser",
    phase: "stream",
  });
}

function truncated(): GatewayFailureError {
  return new GatewayFailureError({
    kind: "upstream_stream_truncated",
    source: "parser",
    phase: "stream",
  });
}
