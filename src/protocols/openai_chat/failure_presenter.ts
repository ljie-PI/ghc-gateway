import {
  defaultFailureStatus,
  safeFailureMessage,
  safeRetryAfter,
  type GatewayFailure,
} from "../../gateway/failures.js";
import { serializeOpenAiErrorBody } from "./wire.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function presentOpenAiChatFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const status = defaultFailureStatus(failure);
  const headers = new Headers({ ...JSON_HEADERS, "x-request-id": requestId });
  const retryAfter = failure.kind === "upstream_http" && failure.status === 429
    ? safeRetryAfter(failure.retryAfter)
    : undefined;
  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(serializeOpenAiErrorBody(safeFailureMessage(failure), errorTypeForStatus(status)), {
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
  if (status === 400 || status === 409 || status === 413 || status === 415 || status === 422) {
    return "invalid_request_error";
  }
  return "api_error";
}
