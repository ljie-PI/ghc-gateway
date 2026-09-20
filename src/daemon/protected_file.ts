import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { DataDirSource } from "../config/startup_config.js";
import { readProtectedFileSync } from "../security/protected_file_read.js";
import { createWindowsPrivateDirectory, type WindowsDirectoryCommand } from "../security/windows_directory.js";

export type DaemonIdentityFileErrorCode =
  | "invalid_identity"
  | "lease_conflict"
  | "unsafe_path"
  | "unsafe_owner"
  | "unsafe_permissions"
  | "io_error";

export class DaemonIdentityFileError extends Error {
  constructor(
    readonly code: DaemonIdentityFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DaemonIdentityFileError";
  }
}

export interface ProtectedFileOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: WindowsDirectoryCommand;
  readonly dataDirSource?: DataDirSource;
  readonly onProtectedReadBeforeOpen?: (filePath: string) => void;
  readonly onProtectedReadComplete?: (filePath: string) => void;
}

export class ProtectedFileSystem {
  readonly directory: string;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: WindowsDirectoryCommand;
  private readonly dataDirSource: DataDirSource;
  private readonly onProtectedReadBeforeOpen: ProtectedFileOptions["onProtectedReadBeforeOpen"];
  private readonly onProtectedReadComplete: ProtectedFileOptions["onProtectedReadComplete"];

  constructor(directory: string, options: Readonly<ProtectedFileOptions> = {}) {
    this.directory = path.resolve(directory);
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.dataDirSource = options.dataDirSource ?? "custom";
    this.onProtectedReadBeforeOpen = options.onProtectedReadBeforeOpen;
    this.onProtectedReadComplete = options.onProtectedReadComplete;
  }

  ensureProtectedDirectory(): void {
    if (!this.pathExists(this.directory)) {
      if (this.platform === "win32" && this.dataDirSource === "default") {
        createWindowsPrivateDirectory(this.directory, this.runCommand);
      } else {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      }
    }
    this.assertProtectedDirectory();
  }

  assertProtectedDirectory(): void {
    const stat = lstatSync(this.directory);
    this.assertDirectoryStat(stat);
  }

  assertProtectedDirectoryIfExists(): boolean {
    let stat: Stats;
    try {
      stat = lstatSync(this.directory);
    } catch (error: unknown) {
      if (isExactMissingLstat(error, this.directory)) return false;
      throw error;
    }
    this.assertDirectoryStat(stat);
    return true;
  }

  private assertDirectoryStat(stat: Stats): void {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DaemonIdentityFileError("unsafe_path", "daemon directory must be a regular directory");
    }
    this.assertOwner(stat);
    if (this.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
      throw new DaemonIdentityFileError("unsafe_permissions", "daemon directory permissions must be 0700");
    }
  }

  createExclusiveFile(filePath: string, contents: string): number {
    const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      writeSync(fd, contents, 0, "utf8");
      fsyncSync(fd);
      this.protectFile(filePath);
      this.assertProtectedRegularFile(filePath);
      return fd;
    } catch (error: unknown) {
      const held = fstatSync(fd);
      closeSync(fd);
      if (this.pathExists(filePath)) {
        const current = lstatSync(filePath);
        if (sameFile(held, current)) this.unlinkIfExists(filePath);
      }
      throw error;
    }
  }

  readProtectedFile(filePath: string, maximumBytes = 64 * 1024): string {
    return readProtectedFileSync({
      filePath,
      maximumBytes,
      observeBefore: () => this.assertProtectedRegularFile(filePath),
      settleMetadata: this.platform === "win32",
      onBeforeOpen: this.onProtectedReadBeforeOpen,
      onPostRead: this.onProtectedReadComplete,
      errors: {
        open: (cause) => new DaemonIdentityFileError(
          "unsafe_path",
          "unable to safely open daemon file",
          { cause },
        ),
        changed: (phase) => new DaemonIdentityFileError(
          "unsafe_path",
          `daemon file changed during ${phase}`,
        ),
        tooLarge: () => new DaemonIdentityFileError(
          "unsafe_path",
          "daemon file changed during validation",
        ),
        incomplete: () => new DaemonIdentityFileError(
          "io_error",
          "unable to read complete daemon file",
        ),
      },
    }).buffer.toString("utf8");
  }

  assertProtectedRegularFile(filePath: string): Stats {
    const stat = lstatSync(filePath);
    this.assertRegularFile(filePath, stat);
    this.assertOwner(stat);
    if (this.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw new DaemonIdentityFileError("unsafe_permissions", "daemon file permissions must be 0600");
    }
    return stat;
  }

  assertProtectedRegularFileIdentity(filePath: string): BigIntStats {
    const stat = lstatSync(filePath, { bigint: true });
    this.assertRegularFile(filePath, stat);
    this.assertOwner(stat);
    if (this.platform !== "win32" && (stat.mode & 0o777n) !== 0o600n) {
      throw new DaemonIdentityFileError("unsafe_permissions", "daemon file permissions must be 0600");
    }
    return stat;
  }

  pathExists(target: string): boolean {
    try {
      lstatSync(target);
      return true;
    } catch (error: unknown) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  unlink(filePath: string): void {
    unlinkSync(filePath);
    this.flushDirectory();
  }

  unlinkIfExists(filePath: string): void {
    try {
      unlinkSync(filePath);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
    }
  }

  flushDirectory(): void {
    if (this.platform === "win32") return;
    const fd = openSync(this.directory, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private assertRegularFile(filePath: string, stat: Stats | BigIntStats): void {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DaemonIdentityFileError("unsafe_path", "daemon path must be a regular file");
    }
  }

  private assertOwner(stat: Stats | BigIntStats): void {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const expected = typeof stat.uid === "bigint" && uid !== undefined ? BigInt(uid) : uid;
    if (this.platform !== "win32" && uid !== undefined && stat.uid !== expected) {
      throw new DaemonIdentityFileError("unsafe_owner", "daemon path must be owned by the current user");
    }
  }

  protectFile(filePath: string): void {
    if (this.platform !== "win32") {
      chmodSync(filePath, 0o600);
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExactMissingLstat(error: unknown, target: string): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "ENOENT"
    && "syscall" in error && error.syscall === "lstat"
    && "path" in error && error.path === target;
}

const WINDOWS_DIRECTORY_COMMAND_TIMEOUT_MS = 15_000;
const WINDOWS_DIRECTORY_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;

function defaultRunCommand(
  file: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
  timeoutMs = WINDOWS_DIRECTORY_COMMAND_TIMEOUT_MS,
): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: WINDOWS_DIRECTORY_COMMAND_MAX_BUFFER_BYTES,
  });
}
