import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { PreferenceRevisionError } from "../../src/accounts/model_preferences.js";
import { RuntimeConfigError, RuntimeConfigStore } from "../../src/config/runtime_config.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { MIGRATION_MANIFEST } from "../../src/persistence/generated_migrations.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import { ResponsesHistoryAdminError, SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { isWireJsonObject, parseWireJson, type WireJson } from "../../src/serialization/wire_json.js";
import { SqliteAdminTelemetry } from "../../src/telemetry/admin.js";
import { TelemetryRecorder } from "../../src/telemetry/recorder.js";

const nowMs = (): number => 1_700_000_000_000;
const signal = new AbortController().signal;

async function withFreshDatabase(work: (filename: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ghcg-current-sqlite-"));
  try {
    await work(path.join(directory, "state.db"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function open(filename: string): ReturnType<typeof openDatabase> {
  return openDatabase({ path: filename, migrations: MIGRATION_MANIFEST, nowMs });
}

function wire(value: unknown): WireJson {
  return parseWireJson(new TextEncoder().encode(JSON.stringify(value)), { maxBytes: 8192, maxDepth: 32 });
}

describe("current-schema SQLite durability with synthetic data", () => {
  it("preserves config and account preferences across updates, rollback and restart", async () => {
    await withFreshDatabase(async (filename) => {
      let database = open(filename);
      try {
        const config = new RuntimeConfigStore(database, nowMs);
        config.seedIfEmpty({ GHC_GATEWAY_ADMISSION_ACTIVE_MAX: "3" });
        const updatedConfig = { ...config.readSnapshot(), admission: { activeMax: 5, queueMax: 12 } };
        config.update(updatedConfig, 1);
        expect(() => config.update(updatedConfig, 1)).toThrow(RuntimeConfigError);
        const credentials = new MemoryCredentialStore();
        const accounts = new AccountDirectory(database, credentials, nowMs);
        const primary = await accounts.upsertAuthenticated({
          host: "github.com", userId: "1", secret: { generation: 0, githubToken: "synthetic-one" },
        });
        const secondary = await accounts.upsertAuthenticated({
          host: "github.com", userId: "2", secret: { generation: 0, githubToken: "synthetic-two" },
        });
        const originalAccounts = accounts.list();
        const defaultRevision = accounts.defaultPreference().revision;
        accounts.use(secondary.accountId, defaultRevision);
        const defaultState = accounts.defaultPreference();
        const preference = accounts.preferences.set(primary.accountId, {
          modelId: "synthetic-model", catalogGeneration: 7,
        }, 0);
        accounts.preferences.set(secondary.accountId, { modelId: "missing", catalogGeneration: 7 }, 0);
        const invalidPreference = accounts.preferences.markInvalidIfMissing(secondary.accountId, new Set(), 8, 1);
        expect(() => accounts.preferences.set(primary.accountId, {
          modelId: "stale", catalogGeneration: 8,
        }, 0)).toThrow(PreferenceRevisionError);
        const rollback = new Error("synthetic rollback");
        expect(() => database.transaction(() => {
          accounts.use(primary.accountId, defaultState.revision);
          accounts.preferences.set(primary.accountId, { modelId: "rolled-back", catalogGeneration: 9 }, 1);
          throw rollback;
        })()).toThrow(rollback);
        expect(accounts.defaultPreference()).toEqual(defaultState);
        expect(accounts.preferences.get(primary.accountId)).toEqual(preference);
        closeDatabase(database);
        database = open(filename);
        const reopenedConfig = new RuntimeConfigStore(database, nowMs);
        reopenedConfig.seedIfEmpty({ GHC_GATEWAY_ADMISSION_ACTIVE_MAX: "9" });
        expect(reopenedConfig.readRevision()).toBe(2);
        expect(reopenedConfig.readSnapshot()).toEqual(updatedConfig);
        const reopenedAccounts = new AccountDirectory(database, credentials, nowMs);
        expect(reopenedAccounts.list()).toEqual(originalAccounts);
        expect(reopenedAccounts.defaultPreference()).toEqual(defaultState);
        expect(reopenedAccounts.preferences.get(primary.accountId)).toEqual(preference);
        expect(reopenedAccounts.preferences.get(secondary.accountId)).toEqual(invalidPreference);
        expect(database.pragma("foreign_key_check")).toEqual([]);
        expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        closeDatabase(database);
      }
    });
  });

  it("rolls back history cleanup and persists scoped checkpoints and clearing across restarts", async () => {
    await withFreshDatabase(async (filename) => {
      let database = open(filename);
      try {
        const history = new SqliteResponsesHistory(database, { nowMs });
        const call = { type: "function_call", call_id: "call_added", name: "synthetic_added", arguments: "{}" };
        const ownership = {
          accountId: "github.com/1", modelId: "synthetic-model", upstreamOrigin: "https://api.githubcopilot.com",
          owner: "converted", upstreamProtocol: "chat", conversionVersion: "responses-chat-v1",
        } as const;
        await history.recordCheckpoint({ responseId: "resp_added", output: wire([call]) }, ownership, "complete", signal);
        const initial = history.inspect();
        expect(initial).toMatchObject({ count: 1, receiptCount: 1, legacyCount: 0 });
        const rollback = new Error("synthetic history rollback");
        expect(() => database.transaction(() => {
          history.clear(initial.revision);
          throw rollback;
        })()).toThrow(rollback);
        expect(history.inspect()).toEqual(initial);
        expect(() => history.clear(initial.revision - 1)).toThrow(ResponsesHistoryAdminError);
        closeDatabase(database);
        database = open(filename);
        const reopened = new SqliteResponsesHistory(database, { nowMs });
        expect(reopened.inspect()).toEqual(initial);
        const output = { type: "function_call_output", call_id: "call_added", output: "synthetic" };
        const resolution = await reopened.resolve("resp_added", ownership.accountId, signal);
        if (resolution.kind !== "owned") throw new Error("expected owned scoped response");
        const request = wire({ model: "synthetic-model", input: [output], previous_response_id: "resp_added" });
        if (!isWireJsonObject(request)) throw new Error("expected synthetic request object");
        expect((await reopened.enrich(decodeResponsesRequest(request), resolution.receipt, signal)).input)
          .toEqual(wire([call, output]));
        const clearedState = reopened.clear(initial.revision);
        expect(clearedState).toMatchObject({ count: 0, receiptCount: 0, legacyCount: 0 });
        closeDatabase(database);
        database = open(filename);
        const cleared = new SqliteResponsesHistory(database, { nowMs });
        expect(cleared.inspect()).toEqual(clearedState);
        await expect(cleared.resolve("resp_added", ownership.accountId, signal)).resolves.toEqual({ kind: "none" });
      } finally {
        closeDatabase(database);
      }
    });
  });

  it("persists usage aggregates and paginated operational events across restart", async () => {
    await withFreshDatabase(async (filename) => {
      let database = open(filename);
      const usageQuery = { fromMs: nowMs() - 3_600_000, toMs: nowMs() + 3_600_000, limit: 1, cursor: null };
      const eventQuery = { fromMs: null, toMs: null, limit: 1, cursor: null };
      try {
        const recorder = new TelemetryRecorder(database, nowMs);
        const admin = new SqliteAdminTelemetry(database, { recorder });
        for (const protocol of ["anthropic", "openai_chat"] as const) {
          recorder.recordUsage({
            occurredAtMs: nowMs(), accountId: "github.com/1", protocol, resolvedModel: "synthetic-model",
            outcome: "success", requestCount: 1, errorCount: 0, inputTokens: 11, outputTokens: 7, cacheTokens: 3, latencyMs: 20,
          });
        }
        recorder.recordEvent({ occurredAtMs: nowMs(), kind: "gateway_started", severity: "info" });
        recorder.recordEvent({ occurredAtMs: nowMs(), kind: "gateway_stopped", severity: "info" });
        expect(admin.snapshot().pendingMutations).toBe(4);
        await recorder.flush(undefined, 1);
        expect(admin.snapshot().pendingMutations).toBe(3);
        await recorder.flush();
        const totals = { requestCount: 2, errorCount: 0, inputTokens: 22, outputTokens: 14, cacheTokens: 6, latencySumMs: 40, latencyMaxMs: 20 };
        closeDatabase(database);
        database = open(filename);
        const reopened = new SqliteAdminTelemetry(database, { recorder: new TelemetryRecorder(database, nowMs) });
        expect(reopened.snapshot()).toMatchObject({ storage: { usageBucketCount: 2, eventCount: 2 }, pendingMutations: 0 });
        const first = await reopened.queryUsage(usageQuery, signal);
        expect(first.totals).toEqual(totals);
        expect(first.items.map((item) => item.protocol)).toEqual(["anthropic"]);
        expect(first.nextCursor).not.toBeNull();
        const second = await reopened.queryUsage({ ...usageQuery, cursor: first.nextCursor }, signal);
        expect(second.items.map((item) => item.protocol)).toEqual(["openai_chat"]);
        expect(second.totals).toEqual(totals);
        expect(second.nextCursor).toBeNull();
        const events = await reopened.queryEvents(eventQuery, signal);
        expect(events.items.map((item) => item.kind)).toEqual(["gateway_started"]);
        expect(events.nextCursor).not.toBeNull();
        const nextEvents = await reopened.queryEvents({ ...eventQuery, cursor: events.nextCursor }, signal);
        expect(nextEvents.items.map((item) => item.kind)).toEqual(["gateway_stopped"]);
        expect(nextEvents.nextCursor).toBeNull();
        expect(await reopened.replayEvents("1", signal)).toMatchObject({ found: true, latestEventId: "2", items: nextEvents.items });
      } finally {
        closeDatabase(database);
      }
    });
  });
});
