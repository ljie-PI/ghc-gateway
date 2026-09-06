const ALLOWLIST = new Set([
  "protocol",
  "metric",
  "thresholdms",
  "actualms",
  "status",
  "reason",
  "outcome",
]);

const EVENT_KEYS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  gateway_started: {
    status: fixedString(["ready", "started"]),
    protocol: fixedString(["openai_chat", "openai_responses_unknown", "openai_responses_native", "openai_responses_bridge", "anthropic", "ollama"]),
  },
  gateway_stopped: {},
  request_failed: {
    requestId: safeRequestId,
    protocol: fixedString(["openai_chat", "openai_responses_unknown", "openai_responses_native", "openai_responses_bridge", "anthropic", "ollama"]),
    status: httpStatus,
    category: fixedString(["invalid_request", "unsupported_semantics", "authentication", "model_not_found", "upstream_error", "upstream_http", "upstream_timeout", "upstream_network", "invalid_upstream_response", "upstream_stream_truncated", "aborted", "internal"]),
    outcome: fixedString(["success", "client_error", "authentication_error", "overloaded", "upstream_error", "timeout", "aborted", "internal_error"]),
  },
  account_authenticated: { accountId: safeAccountId },
  account_removed: { accountId: safeAccountId },
  default_account_changed: { accountId: safeAccountId, revision: nonnegativeInteger },
  preferred_model_changed: { accountId: safeAccountId, revision: nonnegativeInteger },
  runtime_config_changed: { revision: nonnegativeInteger },
  catalog_refreshed: { accountId: safeAccountId, count: nonnegativeInteger },
  performance_degraded: performanceMetadata(),
  performance_recovered: performanceMetadata(),
  telemetry_dropped: {
    droppedUsageUpdates: nonnegativeInteger,
    droppedOperationalEvents: nonnegativeInteger,
  },
  metadata_rejected: { reason: fixedString(["metadata_rejected"]) },
  daemon_start_failed: { category: fixedString(["readiness_timeout", "spawn_failed", "identity_failed"]) },
};

export const METADATA_LIMIT_BYTES = 16 * 1024;
export const LOG_LINE_LIMIT_BYTES = 64 * 1024;

export function sanitizeMetadata(input: unknown): Record<string, string | number | boolean> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (!ALLOWLIST.has(normalized)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

export function sanitizeOperationalEventMetadata(
  kind: string,
  input: unknown,
): Record<string, string | number | boolean> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const validators = EVENT_KEYS[kind];
  if (validators === undefined) {
    return {};
  }
  const source = input as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, validate] of Object.entries(validators)) {
    const value = source[key];
    if (validate(value) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      result[key] = value;
    }
  }
  return result;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function metadataJsonOrRejected(metadata: Record<string, string | number | boolean>): {
  readonly json: string;
  readonly kind: string;
} {
  const json = JSON.stringify(metadata);
  if (utf8Bytes(json) <= METADATA_LIMIT_BYTES) {
    return { json, kind: "ok" };
  }
  return { json: JSON.stringify({ reason: "metadata_rejected" }), kind: "metadata_rejected" };
}

function fixedString(values: readonly string[]): (value: unknown) => boolean {
  const allowed = new Set(values);
  return (value) => typeof value === "string" && allowed.has(value);
}

function safeRequestId(value: unknown): boolean {
  return typeof value === "string" && /^req_[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function safeAccountId(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9.-]+(?::[0-9]+)?\/[1-9][0-9]*$/u.test(value);
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function httpStatus(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function nonnegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function performanceMetadata(): Readonly<Record<string, (value: unknown) => boolean>> {
  return {
    metric: fixedString(["buffered_p95_ms", "stream_event_p95_ms", "checkpoint_p95_ms", "event_loop_p95_ms"]),
    status: fixedString(["healthy", "degraded"]),
    actualMs: nonnegativeFinite,
    thresholdMs: nonnegativeFinite,
  };
}
