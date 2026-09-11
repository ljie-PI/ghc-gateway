import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  captureProcessStartIdentity,
  isCanonicalProcessStartIdentity,
  type ProcessIdentityContext,
} from "./process_identity.js";
import {
  DaemonIdentityFileError,
  ProtectedFileSystem,
  type ProtectedFileOptions,
} from "./protected_file.js";

const OPERATION_DATABASE = "daemon.operation.db";
const OPERATION_OWNER = "daemon.operation.owner.json";
const OPERATION_OWNER_TEMP = ".daemon.operation.owner.json.tmp";
const OPERATION_DATABASE_INIT_PREFIX = ".daemon.operation.db.init-";
const MAX_DATABASE_INIT_TEMPS = 16;
const MAX_OWNER_BYTES = 4 * 1024;
const POLL_INTERVAL_MS = 50;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const OWNER_KEYS = ["version", "state", "pid", "processStartIdentity", "leaseToken"] as const;
const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

export interface DaemonOperationLeaseHandle {
  release(): void;
}

export interface DaemonOperationLeaseContext {
  readonly signal?: AbortSignal;
}

export interface DaemonOperationLeaseAccess {
  acquire(dataDir: string, context?: Readonly<DaemonOperationLeaseContext>): Promise<DaemonOperationLeaseHandle>;
}

export interface DaemonOperationLeaseFileOptions extends ProtectedFileOptions {
  readonly pid?: number;
  readonly write?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  readonly processStartIdentity?: (context?: Readonly<ProcessIdentityContext>) => Promise<string | null>;
  readonly processIdentity?: (
    pid: number,
    context?: Readonly<ProcessIdentityContext>,
  ) => Promise<string | null>;
  readonly createToken?: () => string;
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onInitializationPhase?: (phase: "database_prepared" | "database_published") => void;
  readonly onPhase?: (phase: "os_locked" | "held_published" | "released_published" | "database_closing") => void;
}

export interface OperationOwner {
  readonly version: 1;
  readonly state: "held" | "released";
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly leaseToken: string;
}

export class DaemonOperationLeaseFile implements DaemonOperationLeaseAccess {
  private readonly pid: number;
  private readonly processStartIdentity: (
    context?: Readonly<ProcessIdentityContext>,
  ) => Promise<string | null>;
  private readonly processIdentity: (
    pid: number,
    context?: Readonly<ProcessIdentityContext>,
  ) => Promise<string | null>;
  private readonly createToken: () => string;
  private readonly write: NonNullable<DaemonOperationLeaseFileOptions["write"]>;
  private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly protectedOptions: ProtectedFileOptions;
  private readonly onInitializationPhase: NonNullable<DaemonOperationLeaseFileOptions["onInitializationPhase"]>;
  private readonly onPhase: NonNullable<DaemonOperationLeaseFileOptions["onPhase"]>;

  constructor(options: Readonly<DaemonOperationLeaseFileOptions> = {}) {
    this.pid = options.pid ?? process.pid;
    this.processStartIdentity = options.processStartIdentity
      ?? (async (context) => await captureProcessStartIdentity(this.pid, undefined, context));
    this.processIdentity = options.processIdentity
      ?? (async (pid, context) => await captureProcessStartIdentity(pid, undefined, context));
    this.createToken = options.createToken ?? randomUUID;
    this.write = options.write ?? ((fd, buffer, offset, length, position) =>
      writeSync(fd, buffer, offset, length, position));
    this.delay = options.delay ?? abortableDelay;
    this.onInitializationPhase = options.onInitializationPhase ?? (() => undefined);
    this.onPhase = options.onPhase ?? (() => undefined);
    this.protectedOptions = {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
    };
  }

