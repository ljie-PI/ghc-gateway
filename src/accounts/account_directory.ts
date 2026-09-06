import type { SqliteDatabase } from "../persistence/sqlite.js";
import { withCredentialGenerationLock } from "./credential_generation_lock.js";
import { AccountModelPreferences } from "./model_preferences.js";
import type { CredentialStore, SecretCredential } from "./credential_store.js";
import {
  canonicalUserId,
  formatAccountId,
  resolveGitHubEnvironment,
  type GitHubEnvironment,
} from "./github_environment.js";

export type AccountId = string;
export type CredentialState = "active" | "removing" | "removed";

export interface AccountSummary {
  readonly accountId: AccountId;
  readonly revision: number;
  readonly host: string;
  readonly userId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly state: CredentialState;
  readonly authenticatedAtMs: number | null;
}

export interface BoundAccount {
  readonly accountId: AccountId;
  readonly environment: GitHubEnvironment;
  readonly userId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly credentialGeneration: number;
}

export class AccountDirectoryError extends Error {
  readonly code: "not_found" | "revision_conflict" | "capacity" | "no_default";

  constructor(code: AccountDirectoryError["code"], message: string) {
    super(message);
    this.name = "AccountDirectoryError";
    this.code = code;
  }

}

export class AccountDirectoryPostCommitError extends Error {
  constructor(
    readonly accountId: AccountId,
    readonly retryCleanup: (signal?: AbortSignal) => Promise<void>,
    options: ErrorOptions,
  ) {
    super("account committed but credential cleanup failed", options);
    this.name = "AccountDirectoryPostCommitError";
  }
}

let accountLifecycleLock: Promise<void> = Promise.resolve();

