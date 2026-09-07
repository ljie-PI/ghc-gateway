import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import type { SqliteDatabase, SqliteStatement } from "../../src/persistence/sqlite.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import {
  ResponsesHistoryAdminError,
  SqliteResponsesHistory,
  type ResponsesContinuationOwnership,
  type ResponsesHistoryRecord,
} from "../../src/protocols/responses/history.js";
import { parseWireJson, type WireJson } from "../../src/serialization/wire_json.js";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";

const DAY_MS = 86_400_000;
const SIGNAL = new AbortController().signal;

function ownership(accountId: string, modelId = "gpt"): ResponsesContinuationOwnership {
  return {
    accountId,
    modelId,
    upstreamOrigin: "https://api.githubcopilot.com",
    owner: "converted",
    upstreamProtocol: "chat",
    conversionVersion: "responses-chat-v1",
  };
}

function nativeOwnership(accountId: string, modelId = "native"): ResponsesContinuationOwnership {
  return {
    accountId,
    modelId,
    upstreamOrigin: "https://api.githubcopilot.com",
    owner: "native",
    upstreamProtocol: "responses",
    conversionVersion: null,
  };
}

function record(responseId: string, callId: string): ResponsesHistoryRecord {
  return {
    responseId,
    output: outputFromJson(
      `[{"type":"function_call","call_id":"${callId}","name":"fn","arguments":"{}"}]`,
    ),
  };
}

function outputFromJson(json: string): readonly WireJson[] {
  const value = parseWireJson(new TextEncoder().encode(json), { maxBytes: 8192, maxDepth: 32 });
  if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "array") {
    throw new Error("expected array");
  }
  return value.items;
}

