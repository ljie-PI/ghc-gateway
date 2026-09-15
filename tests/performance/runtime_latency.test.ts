import { describe, expect, it } from "vitest";
import { nearestRankP95, THRESHOLDS } from "../../src/telemetry/performance.js";

describe("runtime latency gates", () => {
  it("keeps thresholds and nearest-rank p95", () => {
    expect(THRESHOLDS.bufferedMs).toBe(5);
    expect(THRESHOLDS.eventMs).toBe(2);
    expect(THRESHOLDS.checkpointMs).toBe(8);
    expect(THRESHOLDS.eventLoopMs).toBe(5);
    expect(nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
  });
});
