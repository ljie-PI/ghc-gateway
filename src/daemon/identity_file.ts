import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { captureProcessStartIdentity } from "./process_identity.js";
import {
  DaemonIdentityFileError,
  ProtectedFileSystem,
} from "./protected_file.js";

export { DaemonIdentityFileError } from "./protected_file.js";
export type { DaemonIdentityFileErrorCode } from "./protected_file.js";

export interface DaemonIdentity {
  readonly version: 1;
  readonly managed: boolean;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly instanceNonce: string;
  readonly controlToken: string;
  readonly port: number;
  readonly createdAt: string;
}

export interface DaemonIdentityLease {
  readonly identity: DaemonIdentity;
  cleanup(): boolean;
  release(): void;
}

export interface DaemonIdentityFileOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: (file: string, args: readonly string[]) => string;
  readonly processIdentity?: (pid: number) => Promise<string | null>;
}

interface DaemonLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly leaseToken: string;
}

const IDENTITY_KEYS = [
  "version",
  "managed",
  "pid",
  "processStartIdentity",
  "instanceNonce",
  "controlToken",
  "port",
  "createdAt",
] as const;
const MAX_IDENTITY_BYTES = 64 * 1024;
const LOCK_KEYS = ["version", "pid", "processStartIdentity", "leaseToken"] as const;

export class DaemonIdentityFile {
  readonly directory: string;
  readonly path: string;
  private readonly lockPath: string;
  private readonly protectedFiles: ProtectedFileSystem;
  private readonly processIdentity: (pid: number) => Promise<string | null>;

  constructor(directory: string, options: DaemonIdentityFileOptions = {}) {
    this.directory = path.resolve(directory);
    this.path = path.join(this.directory, "daemon.json");
    this.lockPath = path.join(this.directory, "daemon.lock");
    this.protectedFiles = new ProtectedFileSystem(this.directory, options);
    this.processIdentity = options.processIdentity ?? captureProcessStartIdentity;
  }

  read(): DaemonIdentity | null {
    this.ensureProtectedDirectory();
    if (!pathExists(this.path)) {
      return null;
    }
    return decodeDaemonIdentity(this.readProtectedFile(this.path));
  }

