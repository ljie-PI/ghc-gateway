import type { SqliteDatabase } from "../persistence/sqlite.js";
import { metadataJsonOrRejected, sanitizeMetadata, sanitizeOperationalEventMetadata } from "./sanitize.js";

export const TELEMETRY_QUEUE_CAP = 1024;
export const USAGE_ROW_CAP = 100_000;
export const EVENT_ROW_CAP = 512;
export const USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type TelemetryProtocol =
  | "openai_chat"
  | "openai_responses_unknown"
  | "openai_responses_native"
  | "openai_responses_bridge"
  | "anthropic";

export type TelemetryOutcome =
  | "success"
  | "client_error"
  | "authentication_error"
  | "overloaded"
  | "upstream_error"
  | "timeout"
  | "aborted"
  | "internal_error";

export interface UsageUpdate {
  readonly occurredAtMs: number;
  readonly accountId: string;
  readonly protocol: TelemetryProtocol;
  readonly resolvedModel: string;
  readonly outcome: TelemetryOutcome;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly latencyMs: number;
}

export type OperationalEventKind =
  | "gateway_started"
  | "gateway_stopped"
  | "request_failed"
  | "account_authenticated"
  | "account_removed"
  | "default_account_changed"
  | "preferred_model_changed"
  | "runtime_config_changed"
  | "catalog_refreshed"
  | "performance_degraded"
  | "performance_recovered"
  | "telemetry_dropped"
  | "metadata_rejected"
  | "daemon_start_failed";

export interface OperationalEventInput {
  readonly occurredAtMs: number;
  readonly kind: OperationalEventKind;
  readonly severity: "info" | "warning" | "error";
  readonly metadata?: unknown;
}

export interface RecordedOperationalEvent {
  readonly eventId: string;
  readonly occurredAtMs: number;
  readonly kind: OperationalEventKind;
  readonly severity: "info" | "warning" | "error";
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export type TelemetryRecorderObserver = (event: Readonly<RecordedOperationalEvent>) => void;

interface PendingUsage {
  readonly type: "usage";
  readonly seq: number;
  key: string;
  update: UsageUpdate;
  latencySumMs: number;
  latencyMaxMs: number;
}

interface PendingEvent {
  readonly type: "event";
  readonly seq: number;
  event: OperationalEventInput;
  json: string;
  kind: OperationalEventKind;
  observerKind: OperationalEventKind;
  observerMetadata: Readonly<Record<string, string | number | boolean>>;
}

type Pending = PendingUsage | PendingEvent;

export class TelemetryRecorder {
  private readonly pending: Pending[] = [];
  private seq = 0;
  private droppedUsage = 0;
  private droppedEvents = 0;
  private observer: TelemetryRecorderObserver | undefined;
  private usageRetentionMs: number;
  private eventRetentionMs: number;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly nowMs: () => number = Date.now,
    private readonly usageRowCap = USAGE_ROW_CAP,
    private readonly eventRowCap = EVENT_ROW_CAP,
    private readonly queueCap = TELEMETRY_QUEUE_CAP,
    observer?: TelemetryRecorderObserver,
    usageRetentionDays = USAGE_RETENTION_MS / (24 * 60 * 60 * 1000),
    eventRetentionDays = EVENT_RETENTION_MS / (24 * 60 * 60 * 1000),
  ) {
    this.observer = observer;
    this.usageRetentionMs = usageRetentionDays * 24 * 60 * 60 * 1000;
    this.eventRetentionMs = eventRetentionDays * 24 * 60 * 60 * 1000;
    this.cleanup(this.nowMs());
  }

  setObserver(observer: TelemetryRecorderObserver | undefined): void {
    this.observer = observer;
  }

  setRetentionDays(usageRetentionDays: number, eventRetentionDays: number): void {
    this.usageRetentionMs = usageRetentionDays * 24 * 60 * 60 * 1000;
    this.eventRetentionMs = eventRetentionDays * 24 * 60 * 60 * 1000;
  }

