import {
  failureFromSignal,
  GatewayFailureError,
  type GatewayFailureOrigin,
} from "./failures.js";
import type { UpstreamByteStream } from "../copilot/upstream_types.js";
import { createStreamResponseWriter, type StreamResponseWriter } from "./stream_response.js";

export type StreamExecutionState = "precommit" | "committed" | "terminating" | "completed";

export type StreamExecutionTerminalCause =
  | "semantic_success"
  | "precommit_failure"
  | "postcommit_failure"
  | "client_cancel"
  | "request_abort"
  | "total_timeout"
  | "first_byte_timeout"
  | "idle_timeout"
  | "shutdown";

export type StreamExecutionEmission<T> =
  | { readonly kind: "wire"; readonly bytes: Uint8Array }
  | { readonly kind: "terminal"; readonly value: T; readonly writerMode?: "close" | "abort" };

export interface StreamExecutionHandle {
  readonly state: StreamExecutionState;
  readonly cause: StreamExecutionTerminalCause | undefined;
  readonly completion: Promise<void>;
  claimDeliveryAdapter(): void;
  markDelivered(): void;
  abort(cause: "shutdown" | "request_abort" | "total_timeout"): Promise<void>;
}

const executionHandles = new WeakMap<Response, StreamExecutionHandle>();

export function getStreamExecutionHandle(response: Response): StreamExecutionHandle | undefined {
  return executionHandles.get(response);
}

