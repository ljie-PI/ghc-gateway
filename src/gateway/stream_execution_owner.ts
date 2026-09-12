import {
  failureFromSignal,
  GatewayFailureError,
  type GatewayFailureOrigin,
} from "./failures.js";
import { createStreamResponseWriter, type StreamResponseWriter } from "./stream_response.js";
import type {
  CreateStreamExecutionResponseInput,
  StreamExecutionHandle,
  StreamExecutionState,
  StreamExecutionTerminalCause,
} from "./stream_execution.js";

interface StreamExecutionOwnerDependencies {
  boundedCleanup(operation: Promise<unknown>, timeoutMs?: number): Promise<void>;
  nextWithDeadline<T>(
    iterator: AsyncIterator<T>,
    timeoutMs: number,
    signal: AbortSignal,
    origin: Readonly<GatewayFailureOrigin>,
  ): Promise<IteratorResult<T>>;
}

export async function createStreamExecutionResponseOwner<T>(
  input: CreateStreamExecutionResponseInput<T>,
  dependencies: StreamExecutionOwnerDependencies,
): Promise<Readonly<{ response: Response; handle: StreamExecutionHandle }>> {
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
  let deliveryFinalizer: (() => void) | undefined;
  let deliveryFinalized = false;
  let deliverySettled = false;
  let resolveDelivery: () => void = () => undefined;
  const deliverySettlement = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  let firstDelivered = false;
  let resolveFirstDelivery: () => void = () => undefined;
  const firstDelivery = new Promise<void>((resolve) => {
    resolveFirstDelivery = resolve;
  });
  const settleDelivery = (): void => {
    if (!deliverySettled) {
      deliverySettled = true;
      resolveDelivery();
    }
  };
  const markDelivered = (): void => {
    if (!firstDelivered) {
      firstDelivered = true;
      if (state === "precommit") {
        state = "committed";
      }
      resolveFirstDelivery();
    }
  };
  const finalizeDelivery = (): void => {
    if (deliveryFinalized || deliveryFinalizer === undefined) {
      return;
    }
    deliveryFinalized = true;
    try {
      deliveryFinalizer();
    } catch {
      // Host finalization cannot prevent completion or listener cleanup.
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
    barrier = (async () => {
      try {
        observe(result);
        if (writerMode === "abort") {
          const error = result.kind === "failure"
            ? (input.presentPostCommitFailure?.(result.error) ?? result.error)
            : undefined;
          resources.writer?.abort(error);
        }
        await dependencies.boundedCleanup(
          Promise.resolve().then(async () => await input.upstream.cancel()),
          input.cleanupTimeoutMs ?? 1_000,
        );
        if (iterator.return !== undefined) {
          await dependencies.boundedCleanup(
            Promise.resolve().then(async () => await iterator.return!()),
            input.cleanupTimeoutMs ?? 1_000,
          );
        }
        if (!fromProducer && resources.producer !== undefined) {
          await dependencies.boundedCleanup(resources.producer, input.cleanupTimeoutMs ?? 1_000);
        }
        if (writerMode === "close") {
          resources.writer?.close();
        }
        if (!deliveryAdapterClaimed) {
          settleDelivery();
        }
        await deliverySettlement;
        finalizeDelivery();
      } finally {
        input.signal.removeEventListener("abort", onRequestAbort);
        input.deliverySignal.removeEventListener("abort", onDeliveryAbort);
        state = "completed";
        resolveCompletion();
      }
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
      : await dependencies.nextWithDeadline(
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
        markDelivered();
      }
    },
    onCancel: async () => {
      if (!deliveryAdapterClaimed) {
        settleDelivery();
      }
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
    claimDeliveryAdapter: (finalize) => {
      if (deliveryAdapterClaimed) {
        throw new Error("stream delivery adapter already claimed");
      }
      deliveryAdapterClaimed = true;
      deliveryFinalizer = finalize;
      if (state === "terminating") {
        settleDelivery();
      } else if (state === "completed") {
        finalizeDelivery();
      }
      return {
        markDelivered,
        settle: settleDelivery,
      };
    },
    abort: async (terminalCause) => {
      const error = terminalCause === "total_timeout"
        ? new GatewayFailureError({ kind: "upstream_timeout", source: "gateway", phase: "stream" })
        : new GatewayFailureError({ kind: "aborted", source: "gateway", phase: "stream" });
      await finish(terminalCause, { kind: "failure", error });
    },
  };

  const produce = async (): Promise<void> => {
    try {
      if (!await resources.writer!.enqueue(firstWire)) {
        return;
      }
      await firstDelivery;
      if (barrier !== undefined) {
        return;
      }
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
          next.value.outcome.kind === "success" ? "semantic_success" : "postcommit_failure",
          next.value.outcome,
          next.value.writerMode,
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
  return { response, handle };
}
