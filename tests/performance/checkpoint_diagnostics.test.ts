import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../../src/persistence/sqlite.js";
import {
  CheckpointDiagnosticsCollector,
  instrumentCheckpointDatabase,
} from "../../scripts/tooling/checkpoint_diagnostics.js";

function expectNonnegative(value: number | null): void {
  if (value === null) return;
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

describe("checkpoint benchmark diagnostics", () => {
  it("counts threshold-exceeded persisted samples and retains the bounded slowest outliers", () => {
    let now = 0;
    let resourceTick = 0;
    const resourceUsage = () => {
      resourceTick += 1;
      return {
        userCPUTime: resourceTick * 10,
        systemCPUTime: resourceTick * 20,
        voluntaryContextSwitches: resourceTick * 2,
        involuntaryContextSwitches: resourceTick * 3,
        majorPageFault: resourceTick * 4,
        minorPageFault: resourceTick * 5,
        fsRead: resourceTick * 6,
        fsWrite: resourceTick * 7,
      };
    };
    const statement = {
      get: () => { now += 2; return undefined; },
      all: () => { now += 3; return []; },
      run: () => { now += 4; return { changes: 1, lastInsertRowid: 1 }; },
    };
    const database = {
      prepare: () => statement,
      transaction: (work: () => unknown) => () => {
        now += 1;
        const result = work();
        now += 1;
        return result;
      },
    } as unknown as SqliteDatabase;
    const collector = new CheckpointDiagnosticsCollector(() => now, 2, 15, resourceUsage);
    const measured = instrumentCheckpointDatabase(database, collector);

    const record = (
      state: "partial" | "complete",
      increment: number,
      gateElapsedMs: number,
    ): number => {
      const measurement = collector.startCheckpoint(state);
      measured.transaction(() => {
        const prepared = measured.prepare("sensitive lowercase select from private_table");
        prepared.get("private/path/id");
        prepared.all("arbitrary payload");
        prepared.run("secret binding");
        now += increment;
      })();
      return measurement.complete(gateElapsedMs);
    };

    expect(record("partial", 1, 12)).toBe(12);
    expect(record("complete", 5, 16)).toBe(16);
    expect(record("partial", 10, 21)).toBe(21);

    const report = collector.report();
    expect(Object.keys(report).sort()).toEqual([
      "observedCount", "retainedSlowestLimit", "slowest", "sqlite", "states",
      "thresholdExceededCount", "thresholdMs",
    ].sort());
    expect(report.observedCount).toBe(3);
    expect(report.thresholdMs).toBe(15);
    expect(report.thresholdExceededCount).toBe(2);
    expect(report.states).toEqual({
      partial: { count: 2, totalMs: 33, maxMs: 21 },
      complete: { count: 1, totalMs: 16, maxMs: 16 },
    });
    expect(report.sqlite.statementGet).toEqual({ count: 3, totalMs: 6, maxMs: 2 });
    expect(report.sqlite.statementAll).toEqual({ count: 3, totalMs: 9, maxMs: 3 });
    expect(report.sqlite.statementRun).toEqual({ count: 3, totalMs: 12, maxMs: 4 });
    expect(report.sqlite.transaction).toEqual({ count: 3, totalMs: 49, maxMs: 21 });
    expect(report.sqlite.transactionCallback).toEqual({ count: 3, totalMs: 43, maxMs: 19 });
    expect(report.sqlite.transactionBoundary).toEqual({ count: 3, totalMs: 6, maxMs: 2 });
    expect(report.slowest).toHaveLength(2);
    expect(report.slowest.map((sample) => [sample.ordinal, sample.state, sample.elapsedMs])).toEqual([
      [3, "partial", 21],
      [2, "complete", 16],
    ]);
    for (const sample of report.slowest) {
      expect(Object.keys(sample).sort()).toEqual([
        "elapsedMs", "ordinal", "resourceUsage", "sqlite", "sqliteAttributedMs", "state",
        "thresholdExceeded", "unattributedMs",
      ].sort());
      expect(sample.thresholdExceeded).toBe(true);
      expect(sample.sqliteAttributedMs).toBe(11);
      expect(sample.unattributedMs).toBe(sample.elapsedMs - 11);
      expect(sample.sqliteAttributedMs + sample.unattributedMs).toBe(sample.elapsedMs);
      expect(sample.resourceUsage).toEqual({
        cpuUserMicros: 10,
        cpuSystemMicros: 20,
        voluntaryContextSwitches: 2,
        involuntaryContextSwitches: 3,
        majorPageFaults: 4,
        minorPageFaults: 5,
        filesystemReads: 6,
        filesystemWrites: 7,
      });
      for (const value of Object.values(sample.resourceUsage)) expectNonnegative(value);
    }
    const serialized = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["sensitive", "select", "private_table", "private/path", "payload", "secret binding"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("abandons unsuccessful operations without creating a checkpoint sample", () => {
    let now = 0;
    const collector = new CheckpointDiagnosticsCollector(() => now, 4, 5, () => ({}));
    const measurement = collector.startCheckpoint("complete");
    now = 7;
    measurement.abandon();

    expect(collector.report()).toMatchObject({
      observedCount: 0,
      thresholdExceededCount: 0,
      slowest: [],
      states: { partial: { count: 0 }, complete: { count: 0 } },
    });

    const next = collector.startCheckpoint("partial");
    now = 10;
    expect(next.complete(3)).toBe(3);
    expect(collector.report()).toMatchObject({ observedCount: 1, thresholdExceededCount: 0 });
  });

  it("keeps the gate sample independent from diagnostic clocks and resource callbacks", () => {
    let diagnosticNow = 0;
    let resourceTick = 0;
    const collector = new CheckpointDiagnosticsCollector(
      () => {
        diagnosticNow += 50;
        return diagnosticNow;
      },
      4,
      5,
      () => {
        resourceTick += 1;
        diagnosticNow += 1_000;
        return { userCPUTime: resourceTick * 10 };
      },
    );
    const rawGateValuesMs: number[] = [];

    const belowGate = collector.startCheckpoint("partial");
    collector.measureSqlite("statementRun", () => { diagnosticNow += 25; });
    rawGateValuesMs.push(belowGate.complete(4.5));
    const aboveGate = collector.startCheckpoint("complete");
    collector.measureSqlite("transactionBoundary", () => { diagnosticNow += 25; });
    rawGateValuesMs.push(aboveGate.complete(6));

    const report = collector.report();
    expect(diagnosticNow).toBe(4_250);
    expect(resourceTick).toBe(4);
    expect(rawGateValuesMs).toEqual([4.5, 6]);
    expect(report.states).toEqual({
      partial: { count: 1, totalMs: 4.5, maxMs: 4.5 },
      complete: { count: 1, totalMs: 6, maxMs: 6 },
    });
    expect(report.thresholdExceededCount).toBe(1);
    expect(report.slowest.map((sample) => [sample.elapsedMs, sample.thresholdExceeded])).toEqual([
      [6, true],
      [4.5, false],
    ]);
  });

  it("preserves SQLite operation exceptions", () => {
    const failure = new Error("private operation failure");
    const database = {
      prepare: () => ({ run: () => { throw failure; } }),
    } as unknown as SqliteDatabase;
    const collector = new CheckpointDiagnosticsCollector(() => 0, 1, 5, () => ({}));
    const measured = instrumentCheckpointDatabase(database, collector);
    const measurement = collector.startCheckpoint("partial");

    expect(() => measured.prepare("lowercase insert").run("payload")).toThrow(failure);
    measurement.abandon();
    expect(collector.report().observedCount).toBe(0);
  });
});
