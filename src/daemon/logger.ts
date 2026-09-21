import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LogLevel } from "../config/startup_config.js";
import { LOG_LINE_LIMIT_BYTES, sanitizeMetadata, utf8Bytes } from "../telemetry/sanitize.js";
import { DiagnosticRecorder, DIAGNOSTIC_LIMITS, sanitizeDiagnosticRecord, type DiagnosticRecord } from "../telemetry/diagnostics.js";

export const LOG_FILE_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const PRUNE_STATE_MAX_BYTES = 1024;
type LogChannel = "gateway" | "diagnostics";

export function createFileDiagnostics(directory: string, onFailure?: () => void): DiagnosticRecorder {
  const file = new JsonlLogger(directory, Date.now, { channel: "diagnostics" });
  return new DiagnosticRecorder({ write: (record) => file.writeDiagnostic(record) }, {
    ...(onFailure === undefined ? {} : { onFailure }),
  });
}

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface DaemonLogger {
  write(record: Record<string, unknown>): void;
}

export interface JsonlLoggerOptions {
  readonly channel?: LogChannel;
  readonly onBeforePrune?: (filePath: string) => void;
  readonly onAfterPruneRename?: (filePath: string) => void;
  readonly onPruneCheckpoint?: (checkpoint: PruneCheckpoint) => void;
}

type PruneCheckpoint =
  | "state-temporary"
  | "state-published"
  | "candidate-renamed"
  | "commit-temporary"
  | "commit-published"
  | "candidate-unlinked";

interface PruneState {
  readonly version: 1;
  readonly originalName: string;
  readonly candidateName: string;
  readonly observation: FileObservation;
}

interface FileObservation {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly nlink: number;
}

export class JsonlLogger implements DaemonLogger {
  private rotationSequence = 0;
  private readonly channel: LogChannel;

