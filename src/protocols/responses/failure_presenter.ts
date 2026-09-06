import {
  defaultFailureStatus,
  safeFailureMessage,
  safeRetryAfter,
  type GatewayFailure,
} from "../../gateway/failures.js";
import { RESPONSES_JSON_HEADERS, serializeResponsesErrorBody } from "./wire.js";

export function presentResponsesFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const status = defaultFailureStatus(failure);
  const headers = new Headers({ ...RESPONSES_JSON_HEADERS, "x-request-id": requestId });
  const retryAfter = failure.kind === "upstream_http" && failure.status === 429
    ? safeRetryAfter(failure.retryAfter)
    : undefined;
  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(serializeResponsesErrorBody(safeFailureMessage(failure), errorTypeForStatus(status)), {
    status,
    headers,
  });
}

function errorTypeForStatus(status: number): string {
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 403) {
    return "permission_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  return status === 400 || status === 409 || status === 413 || status === 415 || status === 422
    ? "invalid_request_error"
    : "api_error";
}
