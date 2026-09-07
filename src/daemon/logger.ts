import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { LogLevel } from "../config/startup_config.js";
import { LOG_LINE_LIMIT_BYTES, sanitizeMetadata, utf8Bytes } from "../telemetry/sanitize.js";

export const LOG_FILE_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface WindowsLogSecurity {
  restrict(target: string, directory: boolean): void;
  assertDirectory(target: string): void;
  assertFile(target: string): void;
}

export class JsonlLogger implements DaemonLogger {
  private rotationSequence = 0;

  constructor(
    private readonly directory: string,
    private readonly nowMs: () => number = Date.now,
    private readonly windowsSecurity: WindowsLogSecurity = DEFAULT_WINDOWS_LOG_SECURITY,
    private readonly threshold: LogLevel = "info",
  ) {
    const existed = pathExists(directory);
    if (!existed) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32" && !existed) {
      chmodSync(directory, 0o700);
    } else if (process.platform === "win32" && !existed) {
      this.windowsSecurity.restrict(directory, true);
    }
    assertSafeDirectory(directory, this.windowsSecurity);
    this.prune();
  }

  write(record: Record<string, unknown>): void {
    if (!shouldWrite(record, this.threshold)) {
      return;
    }
    this.prune();
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
    const encoded = `${line}\n`;
    const active = this.activeFile();
    if (fileSize(active) + utf8Bytes(encoded) > LOG_FILE_BYTES) {
      this.rotate(active, timestamp);
    }
    appendProtected(active, encoded, this.windowsSecurity);
    this.prune();
  }

  private activeFile(): string {
    return path.join(this.directory, "gateway.jsonl");
  }

  private rotate(active: string, timestamp: number): void {
    if (fileSize(active) === 0) {
      return;
    }
    let rotated: string;
    do {
      rotated = path.join(this.directory, `gateway.${timestamp}.${this.rotationSequence}.jsonl`);
      this.rotationSequence += 1;
    } while (pathExists(rotated));
    renameSync(active, rotated);
  }

  private prune(): void {
    const now = this.nowMs();
    const files = readdirSync(this.directory)
      .filter((name) => /^gateway\.\d+\.\d+\.jsonl$/u.test(name))
      .map((name) => path.join(this.directory, name))
      .map((file) => ({ file, stat: assertSafeFile(file, this.windowsSecurity) }))
      .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs)
      .map(({ file }) => file);
    for (const file of files) {
      if (now - statSync(file).mtimeMs > LOG_MAX_AGE_MS) {
        unlinkIfExists(file);
      }
    }
    const active = this.activeFile();
    if (pathExists(active)) {
      const activeStat = assertSafeFile(active, this.windowsSecurity);
      if (now - activeStat.mtimeMs > LOG_MAX_AGE_MS) {
        unlinkIfExists(active);
      }
    }
    const retained = files.filter(pathExists);
    for (const file of retained.slice(0, Math.max(0, retained.length - (LOG_FILE_COUNT - 1)))) {
      unlinkIfExists(file);
    }
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

function appendProtected(filePath: string, value: string, windowsSecurity: WindowsLogSecurity): void {
  const existed = pathExists(filePath);
  if (existed) {
    assertSafeFile(filePath, windowsSecurity);
  }
  const noFollow = process.platform === "win32"
    ? 0
    : ((constants as Readonly<Record<string, number>>)["O_NOFOLLOW"] ?? 0);
  const fd = openSync(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
  try {
    if (process.platform !== "win32") {
      if (!existed) {
        chmodSync(filePath, 0o600);
      }
    } else if (!existed) {
      windowsSecurity.restrict(filePath, false);
    }
    const opened = fstatSync(fd);
    const pathStat = assertSafeFile(filePath, windowsSecurity);
    if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error("log file changed during validation");
    }
    appendFileSync(fd, value, "utf8");
  } finally {
    closeSync(fd);
  }
}

function restrictWindowsAcl(target: string, directory: boolean): void {
  const identity = currentWindowsIdentity();
  const grant = directory ? `*${identity.sid}:(OI)(CI)(F)` : `*${identity.sid}:(F)`;
  execFileSync("icacls", [target, "/inheritance:r", "/grant:r", grant], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function assertSafeDirectory(target: string, windowsSecurity: WindowsLogSecurity): void {
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("log directory must be a regular directory");
  }
  assertOwner(stat.uid);
  if (process.platform === "win32") {
    windowsSecurity.assertDirectory(target);
  } else if ((stat.mode & 0o777) !== 0o700) {
    throw new Error("log directory permissions must be 0700");
  }
}

function assertSafeFile(target: string, windowsSecurity: WindowsLogSecurity): Stats {
  const stat: Stats = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("log path must be a regular file");
  }
  assertOwner(stat.uid);
  if (process.platform === "win32") {
    windowsSecurity.assertFile(target);
  } else if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("log file permissions must be 0600");
  }
  return stat;
}

function assertOwner(uid: number): void {
  if (process.platform !== "win32" && typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("log path must be owned by the current user");
  }
}

function isWindowsReparsePoint(target: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const escaped = target.replaceAll("'", "''");
  const output = execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$item = Get-Item -LiteralPath '${escaped}' -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'true' } else { 'false' }`,
  ], { encoding: "utf8", windowsHide: true });
  return output.trim() === "true";
}

function assertWindowsAcl(target: string): void {
  const current = currentWindowsIdentity();
  const output = execFileSync("icacls", [target], { encoding: "utf8", windowsHide: true });
  const identities: string[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("Successfully processed") || line.startsWith("Failed processing")) {
      continue;
    }
    const entry = rawLine.startsWith(target) ? rawLine.slice(target.length).trim() : line;
    const separator = entry.indexOf(":(");
    if (separator > 0) {
      identities.push(entry.slice(0, separator).toLowerCase());
    }
  }
  if (identities.length !== 1
    || (identities[0] !== current.sid.toLowerCase() && identities[0] !== current.name.toLowerCase())) {
    throw new Error("log ACL must be restricted to the current user");
  }
}

function windowsCommandPath(command: string): string {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    return path.join(systemRoot, "System32", `${command}.exe`);
  }
  return command;
}

function currentWindowsIdentity(): { readonly name: string; readonly sid: string } {
  const whoami = windowsCommandPath("whoami");
  const identity = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const match = /^"([^"]+)","([^"]+)"$/u.exec(identity);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("unable to resolve current Windows identity");
  }
  return { name: match[1], sid: match[2] };
}

const DEFAULT_WINDOWS_LOG_SECURITY: WindowsLogSecurity = {
  restrict: restrictWindowsAcl,
  assertDirectory(target) {
    if (isWindowsReparsePoint(target)) {
      throw new Error("log directory must be a regular directory");
    }
    assertWindowsAcl(target);
  },
  assertFile(target) {
    if (isWindowsReparsePoint(target)) {
      throw new Error("log path must be a regular file");
    }
    assertWindowsAcl(target);
  },
};

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

function pathExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function unlinkIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