export class AccountDirectory {
  readonly preferences: AccountModelPreferences;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly credentials: CredentialStore,
    private readonly nowMs: () => number = Date.now,
    maxAuthenticated = 8,
  ) {
    this.maxAuthenticated = Math.min(Math.max(maxAuthenticated, 1), 32);
    this.preferences = new AccountModelPreferences(database, nowMs);
  }

  private maxAuthenticated: number;

  setMaxAuthenticated(maxAuthenticated: number): void {
    this.maxAuthenticated = maxAuthenticated;
  }

  list(): readonly AccountSummary[] {
    return (this.database.prepare(
      "SELECT account_id, revision, normalized_host, numeric_user_id, environment_kind, login, display_name, authenticated_at_ms, credential_generation, credential_state FROM accounts ORDER BY account_id",
    ).all() as AccountRow[]).map(toSummary);
  }

  defaultState(): { readonly defaultRevision: number; readonly defaultAccountId: AccountId | null } {
    const prefs = this.readPrefs();
    return { defaultRevision: prefs.revision, defaultAccountId: prefs.default_account_id };
  }

  async bindDefault(_signal?: AbortSignal): Promise<BoundAccount> {
    const preferred = this.database.prepare(
      "SELECT default_account_id FROM gateway_preferences WHERE singleton_id = 1",
    ).get() as { default_account_id: string | null } | undefined;
    const accountId = preferred?.default_account_id ?? this.fallbackActiveId();
    if (accountId === null) {
      throw new AccountDirectoryError("no_default", "no authenticated account");
    }
    return this.bind(accountId);
  }

  async bindAccount(accountId: AccountId, _signal?: AbortSignal): Promise<BoundAccount> {
    return this.bind(accountId);
  }

  defaultPreference(): { readonly revision: number; readonly defaultAccountId: string | null } {
    const state = this.defaultState();
    return { revision: state.defaultRevision, defaultAccountId: state.defaultAccountId };
  }

  use(accountId: AccountId, expectedRevision: number): number {
    const prefs = this.readPrefs();
    if (prefs.revision !== expectedRevision) {
      throw new AccountDirectoryError("revision_conflict", "gateway preferences revision conflict");
    }
    this.requireActive(accountId);
    this.database.prepare(
      "UPDATE gateway_preferences SET default_account_id = ?, revision = revision + 1, updated_at_ms = ? WHERE singleton_id = 1",
    ).run(accountId, this.nowMs());
    return this.readPrefs().revision;
  }

  async upsertAuthenticated(input: {
    readonly host: string;
    readonly userId: string | number;
    readonly login?: string;
    readonly displayName?: string;
    readonly secret: SecretCredential;
  }, signal?: AbortSignal): Promise<BoundAccount> {
    throwIfAborted(signal);
    const environment = resolveGitHubEnvironment(input.host);
    const userId = canonicalUserId(input.userId);
    const accountId = formatAccountId(environment.host, userId);
    return await withAccountLifecycleLock(() => withCredentialGenerationLock(accountId, async () => {
      throwIfAborted(signal);
      const existing = this.readAccount(accountId);
      if (existing?.credential_state === "removing") {
        throw new AccountDirectoryError("revision_conflict", "account removal is in progress");
      }
      const activating = existing === undefined || existing.credential_state !== "active";
      if (activating && this.activeCount() >= this.maxAuthenticated) {
        throw new AccountDirectoryError("capacity", "authenticated account capacity reached");
      }
      const generation = (existing?.credential_generation ?? 0) + 1;
      const secret = { ...input.secret, generation };
      await this.credentials.putGeneration(accountId, generation, secret, signal);
      if (signal?.aborted === true) {
        await this.credentials.prune(this.activeCredentialReferences(), signal);
        throw new DOMException("aborted", "AbortError");
      }

      const now = this.nowMs();
      try {
        this.database.transaction(() => {
          if (existing === undefined) {
            this.database.prepare(
              `INSERT INTO accounts (
               account_id, revision, normalized_host, numeric_user_id, environment_kind,
               login, display_name, authenticated_at_ms, credential_generation, credential_state,
               created_at_ms, updated_at_ms
             ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            ).run(
              accountId,
              environment.host,
              userId,
              environment.kind,
              input.login ?? null,
              input.displayName ?? null,
              now,
              generation,
              now,
              now,
            );
          } else {
            this.database.prepare(
              `UPDATE accounts SET
               revision = revision + 1,
               login = ?,
               display_name = ?,
               authenticated_at_ms = ?,
               credential_generation = ?,
               credential_state = 'active',
               updated_at_ms = ?
             WHERE account_id = ?`,
            ).run(input.login ?? existing.login, input.displayName ?? existing.display_name, now, generation, now, accountId);
          }

          if (this.readPrefs().default_account_id === null) {
            this.database.prepare(
              "UPDATE gateway_preferences SET default_account_id = ?, revision = revision + 1, updated_at_ms = ? WHERE singleton_id = 1",
            ).run(accountId, now);
          }
        })();
      } catch (error: unknown) {
        await this.credentials.prune(this.activeCredentialReferences(), signal);
        throw error;
      }

      try {
        await this.credentials.prune(this.activeCredentialReferences(), signal);
      } catch (error: unknown) {
        throw new AccountDirectoryPostCommitError(
          accountId,
          async (cleanupSignal) => await withAccountLifecycleLock(
            async () => await this.credentials.prune(this.activeCredentialReferences(), cleanupSignal),
            cleanupSignal,
          ),
          { cause: error },
        );
      }
      return this.bind(accountId);
    }, signal), signal);
  }

  async remove(
    accountId: AccountId,
    expectedRevision: number,
    signal?: AbortSignal,
    onRemoving?: () => void,
  ): Promise<AccountSummary> {
    throwIfAborted(signal);
    return await withAccountLifecycleLock(
      () => withCredentialGenerationLock(
        accountId,
        () => this.removeUnlocked(accountId, expectedRevision, signal, onRemoving),
        signal,
      ),
      signal,
    );
  }

  private async removeUnlocked(
    accountId: AccountId,
    expectedRevision: number,
    signal?: AbortSignal,
    onRemoving?: () => void,
  ): Promise<AccountSummary> {
    throwIfAborted(signal);
    const row = this.readAccount(accountId);
    if (row === undefined) {
      throw new AccountDirectoryError("not_found", "account not found");
    }
    if (row.revision !== expectedRevision) {
      throw new AccountDirectoryError("revision_conflict", "account revision conflict");
    }
    if (row.credential_state === "removed") {
      onRemoving?.();
      return toSummary(row);
    }

    if (row.credential_state === "active") {
      this.database.transaction(() => {
        this.database.prepare(
          "UPDATE accounts SET credential_state = 'removing', revision = revision + 1, updated_at_ms = ? WHERE account_id = ?",
        ).run(this.nowMs(), accountId);
        this.database.prepare("DELETE FROM account_model_preferences WHERE account_id = ?").run(accountId);
        this.database.prepare(
          "UPDATE gateway_preferences SET default_account_id = CASE WHEN default_account_id = ? THEN NULL ELSE default_account_id END, revision = revision + 1, updated_at_ms = ? WHERE singleton_id = 1",
        ).run(accountId, this.nowMs());
      })();
    }

    onRemoving?.();
    await this.credentials.removeAccount(accountId);
    throwIfAborted(signal);
    this.database.prepare(
      "UPDATE accounts SET credential_state = 'removed', credential_generation = NULL, revision = revision + 1, updated_at_ms = ? WHERE account_id = ?",
    ).run(this.nowMs(), accountId);
    const removed = this.readAccount(accountId);
    if (removed === undefined) {
      throw new AccountDirectoryError("not_found", "account not found");
    }
    return toSummary(removed);
  }

  async reconcile(): Promise<void> {
    await withAccountLifecycleLock(async () => {
      const removing = this.database.prepare(
        "SELECT account_id, revision FROM accounts WHERE credential_state = 'removing'",
      ).all() as Array<{ account_id: string; revision: number }>;
      for (const row of removing) {
        await withCredentialGenerationLock(row.account_id, () => this.removeUnlocked(row.account_id, row.revision));
      }
      await this.credentials.prune(this.activeCredentialReferences());
    });
  }

  private bind(accountId: AccountId): BoundAccount {
    const row = this.requireActive(accountId);
    if (row.credential_generation === null) {
      throw new AccountDirectoryError("no_default", "account has no credential generation");
    }
    return {
      accountId: row.account_id,
      environment: resolveGitHubEnvironment(row.normalized_host),
      userId: row.numeric_user_id,
      login: row.login,
      displayName: row.display_name,
      credentialGeneration: row.credential_generation,
    };
  }

  private requireActive(accountId: AccountId): AccountRow {
    const row = this.readAccount(accountId);
    if (row === undefined || row.credential_state !== "active") {
      throw new AccountDirectoryError("not_found", "account not found");
    }
    return row;
  }

  private fallbackActiveId(): string | null {
    const row = this.database.prepare(
      "SELECT account_id FROM accounts WHERE credential_state = 'active' ORDER BY authenticated_at_ms DESC, account_id ASC LIMIT 1",
    ).get() as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  private activeCount(): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM accounts WHERE credential_state = 'active'",
    ).get() as { count: number };
    return row.count;
  }

  private activeCredentialReferences(): ReadonlyMap<AccountId, number> {
    const active = this.database.prepare(
      "SELECT account_id, credential_generation FROM accounts WHERE credential_state = 'active' AND credential_generation IS NOT NULL",
    ).all() as Array<{ account_id: string; credential_generation: number }>;
    return new Map(active.map((row) => [row.account_id, row.credential_generation]));
  }

  private readPrefs(): { revision: number; default_account_id: string | null } {
    return this.database.prepare(
      "SELECT revision, default_account_id FROM gateway_preferences WHERE singleton_id = 1",
    ).get() as { revision: number; default_account_id: string | null };
  }

  private readAccount(accountId: AccountId): AccountRow | undefined {
    return this.database.prepare(
      "SELECT account_id, revision, normalized_host, numeric_user_id, environment_kind, login, display_name, authenticated_at_ms, credential_generation, credential_state FROM accounts WHERE account_id = ?",
    ).get(accountId) as AccountRow | undefined;
  }
}

async function withAccountLifecycleLock<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = accountLifecycleLock;
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  accountLifecycleLock = queued;
  try {
    await waitForPrevious(previous, signal);
  } catch (error: unknown) {
    release();
    void queued.finally(() => {
      if (accountLifecycleLock === queued) {
        accountLifecycleLock = Promise.resolve();
      }
    });
    throw error;
  }
  try {
    return await work();
  } finally {
    release();
    if (accountLifecycleLock === queued) {
      accountLifecycleLock = Promise.resolve();
    }
  }
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await previous;
    return;
  }
  let removeAbortListener = (): void => undefined;
  await Promise.race([
    previous,
    new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }),
  ]).finally(removeAbortListener);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}

interface AccountRow {
  readonly account_id: string;
  readonly revision: number;
  readonly normalized_host: string;
  readonly numeric_user_id: string;
  readonly environment_kind: "github.com" | "ghes";
  readonly login: string | null;
  readonly display_name: string | null;
  readonly authenticated_at_ms: number | null;
  readonly credential_generation: number | null;
  readonly credential_state: CredentialState;
}

function toSummary(row: AccountRow): AccountSummary {
  return {
    accountId: row.account_id,
    revision: row.revision,
    host: row.normalized_host,
    userId: row.numeric_user_id,
    login: row.login,
    displayName: row.display_name,
    state: row.credential_state,
    authenticatedAtMs: row.authenticated_at_ms,
  };
}