  recordUsage(update: UsageUpdate): void {
    const key = usageKey(update);
    const existing = this.pending.find((item): item is PendingUsage => item.type === "usage" && item.key === key);
    if (existing !== undefined) {
      existing.update = mergeUsage(existing.update, update);
      existing.latencySumMs += update.latencyMs;
      existing.latencyMaxMs = Math.max(existing.latencyMaxMs, update.latencyMs);
      return;
    }
    if (this.pending.length >= this.queueCap) {
      const oldestUsage = this.pending.findIndex((item) => item.type === "usage");
      if (oldestUsage === -1) {
        this.droppedUsage = saturate(this.droppedUsage + update.requestCount);
        return;
      }
      const evicted = this.pending.splice(oldestUsage, 1)[0];
      if (evicted !== undefined && evicted.type === "usage") {
        this.droppedUsage = saturate(this.droppedUsage + evicted.update.requestCount);
      }
    }
    this.pending.push({
      type: "usage",
      seq: this.nextSeq(),
      key,
      update,
      latencySumMs: update.latencyMs,
      latencyMaxMs: update.latencyMs,
    });
  }

  recordEvent(input: OperationalEventInput): void {
    const requestedKind = input.kind;
    const encoded = metadataJsonOrRejected(sanitizeMetadata(input.metadata));
    const kind: OperationalEventKind = encoded.kind === "metadata_rejected"
      ? "metadata_rejected"
      : requestedKind;
    const event: OperationalEventInput = {
      occurredAtMs: input.occurredAtMs,
      kind,
      severity: input.severity,
    };
    if (this.pending.length >= this.queueCap) {
      const oldestEvent = this.pending.findIndex((item) => item.type === "event");
      if (oldestEvent === -1) {
        this.droppedEvents = saturate(this.droppedEvents + 1);
        return;
      }
      this.pending.splice(oldestEvent, 1);
      this.droppedEvents = saturate(this.droppedEvents + 1);
    }
    const persistedKind = encoded.kind === "metadata_rejected" ? "metadata_rejected" : input.kind;
    const observerMetadata = kind === "metadata_rejected"
      ? { reason: "metadata_rejected" }
      : sanitizeOperationalEventMetadata(kind, input.metadata);
    this.pending.push({
      type: "event",
      seq: this.nextSeq(),
      event,
      json: encoded.json,
      kind: persistedKind,
      observerKind: kind,
      observerMetadata,
    });
  }