  async acquire(identity: DaemonIdentity): Promise<DaemonIdentityLease> {
    const canonical = decodeDaemonIdentity(JSON.stringify(identity));
    this.ensureProtectedDirectory();
    const leaseToken = randomUUID();
    let lockFd: number | undefined;
    try {
      lockFd = await this.createExclusiveLock({
        version: 1,
        pid: canonical.pid,
        processStartIdentity: canonical.processStartIdentity,
        leaseToken,
      });
      if (pathExists(this.path)) {
        this.assertProtectedRegularFile(this.path);
        throw new DaemonIdentityFileError("lease_conflict", "daemon identity already exists");
      }
      this.publish(canonical);
    } catch (error: unknown) {
      if (lockFd !== undefined) {
        this.releaseLock(lockFd, leaseToken);
      }
      if (error instanceof DaemonIdentityFileError) {
        throw error;
      }
      throw new DaemonIdentityFileError("io_error", "unable to acquire daemon identity lease", { cause: error });
    }

    let released = false;
    return {
      identity: canonical,
      cleanup: (): boolean => {
        if (released) {
          return false;
        }
        return this.cleanupOwned(canonical);
      },
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.releaseLock(lockFd, leaseToken);
      },
    };
  }

  async remove(expected: Readonly<DaemonIdentity>): Promise<boolean> {
    this.ensureProtectedDirectory();
    if (!pathExists(this.path)) {
      return false;
    }
    const current = decodeDaemonIdentity(this.readProtectedFile(this.path));
    if (!sameIdentity(current, expected)) {
      return false;
    }
    if (pathExists(this.lockPath)) {
      const owner = this.readLockOwner();
      if (owner.pid !== expected.pid || owner.processStartIdentity !== expected.processStartIdentity
        || !await this.proveLockOwnerDead(owner)) {
        return false;
      }
      if (!this.removeLockIfUnchanged(owner)) {
        return false;
      }
    }
    return this.cleanupOwned(expected);
  }

  private async createExclusiveLock(owner: Readonly<DaemonLockOwner>): Promise<number> {
    if (pathExists(this.lockPath)) {
      await this.recoverDeadLock();
    }
    let fd: number;
    try {
      fd = openSync(
        this.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
    } catch (error: unknown) {
      if (isAlreadyExists(error)) {
        this.assertProtectedRegularFile(this.lockPath);
        throw new DaemonIdentityFileError("lease_conflict", "daemon identity lease is already held");
      }
      throw error;
    }
    try {
      writeSync(fd, `${JSON.stringify(owner)}\n`, 0, "utf8");
      fsyncSync(fd);
      this.protectFile(this.lockPath);
      this.assertProtectedRegularFile(this.lockPath);
      return fd;
    } catch (error: unknown) {
      closeSync(fd);
      unlinkIfExists(this.lockPath);
      throw error;
    }
  }

  private async recoverDeadLock(): Promise<void> {
    const owner = this.readLockOwner();
    if (!await this.proveLockOwnerDead(owner) || !this.removeLockIfUnchanged(owner)) {
      throw new DaemonIdentityFileError("lease_conflict", "daemon identity lease is already held");
    }
  }

  private async proveLockOwnerDead(owner: Readonly<DaemonLockOwner>): Promise<boolean> {
    let actual: string | null;
    try {
      actual = await this.processIdentity(owner.pid);
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("lease_conflict", "unable to verify daemon identity lease owner", { cause: error });
    }
    return actual === null || actual !== owner.processStartIdentity;
  }

  private readLockOwner(): DaemonLockOwner {
    return decodeLockOwner(this.readProtectedFile(this.lockPath));
  }

  private removeLockIfUnchanged(expected: Readonly<DaemonLockOwner>): boolean {
    const before = this.assertProtectedRegularFile(this.lockPath);
    const current = this.readLockOwner();
    const after = this.assertProtectedRegularFile(this.lockPath);
    if (!sameFile(before, after) || !sameLockOwner(current, expected)) {
      return false;
    }
    unlinkSync(this.lockPath);
    this.flushDirectory();
    return true;
  }

  private publish(identity: DaemonIdentity): void {
    const tempPath = path.join(this.directory, `.daemon.json.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeSync(fd, `${JSON.stringify(identity)}\n`, 0, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.protectFile(tempPath);
      this.assertProtectedRegularFile(tempPath);
      linkSync(tempPath, this.path);
      unlinkSync(tempPath);
      this.assertProtectedRegularFile(this.path);
      this.flushDirectory();
    } catch (error: unknown) {
      if (fd !== undefined) {
        closeSync(fd);
      }
      unlinkIfExists(tempPath);
      if (isAlreadyExists(error)) {
        throw new DaemonIdentityFileError("lease_conflict", "daemon identity already exists");
      }
      throw error;
    }
  }

  private cleanupOwned(identity: DaemonIdentity): boolean {
    if (!pathExists(this.path)) {
      return false;
    }
    const before = this.assertProtectedRegularFile(this.path);
    const current = decodeDaemonIdentity(this.readProtectedFile(this.path));
    if (!sameIdentity(current, identity)) {
      return false;
    }
    const after = this.assertProtectedRegularFile(this.path);
    if (!sameFile(before, after)) {
      return false;
    }
    unlinkSync(this.path);
    this.flushDirectory();
    return true;
  }

  private releaseLock(fd: number, leaseToken: string): void {
    try {
      const held = fstatSync(fd);
      if (pathExists(this.lockPath)) {
        const pathStat = this.assertProtectedRegularFile(this.lockPath);
        if (sameFile(held, pathStat) && this.readLockOwner().leaseToken === leaseToken) {
          unlinkSync(this.lockPath);
          this.flushDirectory();
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  private ensureProtectedDirectory(): void {
    this.protectedFiles.ensureProtectedDirectory();
  }

  private readProtectedFile(filePath: string): string {
    return this.protectedFiles.readProtectedFile(filePath, MAX_IDENTITY_BYTES);
  }

  private assertProtectedRegularFile(filePath: string): Stats {
    return this.protectedFiles.assertProtectedRegularFile(filePath);
  }

  private protectFile(filePath: string): void {
    this.protectedFiles.protectFile(filePath);
  }

  private flushDirectory(): void {
    this.protectedFiles.flushDirectory();
  }
}

export function decodeDaemonIdentity(text: string): DaemonIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon identity JSON", { cause: error });
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, IDENTITY_KEYS)
    || parsed.version !== 1
    || typeof parsed.managed !== "boolean"
    || !isPositiveSafeInteger(parsed.pid)
    || !isCanonicalProcessIdentity(parsed.processStartIdentity)
    || !isNonemptyString(parsed.instanceNonce)
    || !isNonemptyString(parsed.controlToken)
    || !isPort(parsed.port)
    || !isCanonicalTimestamp(parsed.createdAt)) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon identity schema");
  }
  return {
    version: 1,
    managed: parsed.managed,
    pid: parsed.pid,
    processStartIdentity: parsed.processStartIdentity,
    instanceNonce: parsed.instanceNonce,
    controlToken: parsed.controlToken,
    port: parsed.port,
    createdAt: parsed.createdAt,
  };
}

function decodeLockOwner(text: string): DaemonLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon lock JSON", { cause: error });
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, LOCK_KEYS)
    || parsed.version !== 1
    || !isPositiveSafeInteger(parsed.pid)
    || !isCanonicalProcessIdentity(parsed.processStartIdentity)
    || !isNonemptyString(parsed.leaseToken)) {
    throw new DaemonIdentityFileError("invalid_identity", "invalid daemon lock schema");
  }
  return {
    version: 1,
    pid: parsed.pid,
    processStartIdentity: parsed.processStartIdentity,
    leaseToken: parsed.leaseToken,
  };
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

function isCanonicalProcessIdentity(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9]\d*)$/u.test(value)
    || /^windows:(0|[1-9]\d{0,19})$/u.test(value)) {
    return true;
  }
  const macOs = /^macos:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/u.exec(value);
  if (macOs?.[1] === undefined) {
    return false;
  }
  const milliseconds = Date.parse(macOs[1]);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().replace(".000Z", "Z") === macOs[1];
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameIdentity(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.version === right.version
    && left.managed === right.managed
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.instanceNonce === right.instanceNonce
    && left.controlToken === right.controlToken
    && left.port === right.port
    && left.createdAt === right.createdAt;
}

function sameLockOwner(left: Readonly<DaemonLockOwner>, right: Readonly<DaemonLockOwner>): boolean {
  return left.version === right.version
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.leaseToken === right.leaseToken;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function unlinkIfExists(target: string): void {
  try {
    unlinkSync(target);
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
