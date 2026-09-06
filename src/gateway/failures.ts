export type GatewayFailureSource =
  | "request"
  | "account"
  | "credential"
  | "catalog"
  | "transport"
  | "parser"
  | "converter"
  | "continuation"
  | "gateway";

export type GatewayFailurePhase =
  | "decode"
  | "bind"
  | "refresh"
  | "discover"
  | "connect"
  | "headers"
  | "body"
  | "stream"
  | "parse"
  | "convert"
  | "resume"
  | "admission"
  | "deadline"
  | "internal";

export interface GatewayFailureOrigin {
  readonly source: GatewayFailureSource;
  readonly phase: GatewayFailurePhase;
}

interface GatewayFailureDetails {
  readonly source?: GatewayFailureSource;
  readonly phase?: GatewayFailurePhase;
  readonly cause?: unknown;
}

export type GatewayFailure =
  | ({ readonly kind: "invalid_request" } & GatewayFailureDetails)
  | ({ readonly kind: "body_too_large" } & GatewayFailureDetails)
  | ({ readonly kind: "unsupported_media_type" } & GatewayFailureDetails)
  | ({ readonly kind: "unsupported_semantics" } & GatewayFailureDetails)
  | ({ readonly kind: "authentication" } & GatewayFailureDetails)
  | ({ readonly kind: "permission" } & GatewayFailureDetails)
  | ({ readonly kind: "model_not_found" } & GatewayFailureDetails)
  | ({ readonly kind: "queue_full" } & GatewayFailureDetails)
  | ({ readonly kind: "queue_timeout" } & GatewayFailureDetails)
  | ({
    readonly kind: "upstream_http";
    readonly status: number;
    readonly retryAfter?: string;
  } & GatewayFailureDetails)
  | ({ readonly kind: "upstream_timeout" } & GatewayFailureDetails)
  | ({ readonly kind: "upstream_network" } & GatewayFailureDetails)
  | ({ readonly kind: "upstream_stream_error" } & GatewayFailureDetails)
  | ({ readonly kind: "upstream_stream_truncated" } & GatewayFailureDetails)
  | ({ readonly kind: "invalid_upstream_response" } & GatewayFailureDetails)
  | ({ readonly kind: "invalid_tool_arguments" } & GatewayFailureDetails)
  | ({ readonly kind: "invalid_logprobs" } & GatewayFailureDetails)
  | ({ readonly kind: "aborted" } & GatewayFailureDetails)
  | ({ readonly kind: "internal" } & GatewayFailureDetails);

export type GatewayFailureOutcome =
  | "client_error"
  | "authentication_error"
  | "overloaded"
  | "upstream_error"
  | "timeout"
  | "aborted"
  | "internal_error";

type StaticGatewayFailureKind = Exclude<GatewayFailure["kind"], "upstream_http">;

interface GatewayFailurePolicy {
  readonly status: number;
  readonly message: string;
  readonly outcome: GatewayFailureOutcome;
}

const FAILURE_POLICY: Readonly<Record<StaticGatewayFailureKind, GatewayFailurePolicy>> = {
  invalid_request: { status: 400, message: "invalid request", outcome: "client_error" },
  body_too_large: { status: 413, message: "request body too large", outcome: "client_error" },
  unsupported_media_type: { status: 415, message: "unsupported media type", outcome: "client_error" },
  unsupported_semantics: { status: 422, message: "unsupported semantics", outcome: "client_error" },
  authentication: { status: 401, message: "authentication failed", outcome: "authentication_error" },
  permission: { status: 403, message: "permission denied", outcome: "authentication_error" },
  model_not_found: { status: 404, message: "model not found", outcome: "client_error" },
  queue_full: { status: 503, message: "server overloaded", outcome: "overloaded" },
  queue_timeout: { status: 503, message: "server overloaded", outcome: "overloaded" },
  upstream_timeout: { status: 504, message: "upstream timeout", outcome: "timeout" },
  upstream_network: { status: 502, message: "upstream request failed", outcome: "upstream_error" },
  upstream_stream_error: { status: 502, message: "upstream request failed", outcome: "upstream_error" },
  upstream_stream_truncated: { status: 502, message: "upstream request failed", outcome: "upstream_error" },
  invalid_upstream_response: { status: 502, message: "invalid upstream response", outcome: "upstream_error" },
  invalid_tool_arguments: { status: 502, message: "invalid upstream response", outcome: "upstream_error" },
  invalid_logprobs: { status: 502, message: "invalid upstream response", outcome: "upstream_error" },
  aborted: { status: 500, message: "internal error", outcome: "aborted" },
  internal: { status: 500, message: "internal error", outcome: "internal_error" },
};

export class GatewayFailureError extends Error {
  constructor(readonly failure: GatewayFailure) {
    super(failure.kind);
    this.name = "GatewayFailureError";
  }
}

export function isGatewayFailureError(error: unknown): error is GatewayFailureError {
  return error instanceof GatewayFailureError;
}

export function failureWithOrigin(
  failure: Readonly<GatewayFailure>,
  origin: Readonly<GatewayFailureOrigin>,
): GatewayFailure {
  if (failure.source !== undefined && failure.phase !== undefined) {
    return failure;
  }
  return {
    ...failure,
    source: failure.source ?? origin.source,
    phase: failure.phase ?? origin.phase,
  };
}

export function failureFromSignal(
  signal: AbortSignal,
  origin: Readonly<GatewayFailureOrigin>,
): GatewayFailure {
  if (!signal.aborted) {
    return { kind: "internal", ...origin };
  }
  const reason = signal.reason;
  if (isGatewayFailureError(reason)) {
    return failureWithOrigin(reason.failure, origin);
  }
  return { kind: "aborted", ...origin };
}

export function failureFromUnknown(
  error: unknown,
  origin: Readonly<GatewayFailureOrigin> = { source: "gateway", phase: "internal" },
): GatewayFailure {
  if (isGatewayFailureError(error)) {
    return failureWithOrigin(error.failure, origin);
  }
  return { kind: "internal", ...origin, cause: error };
}

export function failureOutcome(failure: Readonly<GatewayFailure>): GatewayFailureOutcome {
  if (failure.kind === "upstream_http") {
    return "upstream_error";
  }
  return FAILURE_POLICY[failure.kind].outcome;
}

export function defaultFailureStatus(failure: Readonly<GatewayFailure>): number {
  if (failure.kind === "upstream_http") {
    return Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599
      ? failure.status
      : 502;
  }
  return FAILURE_POLICY[failure.kind].status;
}

export function safeFailureMessage(failure: Readonly<GatewayFailure>): string {
  if (failure.kind === "upstream_http") {
    return "upstream request failed";
  }
  return FAILURE_POLICY[failure.kind].message;
}

export function safeRetryAfter(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return value;
  }
  if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return undefined;
}