  async flush(signal?: AbortSignal, maxMutations = Number.POSITIVE_INFINITY): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const batch = this.pending.splice(0, Math.max(0, Math.floor(maxMutations)));
    const recordedEvents: RecordedOperationalEvent[] | null = this.observer === undefined ? null : [];
    const now = this.nowMs();
    const tx = this.database.transaction(() => {
      for (const item of batch) {
        if (item.type === "usage") {
          this.upsertUsage(item.update, item.latencySumMs, item.latencyMaxMs);
        } else {
          const recorded = this.insertEvent(item, recordedEvents !== null);
          if (recorded !== null) {
            recordedEvents?.push(recorded);
          }
        }
      }
      this.persistDrops(now);
      this.cleanup(now);
    });
    try {
      tx();
    } catch (error: unknown) {
      this.pending.unshift(...batch);
      throw error;
    }
    if (recordedEvents !== null) {
      for (const event of recordedEvents) {
        try {
          this.observer?.(event);
        } catch {
          // Telemetry observers cannot affect an already committed telemetry batch.
        }
      }
    }
  }

  droppedCounters(): { readonly droppedUsageUpdates: number; readonly droppedOperationalEvents: number } {
    const row = this.database.prepare(
      "SELECT dropped_usage_updates, dropped_operational_events FROM telemetry_state WHERE singleton_id = 1",
    ).get() as { dropped_usage_updates: number; dropped_operational_events: number } | undefined;
    return {
      droppedUsageUpdates: saturate(this.droppedUsage + (row?.dropped_usage_updates ?? 0)),
      droppedOperationalEvents: saturate(this.droppedEvents + (row?.dropped_operational_events ?? 0)),
    };
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private upsertUsage(update: UsageUpdate, latencySumMs: number, latencyMaxMs: number): void {
    const hour = floorToUtcHour(update.occurredAtMs);
    this.database.prepare(
      `INSERT INTO usage_buckets (
         utc_hour_ms, account_id, protocol, resolved_model, outcome,
         request_count, error_count, input_tokens, output_tokens, cache_tokens, latency_sum_ms, latency_max_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(utc_hour_ms, account_id, protocol, resolved_model, outcome) DO UPDATE SET
         request_count = request_count + excluded.request_count,
         error_count = error_count + excluded.error_count,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_tokens = cache_tokens + excluded.cache_tokens,
         latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
         latency_max_ms = MAX(latency_max_ms, excluded.latency_max_ms)`,
    ).run(
      hour,
      update.accountId,
      update.protocol,
      update.resolvedModel,
      update.outcome,
      update.requestCount,
      update.errorCount,
      update.inputTokens,
      update.outputTokens,
      update.cacheTokens,
      latencySumMs,
      latencyMaxMs,
    );
  }

  private insertEvent(item: PendingEvent, createObserverDto: boolean): RecordedOperationalEvent | null {
    const result = this.database.prepare(
      "INSERT INTO operational_events (occurred_at_ms, kind, severity, metadata_json) VALUES (?, ?, ?, ?)",
    ).run(item.event.occurredAtMs, item.kind, item.event.severity, item.json);
    if (!createObserverDto || item.observerKind === undefined || item.observerMetadata === undefined) {
      return null;
    }
    return {
      eventId: String(result.lastInsertRowid),
      occurredAtMs: item.event.occurredAtMs,
      kind: item.observerKind,
      severity: item.event.severity,
      metadata: item.observerMetadata,
    };
  }

  private persistDrops(now: number): void {
    if (this.droppedUsage === 0 && this.droppedEvents === 0) {
      return;
    }
    this.database.prepare(
      `UPDATE telemetry_state SET
         dropped_usage_updates = MIN(dropped_usage_updates + ?, ?),
         dropped_operational_events = MIN(dropped_operational_events + ?, ?),
         updated_at_ms = ?
       WHERE singleton_id = 1`,
    ).run(this.droppedUsage, Number.MAX_SAFE_INTEGER, this.droppedEvents, Number.MAX_SAFE_INTEGER, now);
    this.droppedUsage = 0;
    this.droppedEvents = 0;
  }

  private cleanup(now: number): void {
    const usageCutoff = floorToUtcHour(now - this.usageRetentionMs);
    this.database.prepare("DELETE FROM usage_buckets WHERE utc_hour_ms < ?").run(usageCutoff);
    const usageCount = (this.database.prepare("SELECT COUNT(*) AS count FROM usage_buckets").get() as { count: number }).count;
    if (usageCount > this.usageRowCap) {
      this.database.prepare(
        `DELETE FROM usage_buckets WHERE rowid IN (
           SELECT rowid FROM usage_buckets
           ORDER BY utc_hour_ms, account_id, protocol, resolved_model, outcome
           LIMIT ?
         )`,
      ).run(usageCount - this.usageRowCap);
    }

    const eventCutoff = now - this.eventRetentionMs;
    this.database.prepare("DELETE FROM operational_events WHERE occurred_at_ms <= ?").run(eventCutoff);
    const eventCount = (this.database.prepare("SELECT COUNT(*) AS count FROM operational_events").get() as { count: number }).count;
    if (eventCount > this.eventRowCap) {
      this.database.prepare(
        `DELETE FROM operational_events WHERE event_id IN (
           SELECT event_id FROM operational_events ORDER BY event_id LIMIT ?
         )`,
      ).run(eventCount - this.eventRowCap);
    }
  }
}

export function floorToUtcHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

function usageKey(update: UsageUpdate): string {
  return [
    floorToUtcHour(update.occurredAtMs),
    update.accountId,
    update.protocol,
    update.resolvedModel,
    update.outcome,
  ].join("\0");
}

function mergeUsage(left: UsageUpdate, right: UsageUpdate): UsageUpdate {
  return {
    occurredAtMs: left.occurredAtMs,
    accountId: left.accountId,
    protocol: left.protocol,
    resolvedModel: left.resolvedModel,
    outcome: left.outcome,
    requestCount: left.requestCount + right.requestCount,
    errorCount: left.errorCount + right.errorCount,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheTokens: left.cacheTokens + right.cacheTokens,
    latencyMs: left.latencyMs + right.latencyMs,
  };
}

function saturate(value: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}