async function dbPath(name: string): Promise<string> {
  const dir = path.resolve("artifacts", "test-data", `responses-history-${process.pid}-${name}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return path.join(dir, "state.db");
}

function openHistory(
  db: string,
  nowMs: () => number,
  options: { readonly ttlDays?: number; readonly maxResponses?: number; readonly maxReceipts?: number } = {},
  statementObserver?: (sql: string) => void,
): {
  readonly database: ReturnType<typeof openDatabase>;
  readonly store: SqliteResponsesHistory;
} {
  const database = openDatabase({
    path: db,
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(responsesHistoryMigration),
      embedMigration(responsesContinuationMigration),
    ],
    nowMs,
  });
  return {
    database,
    store: new SqliteResponsesHistory(observeStatements(database, statementObserver), { nowMs, ...options }),
  };
}

function observeStatements(
  database: SqliteDatabase,
  observer: ((sql: string) => void) | undefined,
): SqliteDatabase {
  if (observer === undefined) {
    return database;
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string): SqliteStatement => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "all") {
                const all = statementTarget.all.bind(statementTarget);
                return (...parameters: Parameters<SqliteStatement["all"]>): unknown[] => {
                  observer(sql);
                  return all(...parameters);
                };
              }
              const value: unknown = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("Responses history SQLite", () => {
  it("recovers scoped ownership and checkpoints after restart", async () => {
    const file = await dbPath("restart");
    const now = () => 1_700_000_000_000;
    const first = openHistory(file, now);
    try {
      await first.store.recordCheckpoint(
        record("resp_restart", "call_restart"),
        ownership("github.com/1"),
        "complete",
        SIGNAL,
      );
      closeDatabase(first.database);

      const reopened = openHistory(file, now);
      try {
        await expect(reopened.store.resolve("resp_restart", "github.com/1", SIGNAL))
          .resolves.toMatchObject({
            kind: "owned",
            receipt: {
              accountId: "github.com/1",
              modelId: "gpt",
              upstreamProtocol: "chat",
              checkpointState: "complete",
            },
          });
        await expect(reopened.store.resolve("resp_restart", "github.com/2", SIGNAL))
          .resolves.toEqual({ kind: "owned_by_another_account" });
        expect(reopened.store.inspect()).toMatchObject({ count: 1, receiptCount: 1 });
      } finally {
        closeDatabase(reopened.database);
      }
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("persists expiry as an unusable tombstone across restart", async () => {
    const file = await dbPath("expiry");
    let current = 1_700_000_000_000;
    const first = openHistory(file, () => current);
    try {
      await first.store.recordCheckpoint(
        record("resp_expired", "call_expired"),
        ownership("github.com/1"),
        "partial",
        SIGNAL,
      );
      closeDatabase(first.database);
      current += 7 * DAY_MS + 1;

      const reopened = openHistory(file, () => current);
      try {
        await expect(reopened.store.resolve("resp_expired", "github.com/1", SIGNAL))
          .resolves.toEqual({ kind: "expired" });
        expect(reopened.store.inspect()).toMatchObject({ count: 0, receiptCount: 1 });
      } finally {
        closeDatabase(reopened.database);
      }
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("fails closed for external native IDs after receipt eviction loses exact ownership", async () => {
    const file = await dbPath("eviction-uncertainty");
    let current = 1_700_000_000_000;
    const opened = openHistory(file, () => current, { maxReceipts: 1 });
    try {
      await opened.store.recordReceipt({
        ...nativeOwnership("github.com/1"),
        responseId: "resp_expired",
        checkpointState: "complete",
      }, SIGNAL);
      current += 7 * DAY_MS + 1;
      await expect(opened.store.resolve("resp_expired", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "expired" });
      await opened.store.recordReceipt({
        ...nativeOwnership("github.com/1"),
        responseId: "resp_current",
        checkpointState: "complete",
      }, SIGNAL);

      await expect(opened.store.resolve("resp_expired", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "untracked_blocked" });
      await expect(opened.store.resolve("external_native", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "untracked_blocked" });
      closeDatabase(opened.database);

      const reopened = openHistory(file, () => current, { maxReceipts: 1 });
      try {
        await expect(reopened.store.resolve("resp_expired", "github.com/1", SIGNAL))
          .resolves.toEqual({ kind: "untracked_blocked" });
      } finally {
        closeDatabase(reopened.database);
      }
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("expires legacy rows while retaining bounded fail-closed uncertainty", async () => {
    const file = await dbPath("legacy-expiry");
    let current = 1_700_000_000_000;
    const opened = openHistory(file, () => current);
    try {
      opened.database.prepare(
        "INSERT INTO responses (response_id, insertion_seq, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)",
      ).run("resp_legacy", 1, current, current + 7 * DAY_MS);
      current += 7 * DAY_MS + 1;

      await expect(opened.store.resolve("resp_legacy", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "untracked_blocked" });
      expect(opened.store.inspect()).toMatchObject({ count: 0, legacyCount: 0 });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("bounds receipts separately without evicting tool checkpoints", async () => {
    const file = await dbPath("capacity");
    const opened = openHistory(file, () => 1_700_000_000_000, {
      maxResponses: 2,
      maxReceipts: 3,
    });
    try {
      await opened.store.recordCheckpoint(record("resp_tool_1", "call_1"), ownership("github.com/1"), "complete", SIGNAL);
      await opened.store.recordCheckpoint(record("resp_tool_2", "call_2"), ownership("github.com/1"), "complete", SIGNAL);
      for (let index = 0; index < 8; index += 1) {
        await opened.store.recordReceipt({
          ...nativeOwnership("github.com/1"),
          responseId: `resp_native_${index}`,
          checkpointState: "complete",
        }, SIGNAL);
      }

      expect(opened.store.inspect()).toMatchObject({ count: 2, receiptCount: 3 });
      await expect(opened.store.resolve("resp_tool_1", "github.com/1", SIGNAL))
        .resolves.toMatchObject({ kind: "owned" });
      await expect(opened.store.resolve("resp_tool_2", "github.com/1", SIGNAL))
        .resolves.toMatchObject({ kind: "owned" });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("removes one account's receipts and checkpoints without touching another account", async () => {
    const file = await dbPath("account-removal");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      opened.store.clearAccount("github.com/unused");
      expect(opened.store.inspect().untrackedContinuationBlocked).toBe(false);
      await opened.store.recordCheckpoint(record("resp_same", "call_1"), ownership("github.com/1"), "complete", SIGNAL);
      await opened.store.recordCheckpoint(record("resp_same", "call_2"), ownership("github.com/2"), "complete", SIGNAL);
      opened.store.clearAccount("github.com/1");

      await expect(opened.store.resolve("resp_same", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "owned_by_another_account" });
      await expect(opened.store.resolve("resp_same", "github.com/2", SIGNAL))
        .resolves.toMatchObject({ kind: "owned" });
      expect(opened.store.inspect()).toMatchObject({ count: 1, receiptCount: 1 });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("cleans scoped continuation state in the account-removal transaction", async () => {
    const file = await dbPath("directory-removal");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      const directory = new AccountDirectory(
        opened.database,
        new MemoryCredentialStore(),
        () => 1_700_000_000_000,
        8,
        (accountId) => opened.store.clearAccount(accountId),
      );
      const account = await directory.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "token" },
      });

      await opened.store.recordCheckpoint(
        record("resp_removed", "call_removed"),
        ownership(account.accountId),
        "complete",
        SIGNAL,
      );
      const revision = directory.list()[0]?.revision;
      if (revision === undefined) {
        throw new Error("expected account revision");
      }
      await directory.remove(account.accountId, revision, SIGNAL);

      await expect(opened.store.resolve("resp_removed", account.accountId, SIGNAL))
        .resolves.toEqual({ kind: "untracked_blocked" });
      expect(opened.store.inspect()).toMatchObject({
        count: 0,
        receiptCount: 0,
        untrackedContinuationBlocked: true,
      });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("rejects a late persistence barrier after the bound account is removed", async () => {
    const file = await dbPath("late-account-write");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      const credentials = new MemoryCredentialStore();
      const directory = new AccountDirectory(
        opened.database,
        credentials,
        () => 1_700_000_000_000,
      );
      const account = await directory.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "token" },
      });
      const guarded = new SqliteResponsesHistory(opened.database, {
        nowMs: () => 1_700_000_000_000,
        accountIsActive: (accountId) => {
          const row = opened.database.prepare(
            "SELECT credential_state FROM accounts WHERE account_id = ?",
          ).get(accountId) as { credential_state: string } | undefined;
          return row?.credential_state === "active";
        },
      });
      const revision = directory.list()[0]?.revision;
      if (revision === undefined) {
        throw new Error("expected account revision");
      }
      await directory.remove(account.accountId, revision, SIGNAL);

      await expect(guarded.recordReceipt({
        ...nativeOwnership(account.accountId),
        responseId: "resp_late",
        checkpointState: "complete",
      }, SIGNAL)).rejects.toMatchObject({ code: "checkpoint_unavailable" });
      expect(guarded.inspect()).toMatchObject({ count: 0, receiptCount: 0 });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("keeps revision-safe Admin clear and reports receipts separately", async () => {
    const file = await dbPath("admin");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      await opened.store.recordReceipt({
        ...nativeOwnership("github.com/1"),
        responseId: "resp_native",
        checkpointState: "complete",
      }, SIGNAL);
      const afterReceipt = opened.store.inspect();
      expect(afterReceipt).toMatchObject({
        revision: 1,
        count: 0,
        receiptCount: 1,
        legacyCount: 0,
        maxResponses: 512,
        maxReceipts: 2048,
      });
      expect(() => opened.store.clear(0)).toThrow(ResponsesHistoryAdminError);
      expect(opened.store.clear(afterReceipt.revision)).toMatchObject({
        revision: 2,
        count: 0,
        receiptCount: 0,
      });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("reuses route-receipt cleanup proof through partial and complete checkpoint commits", async () => {
    const file = await dbPath("checkpoint-cleanup-proof");
    let housekeepingScans = 0;
    const opened = openHistory(file, () => 1_700_000_000_000, {}, (sql) => {
      if (sql.includes("created_at_ms + ? <= ?")) {
        housekeepingScans += 1;
      }
    });
    try {
      await opened.store.recordReceipt({
        ...ownership("github.com/1"),
        responseId: "resp_checkpoint",
        checkpointState: "route_only",
      }, SIGNAL);
      housekeepingScans = 0;

      await opened.store.recordCheckpoint(
        record("resp_checkpoint", "call_checkpoint"),
        ownership("github.com/1"),
        "partial",
        SIGNAL,
      );
      await opened.store.recordCheckpoint(
        record("resp_checkpoint", "call_checkpoint"),
        ownership("github.com/1"),
        "complete",
        SIGNAL,
      );

      expect(housekeepingScans).toBe(0);
      await expect(opened.store.resolve("resp_checkpoint", "github.com/1", SIGNAL))
        .resolves.toMatchObject({ kind: "owned", receipt: { checkpointState: "complete" } });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("runs expiry cleanup when an older receipt reaches the retained proof boundary", async () => {
    const file = await dbPath("checkpoint-cleanup-expiry");
    let current = 1_700_000_000_000;
    const opened = openHistory(file, () => current);
    try {
      await opened.store.recordReceipt({
        ...nativeOwnership("github.com/1"),
        responseId: "resp_older",
        checkpointState: "complete",
      }, SIGNAL);
      current += DAY_MS;
      await opened.store.recordReceipt({
        ...ownership("github.com/1"),
        responseId: "resp_checkpoint",
        checkpointState: "route_only",
      }, SIGNAL);
      await opened.store.recordCheckpoint(
        record("resp_checkpoint", "call_checkpoint"),
        ownership("github.com/1"),
        "partial",
        SIGNAL,
      );

      current += 6 * DAY_MS + 1;
      await opened.store.recordCheckpoint(
        record("resp_checkpoint", "call_checkpoint"),
        ownership("github.com/1"),
        "complete",
        SIGNAL,
      );

      await expect(opened.store.resolve("resp_older", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "expired" });
      await expect(opened.store.resolve("resp_checkpoint", "github.com/1", SIGNAL))
        .resolves.toMatchObject({ kind: "owned", receipt: { checkpointState: "complete" } });
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("rolls back invalid checkpoint records and records bounded timing samples", async () => {
    const file = await dbPath("rollback-benchmark");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      await expect(opened.store.recordCheckpoint({
        responseId: "resp_bad",
        output: [{
          kind: "object",
          members: [
            { key: "type", value: "function_call" },
            { key: "call_id", value: "call_bad" },
            { key: "arguments", value: { kind: "number", lexeme: "01" } },
          ],
        }],
      }, ownership("github.com/1"), "complete", SIGNAL)).rejects.toThrow();
      expect(opened.store.inspect()).toMatchObject({ revision: 0, count: 0, receiptCount: 0 });

      const samples: number[] = [];
      for (let index = 0; index < 30; index += 1) {
        const started = performance.now();
        await opened.store.recordCheckpoint(
          record(`resp_bench_${index}`, `call_bench_${index}`),
          ownership("github.com/1"),
          "complete",
          SIGNAL,
        );
        samples.push(performance.now() - started);
      }
      expect(samples.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true);
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});
