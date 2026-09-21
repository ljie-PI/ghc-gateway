import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AgentError, type AgentId, type AgentMapping } from "./types.js";
import { assertNoLinks, assertPrivate, exists, privateDirectory, protect, syncDirectory, type FileImage } from "./files.js";
import { timestampBackupPattern } from "./backups.js";

const Image = Type.Union([Type.Null(), Type.Object({
  bytes: Type.String({ maxLength: 1_398_104, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
  mode: Type.Integer({ minimum: 0, maximum: 511 }), acl: Type.Union([Type.Null(), Type.String({ maxLength: 16384 })]),
}, { additionalProperties: false })]);
const Mapping = Type.Object({ displayName: Type.String({ maxLength: 80 }), modelId: Type.String({ maxLength: 128 }) }, { additionalProperties: false });
const Backup = Type.Object({
  path: Type.String({ maxLength: 4096 }), digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, { additionalProperties: false });
const Target = Type.Object({
  path: Type.String({ maxLength: 4096 }), original: Image, expected: Image,
  backups: Type.Optional(Type.Array(Backup, { maxItems: 365 })),
}, { additionalProperties: false });
const Step = Type.Object({
  target: Type.Integer({ minimum: 0, maximum: 3 }), before: Image, after: Image,
  scratch: Type.String({ maxLength: 4096 }),
  backup: Type.Optional(Type.String({ maxLength: 4096 })),
  phase: Type.Union([Type.Literal("planned"), Type.Literal("displaced"), Type.Literal("published")]),
}, { additionalProperties: false });
const StateSchema = Type.Object({
  version: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)]), revision: Type.Integer({ minimum: 0 }),
  targets: Type.Array(Target, { maxItems: 4 }), mappings: Type.Array(Mapping, { maxItems: 16 }),
  lastAppliedAt: Type.Union([Type.Null(), Type.String({ maxLength: 40 })]),
  pending: Type.Union([Type.Null(), Type.Object({
    kind: Type.Union([Type.Literal("apply"), Type.Literal("restore")]),
    steps: Type.Array(Step, { minItems: 1, maxItems: 4 }),
    garbage: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 2 }),
  }, { additionalProperties: false })]),
}, { additionalProperties: false });
export type AgentState = Static<typeof StateSchema>;
export type StepState = NonNullable<AgentState["pending"]>["steps"][number];
export function emptyState(): AgentState {
  return { version: 4, revision: 0, targets: [], mappings: [], lastAppliedAt: null, pending: null };
}

// A separate SQLite exclusive transaction is an OS-backed cross-process mutex.
// It is released by the OS after a crash: no PID files, time-based lock stealing,
// or competing stale-lock unlink races. Journal writes use a different database.
export class AgentStore {
  private migrationChecked = false;
  constructor(
    private readonly root: string,
    private readonly agent: AgentId,
    private readonly legacyRoot?: string,
  ) {}
  private get directory(): string { return path.join(this.root, this.agent); }
  private get statePath(): string { return path.join(this.directory, "state.db"); }

  async read(): Promise<AgentState> {
    await this.migrateLegacyState(false);
    return await this.readCurrent();
  }

  private async readCurrent(): Promise<AgentState> {
    assertNoLinks(this.root);
    if (!exists(this.statePath)) return emptyState();
    await this.checkDirectory();
    return readStateDatabase(this.statePath, this.agent);
  }

