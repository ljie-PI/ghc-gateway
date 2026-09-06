import {
  failureFromSignal,
  GatewayFailureError,
  type GatewayFailureOrigin,
} from "./failures.js";
import type { UpstreamByteStream } from "../copilot/upstream_types.js";

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

export async function cleanupOwnedStream(
  upstream: UpstreamByteStream,
  iterator?: AsyncIterator<unknown>,
  timeoutMs = 1_000,
): Promise<void> {
  await createOwnedStreamCleanup(upstream, iterator, timeoutMs)();
}

export function createOwnedStreamCleanup(
  upstream: UpstreamByteStream,
  iterator?: AsyncIterator<unknown>,
  timeoutMs = 1_000,
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return async () => {
    cleanup ??= (async () => {
      await boundedCleanup(upstream.cancel(), timeoutMs);
      if (iterator?.return !== undefined) {
        await boundedCleanup(iterator.return(), timeoutMs);
      }
    })();
    await cleanup;
  };
}

export async function* withByteIdleDeadlines(
  source: AsyncIterable<Uint8Array>,
  upstream: UpstreamByteStream,
  signal: AbortSignal,
  firstByteMs: number,
  idleMs: number,
): AsyncIterable<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const cleanup = createOwnedStreamCleanup(upstream, iterator);
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
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError && error.failure.kind === "upstream_timeout") {
      void cleanup();
    }
    throw error;
  } finally {
    void cleanup();
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
