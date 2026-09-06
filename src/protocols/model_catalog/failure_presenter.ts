import {
  defaultFailureStatus,
  safeFailureMessage,
  safeRetryAfter,
  type GatewayFailure,
} from "../../gateway/failures.js";
import { anthropicErrorBody, type AnthropicErrorType } from "../anthropic_messages/wire.js";
import { serializeOpenAiModelsError } from "./wire.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function presentModelCatalogFailure(
  failure: Readonly<GatewayFailure>,
  requestId: string,
  request: Request,
): Response {
  const status = defaultFailureStatus(failure);
  const anthropic = request.headers.has("anthropic-version");
  const headers = new Headers({
    ...JSON_HEADERS,
    [anthropic ? "request-id" : "x-request-id"]: requestId,
  });
  const retryAfter = failure.kind === "upstream_http" && failure.status === 429
    ? safeRetryAfter(failure.retryAfter)
    : undefined;
  if (retryAfter !== undefined) {
    headers.set("retry-after", retryAfter);
  }
  const body = anthropic
    ? anthropicErrorBody(anthropicErrorType(status), safeFailureMessage(failure), requestId)
    : serializeOpenAiModelsError(status);
  return new Response(body, { status, headers });
}

function anthropicErrorType(status: number): AnthropicErrorType {
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
  if (status === 504) {
    return "timeout_error";
  }
  return "api_error";
}