  async acquire(
    dataDir: string,
    context: Readonly<DaemonOperationLeaseContext> = {},
  ): Promise<DaemonOperationLeaseHandle> {
    const signal = context.signal;
    signal?.throwIfAborted();
    const processStartIdentity = await this.captureOwnerIdentity(signal);
    const held: OperationOwner = {
      version: 1,
      state: "held",
      pid: this.pid,
      processStartIdentity,
      leaseToken: this.createToken(),
    };
    const files = new ProtectedFileSystem(dataDir, this.protectedOptions);
    files.ensureProtectedDirectory();
    const databasePath = path.join(files.directory, OPERATION_DATABASE);
    const ownerPath = path.join(files.directory, OPERATION_OWNER);
    const tempPath = path.join(files.directory, OPERATION_OWNER_TEMP);
    await this.ensureDatabase(files, databasePath, processStartIdentity);

    for (;;) {
      signal?.throwIfAborted();
      this.assertDatabaseAssets(files, databasePath);
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(databasePath, { timeout: 0 });
        database.exec("BEGIN EXCLUSIVE");
      } catch (error: unknown) {
        database?.close();
        if (isSqliteBusy(error)) {
          await this.delay(POLL_INTERVAL_MS, signal);
          continue;
        }
        throw normalizeAcquireError(error);
      }

      try {
        this.onPhase("os_locked");
        signal?.throwIfAborted();
        this.assertDatabaseAssets(files, databasePath);
        await this.cleanupDatabaseInitTemps(files, databasePath, signal);
        this.cleanupOwnerTemp(files, tempPath);
        await this.verifyPreviousOwner(files, ownerPath, signal);
        this.publishOwner(files, ownerPath, tempPath, held);
        this.onPhase("held_published");
        return this.ownedLease(files, database, ownerPath, tempPath, held);
      } catch (error: unknown) {
        closeDatabase(database);
        throw normalizeAcquireError(error);
      }
    }
  }

  private async ensureDatabase(
    files: ProtectedFileSystem,
    databasePath: string,
    processStartIdentity: string,
  ): Promise<void> {
    if (files.pathExists(databasePath)) {
      files.assertProtectedRegularFile(databasePath);
      return;
    }

    const initPath = path.join(
      files.directory,
      `${OPERATION_DATABASE_INIT_PREFIX}${this.pid}-${Buffer.from(processStartIdentity).toString("base64url")}-${randomUUID()}`,
    );
    let fd: number | undefined;
    try {
      fd = openSync(initPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      writeAllSync(fd, emptyDatabaseImage(), this.write);
      fsyncSync(fd);
      files.protectFile(initPath);
      files.assertProtectedRegularFile(initPath);
      closeSync(fd);
      fd = undefined;
      this.validateDatabase(files, initPath);
      this.onInitializationPhase("database_prepared");
      try {
        linkSync(initPath, databasePath);
        files.flushDirectory();
        this.onInitializationPhase("database_published");
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
      }
      files.assertProtectedRegularFile(databasePath);
      files.unlink(initPath);
    } catch (error: unknown) {
      if (fd !== undefined) closeSync(fd);
      this.cleanupOwnDatabaseInitTemp(files, initPath);
      throw normalizeAcquireError(error);
    }
  }

  private validateDatabase(files: ProtectedFileSystem, databasePath: string): void {
    files.assertProtectedRegularFile(databasePath);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
      if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
        throw new Error("SQLite quick check failed");
      }
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("unsafe_path", "invalid daemon operation database", { cause: error });
    } finally {
      database?.close();
    }
    files.assertProtectedRegularFile(databasePath);
  }

  private cleanupOwnDatabaseInitTemp(files: ProtectedFileSystem, initPath: string): void {
    if (!files.pathExists(initPath)) return;
    try {
      files.assertProtectedRegularFile(initPath);
      files.unlink(initPath);
    } catch {
      // Preserve the original sanitized failure. A later holder validates initialization temps.
    }
  }

  private async cleanupDatabaseInitTemps(
    files: ProtectedFileSystem,
    databasePath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const names = readdirSync(files.directory)
      .filter((name) => name.startsWith(OPERATION_DATABASE_INIT_PREFIX));
    if (names.length > MAX_DATABASE_INIT_TEMPS) {
      throw new DaemonIdentityFileError("unsafe_path", "too many daemon operation database initialization files");
    }
    const databaseStat = files.assertProtectedRegularFile(databasePath);
    for (const name of names) {
      signal?.throwIfAborted();
      const initOwner = decodeDatabaseInitName(name);
      const initPath = path.join(files.directory, name);
      const initStat = files.assertProtectedRegularFile(initPath);
      if (sameFile(databaseStat, initStat)) {
        files.unlink(initPath);
        continue;
      }
      this.validateDatabase(files, initPath);

      let actual: string | null;
      try {
        actual = await this.processIdentity(initOwner.pid, { ...(signal === undefined ? {} : { signal }) });
      } catch (error: unknown) {
        throw new DaemonIdentityFileError("unsafe_owner", "unable to verify database initializer", { cause: error });
      }
      if (actual === initOwner.processStartIdentity) continue;
      files.unlink(initPath);
    }
  }

  private assertDatabaseAssets(files: ProtectedFileSystem, databasePath: string): void {
    files.ensureProtectedDirectory();
    files.assertProtectedRegularFile(databasePath);
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = databasePath + suffix;
      if (files.pathExists(sidecar)) {
        files.assertProtectedRegularFile(sidecar);
        throw new DaemonIdentityFileError("unsafe_path", "unexpected daemon operation database sidecar");
      }
    }
  }

  private cleanupOwnerTemp(files: ProtectedFileSystem, tempPath: string): void {
    if (!files.pathExists(tempPath)) return;
    files.assertProtectedRegularFile(tempPath);
    unlinkSync(tempPath);
    files.flushDirectory();
  }

  private async verifyPreviousOwner(
    files: ProtectedFileSystem,
    ownerPath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!files.pathExists(ownerPath)) return;
    const previous = this.readOwner(files, ownerPath);
    if (previous.state === "released") return;

    let actual: string | null;
    try {
      actual = await this.processIdentity(previous.pid, { ...(signal === undefined ? {} : { signal }) });
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("unsafe_owner", "unable to verify operation lease owner", { cause: error });
    }
    if (actual === null) return;
    if (actual === previous.processStartIdentity) {
      throw new DaemonIdentityFileError("unsafe_owner", "operation lease owner is still active");
    }
    throw new DaemonIdentityFileError("unsafe_owner", "operation lease owner identity changed");
  }

  private captureOwnerIdentity = async (signal: AbortSignal | undefined): Promise<string> => {
    let identity: string | null;
    try {
      identity = await this.processStartIdentity({ ...(signal === undefined ? {} : { signal }) });
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("unsafe_owner", "unable to verify operation lease owner", { cause: error });
    }
    if (identity === null || !isCanonicalProcessStartIdentity(identity)) {
      throw new DaemonIdentityFileError("unsafe_owner", "unable to verify operation lease owner");
    }
    return identity;
  };

  private readOwner(files: ProtectedFileSystem, ownerPath: string): OperationOwner {
    files.assertProtectedRegularFile(ownerPath);
    const owner = decodeOperationOwner(files.readProtectedFile(ownerPath, MAX_OWNER_BYTES));
    files.assertProtectedRegularFile(ownerPath);
    return owner;
  }

  private publishOwner(
    files: ProtectedFileSystem,
    ownerPath: string,
    tempPath: string,
    owner: Readonly<OperationOwner>,
  ): void {
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeAllSync(fd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"), this.write);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      files.protectFile(tempPath);
      files.assertProtectedRegularFile(tempPath);
      renameSync(tempPath, ownerPath);
      files.flushDirectory();
      const published = this.readOwner(files, ownerPath);
      if (!sameOwner(published, owner)) {
        throw new DaemonIdentityFileError("unsafe_owner", "daemon operation owner changed during publication");
      }
    } catch (error: unknown) {
      if (fd !== undefined) closeSync(fd);
      if (files.pathExists(tempPath)) {
        try {
          files.assertProtectedRegularFile(tempPath);
          unlinkSync(tempPath);
          files.flushDirectory();
        } catch {
          // Preserve the original sanitized failure. A later acquisition validates the temp file.
        }
      }
      throw error;
    }
  }

  private ownedLease(
    files: ProtectedFileSystem,
    database: DatabaseSync,
    ownerPath: string,
    tempPath: string,
    held: Readonly<OperationOwner>,
  ): DaemonOperationLeaseHandle {
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        let publicationError: unknown;
        try {
          const current = this.readOwner(files, ownerPath);
          if (!sameOwner(current, held) || current.state !== "held") {
            throw new DaemonIdentityFileError("unsafe_owner", "daemon operation ownership changed before release");
          }
          this.publishOwner(files, ownerPath, tempPath, { ...held, state: "released" });
          this.onPhase("released_published");
        } catch (error: unknown) {
          publicationError = error;
        } finally {
          try {
            this.onPhase("database_closing");
          } finally {
            closeDatabase(database);
          }
        }
        if (publicationError !== undefined) throw normalizeAcquireError(publicationError);
      },
    };
  }
}

