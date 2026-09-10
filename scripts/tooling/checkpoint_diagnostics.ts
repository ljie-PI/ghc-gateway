import { stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SqliteDatabase, SqliteStatement } from "../../src/persistence/sqlite.js";

const DEFAULT_SLOWEST_LIMIT = 8;

export interface DiagnosticTimingAggregate {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface CheckpointResourceUsageDelta {
  readonly cpuUserMicros: number | null;
  readonly cpuSystemMicros: number | null;
  readonly voluntaryContextSwitches: number | null;
  readonly involuntaryContextSwitches: number | null;
  readonly majorPageFaults: number | null;
  readonly minorPageFaults: number | null;
  readonly filesystemReads: number | null;
  readonly filesystemWrites: number | null;
}

export interface CheckpointDiagnosticSample {
  readonly ordinal: number;
  readonly state: "partial" | "complete";
  readonly thresholdExceeded: boolean;
  readonly elapsedMs: number;
  readonly sqlite: CheckpointSqliteTimings;
  readonly sqliteAttributedMs: number;
  readonly unattributedMs: number;
  readonly resourceUsage: CheckpointResourceUsageDelta;
}

export interface CheckpointSqliteTimings {
  readonly statementGet: DiagnosticTimingAggregate;
  readonly statementAll: DiagnosticTimingAggregate;
  readonly statementRun: DiagnosticTimingAggregate;
  readonly transaction: DiagnosticTimingAggregate;
  readonly transactionCallback: DiagnosticTimingAggregate;
  readonly transactionBoundary: DiagnosticTimingAggregate;
}

export interface CheckpointTraceReport {
  readonly observedCount: number;
  readonly thresholdMs: number;
  readonly thresholdExceededCount: number;
  readonly retainedSlowestLimit: number;
  readonly states: {
    readonly partial: DiagnosticTimingAggregate;
    readonly complete: DiagnosticTimingAggregate;
  };
  readonly sqlite: CheckpointSqliteTimings;
  readonly slowest: readonly CheckpointDiagnosticSample[];
}

export interface CheckpointResourceSnapshot {
  readonly loadAverage1m: number | null;
  readonly freeMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly processRssBytes: number;
}

export interface CheckpointDiagnostics extends CheckpointTraceReport {
  readonly measurement: {
    readonly wallMs: number;
    readonly cpuUserMicros: number;
    readonly cpuSystemMicros: number;
  };
  readonly environment: {
    readonly before: CheckpointResourceSnapshot;
    readonly after: CheckpointResourceSnapshot;
  };
  readonly sqliteConfiguration: {
    readonly journalMode: "delete" | "truncate" | "persist" | "memory" | "wal" | "off" | "unknown";
    readonly synchronous: number | null;
    readonly busyTimeoutMs: number | null;
    readonly walAutocheckpointPages: number | null;
    readonly pageSizeBytes: number | null;
  };
  readonly filesystem: {
    readonly databaseBytes: number;
    readonly walBytes: number;
    readonly sharedMemoryBytes: number;
    readonly blockSizeBytes: number | null;
    readonly totalBytes: number | null;
    readonly freeBytes: number | null;
  };
}

type CheckpointSqliteOperation = keyof CheckpointSqliteTimings;
type MutableTimingAggregate = { count: number; totalMs: number; maxMs: number };
type MutableSqliteTimings = Record<CheckpointSqliteOperation, MutableTimingAggregate>;
type ResourceUsageField = keyof NodeJS.ResourceUsage;
type ResourceUsageSnapshot = Partial<Record<ResourceUsageField, number>>;

interface ActiveCheckpointDiagnostic {
  readonly ordinal: number;
  readonly state: "partial" | "complete";
  readonly resourceUsage: ResourceUsageSnapshot;
  readonly sqlite: MutableSqliteTimings;
}

export interface ActiveCheckpointMeasurement {
  complete(elapsedMs: number): number;
  abandon(): void;
}

export class CheckpointDiagnosticsCollector {
  private readonly states = {
    partial: emptyTimingAggregate(),
    complete: emptyTimingAggregate(),
  };
  private readonly sqlite = emptySqliteTimings();
  private readonly slowest: CheckpointDiagnosticSample[] = [];
  private observedCount = 0;
  private thresholdExceededCount = 0;
  private active: ActiveCheckpointDiagnostic | undefined;

