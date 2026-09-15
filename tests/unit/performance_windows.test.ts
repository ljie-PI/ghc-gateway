import { describe, expect, it } from "vitest";
import { MAX_WINDOW_SAMPLES, MIN_OBSERVATIONS, nearestRankP95, PerformanceWindows } from "../../src/telemetry/performance.js";

describe("performance windows", () => {
  it("uses nearest-rank p95", () => {
    expect(nearestRankP95([1, 2, 3, 4, 5])).toBe(5);
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRankP95(samples)).toBe(samples[Math.ceil(0.95 * 20) - 1]);
  });

  it("enters degraded after three over windows and clears after three healthy windows", () => {
    const windows = new PerformanceWindows(() => 1_000);
    const over = (): void => {
      for (let index = 0; index < MIN_OBSERVATIONS; index += 1) {
        windows.observeBuffered(20);
        windows.observeEvent(20);
        windows.observeCheckpoint(20);
        windows.observeEventLoop(20);
      }
    };
    const healthy = (): void => {
      for (let index = 0; index < MIN_OBSERVATIONS; index += 1) {
        windows.observeBuffered(1);
        windows.observeEvent(1);
        windows.observeCheckpoint(1);
        windows.observeEventLoop(1);
      }
    };
    expect(windows.evaluateWindow().transition).toBeNull();
    over();
    expect(windows.evaluateWindow().transition).toBeNull();
    over();
    expect(windows.evaluateWindow().transition).toBeNull();
    over();
    const entered = windows.evaluateWindow();
    expect(entered.transition).toBe("enter");
    expect(entered.snapshot.status).toBe("degraded");
    expect(entered.snapshot.startedAtMs).toBe(1_000);

    healthy();
    expect(windows.evaluateWindow().transition).toBeNull();
    healthy();
    expect(windows.evaluateWindow().transition).toBeNull();
    healthy();
    const cleared = windows.evaluateWindow();
    expect(cleared.transition).toBe("clear");
    expect(cleared.snapshot.status).toBe("healthy");
  });

  it("uses the checkpoint and event-loop budgets at their exact boundaries", () => {
    const windows = new PerformanceWindows();
    for (let index = 0; index < MIN_OBSERVATIONS; index += 1) {
      windows.observeCheckpoint(8);
      windows.observeEventLoop(5);
    }
    const boundary = windows.evaluateWindow();
    expect(boundary.snapshot.metrics.checkpointMs.status).toBe("healthy");
    expect(boundary.snapshot.metrics.eventLoopMs.status).toBe("healthy");

    for (let index = 0; index < MIN_OBSERVATIONS; index += 1) {
      windows.observeCheckpoint(8.001);
      windows.observeEventLoop(5.001);
    }
    const exceeded = windows.evaluateWindow();
    expect(exceeded.snapshot.metrics.checkpointMs.status).toBe("over");
    expect(exceeded.snapshot.metrics.eventLoopMs.status).toBe("over");
  });

  it("does not advance consecutive counters on insufficient_data", () => {
    const windows = new PerformanceWindows();
    windows.observeBuffered(50);
    const result = windows.evaluateWindow();
    expect(result.snapshot.metrics.bufferedMs.status).toBe("insufficient_data");
    expect(result.snapshot.metrics.bufferedMs.samples).toBeUndefined();
    expect(result.transition).toBeNull();
    expect(result.snapshot.status).toBe("healthy");
  });

  it("bounds every pending metric window", () => {
    let observed: ReturnType<PerformanceWindows["evaluateWindow"]> | undefined;
    const windows = new PerformanceWindows(Date.now, (evaluation) => { observed = evaluation; });
    for (let index = 0; index < MAX_WINDOW_SAMPLES + 100; index += 1) {
      windows.observeBuffered(index);
      windows.observeEvent(index);
      windows.observeCheckpoint(index);
      windows.observeEventLoop(index);
    }
    windows.evaluateWindow();
    expect(observed?.snapshot.metrics.bufferedMs.samples).toBe(MAX_WINDOW_SAMPLES);
    expect(observed?.snapshot.metrics.eventMs.samples).toBe(MAX_WINDOW_SAMPLES);
    expect(observed?.snapshot.metrics.checkpointMs.samples).toBe(MAX_WINDOW_SAMPLES);
    expect(observed?.snapshot.metrics.eventLoopMs.samples).toBe(MAX_WINDOW_SAMPLES);
  });

  it("tracks degradation and recovery independently for each metric", () => {
    const windows = new PerformanceWindows(() => 1_000);
    for (let window = 0; window < 3; window += 1) {
      for (let sample = 0; sample < MIN_OBSERVATIONS; sample += 1) {
        windows.observeBuffered(20);
      }
      expect(windows.evaluateWindow().transition).toBe(window === 2 ? "enter" : null);
    }

    for (let sample = 0; sample < MIN_OBSERVATIONS; sample += 1) {
      windows.observeEvent(1);
    }
    expect(windows.evaluateWindow().snapshot.status).toBe("degraded");

    for (let window = 0; window < 3; window += 1) {
      for (let sample = 0; sample < MIN_OBSERVATIONS; sample += 1) {
        windows.observeBuffered(1);
      }
      expect(windows.evaluateWindow().transition).toBe(window === 2 ? "clear" : null);
    }
  });
});
