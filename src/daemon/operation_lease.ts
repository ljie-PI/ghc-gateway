import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
  readonly processStartIdentity?: (context?: Readonly<ProcessIdentityContext>) => Promise<string | null>;
  readonly processIdentity?: (
    pid: number,
    context?: Readonly<ProcessIdentityContext>,
  ) => Promise<string | null>;
  readonly createToken?: () => string;
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly protectedOptions: ProtectedFileOptions;
  private readonly onPhase: NonNullable<DaemonOperationLeaseFileOptions["onPhase"]>;

  constructor(options: Readonly<DaemonOperationLeaseFileOptions> = {}) {
    this.pid = options.pid ?? process.pid;
    this.processStartIdentity = options.processStartIdentity
      ?? (async (context) => await captureProcessStartIdentity(this.pid, undefined, context));
    this.processIdentity = options.processIdentity
      ?? (async (pid, context) => await captureProcessStartIdentity(pid, undefined, context));
    this.createToken = options.createToken ?? randomUUID;
    this.delay = options.delay ?? abortableDelay;
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
    this.ensureDatabase(files, databasePath);

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

  private ensureDatabase(files: ProtectedFileSystem, databasePath: string): void {
    if (!files.pathExists(databasePath)) {
      let fd: number | undefined;
      try {
        fd = openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
        writeSync(fd, emptyDatabaseImage());
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        files.protectFile(databasePath);
        files.assertProtectedRegularFile(databasePath);
        files.flushDirectory();
      } catch (error: unknown) {
        if (fd !== undefined) closeSync(fd);
        if (!isAlreadyExists(error)) throw normalizeAcquireError(error);
      }
    }
    files.assertProtectedRegularFile(databasePath);
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
      writeSync(fd, `${JSON.stringify(owner)}\n`, 0, "utf8");
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