  constructor(
    private readonly directory: string,
    private readonly nowMs: () => number = Date.now,
    private readonly options: Readonly<JsonlLoggerOptions> = {},
    private readonly threshold: LogLevel = "info",
  ) {
    this.channel = options.channel ?? "gateway";
    if (this.channel !== "gateway" && this.channel !== "diagnostics") throw new Error("invalid log channel");
    const existed = pathExists(directory);
    if (!existed) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32" && !existed) {
      chmodSync(directory, 0o700);
    }
    assertSafeDirectory(directory);
    this.prune();
  }

  write(record: Record<string, unknown>): void {
    if (this.channel !== "gateway") throw new Error("diagnostic records require the typed writer");
    if (!shouldWrite(record, this.threshold)) {
      return;
    }
    const sanitized = sanitizeMetadata(record);
    const category = typeof record.category === "string" && /^[a-z0-9_]+$/u.test(record.category)
      ? record.category
      : undefined;
    const managed = typeof record.managed === "boolean" ? record.managed : undefined;
    const pid = typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
      ? record.pid
      : undefined;
    const timestamp = this.nowMs();
    let line = JSON.stringify({
      ts: timestamp,
      ...(category === undefined ? {} : { category }),
      ...(managed === undefined ? {} : { managed }),
      ...(pid === undefined ? {} : { pid }),
      ...logLevel(record),
      ...sanitized,
    });
    if (utf8Bytes(line) > LOG_LINE_LIMIT_BYTES) {
      line = JSON.stringify({ ts: timestamp, overflow: true, reason: "log_line_truncated" });
    }
    this.appendLine(line, timestamp);
  }

  writeDiagnostic(record: Readonly<DiagnosticRecord>): void {
    if (this.channel !== "diagnostics") throw new Error("diagnostic log channel required");
    const line = JSON.stringify(sanitizeDiagnosticRecord(record));
    if (utf8Bytes(line) + 1 > DIAGNOSTIC_LIMITS.recordBytes) throw new Error("diagnostic record exceeds limit");
    this.appendLine(line, this.nowMs());
  }

  private appendLine(line: string, timestamp: number): void {
    this.prune();
    const encoded = `${line}\n`;
    const active = this.activeFile();
    if (fileSize(active) + utf8Bytes(encoded) > LOG_FILE_BYTES) {
      this.rotate(active, timestamp);
    }
    appendProtected(active, encoded);
    this.prune();
  }

  private activeFile(): string {
    return path.join(this.directory, `${this.channel}.jsonl`);
  }

  private rotate(active: string, timestamp: number): void {
    if (fileSize(active) === 0) {
      return;
    }
    let rotated: string;
    do {
      rotated = path.join(this.directory, `${this.channel}.${timestamp}.${this.rotationSequence}.jsonl`);
      this.rotationSequence += 1;
    } while (pathExists(rotated));
    renameSync(active, rotated);
  }

  private prune(): void {
    this.recoverPrune();
    const now = this.nowMs();
    const files = readdirSync(this.directory)
      .filter((name) => new RegExp(`^${this.channel}\\.\\d+\\.\\d+\\.jsonl$`, "u").test(name))
      .map((name) => path.join(this.directory, name))
      .map((file) => ({ file, stat: assertSafeFile(file) }))
      .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
    for (const entry of files) {
      if (now - entry.stat.mtimeMs > LOG_MAX_AGE_MS) {
        this.pruneObservedFile(entry.file, entry.stat);
      }
    }
    const active = this.activeFile();
    if (pathExists(active)) {
      const activeStat = assertSafeFile(active);
      if (now - activeStat.mtimeMs > LOG_MAX_AGE_MS) {
        this.pruneObservedFile(active, activeStat);
      }
    }
    const retained = files.filter(({ file }) => pathExists(file));
    for (const entry of retained.slice(0, Math.max(0, retained.length - (LOG_FILE_COUNT - 1)))) {
      this.pruneObservedFile(entry.file, entry.stat);
    }
  }

  private pruneObservedFile(filePath: string, observed: Stats): void {
    this.options.onBeforePrune?.(filePath);
    const current = assertSafeFile(filePath);
    if (!sameFileObservation(observed, current)) return;
    const statePath = this.pruneStatePath();
    const candidateName = `.${this.channel}-prune-${randomUUID()}.jsonl`;
    const quarantined = path.join(this.directory, candidateName);
    if (pathExists(quarantined)) throw new Error("log prune quarantine already exists");
    const stateStat = publishPruneState(statePath, this.pruneStateTempPath(), {
      version: 1,
      originalName: path.basename(filePath),
      candidateName,
      observation: observeFile(current),
    }, () => this.options.onPruneCheckpoint?.("state-temporary"));
    this.options.onPruneCheckpoint?.("state-published");
    try {
      renameSync(filePath, quarantined);
    } catch (error: unknown) {
      unlinkObservedFile(statePath, stateStat);
      if (isNotFound(error)) return;
      throw error;
    }
    fsyncContainingDirectory(quarantined);
    const moved = assertSafeFile(quarantined);
    if (!sameFileAfterRename(current, moved)) {
      throw new Error("log file changed during prune rename");
    }
    this.options.onPruneCheckpoint?.("candidate-renamed");
    const commitPath = this.pruneCommitPath();
    const commitStat = publishPruneState(commitPath, this.pruneCommitTempPath(), {
      version: 1,
      originalName: path.basename(filePath),
      candidateName,
      observation: observeFile(moved),
    }, () => this.options.onPruneCheckpoint?.("commit-temporary"));
    this.options.onPruneCheckpoint?.("commit-published");
    this.options.onAfterPruneRename?.(filePath);
    const verified = assertSafeFile(quarantined);
    if (!sameFileObservation(moved, verified)) {
      throw new Error("log file changed in prune quarantine");
    }
    unlinkPrunePath(quarantined);
    this.options.onPruneCheckpoint?.("candidate-unlinked");
    unlinkObservedFile(commitPath, commitStat);
    unlinkObservedFile(statePath, stateStat);
  }

  private recoverPrune(): void {
    const statePath = this.pruneStatePath();
    const commitPath = this.pruneCommitPath();
    recoverPruneStateTemporary(this.pruneStateTempPath(), pathExists(statePath), pathExists(commitPath), this.channel);
    const prepared = pathExists(statePath) ? readPruneState(statePath) : undefined;
    recoverPruneCommitTemporary(this.pruneCommitTempPath(), pathExists(commitPath), prepared?.state, this.channel);
    const committed = pathExists(commitPath) ? readPruneState(commitPath) : undefined;
    if (prepared === undefined && committed === undefined) return;
    const transaction = committed?.state ?? prepared?.state;
    if (transaction === undefined) return;
    assertPruneOriginalName(transaction.originalName, this.channel);
    assertPruneCandidateName(transaction.candidateName, this.channel);
    const quarantined = path.join(this.directory, transaction.candidateName);
    if (prepared === undefined && pathExists(quarantined)) {
      throw new Error("log prune commit is missing its prepared state");
    }
    if (prepared !== undefined && committed !== undefined
      && (prepared.state.originalName !== committed.state.originalName
        || prepared.state.candidateName !== committed.state.candidateName
        || !matchesAfterRenameObservation(committed.state.observation, prepared.state.observation))) {
      throw new Error("log prune records do not describe the same transaction");
    }
    if (!pathExists(quarantined)) {
      if (committed !== undefined) unlinkObservedFile(commitPath, committed.stat);
      if (prepared !== undefined) unlinkObservedFile(statePath, prepared.stat);
      return;
    }
    const moved = assertSafeFile(quarantined);
    const matchesTransaction = committed === undefined
      ? matchesAfterRename(moved, transaction.observation)
      : matchesObservation(moved, transaction.observation);
    if (!matchesTransaction) {
      throw new Error("log prune quarantine changed during recovery");
    }
    const verified = assertSafeFile(quarantined);
    if (!sameFileObservation(moved, verified)) {
      throw new Error("log prune quarantine changed during recovery");
    }
    unlinkPrunePath(quarantined);
    if (committed !== undefined) unlinkObservedFile(commitPath, committed.stat);
    if (prepared !== undefined) unlinkObservedFile(statePath, prepared.stat);
  }

  private pruneStatePath(): string {
    return path.join(this.directory, `.${this.channel}-prune-state.json`);
  }

  private pruneCommitPath(): string {
    return path.join(this.directory, `.${this.channel}-prune-commit.json`);
  }

  private pruneStateTempPath(): string {
    return path.join(this.directory, `.${this.channel}-prune-state.json.tmp`);
  }

  private pruneCommitTempPath(): string {
    return path.join(this.directory, `.${this.channel}-prune-commit.json.tmp`);
  }

}

