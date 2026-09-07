import type { UpstreamByteStream } from "../copilot/upstream_types.js";
import type { RequestScope } from "./request_scope.js";
import { createStreamResponseWriter } from "./stream_response.js";
import {
  createExchangeCancellation,
  createOwnedStreamCleanup,
  nextWithDeadline,
  withByteIdleDeadlines,
} from "./stream_execution.js";
import { GatewayFailureError, failureFromSignal } from "./failures.js";
import { normalizeChatStreamFailure } from "../copilot/failures.js";
import { convertProtocolStream } from "../protocols/conversion/stream.js";
import type {
  ConversionCheckpointIntent,
  ConvertedProtocolPlan,
  SemanticUsage,
} from "../protocols/conversion/types.js";
import type { ProtocolPerformanceObserver } from "../telemetry/runtime.js";

export async function createConvertedStreamResponse(input: {
  readonly upstream: UpstreamByteStream;
  readonly plan: Readonly<ConvertedProtocolPlan>;
  readonly scope: Readonly<RequestScope>;
  readonly model: string;
  readonly createUuid: () => string;
  readonly nowUnixSeconds: () => number;
  readonly headers: HeadersInit;
  readonly performanceObserver?: ProtocolPerformanceObserver | undefined;
  readonly persistCheckpoint?: (intent: Readonly<ConversionCheckpointIntent>) => Promise<void>;
  readonly onTerminal: (result: Readonly<
    | { readonly kind: "success"; readonly usage: SemanticUsage }
    | { readonly kind: "failure"; readonly error: unknown }
  >) => void;
}): Promise<Response> {
  const cancelExchange = createExchangeCancellation(input.upstream);
  const performanceObserver = input.performanceObserver;
  const emissions = convertProtocolStream(
    withByteIdleDeadlines(
      input.upstream.bytes,
      input.scope.signal,
      input.scope.config.timeouts.firstByteMs,
      input.scope.config.timeouts.streamIdleMs,
      cancelExchange,
    ),
    {
      source: input.plan.target,
      target: input.plan.source,
      model: input.model,
      eventLimitBytes: input.scope.config.limits.sseEventBytes,
      accumulatorBytes: input.scope.config.limits.accumulatorBytes,
      createUuid: input.createUuid,
      nowUnixSeconds: input.nowUnixSeconds,
      degradations: input.plan.request.degradations,
      measureEvent: performanceObserver === undefined
        ? undefined
        : (work) => performanceObserver.measure("event", work),
    },
  );
  const iterator = emissions[Symbol.asyncIterator]();
  const cleanupUpstream = createOwnedStreamCleanup(input.upstream, iterator, 1_000, cancelExchange);
  let observedUsage: SemanticUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const prefetched: Uint8Array[] = [];
  const firstSemanticStartedAt = Date.now();
  try {
    for (;;) {
      const elapsed = Date.now() - firstSemanticStartedAt;
      if (elapsed >= input.scope.config.timeouts.firstByteMs) {
        throw new GatewayFailureError({
          kind: "upstream_timeout",
          source: "converter",
          phase: "stream",
        });
      }
      const next = await nextWithDeadline(
        iterator,
        input.scope.config.timeouts.firstByteMs - elapsed,
        input.scope.signal,
        { source: "converter", phase: "stream" },
      );
      if (next.done === true) {
        throw truncated();
      }
      const emission = next.value;
      if (emission.kind === "checkpoint") {
        await input.persistCheckpoint?.(emission.intent);
      } else if (emission.kind === "usage") {
        observedUsage = emission.usage;
      } else if (emission.kind === "wire") {
        prefetched.push(emission.bytes);
        break;
      }
    }
  } catch (error: unknown) {
    await cleanupUpstream();
    throw normalizeStreamFailure(error, input);
  }

  const writer = createStreamResponseWriter({
    signal: input.scope.signal,
    headers: input.headers,
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
    observeTerminal(input.onTerminal, {
      kind: "failure",
      error: new GatewayFailureError(failureFromSignal(input.scope.signal, {
        source: "converter",
        phase: "stream",
      })),
    });
    void closeStream();
  };
  void (async () => {
    try {
      for (const bytes of prefetched) {
        if (!await writer.enqueue(bytes)) {
          return;
        }
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          throw truncated();
        }
        const emission = next.value;
        if (emission.kind === "wire") {
          if (!await writer.enqueue(emission.bytes)) {
            return;
          }
        } else if (emission.kind === "checkpoint") {
          await input.persistCheckpoint?.(emission.intent);
        } else if (emission.kind === "usage") {
          observedUsage = emission.usage;
        } else if (emission.kind === "terminal") {
          observeTerminal(input.onTerminal, { kind: "success", usage: observedUsage });
          await closeStream();
          writer.close();
          return;
        }
      }
    } catch (error: unknown) {
      observeTerminal(input.onTerminal, { kind: "failure", error: normalizeStreamFailure(error, input) });
      await closeStream();
      writer.abort();
    } finally {
      await closeStream();
    }

  })();
  input.scope.signal.addEventListener("abort", onAbort, { once: true });
  return writer.response;
}

function normalizeStreamFailure(
  error: unknown,
  input: Pick<Parameters<typeof createConvertedStreamResponse>[0], "plan" | "scope">,
): unknown {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (input.plan.target === "chat") {
    return normalizeChatStreamFailure(error, input.scope.signal);
  }
  if (input.scope.signal.aborted) {
    return new GatewayFailureError(failureFromSignal(input.scope.signal, {
      source: "parser",
      phase: "stream",
    }));
  }
  return new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "parser",
    phase: "stream",
    cause: error,
  });
}

function observeTerminal(
  observer: Parameters<typeof createConvertedStreamResponse>[0]["onTerminal"],
  result: Parameters<Parameters<typeof createConvertedStreamResponse>[0]["onTerminal"]>[0],
): void {
  try {
    observer(result);
  } catch {
    // Observability cannot alter stream bytes or cleanup.
  }
}

function truncated(): GatewayFailureError {
  return new GatewayFailureError({
    kind: "upstream_stream_truncated",
    source: "converter",
    phase: "stream",
  });
}
