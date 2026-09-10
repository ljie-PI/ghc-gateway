import { chmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WindowsAcl, windowsCommandPath } from "../security/windows_acl.js";

export type AccountId = string;

export interface SecretCredential {
  readonly generation: number;
  readonly githubToken: string;
  readonly copilotToken?: string;
  readonly copilotExpiresAtMs?: number;
}

export interface CredentialStore {
  readGeneration(accountId: AccountId, generation: number): Promise<SecretCredential | null>;
  putGeneration(
    accountId: AccountId,
    generation: number,
    value: SecretCredential,
    signal?: AbortSignal,
  ): Promise<void>;
  removeAccount(accountId: AccountId): Promise<void>;
  prune(references: ReadonlyMap<AccountId, number>, signal?: AbortSignal): Promise<void>;
}

interface FileDocument {
  readonly version: 1;
  readonly credentials: Record<string, Record<string, SecretCredential>>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly data = new Map<AccountId, Map<number, SecretCredential>>();

  async readGeneration(accountId: AccountId, generation: number): Promise<SecretCredential | null> {
    return this.data.get(accountId)?.get(generation) ?? null;
  }

  async putGeneration(
    accountId: AccountId,
    generation: number,
    value: SecretCredential,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const current = this.data.get(accountId) ?? new Map<number, SecretCredential>();
    current.set(generation, value);
    this.data.set(accountId, current);
    signal?.throwIfAborted();
  }

  async removeAccount(accountId: AccountId): Promise<void> {
    this.data.delete(accountId);
  }

  async prune(references: ReadonlyMap<AccountId, number>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const [accountId, generations] of this.data) {
      const keep = references.get(accountId);
      if (keep === undefined) {
        this.data.delete(accountId);
        continue;
      }
      for (const generation of generations.keys()) {
        if (generation !== keep) {
          generations.delete(generation);
        }
      }
      signal?.throwIfAborted();
    }
  }
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly filePath: string) {
    ensureProtectedDirectory(path.dirname(filePath));
  }

  async readGeneration(accountId: AccountId, generation: number): Promise<SecretCredential | null> {
    const document = readDocument(this.filePath);
    return document.credentials[accountId]?.[String(generation)] ?? null;
  }

  async putGeneration(
    accountId: AccountId,
    generation: number,
    value: SecretCredential,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const document = readDocument(this.filePath);
    const account = document.credentials[accountId] ?? {};
    account[String(generation)] = value;
    writeDocument(this.filePath, {
      version: 1,
      credentials: { ...document.credentials, [accountId]: account },
    });
    signal?.throwIfAborted();
  }

  async removeAccount(accountId: AccountId): Promise<void> {
    const document = readDocument(this.filePath);
    const next = { ...document.credentials };
    delete next[accountId];
    writeDocument(this.filePath, { version: 1, credentials: next });
  }

  async prune(references: ReadonlyMap<AccountId, number>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const document = readDocument(this.filePath);
    const next: FileDocument["credentials"] = {};
    for (const [accountId, generation] of references) {
      const value = document.credentials[accountId]?.[String(generation)];
      if (value !== undefined) {
        next[accountId] = { [String(generation)]: value };
      }
    }
    writeDocument(this.filePath, { version: 1, credentials: next });
    signal?.throwIfAborted();
  }
}

function emptyDocument(): FileDocument {
  return { version: 1, credentials: {} };
}

function readDocument(filePath: string): FileDocument {
  try {
    assertProtectedFile(filePath);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as FileDocument;
    if (parsed.version !== 1 || typeof parsed.credentials !== "object" || parsed.credentials === null) {
      return emptyDocument();
    }
    return parsed;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return emptyDocument();
    }
    throw error;
  }
}

function writeDocument(filePath: string, document: FileDocument): void {
  ensureProtectedDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tempPath, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(document)}\n`, 0, "utf8");
  } finally {
    closeSync(fd);
  }
  protectFile(tempPath);
  renameSync(tempPath, filePath);
  protectFile(filePath);
}

export function ensureProtectedDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error("credential directory must not be a symlink");
  }
  assertOwnedByCurrentUser(stat);
  if (process.platform === "win32") {
    WINDOWS_ACL.restrict(directory, true);
    assertWindowsAclCurrentUserOnly(directory);
    return;
  }
  chmodSync(directory, 0o700);
}

function assertProtectedFile(filePath: string): void {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error("credential file must not be a symlink");
  }
  assertOwnedByCurrentUser(stat);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("credential file permissions must be 0600");
  }
  if (process.platform === "win32") {
    assertWindowsAclCurrentUserOnly(filePath);
  }
}

function assertOwnedByCurrentUser(stat: { uid: number }): void {
  if (process.platform === "win32") {
    return;
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("credential path must be owned by the current user");
  }
}

function protectFile(filePath: string): void {
  if (process.platform === "win32") {
    WINDOWS_ACL.restrict(filePath, false);
    assertWindowsAclCurrentUserOnly(filePath);
    return;
  }
  chmodSync(filePath, 0o600);
}

const WINDOWS_ACL = new WindowsAcl((file, args) => execFileSync(
  windowsCommandPath(file),
  [...args],
  { encoding: "utf8", windowsHide: true },
));

function assertWindowsAclCurrentUserOnly(target: string): void {
  if (!WINDOWS_ACL.isCurrentUserOnly(target)) {
    throw new Error("credential ACL must be restricted to the current user");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function unlinkIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}
