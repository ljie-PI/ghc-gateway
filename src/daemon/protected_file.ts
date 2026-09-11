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
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { InvalidWindowsIdentityError, WindowsAcl, windowsCommandPath } from "../security/windows_acl.js";

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
  readonly runCommand?: (file: string, args: readonly string[]) => string;
}

export class ProtectedFileSystem {
  readonly directory: string;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: (file: string, args: readonly string[]) => string;
  private readonly windowsAcl: WindowsAcl;

  constructor(directory: string, options: Readonly<ProtectedFileOptions> = {}) {
    this.directory = path.resolve(directory);
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.windowsAcl = new WindowsAcl(this.runCommand, { cacheIdentity: true });
  }

  ensureProtectedDirectory(): void {
    let created = false;
    if (!this.pathExists(this.directory)) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      created = true;
    }
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || this.isWindowsReparsePoint(this.directory)) {
      throw new DaemonIdentityFileError("unsafe_path", "daemon directory must be a regular directory");
    }
    this.assertOwner(stat);
    if (this.platform === "win32") {
      if (created) this.restrictWindowsAcl(this.directory, true);
      this.assertWindowsAcl(this.directory);
    } else if ((stat.mode & 0o777) !== 0o700) {
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
    const before = this.assertProtectedRegularFile(filePath);
    const noFollowFlag = (constants as Readonly<Record<string, number>>)["O_NOFOLLOW"] ?? 0;
    let fd: number;
    try {
      fd = openSync(filePath, constants.O_RDONLY | noFollowFlag);
    } catch (error: unknown) {
      throw new DaemonIdentityFileError("unsafe_path", "unable to safely open daemon file", { cause: error });
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || !sameFile(before, opened) || opened.size > maximumBytes) {
        throw new DaemonIdentityFileError("unsafe_path", "daemon file changed during validation");
      }
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== buffer.length) {
        throw new DaemonIdentityFileError("io_error", "unable to read complete daemon file");
      }
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  assertProtectedRegularFile(filePath: string): Stats {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || this.isWindowsReparsePoint(filePath)) {
      throw new DaemonIdentityFileError("unsafe_path", "daemon path must be a regular file");
    }
    this.assertOwner(stat);
    if (this.platform === "win32") {
      this.assertWindowsAcl(filePath);
    } else if ((stat.mode & 0o777) !== 0o600) {
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

  private assertOwner(stat: Stats): void {
    if (this.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new DaemonIdentityFileError("unsafe_owner", "daemon path must be owned by the current user");
    }
  }

  protectFile(filePath: string): void {
    if (this.platform === "win32") {
      this.restrictWindowsAcl(filePath, false);
    } else {
      chmodSync(filePath, 0o600);
    }
  }

  private isWindowsReparsePoint(target: string): boolean {
    if (this.platform !== "win32") return false;
    const script = `$item = Get-Item -LiteralPath '${powerShellLiteral(target)}' -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'true' } else { 'false' }`;
    return this.runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]).trim() === "true";
  }

  private restrictWindowsAcl(target: string, directory: boolean): void {
    const current = this.currentWindowsIdentity();
    this.windowsAcl.restrict(target, directory, { setOwner: true, currentIdentity: current });
  }

  private assertWindowsAcl(target: string): void {
    const current = this.currentWindowsIdentity();
    const owner = windowsOwner(target, this.runCommand);
    if (!this.windowsAcl.isCurrentIdentity(owner, current)) {
      throw new DaemonIdentityFileError("unsafe_owner", "daemon path must be owned by the current user");
    }
    const identities = this.windowsAcl.identities(target);
    if (identities.length !== 1 || !this.windowsAcl.isCurrentIdentity(identities[0] ?? "", current)) {
      throw new DaemonIdentityFileError("unsafe_permissions", "daemon ACL must be restricted to the current user");
    }
  }

  private currentWindowsIdentity() {
    try {
      return this.windowsAcl.currentIdentity();
    } catch (error: unknown) {
      if (error instanceof InvalidWindowsIdentityError) {
        throw new DaemonIdentityFileError("unsafe_owner", "unable to resolve current Windows identity");
      }
      throw error;
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const WINDOWS_SECURITY_COMMAND_TIMEOUT_MS = 5_000;
const WINDOWS_SECURITY_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;

function defaultRunCommand(file: string, args: readonly string[]): string {
  const resolved = process.platform === "win32" && (file === "whoami" || file === "icacls")
    ? windowsCommandPath(file)
    : file;
  return execFileSync(resolved, [...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: WINDOWS_SECURITY_COMMAND_TIMEOUT_MS,
    maxBuffer: WINDOWS_SECURITY_COMMAND_MAX_BUFFER_BYTES,
  });
}

function windowsOwner(target: string, runCommand: (file: string, args: readonly string[]) => string): string {
  const securityModule = "$env:windir\\system32\\WindowsPowerShell\\v1.0\\Modules"
    + "\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1";
  const script = `Import-Module "${securityModule}"; (Get-Acl -LiteralPath '${powerShellLiteral(target)}').Owner`;
  const owner = runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]).trim();
  if (owner.length === 0) {
    throw new DaemonIdentityFileError("unsafe_owner", "unable to resolve daemon path owner");
  }
  return owner;
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
