import { GatewayFailureError, failureFromSignal } from "../../gateway/failures.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import { createStreamResponseWriter } from "../../gateway/stream_response.js";
import {
  createExchangeCancellation,
  createOwnedStreamCleanup,
  nextWithDeadline,
  withByteIdleDeadlines,
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
import { takeSseRecord } from "../conversion/sse.js";
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
  const cancelExchange = createExchangeCancellation(input.upstream);
  const timed = withByteIdleDeadlines(
    input.upstream.bytes,
    input.scope.signal,
    input.scope.config.timeouts.firstByteMs,
    input.scope.config.timeouts.streamIdleMs,
    cancelExchange,
  );
  const iterator = timed[Symbol.asyncIterator]();
  const cleanupUpstream = createOwnedStreamCleanup(input.upstream, iterator, 1_000, cancelExchange);
  const observer = new NativeMessagesObserver(input.scope.config.limits.sseEventBytes);
  const prefetched: Uint8Array[] = [];
  let prefetchedBytes = 0;
  const startedAt = Date.now();
  try {
    while (!observer.hasSemantic) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= input.scope.config.timeouts.firstByteMs) {
        throw new GatewayFailureError({
          kind: "upstream_timeout",
          source: "parser",
          phase: "stream",
        });
      }
      const remaining = input.scope.config.timeouts.firstByteMs - elapsed;
      const next = await nextWithDeadline(
        iterator,
        remaining,
        input.scope.signal,
        { source: "parser", phase: "stream" },
      );
      if (next.done === true) {
        throw truncated();
      }
      prefetchedBytes += next.value.byteLength;
      if (prefetchedBytes > input.scope.config.limits.accumulatorBytes) {
        invalid();
      }
      prefetched.push(...observer.consume(next.value));
    }
  } catch (error: unknown) {
    await cleanupUpstream();
    throw error;
  }

  const writer = createStreamResponseWriter({
    signal: input.scope.signal,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "request-id": input.scope.requestId,
    },
    onCancel: async () => await closeStream(),
  });
  let closed = false;
  let cleanup: Promise<void> | undefined;
  const closeStream = async (): Promise<void> => {
    if (closed) {
      await cleanup;
      return;
    }
    closed = true;
    input.scope.signal.removeEventListener("abort", onAbort);
    cleanup = cleanupUpstream();
    await cleanup;
  };
  const onAbort = (): void => {
    observe(input.onTerminal, {
      kind: "failure",
      error: new GatewayFailureError(failureFromSignal(input.scope.signal, {
        source: "parser",
        phase: "stream",
      })),
    });
    void closeStream();
  };
  void (async () => {
    try {
      for (const value of prefetched) {
        if (!await writer.enqueue(value)) {
          return;
        }
      }
      if (observer.isTerminal) {
        observe(input.onTerminal, { kind: "success", usage: observer.observedUsage });
        await closeStream();
        writer.close();
        return;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          const finished = observer.finish();
          for (const value of finished.records) {
            if (!await writer.enqueue(value)) {
              return;
            }
          }
          observe(input.onTerminal, { kind: "success", usage: finished.usage });
          await closeStream();
          writer.close();
          return;
        }
        for (const value of observer.consume(next.value)) {
          if (!await writer.enqueue(value)) {
            return;
          }
        }
        if (observer.isTerminal) {
          observe(input.onTerminal, { kind: "success", usage: observer.observedUsage });
          await closeStream();
          writer.close();
          return;
        }
      }
    } catch (error: unknown) {
      observe(input.onTerminal, { kind: "failure", error });
      await closeStream();
      writer.abort();
    } finally {
      await closeStream();
    }
  })();
  input.scope.signal.addEventListener("abort", onAbort, { once: true });
  return writer.response;
}

class NativeMessagesObserver {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private readonly encoder = new TextEncoder();
  private pending = "";
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
    this.pending += this.decoder.decode(bytes, { stream: true });
    return this.drain();
  }

  finish(): { readonly usage: SemanticUsage; readonly records: readonly Uint8Array[] } {
    this.pending += this.decoder.decode();
    const records = this.drain(true);
    if (this.pending.trim().length > 0 || !this.terminal) {
      throw truncated();
    }
    return { usage: this.usage, records };
  }

  private drain(final = false): readonly Uint8Array[] {
    const records: Uint8Array[] = [];
    for (;;) {
      const extracted = takeSseRecord(this.pending, final);
      if (extracted === undefined) {
        if (this.encoder.encode(this.pending).byteLength > this.eventLimitBytes) {
          invalid();
        }
        return records;
      }
      this.pending = extracted.rest;
      if (this.encoder.encode(extracted.consumed).byteLength > this.eventLimitBytes) {
        invalid();
      }
      this.observeRecord(extracted.raw.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"));
      records.push(this.encoder.encode(extracted.consumed));
      if (this.terminal) {
        this.pending = "";
        return records;
      }
    }
  }

  private observeRecord(raw: string): void {
    const event = raw.split("\n")
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
    const data = raw.split("\n")
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
      return;
    }
    if (!isWireJsonObject(payload)) {
      return;
    }
    const type = stringMember(payload, "type");
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

function stringMember(object: WireJsonObject, key: string): string | undefined {
  const value = memberValues(object, key)[0];
  return typeof value === "string" ? value : undefined;
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
