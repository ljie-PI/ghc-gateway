import {
  defaultFailureStatus,
  safeFailureMessage,
  safeRetryAfter,
  type GatewayFailure,
} from "../../gateway/failures.js";
import { safeCapabilityFailureMessage } from "../../copilot/model_capabilities.js";
import { anthropicErrorBody, type AnthropicErrorType } from "./wire.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function presentAnthropicFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const status = anthropicStatus(failure);
  const headers = new Headers({ ...JSON_HEADERS, "request-id": requestId });
  const retryAfter = failure.kind === "upstream_http" && failure.status === 429
    ? safeRetryAfter(failure.retryAfter)
    : undefined;
  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(
    anthropicErrorBody(
      anthropicErrorType(status),
      safeCapabilityFailureMessage(
        failure.kind === "unsupported_semantics" ? failure.cause : undefined,
        safeFailureMessage(failure),
      ),
      requestId,
    ),
    { status, headers },
  );
}

function anthropicStatus(failure: Readonly<GatewayFailure>): number {
  if (failure.kind === "unsupported_semantics") {
    return 400;
  }
  if (failure.kind === "queue_full" || failure.kind === "queue_timeout") {
    return 529;
  }
  return defaultFailureStatus(failure);
}

function anthropicErrorType(status: number): AnthropicErrorType {
  if (status === 400 || status === 415 || status === 422) {
    return "invalid_request_error";
  }
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 402) {
    return "billing_error";
  }
  if (status === 403) {
    return "permission_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 413) {
    return "request_too_large";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status === 504) {
    return "timeout_error";
  }
  if (status === 529) {
    return "overloaded_error";
  }
  return "api_error";
}