export function decodeOperationOwner(text: string): OperationOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon operation owner JSON", { cause: error });
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, OWNER_KEYS)
    || parsed.version !== 1
    || (parsed.state !== "held" && parsed.state !== "released")
    || !isPositiveSafeInteger(parsed.pid)
    || !isCanonicalProcessStartIdentity(parsed.processStartIdentity)
    || typeof parsed.leaseToken !== "string" || parsed.leaseToken.length === 0 || parsed.leaseToken.length > 256) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon operation owner schema");
  }
  return {
    version: 1,
    state: parsed.state,
    pid: parsed.pid,
    processStartIdentity: parsed.processStartIdentity,
    leaseToken: parsed.leaseToken,
  };
}

function sameOwner(left: Readonly<OperationOwner>, right: Readonly<OperationOwner>): boolean {
  return left.version === right.version
    && left.state === right.state
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.leaseToken === right.leaseToken;
}

function decodeDatabaseInitName(name: string): { readonly pid: number; readonly processStartIdentity: string } {
  const match = /^\.daemon\.operation\.db\.init-([1-9]\d*)-([A-Za-z0-9_-]+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.exec(name);
  const pid = Number(match?.[1]);
  const encodedIdentity = match?.[2] ?? "";
  const processStartIdentity = Buffer.from(encodedIdentity, "base64url").toString("utf8");
  if (!Number.isSafeInteger(pid) || pid <= 0
    || Buffer.from(processStartIdentity, "utf8").toString("base64url") !== encodedIdentity
    || !isCanonicalProcessStartIdentity(processStartIdentity)) {
    throw new DaemonIdentityFileError("unsafe_path", "invalid daemon operation database initialization file");
  }
  return { pid, processStartIdentity };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function writeAllSync(
  fd: number,
  buffer: Uint8Array,
  write: NonNullable<DaemonOperationLeaseFileOptions["write"]>,
): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = write(fd, buffer, offset, buffer.byteLength - offset, offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.byteLength - offset) {
      throw new Error("unable to write complete daemon file");
    }
    offset += written;
  }
}

let databaseImage: Buffer | undefined;

function emptyDatabaseImage(): Buffer {
  if (databaseImage !== undefined) return databaseImage;
  const memory = new DatabaseSync(":memory:");
  try {
    databaseImage = Buffer.from((memory as unknown as { serialize(): Uint8Array }).serialize());
    return databaseImage;
  } finally {
    memory.close();
  }
}

function closeDatabase(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // close() also releases the OS lock if SQLite already rolled the transaction back.
  } finally {
    database.close();
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  const code = error.errcode;
  return typeof code === "number"
    && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

function normalizeAcquireError(error: unknown): unknown {
  if (error instanceof DaemonIdentityFileError) return error;
  return new DaemonIdentityFileError("io_error", "unable to acquire daemon operation lease", { cause: error });
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
