import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { WindowsAcl, windowsCommandPath } from "../security/windows_acl.js";
import { AgentError } from "./types.js";

export const MAX_FILE_BYTES = 1024 * 1024;
export interface FileImage {
  readonly bytes: string;
  readonly mode: number;
  readonly acl: string | null;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}
export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
export function canonical(target: string): string {
  const absolute = path.resolve(target);
  assertNoLinks(absolute);
  let ancestor = absolute;
  const suffix: string[] = [];
  while (!exists(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const result = path.join(fs.realpathSync.native(ancestor), ...suffix);
  return process.platform === "win32" ? result.toLowerCase() : result;
}
export function assertNoLinks(target: string): void {
  let current = path.resolve(target);
  while (true) {
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new AgentError("agent_unsafe_path");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function assertOwned(target: string, directory: boolean, allowedLink?: string): Promise<string | null> {
  assertNoLinks(target);
  const stat = fs.lstatSync(target);
  const linked = allowedLink !== undefined && exists(allowedLink) ? fs.lstatSync(allowedLink) : null;
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1
    && !(stat.nlink === 2 && linked?.ino === stat.ino && linked.dev === stat.dev))) {
    throw new AgentError("agent_unsafe_path");
  }
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new AgentError("agent_unsafe_path");
    return null;
  }
  return await windowsAcl(target);
}
export async function readImage(target: string, allowedLink?: string): Promise<FileImage | null> {
  assertNoLinks(target);
  if (!exists(target)) return null;
  const recordedAcl = await assertOwned(target, false, allowedLink);
  const before = fs.lstatSync(target);
  if (before.size > MAX_FILE_BYTES) throw new AgentError("agent_invalid_config");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_FILE_BYTES) throw new AgentError("agent_conflict");
    const data = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const read = fs.readSync(fd, data, size, data.length - size, null);
      if (read === 0) break;
      size += read;
    }
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(target);
    if (size > MAX_FILE_BYTES || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
      || named.ino !== stat.ino || named.dev !== stat.dev) throw new AgentError("agent_conflict");
    return { bytes: data.subarray(0, size).toString("base64"), mode: stat.mode & 0o777, acl: recordedAcl };
  } finally { fs.closeSync(fd); }
}
export function sameImage(a: FileImage | null, b: FileImage | null): boolean {
  return digest(a) === digest(b);
}

export function sameDisplacedContent(a: FileImage | null, b: FileImage | null): boolean {
  if (a === null || b === null) return a === b;
  // Windows may recompute inherited ACLs when a file is renamed into the
  // private scratch directory. The durable baseline keeps the original SDDL
  // for restoration; post-rename verification proves the displaced payload,
  // while the full image was already compared immediately before the move.
  return a.bytes === b.bytes && (process.platform === "win32" || a.mode === b.mode);
}
export async function privateDirectory(target: string): Promise<void> {
  assertNoLinks(target);
  if (exists(target)) { await assertPrivate(target, true); return; }
  fs.mkdirSync(target, { mode: 0o700 });
  if (process.platform === "win32") {
    agentWindowsAcl(() => WINDOWS_ACL.restrict(target, true));
  }
  await assertPrivate(target, true);
}
export async function assertPrivate(target: string, directory: boolean): Promise<void> {
  assertNoLinks(target);
  const stat = fs.lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new AgentError("agent_unsafe_path");
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new AgentError("agent_unsafe_path");
  } else if (!agentWindowsAcl(() => WINDOWS_ACL.isCurrentUserOnly(target))) {
    throw new AgentError("agent_unsafe_path");
  }
}
export async function protect(target: string): Promise<void> {
  if (process.platform === "win32") {
    agentWindowsAcl(() => WINDOWS_ACL.restrict(target, false));
  } else fs.chmodSync(target, 0o600);
}
export async function writeExclusive(target: string, image: FileImage, privateOnly = false): Promise<void> {
  const fd = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(fd, Buffer.from(image.bytes, "base64"));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (privateOnly) await protect(target);
  else await applyAccess(target, image);
  syncDirectory(path.dirname(target));
}
export async function applyAccess(target: string, image: FileImage): Promise<void> {
  if (process.platform === "win32") {
    if (image.acl !== null) {
      await windows(target, "$a=Get-Acl -LiteralPath $p; $a.SetSecurityDescriptorSddlForm([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:GHCG_AGENT_ACL))); Set-Acl -LiteralPath $p -AclObject $a", image.acl);
    } else await protect(target);
  } else fs.chmodSync(target, image.mode);
}
export function syncDirectory(directory: string): void {
  // Node cannot open directories for FlushFileBuffers on Windows. File fsync and
  // SQLite FULL synchronization cover process crashes, not hardware power loss.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function windowsAcl(target: string): Promise<string> {
  // Client configuration commonly inherits an Administrators owner on Windows.
  // Ownership is therefore not a useful same-user boundary there; reject
  // reparse points and preserve the complete descriptor instead. Recovery
  // files remain current-user-only through assertPrivate/restrictWindowsAcl.
  return (await windows(target, "$a=Get-Acl -LiteralPath $p; if(((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'unsafe'}; $a.Sddl")).trim();
}

// Windows ACL mutation uses icacls instead of PowerShell Set-Acl: reapplying a
// protected ACL through SetAccessRuleProtection demands SeSecurityPrivilege and
// fails on already-locked files, while icacls /inheritance:r + /grant:r is
// idempotent for the recovery files we revisit across apply/restore operations.
const WINDOWS_ACL = new WindowsAcl((file, args) => execFileSync(
  windowsCommandPath(file, "win32", { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
  [...args],
  { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 },
), { cacheIdentity: true });

function agentWindowsAcl<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    const failure = new AgentError("agent_unsafe_path");
    failure.cause = error;
    throw failure;
  }
}

async function windows(target: string, script: string, acl?: string): Promise<string> {
  try {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const securityModule = "$env:windir\\system32\\WindowsPowerShell\\v1.0\\Modules"
      + "\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1";
    const command = `$ErrorActionPreference='Stop'; Import-Module "${securityModule}"; $p=$env:GHCG_AGENT_PATH; ${script}`;
    const { stdout } = await promisify(execFile)(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 16384,
      env: { ...process.env, GHCG_AGENT_PATH: target, GHCG_AGENT_ACL: acl === undefined ? "" : Buffer.from(acl).toString("base64") },
    });
    return stdout;
  } catch (error: unknown) {
    const failure = new AgentError("agent_unsafe_path");
    failure.cause = error;
    throw failure;
  }
}
