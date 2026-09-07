import { performance } from "node:perf_hooks";
import type { SqliteAdminTelemetry } from "./admin.js";
import {
  PerformanceWindows,
  THRESHOLDS,
  type PerformanceEvaluation,
  type PerformanceMetricSnapshot,
} from "./performance.js";
import type { TelemetryRecorder } from "./recorder.js";

export const TELEMETRY_FLUSH_INTERVAL_MS = 1_000;
export const TELEMETRY_FLUSH_BATCH_SIZE = 64;
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 100;

export type PerformanceMeasurement = "buffered" | "event" | "checkpoint";

export interface ProtocolPerformanceObserver {
  measure<T>(measurement: PerformanceMeasurement, work: () => T): T;
  measureAsync<T>(measurement: PerformanceMeasurement, work: () => Promise<T>): Promise<T>;
  observe?(measurement: PerformanceMeasurement, elapsedMs: number): void;
}

export interface TelemetryRuntimeTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TelemetryRuntimeOptions {
  readonly nowMs?: () => number;
  readonly monotonicNowMs?: () => number;
  readonly timers?: TelemetryRuntimeTimers;
  readonly flushIntervalMs?: number;
  readonly flushBatchSize?: number;
  readonly eventLoopSampleIntervalMs?: number;
  readonly evaluationIntervalMs?: number;
}

type RuntimeRecorder = Pick<
  TelemetryRecorder,
  "flush" | "pendingCount" | "recordEvent" | "setObserver"
>;

interface MetricDescription {
  readonly name: "buffered_p95_ms" | "stream_event_p95_ms" | "checkpoint_p95_ms" | "event_loop_p95_ms";
  readonly thresholdMs: number;
  readonly snapshot: PerformanceMetricSnapshot;
}

export class TelemetryRuntime {
  readonly performance: ProtocolPerformanceObserver;

  private readonly nowMs: () => number;
  private readonly monotonicNowMs: () => number;
  private readonly timers: TelemetryRuntimeTimers;
  private readonly flushBatchSize: number;
  private readonly windows: PerformanceWindows;
  private readonly timerHandles: unknown[] = [];
  private flushInFlight: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private nextEventLoopSampleMs: number;
  private transitionMetric: MetricDescription | undefined;
  private closed = false;

  constructor(
    private readonly recorder: RuntimeRecorder,
    private adminTelemetry?: Pick<SqliteAdminTelemetry, "observeOperationalEvent" | "observePerformance">,
    options: Readonly<TelemetryRuntimeOptions> = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.monotonicNowMs = options.monotonicNowMs ?? performance.now.bind(performance);
    this.timers = options.timers ?? productionTimers;
    this.flushBatchSize = options.flushBatchSize ?? TELEMETRY_FLUSH_BATCH_SIZE;
    const eventLoopSampleIntervalMs = options.eventLoopSampleIntervalMs ?? EVENT_LOOP_SAMPLE_INTERVAL_MS;
    this.nextEventLoopSampleMs = this.monotonicNowMs() + eventLoopSampleIntervalMs;
    this.windows = new PerformanceWindows(this.nowMs, (evaluation) => this.handleEvaluation(evaluation));
    this.performance = {
      measure: (measurement, work) => this.measure(measurement, work),
      measureAsync: async (measurement, work) => await this.measureAsync(measurement, work),
      observe: (measurement, elapsedMs) => this.observe(measurement, elapsedMs),
    };

    this.updateRecorderObserver();
    this.timerHandles.push(
      this.timers.setInterval(() => this.scheduleFlush(), options.flushIntervalMs ?? TELEMETRY_FLUSH_INTERVAL_MS),
      this.timers.setInterval(() => {
        const sampledAtMs = this.monotonicNowMs();
        this.windows.observeEventLoop(Math.max(0, sampledAtMs - this.nextEventLoopSampleMs));
        this.nextEventLoopSampleMs = sampledAtMs + eventLoopSampleIntervalMs;
      }, eventLoopSampleIntervalMs),
      this.timers.setInterval(() => this.windows.evaluateWindow(), options.evaluationIntervalMs ?? 5 * 60 * 1_000),
    );
  }

  attachAdmin(
    adminTelemetry: Pick<SqliteAdminTelemetry, "observeOperationalEvent" | "observePerformance">,
  ): void {
    this.adminTelemetry = adminTelemetry;
    this.updateRecorderObserver();
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeAndDrain();
    await this.closePromise;
  }

