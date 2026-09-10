import type { SqliteDatabase } from "../persistence/sqlite.js";
import type { PerformanceEvaluation, PerformanceSnapshot } from "./performance.js";
import { EVENT_ROW_CAP, type RecordedOperationalEvent, type TelemetryOutcome, type TelemetryProtocol } from "./recorder.js";
import type { TelemetryRecorder } from "./recorder.js";
import { sanitizeOperationalEventMetadata } from "./sanitize.js";

const PROTOCOLS: ReadonlySet<string> = new Set([
  "openai_chat",
  "openai_responses_unknown",
  "openai_responses_native",
  "openai_responses_bridge",
  "anthropic",
]);
const OUTCOMES: ReadonlySet<string> = new Set([
  "success",
  "client_error",
  "authentication_error",
  "overloaded",
  "upstream_error",
  "timeout",
  "aborted",
  "internal_error",
]);
const EVENT_KINDS: ReadonlySet<string> = new Set([
  "gateway_started",
  "gateway_stopped",
  "request_failed",
  "account_authenticated",
  "account_removed",
  "default_account_changed",
  "preferred_model_changed",
  "runtime_config_changed",
  "catalog_refreshed",
  "performance_degraded",
  "performance_recovered",
  "telemetry_dropped",
  "metadata_rejected",
  "daemon_start_failed",
]);
// A batch stays below 1 MiB even when every retained event is near the 16 KiB metadata cap.
export const ADMIN_EVENT_REPLAY_BATCH_SIZE = 32;

export type AdminOperationalEventKind = RecordedOperationalEvent["kind"];

export class AdminTelemetryError extends Error {
  readonly code = "validation_failed";

  constructor() {
    super("validation failed");
    this.name = "AdminTelemetryError";
  }
}

export interface AdminUsageQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
  readonly cursor: string | null;
  readonly accountId?: string;
  readonly protocol?: TelemetryProtocol;
  readonly resolvedModel?: string;
  readonly outcome?: TelemetryOutcome;
}

export interface AdminEventQuery {
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly limit: number;
  readonly cursor: string | null;
  readonly kind?: AdminOperationalEventKind;
  readonly severity?: "info" | "warning" | "error";
}

export interface AdminUsageBucket {
  readonly utcHour: string;
  readonly accountId: string;
  readonly protocol: TelemetryProtocol;
  readonly resolvedModel: string;
  readonly outcome: TelemetryOutcome;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly latencySumMs: number;
  readonly latencyMaxMs: number;
}

export interface AdminUsageTotals {
  readonly requestCount: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly latencySumMs: number;
  readonly latencyMaxMs: number;
}

export interface AdminUsagePage {
  readonly items: readonly AdminUsageBucket[];
  readonly nextCursor: string | null;
  readonly totals: AdminUsageTotals;
}

export interface AdminOperationalEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly kind: AdminOperationalEventKind;
  readonly severity: "info" | "warning" | "error";
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type AdminEventPage = AdminPage<AdminOperationalEvent>;

export interface AdminEventReplay {
  readonly found: boolean;
  readonly latestEventId: string | null;
  readonly items: readonly AdminOperationalEvent[];
}

export interface AdminTelemetrySnapshot {
  readonly storage: {
    readonly usageBucketCount: number;
    readonly eventCount: number;
  };
  readonly pendingMutations: number;
  readonly droppedUsageUpdates: number;
  readonly droppedOperationalEvents: number;
  readonly performance: PerformanceSnapshot;
}

export type AdminMonitorEvent =
  | { readonly kind: "operational"; readonly event: AdminOperationalEvent }
  | {
    readonly kind: "performance";
    readonly transition: "enter" | "clear";
    readonly snapshot: PerformanceSnapshot;
  };

export interface AdminTelemetry {
  queryUsage(query: Readonly<AdminUsageQuery>, signal: AbortSignal): Promise<AdminUsagePage>;
  queryEvents(query: Readonly<AdminEventQuery>, signal: AbortSignal): Promise<AdminEventPage>;
  replayEvents(afterEventId: string, signal: AbortSignal): Promise<AdminEventReplay>;
  snapshot(): AdminTelemetrySnapshot;
  subscribe(listener: (event: Readonly<AdminMonitorEvent>) => void): () => void;
}

export interface SqliteAdminTelemetryOptions {
  readonly recorder?: Pick<TelemetryRecorder, "pendingCount" | "droppedCounters">;
  readonly performance?: () => PerformanceSnapshot;
}

