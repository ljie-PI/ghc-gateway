import { describe, expect, it } from "vitest";
import {
  runBenchmarkIteration,
  type CheckpointDiagnostics,
} from "../../scripts/tooling/bench.js";
import type {
  CheckpointDiagnosticSample,
  CheckpointResourceUsageDelta,
  CheckpointSqliteTimings,
  DiagnosticTimingAggregate,
} from "../../scripts/tooling/checkpoint_diagnostics.js";

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function expectNonnegativeNumber(value: number): void {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

function expectNullableNonnegativeNumber(value: number | null): void {
  if (value !== null) expectNonnegativeNumber(value);
}

function expectTiming(value: DiagnosticTimingAggregate): void {
  expectExactKeys(value, ["count", "totalMs", "maxMs"]);
  expect(Number.isSafeInteger(value.count)).toBe(true);
  expectNonnegativeNumber(value.count);
  expectNonnegativeNumber(value.totalMs);
  expectNonnegativeNumber(value.maxMs);
  expect(value.maxMs).toBeLessThanOrEqual(value.totalMs);
  if (value.count === 0) expect(value).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
}

function expectSqlite(value: CheckpointSqliteTimings): void {
  expectExactKeys(value, [
    "statementGet", "statementAll", "statementRun", "transaction", "transactionCallback",
    "transactionBoundary",
  ]);
  for (const timing of Object.values(value)) expectTiming(timing);
}

function expectResourceUsage(value: CheckpointResourceUsageDelta): void {
  expectExactKeys(value, [
    "cpuUserMicros", "cpuSystemMicros", "voluntaryContextSwitches", "involuntaryContextSwitches",
    "majorPageFaults", "minorPageFaults", "filesystemReads", "filesystemWrites",
  ]);
  for (const measurement of Object.values(value)) expectNullableNonnegativeNumber(measurement);
}

function expectSample(sample: CheckpointDiagnosticSample, diagnostics: CheckpointDiagnostics): void {
  expectExactKeys(sample, [
    "ordinal", "state", "thresholdExceeded", "elapsedMs", "sqlite", "sqliteAttributedMs",
    "unattributedMs", "resourceUsage",
  ]);
  expect(Number.isSafeInteger(sample.ordinal)).toBe(true);
  expect(sample.ordinal).toBeGreaterThan(0);
  expect(["partial", "complete"]).toContain(sample.state);
  expect(typeof sample.thresholdExceeded).toBe("boolean");
  expect(sample.thresholdExceeded).toBe(sample.elapsedMs > diagnostics.thresholdMs);
  expectNonnegativeNumber(sample.elapsedMs);
  expectSqlite(sample.sqlite);
  expectNonnegativeNumber(sample.sqliteAttributedMs);
  expectNonnegativeNumber(sample.unattributedMs);
  expect(sample.sqliteAttributedMs).toBe(
    sample.sqlite.statementGet.totalMs
      + sample.sqlite.statementAll.totalMs
      + sample.sqlite.statementRun.totalMs
      + sample.sqlite.transactionBoundary.totalMs,
  );
  expect(sample.sqliteAttributedMs + sample.unattributedMs).toBeCloseTo(sample.elapsedMs, 8);
  expectResourceUsage(sample.resourceUsage);
}

function expectContentFree(value: unknown): void {
  const forbiddenKeys = /^(?:sql|query|path|error|errors|stack|payload|request|response|requestid|responseid|accountid|modelid|id|arguments|content|env)$/iu;
  const forbiddenStrings = [
    /\b(?:select|insert|update|delete|replace|pragma|create|drop)\b/iu,
    /[\\/]/u,
    /(?:resp|call|req|chatcmpl)_[a-z0-9_-]+/iu,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    /\b(?:error|failure|exception|secret|token|credential|payload|stack trace)\b/iu,
    /\b(?:env|environment|home|path|token|secret)[_a-z0-9]*\s*=/iu,
  ];
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      for (const forbidden of forbiddenStrings) expect(current).not.toMatch(forbidden);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      expect(key).not.toMatch(forbiddenKeys);
      visit(nested);
    }
  };
  visit(value);
}