  async locked<T>(work: (save: (state: AgentState, beforeCommit?: () => void) => Promise<void>) => Promise<T>): Promise<T> {
    await this.migrateLegacyState(true);
    if (!exists(path.dirname(this.root))) await privateDirectory(path.dirname(this.root));
    await privateDirectory(this.root);
    await privateDirectory(this.directory);
    await this.checkDirectory();
    const lockPath = path.join(this.directory, "lock.db");
    if (exists(lockPath)) await assertPrivate(lockPath, false);
    if (!exists(lockPath)) {
      let created = false;
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        fs.closeSync(fd);
        created = true;
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
      }
      if (created) await protect(lockPath);
    }
    await assertPrivateDatabase(lockPath);
    await assertPrivateDatabaseSidecars(lockPath);
    const lock = new DatabaseSync(lockPath, { timeout: 0 });
    try {
      try { lock.exec("BEGIN EXCLUSIVE"); } catch { throw new AgentError("agent_busy"); }
      return await work((state, beforeCommit) => this.save(state, beforeCommit));
    } finally { lock.close(); }
  }

  private async migrateLegacyState(requireFence: boolean): Promise<void> {
    if (this.migrationChecked) return;
    this.migrationChecked = await this.performLegacyMigration(requireFence);
  }

  private async performLegacyMigration(requireFence: boolean): Promise<boolean> {
    if (this.legacyRoot === undefined || samePath(this.legacyRoot, this.root)) return true;
    const legacyDirectory = path.join(this.legacyRoot, this.agent);
    const legacyStatePath = path.join(legacyDirectory, "state.db");
    const retiredStatePath = `${legacyStatePath}.migrated`;
    if (!exists(legacyStatePath) && !exists(retiredStatePath) && !exists(this.statePath) && !requireFence) return false;

    if (exists(legacyStatePath)) {
      assertNoLinks(this.legacyRoot);
      assertNoLinks(legacyDirectory);
      await assertPrivate(this.legacyRoot, true);
      await assertPrivate(legacyDirectory, true);
      await assertPrivate(legacyStatePath, false);
      const marker = await readMigrationMarker(legacyStatePath);
      if (marker !== null) {
        if (!samePath(marker.target, this.statePath)) throw new AgentError("agent_recovery_required");
        if (exists(retiredStatePath)) await readStateDatabase(retiredStatePath, this.agent);
        if (marker.phase === "complete" && exists(this.statePath)) {
          await readStateDatabase(this.statePath, this.agent);
          return true;
        }
        if (marker.phase === "complete" && !exists(retiredStatePath)) return true;
      }
    }

    if (!exists(this.legacyRoot)) await privateDirectory(this.legacyRoot);
    else await assertPrivate(this.legacyRoot, true);
    if (!exists(legacyDirectory)) await privateDirectory(legacyDirectory);
    else await assertPrivate(legacyDirectory, true);
    assertNoLinks(this.root);
    if (!exists(path.dirname(this.root))) await privateDirectory(path.dirname(this.root));
    await privateDirectory(this.root);
    await privateDirectory(this.directory);

    const legacyLock = await migrationLock(legacyDirectory);
    let currentLock: DatabaseSync | null = null;
    try {
      currentLock = await migrationLock(this.directory);
      if (exists(legacyStatePath)) {
        await assertPrivate(legacyStatePath, false);
        const marker = await readMigrationMarker(legacyStatePath);
        if (marker !== null) {
          if (!samePath(marker.target, this.statePath)) throw new AgentError("agent_recovery_required");
          if (marker.phase === "complete" && exists(this.statePath)) {
            await readStateDatabase(this.statePath, this.agent);
            return true;
          }
          if (marker.phase === "complete" && !exists(retiredStatePath)) return true;
        }
      }

      if (!exists(legacyStatePath) && exists(retiredStatePath)) {
        const retired = await readStateDatabase(retiredStatePath, this.agent);
        await writeMigrationMarker(legacyStatePath, this.statePath, "pending");
        if (exists(this.statePath)) {
          const current = await readStateDatabase(this.statePath, this.agent);
          if (!statesEqual(retired, current)) throw new AgentError("agent_recovery_required");
        } else await publishStateDatabase(this.statePath, retired, this.agent);
        await completeMigrationMarker(legacyStatePath, this.statePath);
        return true;
      }

      const marker = exists(legacyStatePath) ? await readMigrationMarker(legacyStatePath) : null;
      if (marker?.phase === "pending") {
        if (!exists(retiredStatePath)) throw new AgentError("agent_recovery_required");
        const retired = await readStateDatabase(retiredStatePath, this.agent);
        if (exists(this.statePath)) {
          const current = await readStateDatabase(this.statePath, this.agent);
          if (!statesEqual(retired, current)) throw new AgentError("agent_recovery_required");
        } else await publishStateDatabase(this.statePath, retired, this.agent);
        await completeMigrationMarker(legacyStatePath, this.statePath);
        return true;
      }

      if (exists(legacyStatePath)) {
        const legacy = await readStateDatabase(legacyStatePath, this.agent);
        if (exists(this.statePath)) {
          const current = await readStateDatabase(this.statePath, this.agent);
          if (!statesEqual(legacy, current)) throw new AgentError("agent_recovery_required");
        }
        if (exists(retiredStatePath)) {
          const retired = await readStateDatabase(retiredStatePath, this.agent);
          if (!statesEqual(legacy, retired)) throw new AgentError("agent_recovery_required");
        } else await copyStateDatabase(legacyStatePath, retiredStatePath, this.agent);
        await replaceStateWithMigrationMarker(legacyStatePath, this.statePath, "pending");
        if (!exists(this.statePath)) await publishStateDatabase(this.statePath, legacy, this.agent);
        await completeMigrationMarker(legacyStatePath, this.statePath);
        return true;
      }

      await writeMigrationMarker(legacyStatePath, this.statePath, "complete");
      return true;
    } finally {
      currentLock?.close();
      legacyLock.close();
    }
  }

  private async save(state: AgentState, beforeCommit?: () => void): Promise<void> {
    if (!Value.Check(StateSchema, state)) throw new AgentError("agent_recovery_required");
    const normalized = normalizeStateImages(state);
    validateStatePaths(normalized, this.agent);
    await this.checkDirectory();
    if (exists(this.statePath)) await assertPrivateDatabase(this.statePath);
    beforeCommit?.();
    if (!exists(this.statePath)) {
      const fd = fs.openSync(this.statePath, "wx", 0o600);
      fs.closeSync(fd);
      protect(this.statePath);
    }
    await assertPrivateDatabase(this.statePath);
    await assertPrivateDatabaseSidecars(this.statePath);
    const db = new DatabaseSync(this.statePath, { timeout: 0 });
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
      db.prepare("INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(JSON.stringify(normalized));
    } finally { db.close(); }
  }
  private async checkDirectory(): Promise<void> {
    await assertPrivate(this.root, true);
    await assertPrivate(this.directory, true);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = this.statePath + suffix;
      if (exists(sidecar)) {
        await assertPrivateDatabase(sidecar);
      }
    }
  }
}