interface UsageRow {
  readonly utc_hour_ms: number;
  readonly account_id: string;
  readonly protocol: TelemetryProtocol;
  readonly resolved_model: string;
  readonly outcome: TelemetryOutcome;
  readonly request_count: number;
  readonly error_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_tokens: number;
  readonly latency_sum_ms: number;
  readonly latency_max_ms: number;
}

interface UsageTotalsRow {
  readonly request_count: number;
  readonly error_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_tokens: number;
  readonly latency_sum_ms: number;
  readonly latency_max_ms: number;
}

interface EventRow {
  readonly event_id: number;
  readonly occurred_at_ms: number;
  readonly kind: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata_json: string;
}

interface UsageCursor {
  readonly utcHourMs: number;
  readonly accountId: string;
  readonly protocol: TelemetryProtocol;
  readonly resolvedModel: string;
  readonly outcome: TelemetryOutcome;
}

export class SqliteAdminTelemetry implements AdminTelemetry {
  private readonly listeners = new Set<(event: Readonly<AdminMonitorEvent>) => void>();
  private latestPerformance: PerformanceSnapshot = emptyPerformanceSnapshot();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: Readonly<SqliteAdminTelemetryOptions> = {},
  ) {}

  async queryUsage(query: Readonly<AdminUsageQuery>, signal: AbortSignal): Promise<AdminUsagePage> {
    signal.throwIfAborted();
    validateUsageQuery(query);
    const cursor = query.cursor === null ? null : decodeUsageCursor(query.cursor);
    const where = ["utc_hour_ms >= ?", "utc_hour_ms < ?"];
    const params: Array<string | number> = [query.fromMs, query.toMs];
    addFilter(where, params, "account_id", query.accountId);
    addFilter(where, params, "protocol", query.protocol);
    addFilter(where, params, "resolved_model", query.resolvedModel);
    addFilter(where, params, "outcome", query.outcome);
    const totals = this.queryUsageTotals(where, params);
    if (cursor !== null) {
      where.push("(utc_hour_ms, account_id, protocol, resolved_model, outcome) > (?, ?, ?, ?, ?)");
      params.push(cursor.utcHourMs, cursor.accountId, cursor.protocol, cursor.resolvedModel, cursor.outcome);
    }
    const rows = this.database.prepare(
      `SELECT utc_hour_ms, account_id, protocol, resolved_model, outcome,
              request_count, error_count, input_tokens, output_tokens, cache_tokens,
              latency_sum_ms, latency_max_ms
       FROM usage_buckets
       WHERE ${where.join(" AND ")}
       ORDER BY utc_hour_ms, account_id, protocol, resolved_model, outcome
       LIMIT ?`,
    ).all(...params, query.limit + 1) as UsageRow[];
    signal.throwIfAborted();
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(usageDto),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeUsageCursor(last) : null,
      totals,
    };
  }

  async queryEvents(query: Readonly<AdminEventQuery>, signal: AbortSignal): Promise<AdminEventPage> {
    signal.throwIfAborted();
    validateEventQuery(query);
    const cursor = query.cursor === null ? null : decodeEventCursor(query.cursor);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.fromMs !== null) {
      where.push("occurred_at_ms >= ?");
      params.push(query.fromMs);
    }
    if (query.toMs !== null) {
      where.push("occurred_at_ms < ?");
      params.push(query.toMs);
    }
    addFilter(where, params, "kind", query.kind);
    addFilter(where, params, "severity", query.severity);
    if (cursor !== null) {
      where.push("event_id > ?");
      params.push(cursor);
    }
    const limit = Math.min(query.limit, EVENT_ROW_CAP);
    const rows = this.database.prepare(
      `SELECT event_id, occurred_at_ms, kind, severity, metadata_json
       FROM operational_events
       WHERE ${where.length === 0 ? "1 = 1" : where.join(" AND ")}
       ORDER BY event_id
       LIMIT ?`,
    ).all(...params, limit + 1) as EventRow[];
    signal.throwIfAborted();
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(eventDto),
      nextCursor: rows.length > limit && last !== undefined ? encodeEventCursor(last.event_id) : null,
    };
  }

  async replayEvents(afterEventId: string, signal: AbortSignal): Promise<AdminEventReplay> {
    signal.throwIfAborted();
    const eventId = decimalEventId(afterEventId);
    const latest = this.latestEventId();
    const found = this.database.prepare("SELECT 1 FROM operational_events WHERE event_id = ?").get(eventId) !== undefined;
    if (!found) {
      return { found: false, latestEventId: latest, items: [] };
    }
    const rows = this.database.prepare(
      `SELECT event_id, occurred_at_ms, kind, severity, metadata_json
       FROM operational_events
       WHERE event_id > ?
       ORDER BY event_id
       LIMIT ?`,
    ).all(eventId, ADMIN_EVENT_REPLAY_BATCH_SIZE) as EventRow[];
    signal.throwIfAborted();
    return { found: true, latestEventId: latest, items: rows.map(eventDto) };
  }

  snapshot(): AdminTelemetrySnapshot {
    const storage = this.storageCounts();
    const drops = this.options.recorder?.droppedCounters() ?? this.persistedDrops();
    return {
      storage,
      pendingMutations: this.options.recorder?.pendingCount() ?? 0,
      droppedUsageUpdates: drops.droppedUsageUpdates,
      droppedOperationalEvents: drops.droppedOperationalEvents,
      performance: this.options.performance?.() ?? this.latestPerformance,
    };
  }

  subscribe(listener: (event: Readonly<AdminMonitorEvent>) => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (subscribed) {
        subscribed = false;
        this.listeners.delete(listener);
      }
    };
  }

  observeOperationalEvent(event: Readonly<RecordedOperationalEvent>): void {
    this.publish({ kind: "operational", event: recordedEventDto(event) });
  }

  observePerformance(evaluation: Readonly<PerformanceEvaluation>): void {
    this.latestPerformance = evaluation.snapshot;
    if (evaluation.transition !== null) {
      this.publish({
        kind: "performance",
        transition: evaluation.transition,
        snapshot: evaluation.snapshot,
      });
    }
  }

  private queryUsageTotals(where: readonly string[], params: readonly (string | number)[]): AdminUsageTotals {
    const row = this.database.prepare(
      `SELECT COALESCE(SUM(request_count), 0) AS request_count,
              COALESCE(SUM(error_count), 0) AS error_count,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_tokens), 0) AS cache_tokens,
              COALESCE(SUM(latency_sum_ms), 0) AS latency_sum_ms,
              COALESCE(MAX(latency_max_ms), 0) AS latency_max_ms
       FROM usage_buckets
       WHERE ${where.join(" AND ")}`,
    ).get(...params) as UsageTotalsRow;
    return {
      requestCount: row.request_count,
      errorCount: row.error_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens,
      latencySumMs: row.latency_sum_ms,
      latencyMaxMs: row.latency_max_ms,
    };
  }

  private storageCounts(): AdminTelemetrySnapshot["storage"] {
    const usage = this.database.prepare("SELECT COUNT(*) AS count FROM usage_buckets").get() as { count: number };
    const events = this.database.prepare("SELECT COUNT(*) AS count FROM operational_events").get() as { count: number };
    return { usageBucketCount: usage.count, eventCount: events.count };
  }

  private persistedDrops(): Pick<AdminTelemetrySnapshot, "droppedUsageUpdates" | "droppedOperationalEvents"> {
    const row = this.database.prepare(
      "SELECT dropped_usage_updates, dropped_operational_events FROM telemetry_state WHERE singleton_id = 1",
    ).get() as { dropped_usage_updates: number; dropped_operational_events: number };
    return {
      droppedUsageUpdates: row.dropped_usage_updates,
      droppedOperationalEvents: row.dropped_operational_events,
    };
  }

  private latestEventId(): string | null {
    const row = this.database.prepare("SELECT MAX(event_id) AS event_id FROM operational_events").get() as {
      event_id: number | null;
    };
    return row.event_id === null ? null : String(row.event_id);
  }

  private publish(event: Readonly<AdminMonitorEvent>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One in-process subscriber cannot prevent delivery to the others.
      }
    }
  }
}

