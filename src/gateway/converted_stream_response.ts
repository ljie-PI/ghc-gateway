import type { UpstreamByteStream } from "../copilot/upstream_types.js";
import type { RequestScope } from "./request_scope.js";
import {
  createStreamExecutionResponse,
  nextWithDeadline,
  withByteIdleDeadlines,
  type StreamExecutionEmission,
} from "./stream_execution.js";
import { GatewayFailureError, failureFromSignal } from "./failures.js";
import { normalizeChatStreamFailure } from "../copilot/failures.js";
import { convertProtocolStream } from "../protocols/conversion/stream.js";
import type {
  ConversionCheckpointIntent,
  ConvertedProtocolPlan,
  ConvertedStreamEmission,
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
  const performanceObserver = input.performanceObserver;
  let eventElapsedMs = 0;
  const aggregateEventMeasurements = performanceObserver?.observe !== undefined;
  const converted = convertProtocolStream(
    withByteIdleDeadlines(
      input.upstream.bytes,
      input.scope.signal,
      input.scope.config.timeouts.firstByteMs,
      input.scope.config.timeouts.streamIdleMs,
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
        : aggregateEventMeasurements
          ? (work) => {
            const startedAt = performance.now();
            try {
              return work();
            } finally {
              eventElapsedMs += performance.now() - startedAt;
            }
          }
          : (work) => performanceObserver.measure("event", work),
      flushEventMeasurement: !aggregateEventMeasurements || performanceObserver === undefined
        ? undefined
        : () => {
          if (eventElapsedMs > 0) {
            performanceObserver.observe?.("event", eventElapsedMs);
            eventElapsedMs = 0;
          }
        },
    },
  );

  return await createStreamExecutionResponse({
    upstream: input.upstream,
    emissions: convertedEmissions(converted, input),
    signal: input.scope.signal,
    deliverySignal: input.scope.deliverySignal,
    headers: input.headers,
    firstEmissionTimeoutMs: input.scope.config.timeouts.firstByteMs,
    normalizeFailure: (error) => normalizeStreamFailure(error, input),
    onTerminal: (result) => result.kind === "success"
      ? observeTerminal(input.onTerminal, { kind: "success", usage: result.value })
      : observeTerminal(input.onTerminal, { kind: "failure", error: result.error }),
  });
}

async function* convertedEmissions(
  converted: AsyncIterable<ConvertedStreamEmission>,
  input: Parameters<typeof createConvertedStreamResponse>[0],
): AsyncIterable<StreamExecutionEmission<SemanticUsage>> {
  const iterator = converted[Symbol.asyncIterator]();
  let observedUsage: SemanticUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  let firstSemanticObserved = false;
  const startedAt = Date.now();
  try {
    for (;;) {
      let next: IteratorResult<ConvertedStreamEmission>;
      if (firstSemanticObserved) {
        next = await iterator.next();
      } else {
        const remaining = input.scope.config.timeouts.firstByteMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          throw new GatewayFailureError({ kind: "upstream_timeout", source: "converter", phase: "stream" });
        }
        next = await nextWithDeadline(
          iterator,
          remaining,
          input.scope.signal,
          { source: "converter", phase: "stream" },
        );
      }
      if (next.done === true) {
        throw truncated();
      }
      const emission = next.value;
      if (emission.kind === "first_semantic") {
        firstSemanticObserved = true;
      } else if (emission.kind === "checkpoint") {
        await input.persistCheckpoint?.(emission.intent);
      } else if (emission.kind === "usage") {
        observedUsage = emission.usage;
      } else if (emission.kind === "wire") {
        yield { kind: "wire", bytes: emission.bytes };
      } else if (emission.kind === "terminal") {
        yield {
          kind: "terminal",
          outcome: { kind: "success", value: observedUsage },
          writerMode: "close",
        };
        return;
      }
    }
  } finally {
    if (iterator.return !== undefined) {
      await iterator.return();
    }
  }
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
