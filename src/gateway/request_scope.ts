import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { RequestAttempt } from "./request_attempt.js";

export interface RequestScope {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly deliverySignal: AbortSignal;
  readonly config: Readonly<RuntimeConfigSnapshot>;
  readonly attempt: RequestAttempt;
}

export function createRequestScope(
  requestId: string,
  signal: AbortSignal,
  deliverySignal: AbortSignal,
  config: Readonly<RuntimeConfigSnapshot>,
  attempt: RequestAttempt,
): RequestScope {
  return { requestId, signal, deliverySignal, config, attempt };
}
