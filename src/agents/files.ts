import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readProtectedFileSync } from "../security/protected_file_read.js";
import { AgentError } from "./types.js";

export const MAX_FILE_BYTES = 1024 * 1024;
export interface FileImage {
  readonly bytes: string;
  readonly mode: number;
  readonly acl: string | null;
}
export interface SecurityPathObservation {
  readonly present: boolean;
  readonly dev?: number;
  readonly ino?: number;
  readonly ctimeMs?: number;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly nlink?: number;
}
export interface ImageReadOptions {
  readonly onBeforeOpen?: (target: string) => void;
  readonly onReadComplete?: (target: string) => void;
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
export function observeSecurityPath(target: string): SecurityPathObservation {
  if (!exists(target)) return { present: false };
  const stat = fs.lstatSync(target);
  return {
    present: true,
    dev: stat.dev,
    ino: stat.ino,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    nlink: stat.nlink,
  };
}
export function assertSecurityPathUnchanged(
  target: string,
  observation: SecurityPathObservation,
  directory: boolean,
): void {
  assertNoLinks(target);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(target);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  if (stat === null) {
    if (observation.present) throw new AgentError("agent_unsafe_path");
    return;
  }
  if (!observation.present || stat.dev !== observation.dev || stat.ino !== observation.ino || (!directory
    && (stat.ctimeMs !== observation.ctimeMs || stat.mtimeMs !== observation.mtimeMs
      || stat.size !== observation.size || stat.nlink !== observation.nlink))) {
    throw new AgentError("agent_unsafe_path");
  }
}
export function sameSecurityPathIdentity(
  left: SecurityPathObservation,
  right: SecurityPathObservation,
): boolean {
  return left.present === right.present && (!left.present || left.dev === right.dev && left.ino === right.ino);
}
export async function assertOwned(
  target: string,
  directory: boolean,
  allowedLink?: string,
): Promise<string | null> {
  assertNoLinks(target);
  const stat = assertOwnedStat(target, directory, allowedLink);
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new AgentError("agent_unsafe_path");
    return null;
  }
  return null;
}
export async function readImage(
  target: string,
  allowedLink?: string,
  options: Readonly<ImageReadOptions> = {},
): Promise<FileImage | null> {
  assertNoLinks(target);
  if (!exists(target)) return null;
  const recordedAcl = await assertOwned(target, false, allowedLink);
  return readVerifiedImage(target, recordedAcl, allowedLink, options);
}
function assertOwnedStat(target: string, directory: boolean, allowedLink?: string | SecurityPathObservation): fs.Stats {
  const stat = fs.lstatSync(target);
  const linked = typeof allowedLink === "string"
    ? exists(allowedLink) ? observeSecurityPath(allowedLink) : undefined
    : allowedLink;
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1
    && !(stat.nlink === 2 && linked?.present === true
      && linked.ino === stat.ino && linked.dev === stat.dev))) {
    throw new AgentError("agent_unsafe_path");
  }
  return stat;
}
function readVerifiedImage(
  target: string,
  recordedAcl: string | null,
  allowedLink: string | undefined,
  options: Readonly<ImageReadOptions>,
): FileImage {
  const result = readProtectedFileSync({
    filePath: target,
    maximumBytes: MAX_FILE_BYTES,
    observeBefore: () => assertOwnedStat(target, false, allowedLink),
    observeNamed: () => fs.lstatSync(target),
    validateBefore: (stat) => {
      if (stat.size > MAX_FILE_BYTES) throw new AgentError("agent_invalid_config");
    },
    validateNamed: () => { assertOwnedStat(target, false, allowedLink); },
    onBeforeOpen: options.onBeforeOpen,
    onPostRead: options.onReadComplete,
    settleMetadata: process.platform === "win32",
    errors: {
      changed: () => new AgentError("agent_conflict"),
      tooLarge: () => new AgentError("agent_conflict"),
      incomplete: () => new AgentError("agent_conflict"),
    },
  });
  return {
    bytes: result.buffer.toString("base64"),
    mode: result.opened.mode & 0o777,
    acl: recordedAcl,
  };
}
export function sameImage(a: FileImage | null, b: FileImage | null): boolean {
  return digest(a) === digest(b);
}

export function sameDisplacedContent(a: FileImage | null, b: FileImage | null): boolean {
  if (a === null || b === null) return a === b;
  // Windows mode bits are not an access-control boundary. The full image was
  // already compared immediately before the move.
  return a.bytes === b.bytes && (process.platform === "win32" || a.mode === b.mode);
}
export async function privateDirectory(target: string): Promise<void> {
  assertNoLinks(target);
  if (exists(target)) {
    await assertPrivate(target, true);
    return;
  }
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
  }
  await assertPrivate(target, true);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
export async function assertPrivate(target: string, directory: boolean): Promise<void> {
  assertNoLinks(target);
  const stat = fs.lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new AgentError("agent_unsafe_path");
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new AgentError("agent_unsafe_path");
  }
}
export function protect(target: string): void {
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
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
  if (process.platform !== "win32") fs.chmodSync(target, image.mode);
}
export function syncDirectory(directory: string): void {
  // Node cannot open directories for FlushFileBuffers on Windows. File fsync and
  // SQLite FULL synchronization cover process crashes, not hardware power loss.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