export class StderrLogger implements DaemonLogger {
  constructor(
    private readonly stream: { write(chunk: string): unknown },
    private readonly nowMs: () => number = Date.now,
    private readonly threshold: LogLevel = "info",
  ) {}

  write(record: Record<string, unknown>): void {
    if (!shouldWrite(record, this.threshold)) {
      return;
    }
    const category = typeof record.category === "string" && /^[a-z0-9_]+$/u.test(record.category)
      ? record.category
      : undefined;
    this.stream.write(`${JSON.stringify({
      ts: this.nowMs(),
      ...(category === undefined ? {} : { category }),
      ...logLevel(record),
      ...sanitizeMetadata(record),
    })}\n`);
  }
}

function shouldWrite(record: Readonly<Record<string, unknown>>, threshold: LogLevel): boolean {
  const level = isLogLevel(record.level) ? record.level : "info";
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[threshold];
}

function logLevel(record: Readonly<Record<string, unknown>>): { readonly level?: LogLevel } {
  return isLogLevel(record.level) ? { level: record.level } : {};
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error";
}

function appendProtected(filePath: string, value: string): void {
  const existed = pathExists(filePath);
  const before = existed ? assertSafeFile(filePath) : undefined;
  const noFollow = process.platform === "win32"
    ? 0
    : ((constants as Readonly<Record<string, number>>)["O_NOFOLLOW"] ?? 0);
  const fd = openSync(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
  try {
    if (process.platform !== "win32" && !existed) {
      fchmodSync(fd, 0o600);
    }
    const opened = fstatSync(fd);
    const pathStat = assertSafeFile(filePath);
    if (!opened.isFile()
      || (before !== undefined && !sameFile(before, opened))
      || !sameFile(opened, pathStat)) {
      throw new Error("log file changed during validation");
    }
    appendFileSync(fd, value, "utf8");
  } finally {
    closeSync(fd);
  }
}

function assertSafeDirectory(target: string): void {
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("log directory must be a regular directory");
  }
  assertOwner(stat.uid);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw new Error("log directory permissions must be 0700");
  }
}

function assertSafeFile(target: string): Stats {
  const stat: Stats = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("log path must be a regular file");
  }
  assertOwner(stat.uid);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw new Error("log file permissions must be 0600");
  }
  return stat;
}

