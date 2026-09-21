import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { RequestAttempt } from "./request_attempt.js";
import type { RequestDiagnostics } from "../telemetry/diagnostics.js";

export interface RequestScope {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly deliverySignal: AbortSignal;
  readonly config: Readonly<RuntimeConfigSnapshot>;
  readonly attempt: RequestAttempt;
  readonly diagnostics?: RequestDiagnostics;
}

export function createRequestScope(
  requestId: string,
  signal: AbortSignal,
  deliverySignal: AbortSignal,
  config: Readonly<RuntimeConfigSnapshot>,
  attempt: RequestAttempt,
  diagnostics?: RequestDiagnostics,
): RequestScope {
  return { requestId, signal, deliverySignal, config, attempt, ...(diagnostics === undefined ? {} : { diagnostics }) };
}
