export const WINDOW_MS = 5 * 60 * 1000;
export const MIN_OBSERVATIONS = 20;
export const MAX_WINDOW_SAMPLES = 4_096;
export const THRESHOLDS = {
  bufferedMs: 5,
  eventMs: 2,
  checkpointMs: 8,
  eventLoopMs: 5,
} as const;

export type PerformanceStatus = "healthy" | "degraded";
export type MetricStatus = "healthy" | "over" | "insufficient_data";

export interface PerformanceSnapshot {
  readonly status: PerformanceStatus;
  readonly startedAtMs: number | null;
  readonly metrics: {
    readonly bufferedMs: PerformanceMetricSnapshot;
    readonly eventMs: PerformanceMetricSnapshot;
    readonly checkpointMs: PerformanceMetricSnapshot;
    readonly eventLoopMs: PerformanceMetricSnapshot;
  };
}

export interface PerformanceMetricSnapshot {
  readonly p95: number | null;
  readonly status: MetricStatus;
  readonly samples?: number;
}

export interface PerformanceEvaluation {
  readonly snapshot: PerformanceSnapshot;
  readonly transition: "enter" | "clear" | null;
}

export type PerformanceObserver = (evaluation: Readonly<PerformanceEvaluation>) => void;

export class PerformanceWindows {
  private readonly buffered: number[] = [];
  private readonly event: number[] = [];
  private readonly checkpoint: number[] = [];
  private readonly eventLoop: number[] = [];
  private readonly consecutive = {
    buffered: metricWindows(),
    event: metricWindows(),
    checkpoint: metricWindows(),
    eventLoop: metricWindows(),
  };
  private status: PerformanceStatus = "healthy";
  private degradedSinceMs: number | null = null;

  constructor(
    private readonly nowMs: () => number = Date.now,
    private readonly observer?: PerformanceObserver,
  ) {}

  observeBuffered(ms: number): void {
    addSample(this.buffered, ms);
  }

  observeEvent(ms: number): void {
    addSample(this.event, ms);
  }

  observeCheckpoint(ms: number): void {
    addSample(this.checkpoint, ms);
  }

  observeEventLoop(ms: number): void {
    addSample(this.eventLoop, ms);
  }

  evaluateWindow(): PerformanceEvaluation {
    const buffered = summarize(this.buffered, THRESHOLDS.bufferedMs);
    const event = summarize(this.event, THRESHOLDS.eventMs);
    const checkpoint = summarize(this.checkpoint, THRESHOLDS.checkpointMs);
    const eventLoop = summarize(this.eventLoop, THRESHOLDS.eventLoopMs);
    this.buffered.length = 0;
    this.event.length = 0;
    this.checkpoint.length = 0;
    this.eventLoop.length = 0;

    updateMetricWindows(this.consecutive.buffered, buffered);
    updateMetricWindows(this.consecutive.event, event);
    updateMetricWindows(this.consecutive.checkpoint, checkpoint);
    updateMetricWindows(this.consecutive.eventLoop, eventLoop);
    let transition: "enter" | "clear" | null = null;
    const degraded = Object.values(this.consecutive).some((metric) => metric.degraded);
    if (this.status === "healthy" && degraded) {
      this.status = "degraded";
      this.degradedSinceMs = this.nowMs();
      transition = "enter";
    } else if (this.status === "degraded" && !degraded) {
      this.status = "healthy";
      this.degradedSinceMs = null;
      transition = "clear";
    }

    const evaluation: PerformanceEvaluation = {
      snapshot: {
        status: this.status,
        startedAtMs: this.degradedSinceMs,
        metrics: {
          bufferedMs: withoutSamples(buffered),
          eventMs: withoutSamples(event),
          checkpointMs: withoutSamples(checkpoint),
          eventLoopMs: withoutSamples(eventLoop),
        },
      },
      transition,
    };
    try {
      this.observer?.({
        ...evaluation,
        snapshot: {
          ...evaluation.snapshot,
          metrics: { bufferedMs: buffered, eventMs: event, checkpointMs: checkpoint, eventLoopMs: eventLoop },
        },
      });
    } catch {
      // Monitoring observers cannot change performance state transitions.
    }
    return evaluation;
  }
}

function addSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  if (samples.length >= MAX_WINDOW_SAMPLES) {
    samples.shift();
  }
  samples.push(value);
}

interface MetricWindows {
  over: number;
  healthy: number;
  degraded: boolean;
}

function metricWindows(): MetricWindows {
  return { over: 0, healthy: 0, degraded: false };
}

function updateMetricWindows(windows: MetricWindows, metric: PerformanceMetricSnapshot): void {
  if (metric.status === "insufficient_data") {
    return;
  }
  if (metric.status === "over") {
    windows.over += 1;
    windows.healthy = 0;
    if (windows.over >= 3) {
      windows.degraded = true;
      windows.over = 0;
    }
    return;
  }
  windows.over = 0;
  if (!windows.degraded) {
    windows.healthy = 0;
    return;
  }
  windows.healthy += 1;
  if (windows.healthy >= 3) {
    windows.degraded = false;
    windows.healthy = 0;
  }
}

export function nearestRankP95(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function summarize(samples: readonly number[], threshold: number): PerformanceMetricSnapshot {
  if (samples.length < MIN_OBSERVATIONS) {
    return { p95: nearestRankP95(samples), status: "insufficient_data", samples: samples.length };
  }
  const p95 = nearestRankP95(samples);
  if (p95 === null) {
    return { p95: null, status: "insufficient_data", samples: samples.length };
  }
  return { p95, status: p95 > threshold ? "over" : "healthy", samples: samples.length };
}

function withoutSamples(metric: PerformanceMetricSnapshot): PerformanceMetricSnapshot {
  return { p95: metric.p95, status: metric.status };
}