  forceClose(): void {
    if (this.closed) {
      return;
    }
    this.stopTimers();
    if (this.flushInFlight === undefined && this.recorder.pendingCount() > 0) {
      void this.recorder.flush(undefined, this.flushBatchSize).catch(() => undefined);
    }
    this.recorder.setObserver(undefined);
  }

  private measure<T>(measurement: PerformanceMeasurement, work: () => T): T {
    const startedAtMs = this.monotonicNowMs();
    try {
      return work();
    } finally {
      this.observe(measurement, Math.max(0, this.monotonicNowMs() - startedAtMs));
    }
  }

  private async measureAsync<T>(measurement: PerformanceMeasurement, work: () => Promise<T>): Promise<T> {
    const startedAtMs = this.monotonicNowMs();
    try {
      return await work();
    } finally {
      this.observe(measurement, Math.max(0, this.monotonicNowMs() - startedAtMs));
    }
  }

  private observe(measurement: PerformanceMeasurement, elapsedMs: number): void {
    if (measurement === "buffered") {
      this.windows.observeBuffered(elapsedMs);
    } else if (measurement === "event") {
      this.windows.observeEvent(elapsedMs);
    } else {
      this.windows.observeCheckpoint(elapsedMs);
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.flushInFlight !== undefined || this.recorder.pendingCount() === 0) {
      return;
    }
    const pending = this.recorder.flush(undefined, this.flushBatchSize).catch(() => undefined);
    this.flushInFlight = pending;
    void pending.finally(() => {
      if (this.flushInFlight === pending) {
        this.flushInFlight = undefined;
      }
    });
  }

  private handleEvaluation(evaluation: Readonly<PerformanceEvaluation>): void {
    this.adminTelemetry?.observePerformance(evaluation);
    if (evaluation.transition === null) {
      return;
    }
    const metrics = describedMetrics(evaluation);
    const metric = evaluation.transition === "enter"
      ? metrics.find((candidate) => candidate.snapshot.status === "over")
      : metrics.find((candidate) => candidate.name === this.transitionMetric?.name
          && candidate.snapshot.status === "healthy" && candidate.snapshot.p95 !== null)
        ?? metrics.find((candidate) => candidate.snapshot.status === "healthy" && candidate.snapshot.p95 !== null);
    if (metric === undefined || metric.snapshot.p95 === null) {
      return;
    }
    this.recorder.recordEvent({
      occurredAtMs: this.nowMs(),
      kind: evaluation.transition === "enter" ? "performance_degraded" : "performance_recovered",
      severity: evaluation.transition === "enter" ? "warning" : "info",
      metadata: {
        metric: metric.name,
        status: evaluation.transition === "enter" ? "degraded" : "healthy",
        actualMs: metric.snapshot.p95,
        thresholdMs: metric.thresholdMs,
      },
    });
    this.transitionMetric = evaluation.transition === "enter" ? metric : undefined;
  }

  private stopTimers(): void {
    this.closed = true;
    for (const handle of this.timerHandles.splice(0)) {
      this.timers.clearInterval(handle);
    }
  }

  private async closeAndDrain(): Promise<void> {
    this.stopTimers();
    await this.flushInFlight;
    do {
      await this.recorder.flush(undefined, this.flushBatchSize);
    } while (this.recorder.pendingCount() > 0);
    this.recorder.setObserver(undefined);
  }

  private updateRecorderObserver(): void {
    this.recorder.setObserver(this.adminTelemetry === undefined
      ? undefined
      : (event) => this.adminTelemetry?.observeOperationalEvent(event));
  }
}

function describedMetrics(evaluation: Readonly<PerformanceEvaluation>): readonly MetricDescription[] {
  return [
    { name: "buffered_p95_ms", thresholdMs: THRESHOLDS.bufferedMs, snapshot: evaluation.snapshot.metrics.bufferedMs },
    { name: "stream_event_p95_ms", thresholdMs: THRESHOLDS.eventMs, snapshot: evaluation.snapshot.metrics.eventMs },
    { name: "checkpoint_p95_ms", thresholdMs: THRESHOLDS.checkpointMs, snapshot: evaluation.snapshot.metrics.checkpointMs },
    { name: "event_loop_p95_ms", thresholdMs: THRESHOLDS.eventLoopMs, snapshot: evaluation.snapshot.metrics.eventLoopMs },
  ];
}

const productionTimers: TelemetryRuntimeTimers = {
  setInterval(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};