export async function createStreamExecutionResponse<T>(input: {
  readonly upstream: UpstreamByteStream;
  readonly emissions: AsyncIterable<StreamExecutionEmission<T>>;
  readonly signal: AbortSignal;
  readonly deliverySignal: AbortSignal;
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly firstEmissionTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly normalizeFailure: (error: unknown) => unknown;
  readonly presentPostCommitFailure?: (error: unknown) => unknown;
  readonly onTerminal: (result: Readonly<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "failure"; readonly error: unknown }
  >) => void;
}): Promise<Response> {
  const iterator = input.emissions[Symbol.asyncIterator]();
  let state: StreamExecutionState = "precommit";
  let cause: StreamExecutionTerminalCause | undefined;
  const resources: {
    writer?: StreamResponseWriter;
    producer?: Promise<void>;
  } = {};
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let barrier: Promise<void> | undefined;
  let deliveryAdapterClaimed = false;
  let deliverySettled = false;
  let resolveDelivery: () => void = () => undefined;
  const firstDelivery = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const settleDelivery = (): void => {
    if (!deliverySettled) {
      deliverySettled = true;
      resolveDelivery();
    }
  };

  const observe = (result: Parameters<typeof input.onTerminal>[0]): void => {
    try {
      input.onTerminal(result);
    } catch {
      // Observability cannot alter stream delivery or resource cleanup.
    }
  };

  const finish = async (
    terminalCause: StreamExecutionTerminalCause,
    result: Parameters<typeof input.onTerminal>[0],
    writerMode: "close" | "abort" = terminalCause === "semantic_success" ? "close" : "abort",
    fromProducer = false,
  ): Promise<void> => {
    if (barrier !== undefined) {
      if (!fromProducer) {
        await barrier;
      }
      return;
    }
    cause = terminalCause;
    state = "terminating";
    settleDelivery();
    barrier = (async () => {
      observe(result);
      if (writerMode === "abort") {
        const error = result.kind === "failure"
          ? (input.presentPostCommitFailure?.(result.error) ?? result.error)
          : undefined;
        resources.writer?.abort(error);
      }
      await boundedCleanup(
        Promise.resolve().then(async () => await input.upstream.cancel()),
        input.cleanupTimeoutMs ?? 1_000,
      );
      if (iterator.return !== undefined) {
        await boundedCleanup(
          Promise.resolve().then(async () => await iterator.return!()),
          input.cleanupTimeoutMs ?? 1_000,
        );
      }
      if (!fromProducer && resources.producer !== undefined) {
        await boundedCleanup(resources.producer, input.cleanupTimeoutMs ?? 1_000);
      }
      if (writerMode === "close") {
        resources.writer?.close();
      }
      input.signal.removeEventListener("abort", onRequestAbort);
      input.deliverySignal.removeEventListener("abort", onDeliveryAbort);
      state = "completed";
      resolveCompletion();
    })();
    await barrier;
  };

  const signalCause = (): "request_abort" | "total_timeout" => {
    const reason = input.signal.reason;
    return reason instanceof GatewayFailureError && reason.failure.kind === "upstream_timeout"
      ? "total_timeout"
      : "request_abort";
  };
  const failureCause = (error: unknown, committed: boolean): StreamExecutionTerminalCause => {
    if (error instanceof GatewayFailureError && error.failure.kind === "upstream_timeout") {
      if (input.signal.aborted) {
        return signalCause();
      }
      return committed ? "idle_timeout" : "first_byte_timeout";
    }
    return committed ? "postcommit_failure" : "precommit_failure";
  };
  const abortFailure = (): GatewayFailureError => new GatewayFailureError(failureFromSignal(input.signal, {
    source: "parser",
    phase: "stream",
  }));
  const onRequestAbort = (): void => {
    const error = abortFailure();
    void finish(signalCause(), { kind: "failure", error });
  };
  const onDeliveryAbort = (): void => {
    const error = new GatewayFailureError({ kind: "aborted", source: "request", phase: "stream" });
    void finish("client_cancel", { kind: "failure", error });
  };

  input.signal.addEventListener("abort", onRequestAbort, { once: true });
  input.deliverySignal.addEventListener("abort", onDeliveryAbort, { once: true });
  if (input.signal.aborted) {
    onRequestAbort();
    await completion;
    throw abortFailure();
  }
  if (input.deliverySignal.aborted) {
    onDeliveryAbort();
    await completion;
    throw new GatewayFailureError({ kind: "aborted", source: "request", phase: "stream" });
  }

  let firstWire: Uint8Array;
  try {
    const first = input.firstEmissionTimeoutMs === undefined
      ? await iterator.next()
      : await nextWithDeadline(
        iterator,
        input.firstEmissionTimeoutMs,
        input.signal,
        { source: "parser", phase: "stream" },
      );
    if (first.done === true || first.value.kind === "terminal") {
      throw new GatewayFailureError({
        kind: "upstream_stream_truncated",
        source: "parser",
        phase: "stream",
      });
    }
    firstWire = first.value.bytes;
  } catch (error: unknown) {
    const failure = input.normalizeFailure(error);
    await finish(failureCause(failure, false), { kind: "failure", error: failure });
    throw failure;
  }

  resources.writer = createStreamResponseWriter({
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    onCommit: () => {
      if (!deliveryAdapterClaimed) {
        settleDelivery();
      }
    },
    onCancel: async () => {
      const error = new GatewayFailureError({ kind: "aborted", source: "request", phase: "stream" });
      await finish("client_cancel", { kind: "failure", error });
    },
  });
  const response = resources.writer.response;
  const handle: StreamExecutionHandle = {
    get state() {
      return state;
    },
    get cause() {
      return cause;
    },
    completion,
    claimDeliveryAdapter: () => {
      deliveryAdapterClaimed = true;
    },
    markDelivered: settleDelivery,
    abort: async (terminalCause) => {
      const error = terminalCause === "total_timeout"
        ? new GatewayFailureError({ kind: "upstream_timeout", source: "gateway", phase: "stream" })
        : new GatewayFailureError({ kind: "aborted", source: "gateway", phase: "stream" });
      await finish(terminalCause, { kind: "failure", error });
    },
  };
  executionHandles.set(response, handle);

  const produce = async (): Promise<void> => {
    try {
      if (!await resources.writer!.enqueue(firstWire)) {
        return;
      }
      await firstDelivery;
      if (barrier !== undefined) {
        return;
      }
      state = "committed";
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          throw new GatewayFailureError({
            kind: "upstream_stream_truncated",
            source: "parser",
            phase: "stream",
          });
        }
        if (next.value.kind === "wire") {
          if (!await resources.writer!.enqueue(next.value.bytes)) {
            return;
          }
          continue;
        }
        await finish(
          next.value.writerMode === "abort" ? "postcommit_failure" : "semantic_success",
          { kind: "success", value: next.value.value },
          next.value.writerMode ?? "close",
          true,
        );
        return;
      }
    } catch (error: unknown) {
      const failure = input.normalizeFailure(error);
      await finish(failureCause(failure, resources.writer!.committed), {
        kind: "failure",
        error: failure,
      }, "abort", true);
    }
  };
  resources.producer = produce();
  void resources.producer.catch(() => undefined);
  return response;
}

export async function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal: AbortSignal,
  origin: Readonly<GatewayFailureOrigin>,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    throw new GatewayFailureError(failureFromSignal(signal, origin));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GatewayFailureError({
      kind: "upstream_timeout",
      ...origin,
    })), timeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new GatewayFailureError(failureFromSignal(signal, origin)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), timeout, aborted]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function* withByteIdleDeadlines(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  firstByteMs: number,
  idleMs: number,
): AsyncIterable<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let seenBytes = false;
  try {
    for (;;) {
      const next = await nextWithDeadline(
        iterator,
        seenBytes ? idleMs : firstByteMs,
        signal,
        { source: "parser", phase: "stream" },
      );
      if (next.done === true) {
        return;
      }
      seenBytes = true;
      yield next.value;
    }
  } finally {
    if (iterator.return !== undefined) {
      await boundedCleanup(iterator.return());
    }
  }
}

export async function boundedCleanup(operation: Promise<unknown>, timeoutMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