  constructor(
    private readonly now: () => number = performance.now.bind(performance),
    private readonly retainedSlowestLimit = DEFAULT_SLOWEST_LIMIT,
    private readonly thresholdMs = 5,
    private readonly resourceUsage: () => ResourceUsageSnapshot = checkpointProcessResourceUsage,
  ) {
    if (!Number.isInteger(retainedSlowestLimit) || retainedSlowestLimit < 1) {
      throw new Error("checkpoint diagnostic retention must be a positive integer");
    }
    if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
      throw new Error("checkpoint diagnostic threshold must be nonnegative");
    }
  }

  reset(): void {
    if (this.active !== undefined) {
      throw new Error("cannot reset checkpoint diagnostics while a sample is active");
    }
    this.observedCount = 0;
    this.thresholdExceededCount = 0;
    resetTimingAggregate(this.states.partial);
    resetTimingAggregate(this.states.complete);
    resetSqliteTimings(this.sqlite);
    this.slowest.length = 0;
  }

  startCheckpoint(state: "partial" | "complete"): ActiveCheckpointMeasurement {
    if (this.active !== undefined) {
      throw new Error("checkpoint diagnostics do not support overlapping samples");
    }
    const active: ActiveCheckpointDiagnostic = {
      ordinal: this.observedCount + 1,
      state,
      resourceUsage: this.resourceUsage(),
      sqlite: emptySqliteTimings(),
    };
    this.active = active;
    let finished = false;
    const claim = (): void => {
      if (finished || this.active !== active) {
        throw new Error("checkpoint diagnostic sample was already finished");
      }
      finished = true;
      this.active = undefined;
    };
    return {
      complete: (elapsedMs) => {
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
          throw new Error("checkpoint gate elapsed time must be nonnegative");
        }
        claim();
        const resourceUsage = resourceUsageDelta(active.resourceUsage, this.resourceUsage());
        const sqlite = copySqliteTimings(active.sqlite);
        const sqliteAttributedMs = attributedSqliteMs(sqlite);
        const thresholdExceeded = elapsedMs > this.thresholdMs;
        const sample: CheckpointDiagnosticSample = {
          ordinal: active.ordinal,
          state,
          thresholdExceeded,
          elapsedMs,
          sqlite,
          sqliteAttributedMs,
          unattributedMs: Math.max(0, elapsedMs - sqliteAttributedMs),
          resourceUsage,
        };
        this.observedCount += 1;
        if (thresholdExceeded) this.thresholdExceededCount += 1;
        observeTiming(this.states[state], elapsedMs);
        mergeSqliteTimings(this.sqlite, active.sqlite);
        retainSlowest(this.slowest, sample, this.retainedSlowestLimit);
        return elapsedMs;
      },
      abandon: claim,
    };
  }

  measureSqlite<T>(operation: CheckpointSqliteOperation, work: () => T): T {
    const active = this.active;
    if (active === undefined) return work();
    const startedAtMs = this.now();
    try {
      return work();
    } finally {
      this.observeSqlite(operation, this.now() - startedAtMs);
    }
  }

  observeSqlite(operation: CheckpointSqliteOperation, elapsedMs: number): void {
    if (this.active !== undefined) observeTiming(this.active.sqlite[operation], elapsedMs);
  }

  clockMs(): number {
    return this.now();
  }

  report(): CheckpointTraceReport {
    return {
      observedCount: this.observedCount,
      thresholdMs: this.thresholdMs,
      thresholdExceededCount: this.thresholdExceededCount,
      retainedSlowestLimit: this.retainedSlowestLimit,
      states: {
        partial: copyTimingAggregate(this.states.partial),
        complete: copyTimingAggregate(this.states.complete),
      },
      sqlite: copySqliteTimings(this.sqlite),
      slowest: this.slowest.map((sample) => ({
        ...sample,
        sqlite: copySqliteTimings(sample.sqlite),
        resourceUsage: { ...sample.resourceUsage },
      })),
    };
  }
}