function validateUsageQuery(query: Readonly<AdminUsageQuery>): void {
  if (!validMs(query.fromMs) || !validMs(query.toMs) || query.fromMs >= query.toMs || !validLimit(query.limit)) {
    throw new AdminTelemetryError();
  }
  if (query.protocol !== undefined && !PROTOCOLS.has(query.protocol)) {
    throw new AdminTelemetryError();
  }
  if (query.outcome !== undefined && !OUTCOMES.has(query.outcome)) {
    throw new AdminTelemetryError();
  }
}

function validateEventQuery(query: Readonly<AdminEventQuery>): void {
  if ((query.fromMs !== null && !validMs(query.fromMs))
    || (query.toMs !== null && !validMs(query.toMs))
    || (query.fromMs !== null && query.toMs !== null && query.fromMs >= query.toMs)
    || !validLimit(query.limit)) {
    throw new AdminTelemetryError();
  }
  if (query.kind !== undefined && !EVENT_KINDS.has(query.kind)) {
    throw new AdminTelemetryError();
  }
}

function validMs(value: number): boolean {
  return Number.isSafeInteger(value);
}

function validLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 500;
}

function addFilter(
  where: string[],
  params: Array<string | number>,
  column: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    where.push(`${column} = ?`);
    params.push(value);
  }
}

