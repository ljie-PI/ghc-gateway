import { describe, expect, it } from "vitest";
import {
  benchmarkCliSummary,
  evaluateBenchmarkRuns,
  sanitizedNpmUserAgent,
  type BenchmarkArtifact,
  type BenchmarkRunResult,
  type CheckpointDiagnostics,
} from "../../scripts/tooling/bench.js";

function checkpointDiagnostics(): CheckpointDiagnostics {
  const timing = { count: 1, totalMs: 1, maxMs: 1 };
  return {
    observedCount: 2,
    thresholdMs: 5,
    thresholdExceededCount: 0,
    retainedSlowestLimit: 8,
    states: { partial: timing, complete: timing },
    sqlite: {
      statementGet: timing,
      statementAll: timing,
      statementRun: timing,
      transaction: timing,
      transactionCallback: timing,
      transactionBoundary: timing,
    },
    slowest: [{
      ordinal: 1,
      state: "partial",
      thresholdExceeded: false,
      elapsedMs: 5,
      sqlite: {
        statementGet: timing,
        statementAll: timing,
        statementRun: timing,
        transaction: timing,
        transactionCallback: timing,
        transactionBoundary: timing,
      },
      sqliteAttributedMs: 4,
      unattributedMs: 1,
      resourceUsage: {
        cpuUserMicros: 1,
        cpuSystemMicros: 1,
        voluntaryContextSwitches: 0,
        involuntaryContextSwitches: 0,
        majorPageFaults: 0,
        minorPageFaults: 0,
        filesystemReads: 0,
        filesystemWrites: 0,
      },
    }],
    measurement: { wallMs: 2, cpuUserMicros: 1, cpuSystemMicros: 1 },
    environment: {
      before: { loadAverage1m: 0, freeMemoryBytes: 1, totalMemoryBytes: 2, processRssBytes: 1 },
      after: { loadAverage1m: 0, freeMemoryBytes: 1, totalMemoryBytes: 2, processRssBytes: 1 },
    },
    sqliteConfiguration: {
      journalMode: "wal",
      synchronous: 2,
      busyTimeoutMs: 1_000,
      walAutocheckpointPages: 1_000,
      pageSizeBytes: 4_096,
    },
    filesystem: {
      databaseBytes: 4_096,
      walBytes: 0,
      sharedMemoryBytes: 0,
      blockSizeBytes: 4_096,
      totalBytes: 8_192,
      freeBytes: 4_096,
    },
  };
}

function passingRun(run: number): BenchmarkRunResult {
  const resident = {
    samples: [{ residentBytes: 32 * 1024 * 1024, metric: "node_rss_bytes" as const }],
    medianBytes: 32 * 1024 * 1024,
    metric: "node_rss_bytes" as const,
  };
  const latency = {
    thresholdMs: 5,
    warmupCount: 20,
    sampleCount: 20,
    valuesMs: Array.from({ length: 20 }, () => 1),
    p95Ms: 1,
    passed: true,
  };
  return {
    run,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: 1, npmUserAgent: null },
    browserIncluded: false,
    offlineScripted: true,
    listener: "loopback",
    idle: { limitBytes: 64 * 1024 * 1024, launchArgs: ["--jitless"], resident, passed: true },
    adminPage: { browserIncluded: false, assetCount: 2, resident, deltaFromIdleBytes: 0 },
    streams: {
      warmupCount: 1_000,
      launchArgs: ["--jitless"],
      executionCount: 1_000,
      completedCount: 500,
      abortedCount: 500,
      warmedBaseline: resident,
      stabilized: resident,
      deltaBytes: 0,
      limitBytes: 16 * 1024 * 1024,
      passed: true,
    },
    buffered: latency,
    streamEvent: { ...latency, thresholdMs: 2 },
    checkpoint: { ...latency, diagnostics: checkpointDiagnostics() },
    eventLoop: { ...latency, thresholdMs: 10 },
    passed: true,
  };
}

describe("benchmark gate contract", () => {
  it("requires every metric in every repetition to pass", () => {
    const runs = [passingRun(1), passingRun(2), passingRun(3)];
    expect(evaluateBenchmarkRuns(runs)).toBe(true);

    const failed: BenchmarkRunResult = { ...runs[1]!, checkpoint: { ...runs[1]!.checkpoint, passed: false } };
    expect(evaluateBenchmarkRuns([runs[0]!, failed, runs[2]!])).toBe(false);
  });

  it("records process-resident memory and excludes browser memory", () => {
    const run = passingRun(1);
    expect(run.browserIncluded).toBe(false);
    expect(run.adminPage.browserIncluded).toBe(false);
    expect(run.idle.resident.metric).not.toContain("heap");
    expect(run.streams.executionCount).toBe(1_000);
    expect(run.streams.completedCount + run.streams.abortedCount).toBe(1_000);
  });

  it("keeps bounded threshold-exceeded checkpoint evidence in the CLI summary", () => {
    const run = passingRun(1);
    const failedRun: BenchmarkRunResult = {
      ...run,
      checkpoint: { ...run.checkpoint, passed: false },
      passed: false,
    };
    const artifact: BenchmarkArtifact = {
      kind: "full-gateway",
      generatedAt: "2026-01-02T03:04:05.000Z",
      repeat: 1,
      requiredRepeat: 3,
      runs: [failedRun],
      passed: false,
    };

    const summary = benchmarkCliSummary("artifacts/bench/full-gateway.json", artifact);
    expect(summary).toMatchObject({
      passed: false,
      runs: [{
        checkpointP95Ms: 1,
        checkpointDiagnostics: {
          observedCount: 2,
          thresholdMs: 5,
          thresholdExceededCount: 0,
          partialCount: 1,
          completeCount: 1,
          slowestMs: [5],
          transactionMaxMs: 1,
        },
        passed: false,
      }],
    });
    expect(JSON.stringify(summary)).not.toContain("generatedAt");
  });

  it.each([
    ["npm/10.9.2 node/v24.20.0 win32 x64 workspaces/false", "npm/10.9.2 node/v24.20.0 win32 x64 workspaces/false"],
    ["npm/10.9.2-beta.1 node/v24.20.0", "node/v24.20.0"],
    ["npm/10.9.2 node/v24.20.0-rc.1", "npm/10.9.2"],
    ["npm/10.9.2-../../private node/v24.20.0-secret", null],
    ["npm/10.9 node/v24.20.0.1 npm/v10.9.2+build", null],
    ["npm/01.002.0003 node/v01.002.0003", null],
    ["workspaces/true linux arm64 arbitrary/payload", "workspaces/true linux arm64"],
    ["npm/10.9.2  node/v24.20.0\nSECRET_ENV=value", "npm/10.9.2"],
    [undefined, null],
  ] as const)("sanitizes npm user agent %# to numeric semver and fixed labels", (input, expected) => {
    expect(sanitizedNpmUserAgent(input)).toBe(expected);
  });
});
