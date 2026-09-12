import {
  failureFromSignal,
  GatewayFailureError,
  type GatewayFailureOrigin,
} from "./failures.js";
import type { UpstreamByteStream } from "../copilot/upstream_types.js";

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
  | {
    readonly kind: "terminal";
    readonly outcome: Readonly<
      | { readonly kind: "success"; readonly value: T }
      | { readonly kind: "failure"; readonly error: unknown }
    >;
    readonly writerMode: "close" | "abort";
  };

export interface StreamExecutionDelivery {
  markDelivered(): void;
  settle(): void;
}

export interface StreamExecutionHandle {
  readonly state: StreamExecutionState;
  readonly cause: StreamExecutionTerminalCause | undefined;
  readonly completion: Promise<void>;
  claimDeliveryAdapter(finalize: () => void): StreamExecutionDelivery;
  abort(cause: "shutdown" | "request_abort" | "total_timeout"): Promise<void>;
}

export interface CreateStreamExecutionResponseInput<T> {
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
}

const executionHandles = new WeakMap<Response, StreamExecutionHandle>();

export function getStreamExecutionHandle(response: Response): StreamExecutionHandle | undefined {
  return executionHandles.get(response);
}

export async function createStreamExecutionResponse<T>(
  input: CreateStreamExecutionResponseInput<T>,
): Promise<Response> {
  const owner = await (async () => {
    try {
      return await import("./stream_execution_owner.js");
    } catch (error: unknown) {
      await boundedCleanup(
        Promise.resolve().then(async () => await input.upstream.cancel()),
        input.cleanupTimeoutMs ?? 1_000,
      );
      throw error;
    }
  })();

  const result = await owner.createStreamExecutionResponseOwner(input, {
    boundedCleanup,
    nextWithDeadline,
  });
  executionHandles.set(result.response, result.handle);
  return result.response;
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