async function migrationLock(directory: string): Promise<DatabaseSync> {
  await privateDirectory(directory);
  const lockPath = path.join(directory, "lock.db");
  if (!exists(lockPath)) {
    let created = false;
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.closeSync(fd);
      created = true;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
    if (created) protect(lockPath);
  }
  await assertPrivateDatabase(lockPath);
  await assertPrivateDatabaseSidecars(lockPath);
  const lock = new DatabaseSync(lockPath, { timeout: 10_000 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch {
    lock.close();
    throw new AgentError("agent_busy");
  }
}

async function readStateDatabase(statePath: string, agent: AgentId): Promise<AgentState> {
  await assertPrivateDatabase(statePath);
  await assertPrivateDatabaseSidecars(statePath);
  const db = new DatabaseSync(statePath, { readOnly: true, timeout: 0 });
  try {
    const row = db.prepare("SELECT document FROM state WHERE id=1").get();
    if (row === undefined) return emptyState();
    if (typeof row.document !== "string" || row.document.length > 32 * 1024 * 1024) throw new AgentError("agent_recovery_required");
    const state: unknown = JSON.parse(row.document);
    if (!Value.Check(StateSchema, state)) throw new AgentError("agent_recovery_required");
    validateStatePaths(state, agent);
    return normalizeStateImages(state);
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    if (isSqliteBusy(error)) throw new AgentError("agent_busy");
    throw new AgentError("agent_recovery_required");
  } finally { db.close(); }
}

function statesEqual(left: AgentState, right: AgentState): boolean {
  return isDeepStrictEqual(left, right);
}

function normalizeStateImages(state: AgentState): AgentState {
  const image = (value: FileImage | null): FileImage | null => value === null ? null : { ...value, acl: null };
  return {
    ...state,
    targets: state.targets.map((target) => ({
      ...target,
      original: image(target.original),
      expected: image(target.expected),
    })),
    pending: state.pending === null ? null : {
      ...state.pending,
      steps: state.pending.steps.map((step) => ({
        ...step,
        before: image(step.before),
        after: image(step.after),
      })),
    },
  };
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

type MigrationPhase = "pending" | "complete";
interface MigrationMarker { readonly target: string; readonly phase: MigrationPhase }

async function writeMigrationMarker(statePath: string, targetStatePath: string, phase: MigrationPhase): Promise<void> {
  const temporary = `${statePath}.marker`;
  if (exists(temporary)) {
    await assertPrivateDatabase(temporary);
    fs.unlinkSync(temporary);
  }
  const fd = fs.openSync(temporary, "wx", 0o600);
  fs.closeSync(fd);
  protect(temporary);
  await assertPrivateDatabase(temporary);
  await assertPrivateDatabaseSidecars(temporary);
  const db = new DatabaseSync(temporary, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE migration(target TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pending','complete'))); CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
    db.prepare("INSERT INTO migration VALUES(?,?)").run(targetStatePath, phase);
    // Old binaries see an invalid durable state and fail closed instead of
    // recreating a writable authority at the retired location.
    db.prepare("INSERT INTO state VALUES(1,?)").run(markerSentinel(targetStatePath));
  } finally {
    db.close();
  }
  fs.renameSync(temporary, statePath);
  syncDirectory(path.dirname(statePath));
}

async function completeMigrationMarker(statePath: string, targetStatePath: string): Promise<void> {
  await assertPrivateDatabase(statePath);
  const marker = await readMigrationMarker(statePath);
  if (marker?.phase !== "pending" || !samePath(marker.target, targetStatePath)) {
    throw new AgentError("agent_recovery_required");
  }
  await assertPrivateDatabaseSidecars(statePath);
  const db = new DatabaseSync(statePath, { timeout: 0 });
  try {
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    db.prepare("UPDATE migration SET phase='complete'").run();
    db.exec("COMMIT");
  } catch (error: unknown) {
    try { db.exec("ROLLBACK"); } catch { /* The transaction may not have started. */ }
    if (error instanceof AgentError) throw error;
    throw new AgentError("agent_recovery_required");
  } finally { db.close(); }
  syncDirectory(path.dirname(statePath));
}

async function publishStateDatabase(statePath: string, state: AgentState, agent: AgentId): Promise<void> {
  validateStatePaths(state, agent);
  const temporary = `${statePath}.migrating`;
  if (exists(temporary)) {
    await assertPrivateDatabase(temporary);
    fs.unlinkSync(temporary);
  }
  const fd = fs.openSync(temporary, "wx", 0o600);
  fs.closeSync(fd);
  protect(temporary);
  await assertPrivateDatabase(temporary);
  await assertPrivateDatabaseSidecars(temporary);
  const db = new DatabaseSync(temporary, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192; CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
    db.prepare("INSERT INTO state VALUES(1,?)").run(JSON.stringify(state));
  } finally {
    db.close();
  }
  fs.renameSync(temporary, statePath);
  syncDirectory(path.dirname(statePath));
}

async function copyStateDatabase(source: string, target: string, agent: AgentId): Promise<void> {
  await readStateDatabase(source, agent);
  const temporary = `${target}.migrating`;
  if (exists(temporary)) {
    await assertPrivateDatabase(temporary);
    fs.unlinkSync(temporary);
  }
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  protect(temporary);
  await assertPrivateDatabase(temporary);
  const fd = fs.openSync(temporary, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  await readStateDatabase(temporary, agent);
  fs.renameSync(temporary, target);
  syncDirectory(path.dirname(target));
}

async function replaceStateWithMigrationMarker(
  statePath: string,
  targetStatePath: string,
  phase: MigrationPhase,
): Promise<void> {
  await assertPrivateDatabase(statePath);
  await assertPrivateDatabaseSidecars(statePath);
  const db = new DatabaseSync(statePath, { timeout: 0 });
  try {
    db.exec("PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; CREATE TABLE migration(target TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pending','complete')))");
    db.prepare("INSERT INTO migration VALUES(?,?)").run(targetStatePath, phase);
    db.prepare("UPDATE state SET document=? WHERE id=1").run(markerSentinel(targetStatePath));
    db.exec("COMMIT");
  } catch (error: unknown) {
    try { db.exec("ROLLBACK"); } catch { /* The transaction may not have started. */ }
    if (error instanceof AgentError) throw error;
    throw new AgentError("agent_recovery_required");
  } finally { db.close(); }
  syncDirectory(path.dirname(statePath));
}

async function readMigrationMarker(statePath: string): Promise<MigrationMarker | null> {
  await assertPrivateDatabase(statePath);
  await assertPrivateDatabaseSidecars(statePath);
  const db = new DatabaseSync(statePath, { readOnly: true, timeout: 0 });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration'").get();
    if (table === undefined) return null;
    const rows = db.prepare("SELECT target, phase FROM migration LIMIT 2").all();
    const stateRows = db.prepare("SELECT id, document FROM state LIMIT 2").all();
    const row = rows[0];
    const state = stateRows[0];
    if (rows.length !== 1 || stateRows.length !== 1 || row === undefined || state === undefined
      || typeof row.target !== "string" || row.target.length > 4096
      || (row.phase !== "pending" && row.phase !== "complete")
      || state.id !== 1 || state.document !== markerSentinel(row.target)) {
      throw new AgentError("agent_recovery_required");
    }
    return { target: row.target, phase: row.phase };
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    if (isSqliteBusy(error)) throw new AgentError("agent_busy");
    throw new AgentError("agent_recovery_required");
  } finally { db.close(); }
}

function markerSentinel(targetStatePath: string): string {
  return JSON.stringify({ migratedTo: targetStatePath });
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function assertPrivateDatabase(target: string): Promise<void> {
  await assertPrivate(target, false);
  if (fs.lstatSync(target).nlink !== 1) throw new AgentError("agent_unsafe_path");
}

async function assertPrivateDatabaseSidecars(target: string): Promise<void> {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = target + suffix;
    if (exists(sidecar)) await assertPrivateDatabase(sidecar);
  }
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ERR_SQLITE_ERROR" || error.code === "SQLITE_BUSY")
    && "message" in error && typeof error.message === "string" && error.message.includes("database is locked");
}

function validateStatePaths(state: AgentState, agent: AgentId): void {
  if (agent === "codex" && state.targets.length > 0 && state.version !== 3 && state.version !== 4) {
    throw new AgentError("agent_recovery_required");
  }
  const count = state.version === 4 ? agent === "claude" ? 1 : 2
    : agent === "claude" ? state.version === 1 ? 1 : 2
      : state.version === 1 ? 2 : state.version === 2 ? 3 : 4;
  if (state.targets.length !== 0 && state.targets.length !== count) throw new AgentError("agent_recovery_required");
  if (state.version !== 1 && state.pending?.kind === "restore") throw new AgentError("agent_recovery_required");
  if (state.version !== 1 && state.version !== 4 && state.targets.length > 0
    && state.targets[0]!.path !== `${state.targets.at(-1)!.path}.ghcg.bak`) throw new AgentError("agent_recovery_required");
  if (agent === "codex" && state.version === 3 && state.targets.length > 0
    && state.targets[1]!.path !== `${state.targets[2]!.path}.ghcg.bak`) throw new AgentError("agent_recovery_required");
  if (agent === "codex" && state.version === 3 && state.targets.length > 0) {
    const [configBackup, catalogBackup, catalog, config] = state.targets;
    const directory = path.dirname(config!.path);
    if (path.basename(config!.path) !== "config.toml" || path.basename(catalog!.path) !== "models.json"
      || path.dirname(configBackup!.path) !== directory || path.dirname(catalogBackup!.path) !== directory
      || path.dirname(catalog!.path) !== directory || configBackup!.path !== `${config!.path}.ghcg.bak`
      || catalogBackup!.path !== `${catalog!.path}.ghcg.bak`
      || new Set(state.targets.map((target) => target.path)).size !== 4) throw new AgentError("agent_recovery_required");
  }
  for (const target of state.targets) {
    if (!path.isAbsolute(target.path)) throw new AgentError("agent_recovery_required");
    const backups = target.backups ?? [];
    if (state.version !== 4 && backups.length > 0) throw new AgentError("agent_recovery_required");
    if (backups.some((backup) => path.dirname(backup.path) !== path.dirname(target.path)
      || !timestampBackupPattern(path.basename(target.path)).test(path.basename(backup.path)))
      || new Set(backups.map((backup) => backup.path)).size !== backups.length) {
      throw new AgentError("agent_recovery_required");
    }
  }
  const steps = state.pending?.steps ?? [];
  if (new Set(steps.map((step) => step.target)).size !== steps.length) throw new AgentError("agent_recovery_required");
  for (const step of steps) {
    const target = state.targets[step.target];
    if (!target || path.dirname(step.scratch) !== path.dirname(target.path)
      || !new RegExp(`^\\.ghcg-agents-${agent}-[0-9a-f-]{36}$`, "u").test(path.basename(step.scratch))) throw new AgentError("agent_recovery_required");
    if (state.version === 4 && (step.backup === undefined || path.dirname(step.backup) !== path.dirname(target.path)
      || !timestampBackupPattern(path.basename(target.path)).test(path.basename(step.backup)))) {
      throw new AgentError("agent_recovery_required");
    }
  }
  const backups = steps.flatMap((step) => step.backup === undefined ? [] : [step.backup]);
  if (new Set(backups).size !== backups.length) throw new AgentError("agent_recovery_required");
  for (const garbage of state.pending?.garbage ?? []) {
    if (!state.targets.some((target) => path.dirname(target.path) === path.dirname(garbage))
      || !new RegExp(`^\\.ghcg-agents-${agent}-[0-9a-f-]{36}$`, "u").test(path.basename(garbage))) throw new AgentError("agent_recovery_required");
  }
}
export function newImage(bytes: Buffer, original: FileImage | null): FileImage {
  return { bytes: bytes.toString("base64"), mode: original?.mode ?? 0o600, acl: null };
}
export function copyMappings(mappings: readonly AgentMapping[]): AgentMapping[] {
  return mappings.map((row) => ({ displayName: row.displayName, modelId: row.modelId }));
}