function assertOwner(uid: number): void {
  if (process.platform !== "win32" && typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("log path must be owned by the current user");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileObservation(left: Stats, right: Stats): boolean {
  return sameFile(left, right)
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.nlink === right.nlink;
}

function sameFileAfterRename(left: Stats, right: Stats): boolean {
  return sameFile(left, right)
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.nlink === right.nlink;
}

function observeFile(stat: Stats): FileObservation {
  return {
    dev: stat.dev,
    ino: stat.ino,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    nlink: stat.nlink,
  };
}

function matchesAfterRename(stat: Stats, observation: FileObservation): boolean {
  return stat.dev === observation.dev
    && stat.ino === observation.ino
    && stat.mtimeMs === observation.mtimeMs
    && stat.size === observation.size
    && stat.nlink === observation.nlink;
}

function matchesObservation(stat: Stats, observation: FileObservation): boolean {
  return matchesAfterRename(stat, observation) && stat.ctimeMs === observation.ctimeMs;
}

function matchesAfterRenameObservation(left: FileObservation, right: FileObservation): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.nlink === right.nlink;
}

function publishPruneState(
  filePath: string,
  temporaryPath: string,
  state: PruneState,
  onTemporary: () => void,
): Stats {
  if (pathExists(filePath)) throw new Error("log prune state already exists");
  const encoded = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
  if (encoded.length > PRUNE_STATE_MAX_BYTES) throw new Error("log prune state is too large");
  const temporary = writePruneStateTemporary(temporaryPath, encoded);
  onTemporary();
  if (pathExists(filePath)) throw new Error("log prune state appeared during publication");
  renamePrunePath(temporaryPath, filePath);
  const published = assertSafeFile(filePath);
  if (!sameFileAfterRename(temporary, published)) {
    throw new Error("log prune state changed during publication");
  }
  return published;
}

function writePruneStateTemporary(filePath: string, encoded: Buffer): Stats {
  const noFollow = process.platform === "win32"
    ? 0
    : ((constants as Readonly<Record<string, number>>)["O_NOFOLLOW"] ?? 0);
  const fd = openSync(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  let opened: Stats | undefined;
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < encoded.length) {
      const written = writeSync(fd, encoded, offset, encoded.length - offset, offset);
      if (written === 0) throw new Error("unable to write complete log prune state");
      offset += written;
    }
    fsyncSync(fd);
    opened = fstatSync(fd);
    const named = assertSafeFile(filePath);
    if (!opened.isFile() || opened.size !== encoded.length || !sameFileObservation(opened, named)) {
      throw new Error("log prune state changed during publication");
    }
  } catch (error: unknown) {
    try {
      const named = assertSafeFile(filePath);
      const current = opened ?? fstatSync(fd);
      if (sameFileObservation(current, named)) unlinkPrunePath(filePath);
    } catch {
      // Preserve the original failure; a later recovery handles any published state.
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  const validated = readPruneStateBytes(filePath);
  if (opened === undefined || !sameFileObservation(opened, validated.stat) || !validated.value.equals(encoded)) {
    throw new Error("log prune state changed during validation");
  }
  return validated.stat;
}

function readPruneState(filePath: string): { readonly state: PruneState; readonly stat: Stats } {
  const record = readPruneStateBytes(filePath);
  return { state: parsePruneState(record.value.toString("utf8")), stat: record.stat };
}

function readPruneStateBytes(filePath: string): { readonly value: Buffer; readonly stat: Stats } {
  settleWindowsFileMetadata(filePath);
  const before = assertSafeFile(filePath);
  if (before.size > PRUNE_STATE_MAX_BYTES) throw new Error("log prune state is too large");
  const noFollow = process.platform === "win32"
    ? 0
    : ((constants as Readonly<Record<string, number>>)["O_NOFOLLOW"] ?? 0);
  const fd = openSync(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileObservation(before, opened)) {
      throw new Error("log prune state changed during validation");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) throw new Error("unable to read complete log prune state");
    const after = fstatSync(fd);
    const named = assertSafeFile(filePath);
    if (!sameFileObservation(opened, after) || !sameFileObservation(after, named)) {
      throw new Error("log prune state changed during read");
    }
    return { value: buffer, stat: named };
  } finally {
    closeSync(fd);
  }
}

function recoverPruneStateTemporary(
  filePath: string,
  finalExists: boolean,
  commitExists: boolean,
  channel: LogChannel,
): void {
  if (!pathExists(filePath)) return;
  if (finalExists || commitExists) {
    throw new Error("log prune temporary conflicts with transaction state");
  }
  const temporary = readPruneStateBytes(filePath);
  const state = parsePruneStateIfComplete(temporary.value);
  if (state !== undefined) {
    assertPruneOriginalName(state.originalName, channel);
    assertPruneCandidateName(state.candidateName, channel);
    if (pathExists(path.join(path.dirname(filePath), state.candidateName))) {
      throw new Error("log prune temporary conflicts with quarantine");
    }
  }
  unlinkObservedFile(filePath, temporary.stat);
}

function recoverPruneCommitTemporary(
  filePath: string,
  finalExists: boolean,
  prepared: PruneState | undefined,
  channel: LogChannel,
): void {
  if (!pathExists(filePath)) return;
  if (finalExists || prepared === undefined) {
    throw new Error("log prune temporary conflicts with transaction state");
  }
  const temporary = readPruneStateBytes(filePath);
  const committed = parsePruneStateIfComplete(temporary.value);
  if (committed !== undefined) {
    assertPruneOriginalName(committed.originalName, channel);
    assertPruneCandidateName(committed.candidateName, channel);
    if (prepared.originalName !== committed.originalName
      || prepared.candidateName !== committed.candidateName
      || !matchesAfterRenameObservation(committed.observation, prepared.observation)) {
      throw new Error("log prune temporary does not match prepared state");
    }
  }
  unlinkObservedFile(filePath, temporary.stat);
}

function parsePruneStateIfComplete(value: Buffer): PruneState | undefined {
  try {
    return parsePruneState(value.toString("utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function settleWindowsFileMetadata(filePath: string): void {
  if (process.platform !== "win32") return;
  const fd = openSync(filePath, constants.O_RDONLY);
  closeSync(fd);
}

function parsePruneState(value: string): PruneState {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null
    || !("version" in parsed) || parsed.version !== 1
    || !("originalName" in parsed) || typeof parsed.originalName !== "string"
    || !("candidateName" in parsed) || typeof parsed.candidateName !== "string"
    || !("observation" in parsed) || !isFileObservation(parsed.observation)) {
    throw new Error("invalid log prune state");
  }
  return {
    version: 1,
    originalName: parsed.originalName,
    candidateName: parsed.candidateName,
    observation: parsed.observation,
  };
}

function isFileObservation(value: unknown): value is FileObservation {
  if (typeof value !== "object" || value === null) return false;
  return ["dev", "ino", "ctimeMs", "mtimeMs", "size", "nlink"].every((field) => (
    field in value && typeof value[field as keyof typeof value] === "number"
      && Number.isFinite(value[field as keyof typeof value])
  ));
}

function assertPruneOriginalName(originalName: string, channel: LogChannel): void {
  if (originalName !== `${channel}.jsonl` && !new RegExp(`^${channel}\\.\\d+\\.\\d+\\.jsonl$`, "u").test(originalName)) {
    throw new Error("invalid log prune target");
  }
}

function assertPruneCandidateName(candidateName: string, channel: LogChannel): void {
  if (!new RegExp(`^\\.${channel}-prune-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jsonl$`, "u").test(candidateName)) {
    throw new Error("invalid log prune quarantine");
  }
}

function unlinkObservedFile(filePath: string, observed: Stats): void {
  const current = assertSafeFile(filePath);
  if (!sameFileObservation(observed, current)) {
    throw new Error("log prune state changed before cleanup");
  }
  unlinkPrunePath(filePath);
}

function renamePrunePath(source: string, destination: string): void {
  renameSync(source, destination);
  fsyncContainingDirectory(destination);
}

function unlinkPrunePath(filePath: string): void {
  unlinkSync(filePath);
  fsyncContainingDirectory(filePath);
}

function fsyncContainingDirectory(filePath: string): void {
  if (process.platform === "win32") return;
  const directoryFd = openSync(path.dirname(filePath), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function fileSize(filePath: string): number {
  try {
    return assertSafeFile(filePath).size;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
