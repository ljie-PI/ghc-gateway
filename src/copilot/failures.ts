import { AccountDirectoryError } from "../accounts/account_directory.js";
import {
  failureFromSignal,
  failureFromUnknown,
  failureWithOrigin,
  GatewayFailureError,
  isGatewayFailureError,
  safeRetryAfter,
  type GatewayFailureOrigin,
} from "../gateway/failures.js";
import { ChatSseError } from "./chat_sse.js";
import type { ChatStreamFrame } from "../protocols/chat_completions/types.js";
import { CapiFetchError } from "./models_source.js";
import { TokenRefreshError } from "./token_refresh.js";
import {
  InvalidUpstreamResponseError,
  mapTokenRefreshError,
  UpstreamBodyLimitError,
  UpstreamTimeoutError,
} from "./transport.js";
import { InferencePoolAcquireTimeoutError } from "./inference_pool.js";

const ACCOUNT_BIND_ORIGIN = { source: "account", phase: "bind" } as const;
const CATALOG_ORIGIN = { source: "catalog", phase: "discover" } as const;
const CREDENTIAL_ORIGIN = { source: "credential", phase: "refresh" } as const;

export function normalizeAccountBindingFailure(error: unknown): GatewayFailureError {
  if (isGatewayFailureError(error)) {
    return new GatewayFailureError(failureWithOrigin(error.failure, ACCOUNT_BIND_ORIGIN));
  }
  if (error instanceof AccountDirectoryError && (error.code === "no_default" || error.code === "not_found")) {
    return new GatewayFailureError({ kind: "authentication", ...ACCOUNT_BIND_ORIGIN, cause: error });
  }
  return new GatewayFailureError(failureFromUnknown(error, ACCOUNT_BIND_ORIGIN));
}

export function normalizeCatalogFailure(error: unknown, signal: AbortSignal): GatewayFailureError {
  if (isGatewayFailureError(error)) {
    return new GatewayFailureError(failureWithOrigin(error.failure, CATALOG_ORIGIN));
  }
  if (error instanceof TokenRefreshError) {
    return tokenRefreshFailure(error);
  }
  if (error instanceof CapiFetchError) {
    if (error.failureKind === "upstream_http") {
      const retryAfter = error.status === 429 ? safeRetryAfter(error.retryAfter) : undefined;
      return new GatewayFailureError({
        kind: "upstream_http",
        status: error.status,
        ...CATALOG_ORIGIN,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    return new GatewayFailureError({
      kind: error.failureKind,
      ...CATALOG_ORIGIN,
      cause: error,
    });
  }
  if (isAbortError(error)) {
    return new GatewayFailureError(failureFromSignal(signal, CATALOG_ORIGIN));
  }
  return new GatewayFailureError({
    kind: "internal",
    source: "gateway",
    phase: "internal",
    cause: error,
  });
}

export function normalizeCopilotBindingFailure(error: unknown, signal: AbortSignal): GatewayFailureError {
  if (isGatewayFailureError(error)) {
    return new GatewayFailureError(failureWithOrigin(error.failure, CREDENTIAL_ORIGIN));
  }
  if (error instanceof TokenRefreshError) {
    return tokenRefreshFailure(error);
  }
  if (isAbortError(error)) {
    return new GatewayFailureError(failureFromSignal(signal, CREDENTIAL_ORIGIN));
  }
  const transport = recognizedTransportFailure(error);
  if (transport !== undefined) {
    return new GatewayFailureError({
      kind: transport,
      source: "transport",
      phase: "connect",
      ...(transport === "aborted" ? {} : { cause: error }),
    });
  }
  return new GatewayFailureError({
    kind: "internal",
    source: "gateway",
    phase: "internal",
    cause: error,
  });
}

export function normalizeTransportFailure(
  error: unknown,
  signal: AbortSignal,
  origin: Readonly<GatewayFailureOrigin>,
): GatewayFailureError {
  if (isGatewayFailureError(error)) {
    return new GatewayFailureError(failureWithOrigin(error.failure, origin));
  }
  if (isAbortError(error)) {
    return new GatewayFailureError(failureFromSignal(signal, origin));
  }
  const kind = recognizedTransportFailure(error);
  if (kind === undefined) {
    return new GatewayFailureError({
      kind: "internal",
      source: "gateway",
      phase: "internal",
      cause: error,
    });
  }
  return new GatewayFailureError({
    kind,
    ...origin,
    ...(kind === "aborted" ? {} : { cause: error }),
  });
}

export function normalizeChatStreamFailure(
  error: unknown,
  signal: AbortSignal,
  phase: "stream" | "parse" = "parse",
): GatewayFailureError {
  const origin = { source: "parser", phase } as const;
  if (isGatewayFailureError(error)) {
    return new GatewayFailureError(failureWithOrigin(error.failure, origin));
  }
  if (isAbortError(error)) {
    return new GatewayFailureError(failureFromSignal(signal, origin));
  }
  if (error instanceof ChatSseError) {
    const kind = error.code === "truncated" ? "upstream_stream_truncated" : "invalid_upstream_response";
    return new GatewayFailureError({ kind, ...origin, cause: error });
  }
  const transport = recognizedTransportFailure(error);
  if (transport !== undefined) {
    return new GatewayFailureError({
      kind: transport,
      source: "transport",
      phase: "stream",
      ...(transport === "aborted" ? {} : { cause: error }),
    });
  }
  return new GatewayFailureError({
    kind: "internal",
    source: "gateway",
    phase: "internal",
    cause: error,
  });
}

export function upstreamStreamEventFailure(): GatewayFailureError {
  return new GatewayFailureError({
    kind: "upstream_stream_error",
    source: "parser",
    phase: "stream",
  });
}

export async function* normalizeChatFrames(
  frames: AsyncIterable<ChatStreamFrame>,
  signal: AbortSignal,
): AsyncIterable<ChatStreamFrame> {
  try {
    yield* frames;
  } catch (error: unknown) {
    throw normalizeChatStreamFailure(error, signal);
  }
}

function tokenRefreshFailure(error: TokenRefreshError): GatewayFailureError {
  return new GatewayFailureError({
    kind: mapTokenRefreshError(error),
    ...CREDENTIAL_ORIGIN,
    cause: error,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function recognizedTransportFailure(
  error: unknown,
): "aborted" | "invalid_upstream_response" | "upstream_timeout" | "upstream_network" | undefined {
  if (isAbortError(error)) {
    return "aborted";
  }
  if (error instanceof UpstreamBodyLimitError || error instanceof InvalidUpstreamResponseError) {
    return "invalid_upstream_response";
  }
  if (error instanceof UpstreamTimeoutError || error instanceof InferencePoolAcquireTimeoutError) {
    return "upstream_timeout";
  }
  if (error instanceof TypeError || hasNetworkErrorCode(error)) {
    return "upstream_network";
  }
  return undefined;
}

function hasNetworkErrorCode(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string"
    && /^(?:UND_ERR_|ECONN|ENET|EHOST|EAI_)/u.test(code);
}
