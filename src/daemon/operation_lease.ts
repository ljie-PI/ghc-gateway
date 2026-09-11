import { randomUUID } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import path from "node:path";
import { captureProcessStartIdentity } from "./process_identity.js";
import {
  DaemonIdentityFileError,
  ProtectedFileSystem,
  sameProtectedFile,
  type ProtectedFileOptions,
} from "./protected_file.js";

const OPERATION_FILE = "daemon.operation.lock";
const MAX_OWNER_BYTES = 4 * 1024;
const POLL_INTERVAL_MS = 50;
const OWNER_KEYS = ["version", "pid", "processStartIdentity", "leaseToken"] as const;

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
  readonly processStartIdentity?: () => Promise<string | null>;
  readonly processIdentity?: (pid: number) => Promise<string | null>;
  readonly createToken?: () => string;
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface OperationOwner {
  readonly version: 1;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly leaseToken: string;
}

export class DaemonOperationLeaseFile implements DaemonOperationLeaseAccess {
  private readonly pid: number;
  private readonly processStartIdentity: () => Promise<string | null>;
  private readonly processIdentity: (pid: number) => Promise<string | null>;
  private readonly createToken: () => string;
  private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly protectedOptions: ProtectedFileOptions;

  constructor(options: Readonly<DaemonOperationLeaseFileOptions> = {}) {
    this.pid = options.pid ?? process.pid;
    this.processStartIdentity = options.processStartIdentity
      ?? (async () => await captureProcessStartIdentity(this.pid));
    this.processIdentity = options.processIdentity ?? captureProcessStartIdentity;
    this.createToken = options.createToken ?? randomUUID;
    this.delay = options.delay ?? abortableDelay;
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
    const processStartIdentity = await this.captureOwnerIdentity();
    const owner: OperationOwner = {
      version: 1,
      pid: this.pid,
      processStartIdentity,
      leaseToken: this.createToken(),
    };
    const files = new ProtectedFileSystem(dataDir, this.protectedOptions);
    files.ensureProtectedDirectory();
    const operationPath = path.join(files.directory, OPERATION_FILE);

    for (;;) {
      signal?.throwIfAborted();
      let fd: number;
      try {
        fd = files.createExclusiveFile(operationPath, `${JSON.stringify(owner)}\n`);
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw normalizeAcquireError(error);
        try {
          await this.waitForOrRecoverOwner(files, operationPath, signal);
        } catch (ownerError: unknown) {
          if (!isNotFound(ownerError) && files.pathExists(operationPath)) {
            throw normalizeAcquireError(ownerError);
          }
        }
        continue;
      }
      return this.ownedLease(files, operationPath, fd, owner);
    }
  }

  private async captureOwnerIdentity(): Promise<string> {
    let identity: string | null;
    try {
      identity = await this.processStartIdentity();
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("unsafe_owner", "unable to verify operation lease owner", { cause: error });
    }
    if (identity === null || !isCanonicalProcessIdentity(identity)) {
      throw new DaemonIdentityFileError("unsafe_owner", "unable to verify operation lease owner");
    }
    return identity;
  }

  private async waitForOrRecoverOwner(
    files: ProtectedFileSystem,
    operationPath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const before = files.assertProtectedRegularFile(operationPath);
    const owner = decodeOperationOwner(files.readProtectedFile(operationPath, MAX_OWNER_BYTES));
    const after = files.assertProtectedRegularFile(operationPath);
    if (!sameProtectedFile(before, after)) return;

    let actual: string | null;
    try {
      actual = await this.processIdentity(owner.pid);
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("unsafe_owner", "unable to verify operation lease owner", { cause: error });
    }
    if (actual === null) {
      const finalBefore = files.assertProtectedRegularFile(operationPath);
      const finalOwner = decodeOperationOwner(files.readProtectedFile(operationPath, MAX_OWNER_BYTES));
      const finalAfter = files.assertProtectedRegularFile(operationPath);
      const unchanged = sameProtectedFile(after, finalBefore)
        && sameProtectedFile(finalBefore, finalAfter)
        && sameOwner(owner, finalOwner);
      if (unchanged) files.unlink(operationPath);
      return;
    }
    if (actual !== owner.processStartIdentity) {
      throw new DaemonIdentityFileError("unsafe_owner", "operation lease owner identity changed");
    }
    await this.delay(POLL_INTERVAL_MS, signal);
  }

  private ownedLease(
    files: ProtectedFileSystem,
    operationPath: string,
    fd: number,
    owner: Readonly<OperationOwner>,
  ): DaemonOperationLeaseHandle {
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        try {
          const held = fstatSync(fd);
          if (files.pathExists(operationPath)) {
            const pathStat = files.assertProtectedRegularFile(operationPath);
            const current = decodeOperationOwner(files.readProtectedFile(operationPath, MAX_OWNER_BYTES));
            const finalStat = files.assertProtectedRegularFile(operationPath);
            if (sameProtectedFile(held, pathStat)
              && sameProtectedFile(pathStat, finalStat)
              && sameOwner(current, owner)) {
              files.unlink(operationPath);
            }
          }
        } finally {
          closeSync(fd);
        }
      },
    };
  }
}

export function decodeOperationOwner(text: string): OperationOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon operation lease JSON", { cause: error });
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, OWNER_KEYS)
    || parsed.version !== 1
    || !isPositiveSafeInteger(parsed.pid)
    || !isCanonicalProcessIdentity(parsed.processStartIdentity)
    || typeof parsed.leaseToken !== "string" || parsed.leaseToken.length === 0) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon operation lease schema");
  }
  return {
    version: 1,
    pid: parsed.pid,
    processStartIdentity: parsed.processStartIdentity,
    leaseToken: parsed.leaseToken,
  };
}

function sameOwner(left: Readonly<OperationOwner>, right: Readonly<OperationOwner>): boolean {
  return left.version === right.version
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.leaseToken === right.leaseToken;
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

function isCanonicalProcessIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9]\d*)$/u.test(value)
    || /^windows:(0|[1-9]\d{0,19})$/u.test(value)) return true;
  const macOs = /^macos:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/u.exec(value);
  if (macOs?.[1] === undefined) return false;
  const milliseconds = Date.parse(macOs[1]);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().replace(".000Z", "Z") === macOs[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
