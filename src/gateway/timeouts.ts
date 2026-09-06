import { GatewayFailureError } from "./failures.js";

export interface TimeoutScheduler {
  readonly nowMs: () => number;
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function armTimeout(
  ms: number,
  signal: AbortSignal,
  scheduler: TimeoutScheduler,
  onTimeout: () => void,
): () => void {
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  let disarmed = false;
  scheduler.delay(ms, combined).then(
    () => {
      if (!disarmed && !signal.aborted) {
        onTimeout();
      }
    },
    (_error: unknown) => {
      // aborted or closed
    },
  );
  return () => {
    disarmed = true;
    if (!local.signal.aborted) {
      local.abort();
    }
  };
}

export function abortWithTimeout(controller: AbortController): void {
  if (!controller.signal.aborted) {
    controller.abort(new GatewayFailureError({
      kind: "upstream_timeout",
      source: "gateway",
      phase: "deadline",
    }));
  }
}