function expectDiagnosticContract(diagnostics: CheckpointDiagnostics): void {
  expectExactKeys(diagnostics, [
    "observedCount", "thresholdMs", "thresholdExceededCount", "retainedSlowestLimit", "states",
    "sqlite", "slowest", "measurement", "environment", "sqliteConfiguration", "filesystem",
  ]);
  for (const count of [
    diagnostics.observedCount,
    diagnostics.thresholdExceededCount,
    diagnostics.retainedSlowestLimit,
  ]) {
    expect(Number.isSafeInteger(count)).toBe(true);
    expectNonnegativeNumber(count);
  }
  expect(diagnostics.thresholdExceededCount).toBeLessThanOrEqual(diagnostics.observedCount);
  expectNonnegativeNumber(diagnostics.thresholdMs);
  expectExactKeys(diagnostics.states, ["partial", "complete"]);
  expectTiming(diagnostics.states.partial);
  expectTiming(diagnostics.states.complete);
  expectSqlite(diagnostics.sqlite);
  expect(diagnostics.slowest.length).toBeLessThanOrEqual(diagnostics.retainedSlowestLimit);
  for (const sample of diagnostics.slowest) expectSample(sample, diagnostics);

  expectExactKeys(diagnostics.measurement, ["wallMs", "cpuUserMicros", "cpuSystemMicros"]);
  for (const value of Object.values(diagnostics.measurement)) expectNonnegativeNumber(value);
  expectExactKeys(diagnostics.environment, ["before", "after"]);
  for (const snapshot of Object.values(diagnostics.environment)) {
    expectExactKeys(snapshot, ["loadAverage1m", "freeMemoryBytes", "totalMemoryBytes", "processRssBytes"]);
    expectNullableNonnegativeNumber(snapshot.loadAverage1m);
    expectNonnegativeNumber(snapshot.freeMemoryBytes);
    expectNonnegativeNumber(snapshot.totalMemoryBytes);
    expectNonnegativeNumber(snapshot.processRssBytes);
  }
  expectExactKeys(diagnostics.sqliteConfiguration, [
    "journalMode", "synchronous", "busyTimeoutMs", "walAutocheckpointPages", "pageSizeBytes",
  ]);
  expect(["delete", "truncate", "persist", "memory", "wal", "off", "unknown"])
    .toContain(diagnostics.sqliteConfiguration.journalMode);
  for (const [key, value] of Object.entries(diagnostics.sqliteConfiguration)) {
    if (key !== "journalMode") expectNullableNonnegativeNumber(value as number | null);
  }
  expectExactKeys(diagnostics.filesystem, [
    "databaseBytes", "walBytes", "sharedMemoryBytes", "blockSizeBytes", "totalBytes", "freeBytes",
  ]);
  for (const value of Object.values(diagnostics.filesystem)) expectNullableNonnegativeNumber(value);
  expectContentFree(diagnostics);
}

describe("full-gateway benchmark smoke", () => {
  it("measures production gateway, stream, and SQLite seams with scripted remotes", async () => {
    const result = await runBenchmarkIteration(1, {
      memoryStreams: 10,
      bufferedSamples: 20,
      eventSamples: 20,
      checkpointStreams: 4,
      openAdmin: false,
    });

    expect(result.offlineScripted).toBe(true);
    expect(result.listener).toBe("loopback");
    expect(result.streams.executionCount).toBe(10);
    expect(result.buffered.valuesMs).toHaveLength(20);
    expect(result.streamEvent.valuesMs).toHaveLength(20);
    expect(result.checkpoint.valuesMs).toHaveLength(8);
    expect(result.checkpoint.diagnostics.observedCount).toBe(8);
    expect(result.checkpoint.diagnostics.states.partial.count).toBe(4);
    expect(result.checkpoint.diagnostics.states.complete.count).toBe(4);
    expect(result.checkpoint.diagnostics.thresholdMs).toBe(result.checkpoint.thresholdMs);
    expect(result.checkpoint.diagnostics.thresholdExceededCount).toBe(
      result.checkpoint.valuesMs.filter((value) => value > result.checkpoint.thresholdMs).length,
    );
    expect(result.checkpoint.diagnostics.slowest.map((sample) => sample.elapsedMs)).toEqual(
      [...result.checkpoint.valuesMs].sort((left, right) => right - left).slice(
        0,
        result.checkpoint.diagnostics.retainedSlowestLimit,
      ),
    );
    for (const sample of result.checkpoint.diagnostics.slowest) {
      expect(result.checkpoint.valuesMs).toContain(sample.elapsedMs);
    }
    expectDiagnosticContract(result.checkpoint.diagnostics);
    expect(result.checkpoint.diagnostics.sqlite.statementRun.count).toBeGreaterThan(0);
    expect(result.checkpoint.diagnostics.sqlite.transaction.count).toBeGreaterThan(0);
    expect(result.checkpoint.diagnostics.measurement.wallMs).toBeGreaterThan(0);
    expect(result.checkpoint.diagnostics.environment.before.totalMemoryBytes).toBeGreaterThan(0);
    expect(result.checkpoint.diagnostics.environment.after.processRssBytes).toBeGreaterThan(0);
    expect(result.checkpoint.diagnostics.sqliteConfiguration.journalMode).toBe("wal");
    expect(result.checkpoint.diagnostics.filesystem.databaseBytes).toBeGreaterThan(0);
    expect(result.eventLoop.valuesMs.length).toBeGreaterThanOrEqual(100);
    expect(result.buffered.valuesMs.some((value) => value > 0)).toBe(true);
    expect(result.checkpoint.valuesMs.every((value) => value > 0)).toBe(true);
  }, 60_000);
});