function usageDto(row: UsageRow): AdminUsageBucket {
  return {
    utcHour: new Date(row.utc_hour_ms).toISOString(),
    accountId: row.account_id,
    protocol: row.protocol,
    resolvedModel: row.resolved_model,
    outcome: row.outcome,
    requestCount: row.request_count,
    errorCount: row.error_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    latencySumMs: row.latency_sum_ms,
    latencyMaxMs: row.latency_max_ms,
  };
}

function eventDto(row: EventRow): AdminOperationalEvent {
  const kind = row.kind;
  if (!EVENT_KINDS.has(kind)) {
    throw new Error("invalid operational event kind");
  }
  return {
    eventId: String(row.event_id),
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    kind: kind as AdminOperationalEventKind,
    severity: row.severity,
    metadata: sanitizeEventMetadata(kind, parseMetadata(row.metadata_json)),
  };
}

function recordedEventDto(event: Readonly<RecordedOperationalEvent>): AdminOperationalEvent {
  return {
    eventId: event.eventId,
    occurredAt: new Date(event.occurredAtMs).toISOString(),
    kind: event.kind,
    severity: event.severity,
    metadata: sanitizeEventMetadata(event.kind, event.metadata),
  };
}

function parseMetadata(json: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sanitizeEventMetadata(
  kind: string,
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean | null>> {
  return sanitizeOperationalEventMetadata(kind, metadata);
}

function encodeUsageCursor(row: UsageRow): string {
  return encodeCursor(["usage", 1, row.utc_hour_ms, row.account_id, row.protocol, row.resolved_model, row.outcome]);
}

function decodeUsageCursor(cursor: string): UsageCursor {
  const parsed = decodeCursor(cursor);
  if (!Array.isArray(parsed) || parsed.length !== 7 || parsed[0] !== "usage" || parsed[1] !== 1) {
    throw new AdminTelemetryError();
  }
  const [, , utcHourMs, accountId, protocol, resolvedModel, outcome] = parsed;
  if (!Number.isSafeInteger(utcHourMs) || typeof accountId !== "string" || typeof protocol !== "string"
    || !PROTOCOLS.has(protocol) || typeof resolvedModel !== "string" || typeof outcome !== "string"
    || !OUTCOMES.has(outcome)) {
    throw new AdminTelemetryError();
  }
  return {
    utcHourMs: utcHourMs as number,
    accountId,
    protocol: protocol as TelemetryProtocol,
    resolvedModel,
    outcome: outcome as TelemetryOutcome,
  };
}

function encodeEventCursor(eventId: number): string {
  return encodeCursor(["event", 1, String(eventId)]);
}

function decodeEventCursor(cursor: string): number {
  const parsed = decodeCursor(cursor);
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== "event" || parsed[1] !== 1
    || typeof parsed[2] !== "string") {
    throw new AdminTelemetryError();
  }
  return decimalEventId(parsed[2]);
}

function encodeCursor(value: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): unknown {
  try {
    if (cursor.length === 0 || cursor.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new AdminTelemetryError();
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new AdminTelemetryError();
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof AdminTelemetryError) {
      throw error;
    }
    throw new AdminTelemetryError();
  }
}

function decimalEventId(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new AdminTelemetryError();
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new AdminTelemetryError();
  }
  return result;
}

function emptyPerformanceSnapshot(): PerformanceSnapshot {
  return {
    status: "healthy",
    startedAtMs: null,
    metrics: {
      bufferedMs: { p95: null, status: "insufficient_data", samples: 0 },
      eventMs: { p95: null, status: "insufficient_data", samples: 0 },
      checkpointMs: { p95: null, status: "insufficient_data", samples: 0 },
      eventLoopMs: { p95: null, status: "insufficient_data", samples: 0 },
    },
  };
}