export function instrumentCheckpointDatabase(
  database: SqliteDatabase,
  collector: CheckpointDiagnosticsCollector,
): SqliteDatabase {
  return new Proxy(database, {
    get(target, property): unknown {
      if (property === "prepare") {
        return (source: string): SqliteStatement => instrumentCheckpointStatement(
          target.prepare(source),
          collector,
        );
      }
      if (property === "transaction") {
        return <Args extends unknown[], Result>(work: (...args: Args) => Result) => {
          let callbackElapsedMs = 0;
          const transaction = target.transaction((...args: Args): Result => {
            const callbackStartedAtMs = collector.clockMs();
            try {
              return work(...args);
            } finally {
              callbackElapsedMs = collector.clockMs() - callbackStartedAtMs;
            }
          });
          return (...args: Args): Result => {
            callbackElapsedMs = 0;
            const transactionStartedAtMs = collector.clockMs();
            try {
              return transaction(...args);
            } finally {
              const transactionElapsedMs = collector.clockMs() - transactionStartedAtMs;
              collector.observeSqlite("transaction", transactionElapsedMs);
              collector.observeSqlite("transactionCallback", callbackElapsedMs);
              collector.observeSqlite(
                "transactionBoundary",
                Math.max(0, transactionElapsedMs - callbackElapsedMs),
              );
            }
          };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function checkpointResourceSnapshot(): CheckpointResourceSnapshot {
  const loadAverage = os.loadavg()[0];
  return {
    loadAverage1m: loadAverage !== undefined && Number.isFinite(loadAverage) && loadAverage >= 0
      ? loadAverage
      : null,
    freeMemoryBytes: safeNonNegativeInteger(os.freemem()),
    totalMemoryBytes: safeNonNegativeInteger(os.totalmem()),
    processRssBytes: safeNonNegativeInteger(process.memoryUsage().rss),
  };
}

export function checkpointSqliteConfiguration(
  database: SqliteDatabase,
): CheckpointDiagnostics["sqliteConfiguration"] {
  const journalMode = database.pragma("journal_mode", { simple: true });
  const normalizedJournalMode = typeof journalMode === "string" ? journalMode.toLowerCase() : "unknown";
  return {
    journalMode: isAllowedJournalMode(normalizedJournalMode) ? normalizedJournalMode : "unknown",
    synchronous: safePragmaNumber(database.pragma("synchronous", { simple: true })),
    busyTimeoutMs: safePragmaNumber(database.pragma("busy_timeout", { simple: true })),
    walAutocheckpointPages: safePragmaNumber(database.pragma("wal_autocheckpoint", { simple: true })),
    pageSizeBytes: safePragmaNumber(database.pragma("page_size", { simple: true })),
  };
}

export async function checkpointFilesystem(
  databasePath: string,
): Promise<CheckpointDiagnostics["filesystem"]> {
  const [databaseBytes, walBytes, sharedMemoryBytes, filesystem] = await Promise.all([
    fileSize(databasePath),
    fileSize(`${databasePath}-wal`),
    fileSize(`${databasePath}-shm`),
    statfs(path.dirname(databasePath)).catch(() => undefined),
  ]);
  const blockSizeBytes = filesystem === undefined ? null : safeNullableInteger(filesystem.bsize);
  const blocks = filesystem === undefined ? null : safeNullableInteger(filesystem.blocks);
  const freeBlocks = filesystem === undefined ? null : safeNullableInteger(filesystem.bfree);
  return {
    databaseBytes,
    walBytes,
    sharedMemoryBytes,
    blockSizeBytes,
    totalBytes: blockSizeBytes === null || blocks === null ? null : safeNullableInteger(blockSizeBytes * blocks),
    freeBytes: blockSizeBytes === null || freeBlocks === null ? null : safeNullableInteger(blockSizeBytes * freeBlocks),
  };
}

function instrumentCheckpointStatement(
  statement: SqliteStatement,
  collector: CheckpointDiagnosticsCollector,
): SqliteStatement {
  return new Proxy(statement, {
    get(target, property): unknown {
      const operation = property === "get"
        ? "statementGet"
        : property === "all"
          ? "statementAll"
          : property === "run"
            ? "statementRun"
            : undefined;
      const value = Reflect.get(target, property, target) as unknown;
      if (operation === undefined || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]): unknown => collector.measureSqlite(
        operation,
        () => Reflect.apply(value, target, args) as unknown,
      );
    },
  });
}

function checkpointProcessResourceUsage(): ResourceUsageSnapshot {
  try {
    return process.resourceUsage();
  } catch {
    return {};
  }
}

function resourceUsageDelta(
  before: Readonly<ResourceUsageSnapshot>,
  after: Readonly<ResourceUsageSnapshot>,
): CheckpointResourceUsageDelta {
  return {
    cpuUserMicros: safeResourceDelta(before, after, "userCPUTime"),
    cpuSystemMicros: safeResourceDelta(before, after, "systemCPUTime"),
    voluntaryContextSwitches: safeResourceDelta(before, after, "voluntaryContextSwitches"),
    involuntaryContextSwitches: safeResourceDelta(before, after, "involuntaryContextSwitches"),
    majorPageFaults: safeResourceDelta(before, after, "majorPageFault"),
    minorPageFaults: safeResourceDelta(before, after, "minorPageFault"),
    filesystemReads: safeResourceDelta(before, after, "fsRead"),
    filesystemWrites: safeResourceDelta(before, after, "fsWrite"),
  };
}

function safeResourceDelta(
  before: Readonly<ResourceUsageSnapshot>,
  after: Readonly<ResourceUsageSnapshot>,
  field: ResourceUsageField,
): number | null {
  const earlier = before[field];
  const later = after[field];
  if (typeof earlier !== "number" || typeof later !== "number") return null;
  const delta = later - earlier;
  return Number.isSafeInteger(delta) && delta >= 0 ? delta : null;
}

function attributedSqliteMs(timings: CheckpointSqliteTimings): number {
  return timings.statementGet.totalMs
    + timings.statementAll.totalMs
    + timings.statementRun.totalMs
    + timings.transactionBoundary.totalMs;
}

function emptyTimingAggregate(): MutableTimingAggregate {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function emptySqliteTimings(): MutableSqliteTimings {
  return {
    statementGet: emptyTimingAggregate(),
    statementAll: emptyTimingAggregate(),
    statementRun: emptyTimingAggregate(),
    transaction: emptyTimingAggregate(),
    transactionCallback: emptyTimingAggregate(),
    transactionBoundary: emptyTimingAggregate(),
  };
}

function resetTimingAggregate(aggregate: MutableTimingAggregate): void {
  aggregate.count = 0;
  aggregate.totalMs = 0;
  aggregate.maxMs = 0;
}

function resetSqliteTimings(timings: MutableSqliteTimings): void {
  for (const aggregate of Object.values(timings)) resetTimingAggregate(aggregate);
}

function observeTiming(aggregate: MutableTimingAggregate, elapsed: number): void {
  aggregate.count += 1;
  aggregate.totalMs += elapsed;
  aggregate.maxMs = Math.max(aggregate.maxMs, elapsed);
}

function copyTimingAggregate(aggregate: Readonly<MutableTimingAggregate>): DiagnosticTimingAggregate {
  return { count: aggregate.count, totalMs: aggregate.totalMs, maxMs: aggregate.maxMs };
}

function copySqliteTimings(timings: Readonly<MutableSqliteTimings | CheckpointSqliteTimings>): CheckpointSqliteTimings {
  return {
    statementGet: copyTimingAggregate(timings.statementGet),
    statementAll: copyTimingAggregate(timings.statementAll),
    statementRun: copyTimingAggregate(timings.statementRun),
    transaction: copyTimingAggregate(timings.transaction),
    transactionCallback: copyTimingAggregate(timings.transactionCallback),
    transactionBoundary: copyTimingAggregate(timings.transactionBoundary),
  };
}

function mergeSqliteTimings(target: MutableSqliteTimings, source: Readonly<MutableSqliteTimings>): void {
  for (const operation of Object.keys(target) as CheckpointSqliteOperation[]) {
    const aggregate = source[operation];
    target[operation].count += aggregate.count;
    target[operation].totalMs += aggregate.totalMs;
    target[operation].maxMs = Math.max(target[operation].maxMs, aggregate.maxMs);
  }
}

function retainSlowest(
  samples: CheckpointDiagnosticSample[],
  candidate: CheckpointDiagnosticSample,
  limit: number,
): void {
  samples.push(candidate);
  samples.sort((left, right) => right.elapsedMs - left.elapsedMs || left.ordinal - right.ordinal);
  if (samples.length > limit) samples.length = limit;
}

function isAllowedJournalMode(
  value: string,
): value is CheckpointDiagnostics["sqliteConfiguration"]["journalMode"] {
  return value === "delete"
    || value === "truncate"
    || value === "persist"
    || value === "memory"
    || value === "wal"
    || value === "off";
}

async function fileSize(filename: string): Promise<number> {
  try {
    return safeNonNegativeInteger((await stat(filename)).size);
  } catch {
    return 0;
  }
}

function safePragmaNumber(value: unknown): number | null {
  return typeof value === "number" ? safeNullableInteger(value) : null;
}

function safeNullableInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeNonNegativeInteger(value: number): number {
  return safeNullableInteger(value) ?? 0;
}
