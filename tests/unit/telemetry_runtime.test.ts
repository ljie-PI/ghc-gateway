import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import { SqliteAdminTelemetry } from "../../src/telemetry/admin.js";
import { MIN_OBSERVATIONS } from "../../src/telemetry/performance.js";
import { TelemetryRecorder } from "../../src/telemetry/recorder.js";
import {
  TelemetryRuntime,
  type TelemetryRuntimeTimers,
} from "../../src/telemetry/runtime.js";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

describe("telemetry runtime", () => {
  it("flushes a short batch so Admin usage is visible before shutdown", async () => {
    const database = createDatabase();
    const timers = new ManualTimers();
    const recorder = new TelemetryRecorder(database, () => NOW);
    const admin = new SqliteAdminTelemetry(database, { recorder });
    const runtime = new TelemetryRuntime(recorder, admin, { timers });
    try {
      recorder.recordUsage({
        occurredAtMs: NOW,
        accountId: "github.com/22",
        protocol: "openai_chat",
        resolvedModel: "gpt-test",
        outcome: "success",
        requestCount: 1,
        errorCount: 0,
        inputTokens: 2,
        outputTokens: 3,
        cacheTokens: 1,
        latencyMs: 4,
      });

      timers.fire(1_000);
      await settle();

      const usage = await admin.queryUsage({
        fromMs: NOW - 1,
        toMs: NOW + 1,
        limit: 10,
        cursor: null,
      }, new AbortController().signal);
      expect(usage.items).toHaveLength(1);
      expect(usage.totals).toMatchObject({ requestCount: 1, inputTokens: 2, outputTokens: 3 });
      expect(admin.snapshot().pendingMutations).toBe(0);
    } finally {
      await runtime.close();
      closeDatabase(database);
    }
  });

  it("samples event-loop delay and records one sanitized event per three-window transition", async () => {
    const database = createDatabase();
    const timers = new ManualTimers();
    const recorder = new TelemetryRecorder(database, () => NOW);
    const admin = new SqliteAdminTelemetry(database, { recorder });
    let monotonicMs = 0;
    const runtime = new TelemetryRuntime(recorder, admin, {
      timers,
      monotonicNowMs: () => monotonicMs,
      eventLoopSampleIntervalMs: 100,
      evaluationIntervalMs: 300_000,
    });
    try {
      for (let window = 0; window < 3; window += 1) {
        for (let sample = 0; sample < MIN_OBSERVATIONS; sample += 1) {
          monotonicMs += 120;
          timers.fire(100);
        }
        timers.fire(300_000);
      }
      expect(admin.snapshot().performance.status).toBe("degraded");

      for (let window = 0; window < 3; window += 1) {
        for (let sample = 0; sample < MIN_OBSERVATIONS; sample += 1) {
          monotonicMs += 100;
          timers.fire(100);
        }
        timers.fire(300_000);
      }
      expect(admin.snapshot().performance.status).toBe("healthy");

      timers.fire(1_000);
      await settle();
      const events = await admin.queryEvents({
        fromMs: null,
        toMs: null,
        limit: 10,
        cursor: null,
      }, new AbortController().signal);
      expect(events.items.map((event) => ({
        kind: event.kind,
        severity: event.severity,
        metadata: event.metadata,
      }))).toEqual([
        {
          kind: "performance_degraded",
          severity: "warning",
          metadata: {
            metric: "event_loop_p95_ms",
            status: "degraded",
            actualMs: 20,
            thresholdMs: 5,
          },
        },
        {
          kind: "performance_recovered",
          severity: "info",
          metadata: {
            metric: "event_loop_p95_ms",
            status: "healthy",
            actualMs: 0,
            thresholdMs: 5,
          },
        },
      ]);
    } finally {
      await runtime.close();
      expect(timers.activeCount).toBe(0);
      closeDatabase(database);
    }
  });

  it("prevents overlapping flushes and clears every timer on force close", async () => {
    const timers = new ManualTimers();
    let finishFlush: (() => void) | undefined;
    let flushes = 0;
    let pending = 1;
    const runtime = new TelemetryRuntime({
      flush: async () => {
        flushes += 1;
        await new Promise<void>((resolve) => { finishFlush = resolve; });
      },
      pendingCount: () => pending,
      recordEvent: () => undefined,
      setObserver: () => undefined,
    }, undefined, { timers });

    timers.fire(1_000);
    timers.fire(1_000);
    expect(flushes).toBe(1);
    runtime.forceClose();
    expect(flushes).toBe(1);
    expect(timers.activeCount).toBe(0);
    pending = 0;
    finishFlush?.();
    await settle();
  });

  it("flushes pending telemetry and clears every timer on force close", () => {
    const timers = new ManualTimers();
    let pending = 1;
    let flushes = 0;
    const runtime = new TelemetryRuntime({
      flush: async () => {
        flushes += 1;
        pending = 0;
      },
      pendingCount: () => pending,
      recordEvent: () => undefined,
      setObserver: () => undefined,
    }, undefined, { timers });

    runtime.forceClose();

    expect(flushes).toBe(1);
    expect(timers.activeCount).toBe(0);
  });
});

class ManualTimers implements TelemetryRuntimeTimers {
  private nextId = 0;
  private readonly callbacks = new Map<number, { readonly delayMs: number; readonly callback: () => void }>();

  get activeCount(): number {
    return this.callbacks.size;
  }

  setInterval(callback: () => void, delayMs: number): unknown {
    this.nextId += 1;
    this.callbacks.set(this.nextId, { delayMs, callback });
    return this.nextId;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  fire(delayMs: number): void {
    for (const timer of this.callbacks.values()) {
      if (timer.delayMs === delayMs) {
        timer.callback();
      }
    }
  }
}

function createDatabase(): ReturnType<typeof openDatabase> {
  return openDatabase({
    path: ":memory:",
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(telemetryMigration)],
    nowMs: () => NOW,
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
