import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { readProtectedFileSync } from "../security/protected_file_read.js";

const CREDENTIAL_FILE_MAX_BYTES = 1024n * 1024n;

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

export interface FileCredentialStoreOptions {
  readonly syncDirectory?: (directory: string) => void;
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
  private readonly syncDirectory: (directory: string) => void;

  constructor(
    private readonly filePath: string,
    options: Readonly<FileCredentialStoreOptions> = {},
  ) {
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
    ensureProtectedDirectory(path.dirname(filePath));
    cleanupOrphanedStages(filePath, this.syncDirectory);
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
    updateDocument(this.filePath, this.syncDirectory, (document) => {
      const account = { ...document.credentials[accountId], [String(generation)]: value };
      return {
        version: 1,
        credentials: { ...document.credentials, [accountId]: account },
      };
    });
    signal?.throwIfAborted();
  }

  async removeAccount(accountId: AccountId): Promise<void> {
    updateDocument(this.filePath, this.syncDirectory, (document) => {
      const next = { ...document.credentials };
      delete next[accountId];
      return { version: 1, credentials: next };
    });
  }

  async prune(references: ReadonlyMap<AccountId, number>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    updateDocument(this.filePath, this.syncDirectory, (document) => {
      const next: FileDocument["credentials"] = {};
      for (const [accountId, generation] of references) {
        const value = document.credentials[accountId]?.[String(generation)];
        if (value !== undefined) {
          next[accountId] = { [String(generation)]: value };
        }
      }
      return { version: 1, credentials: next };
    });
    signal?.throwIfAborted();
  }
}

function emptyDocument(): FileDocument {
  return { version: 1, credentials: {} };
}

function readDocument(filePath: string): FileDocument {
  const contents = readProtectedFile(filePath);
  if (contents === null) {
    return emptyDocument();
  }
  const parsed = JSON.parse(contents) as FileDocument;
  if (parsed.version !== 1 || typeof parsed.credentials !== "object" || parsed.credentials === null) {
    return emptyDocument();
  }
  return parsed;
}

function readProtectedFile(filePath: string): string | null {
  try {
    assertProtectedFile(filePath);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const result = readProtectedFileSync({
    filePath,
    maximumBytes: Number(CREDENTIAL_FILE_MAX_BYTES),
    bigint: true,
    observeBefore: () => assertProtectedFile(filePath),
    settleMetadata: process.platform === "win32",
    errors: {
      changed: (phase) => new Error(`credential file changed during ${phase}`),
      tooLarge: () => new Error("credential file is too large"),
      incomplete: () => new Error("unable to read complete credential file"),
    },
  });
  return result.buffer.toString("utf8");
}

function updateDocument(
  filePath: string,
  flushDirectory: (directory: string) => void,
  update: (document: FileDocument) => FileDocument,
): void {
  const directory = path.dirname(filePath);
  ensureProtectedDirectory(directory);
  cleanupOrphanedStages(filePath, flushDirectory);
  const preparationPath = stagingPreparationPath(filePath);
  const tempPath = stagingPath(filePath);
  const fd = openSync(preparationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const staged = fstatSync(fd, { bigint: true });
  let published = false;
  try {
    if (process.platform !== "win32") {
      fchmodSync(fd, 0o600);
    }
    flushDirectory(directory);

    const contents = `${JSON.stringify(update(readDocument(filePath)))}\n`;
    if (Buffer.byteLength(contents) > Number(CREDENTIAL_FILE_MAX_BYTES)) {
      throw new Error("credential file is too large");
    }
    writeContents(fd, contents);
    fsyncSync(fd);
    const named = assertProtectedFile(preparationPath);
    if (!sameFile(staged, named)) {
      throw new Error("credential file changed during publication");
    }
    closeSync(fd);
    renameSync(preparationPath, tempPath);
    flushDirectory(directory);
    const prepared = assertProtectedFile(tempPath);
    if (!sameFile(staged, prepared)) {
      throw new Error("credential file changed during publication");
    }
    renameSync(tempPath, filePath);
    published = true;
    flushDirectory(directory);
    const live = assertProtectedFile(filePath);
    if (!sameFile(staged, live)) {
      throw new Error("credential file changed during publication");
    }
  } catch (error: unknown) {
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed for publication.
    }
    if (!published && (unlinkIfSameFile(preparationPath, staged) || unlinkIfSameFile(tempPath, staged))) {
      flushDirectory(directory);
    }
    throw error;
  }
}

function writeContents(fd: number, contents: string): void {
  const buffer = Buffer.from(contents, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (written === 0) {
      throw new Error("unable to write complete credential file");
    }
    offset += written;
  }
}

function cleanupOrphanedStages(
  filePath: string,
  flushDirectory: (directory: string) => void,
): void {
  let changed = false;
  for (const stagePath of [stagingPreparationPath(filePath), stagingPath(filePath)]) {
    const stage = protectedFileIfExists(stagePath);
    if (stage !== null) changed = unlinkIfSameFile(stagePath, stage) || changed;
  }
  if (changed) {
    flushDirectory(path.dirname(filePath));
  }
}

function stagingPath(filePath: string): string {
  return `${filePath}.tmp`;
}

function stagingPreparationPath(filePath: string): string {
  return `${filePath}.tmp.prepare`;
}

export function ensureProtectedDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error("credential directory must not be a symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error("credential directory must be a regular directory");
  }
  assertOwnedByCurrentUser(stat);
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
  }
}

function assertProtectedFile(filePath: string): BigIntStats {
  const stat = lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("credential path must be a regular file");
  }
  assertOwnedByCurrentUser(stat);
  if (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) {
    throw new Error("credential file permissions must be 0600");
  }
  if (stat.nlink !== 1n) {
    throw new Error("credential file has unexpected hard links");
  }
  return stat;
}

function assertOwnedByCurrentUser(stat: { uid: number | bigint }): void {
  if (process.platform === "win32") {
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const expected = typeof stat.uid === "bigint" && uid !== undefined ? BigInt(uid) : uid;
  if (uid !== undefined && stat.uid !== expected) {
    throw new Error("credential path must be owned by the current user");
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkIfSameFile(filePath: string, expected: BigIntStats): boolean {
  try {
    const current = lstatSync(filePath, { bigint: true });
    if (sameFile(current, expected)) {
      unlinkSync(filePath);
      return true;
    }
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  return false;
}

function protectedFileIfExists(filePath: string): BigIntStats | null {
  try {
    return assertProtectedFile(filePath);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
