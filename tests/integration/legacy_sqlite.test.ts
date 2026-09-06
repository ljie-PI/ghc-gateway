import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/sqlite/legacy-v13/", import.meta.url));
const FIXTURE_SHA256 = "d11e68a32fbcbfc7e3f7d8a448057a18669158734d7066eff9aea84fc49144f3";
const PRIMARY_ACCOUNT = "github.com/86001";
const SECONDARY_ACCOUNT = "github.com/86002";
const nowMs = (): number => 1_700_000_000_000;
const fixtureHash = async (): Promise<string> =>
  createHash("sha256").update(await readFile(path.join(FIXTURE_DIR, "state.db"))).digest("hex");

async function withFixtureCopy(name: string, work: (filename: string) => Promise<void>): Promise<void> {
  expect(await fixtureHash()).toBe(FIXTURE_SHA256);
  const directory = path.join(FIXTURE_DIR, `.run-${process.pid}-${name}`);
  await mkdir(directory);
  try {
    const filename = path.join(directory, "state.db");
    await copyFile(path.join(FIXTURE_DIR, "state.db"), filename);
    await work(filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
    expect(await fixtureHash()).toBe(FIXTURE_SHA256);
  }
}

function openFixture(filename: string): ReturnType<typeof openDatabase> {
  return openDatabase({ path: filename, migrations: MIGRATION_MANIFEST, nowMs });
}

function wire(value: unknown): WireJson {
  return parseWireJson(new TextEncoder().encode(JSON.stringify(value)), { maxBytes: 8192, maxDepth: 32 });
}

function historyRequest(input: unknown, previousResponseId?: string): ReturnType<typeof decodeResponsesRequest> {
  const value = wire({
    model: "synthetic-model",
    input,
    ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
  });
  if (!isWireJsonObject(value)) throw new Error("expected a synthetic request object");
  return decodeResponsesRequest(value);
}

describe("legacy better-sqlite3 database compatibility", () => {
  it("opens the authentic legacy file without changing migration checksums or persisted rows", async () => {
    await withFixtureCopy("rows", async (filename) => {
      const provenance: unknown = JSON.parse(await readFile(path.join(FIXTURE_DIR, "provenance.json"), "utf8"));
      expect(provenance).toMatchObject({
        sourceCommit: "31c81aa411c3b765903ea935bd110920695b9ee4",
        fixedNowMs: 1_700_000_000_000,
        fixture: { file: "state.db", bytes: 110592, sha256: FIXTURE_SHA256 },
        driver: { package: "better-sqlite3", version: "13.0.3" },
        sqlite: { version: "3.53.4" },
      });
      const expected = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-state.json"), "utf8")) as
        Record<string, readonly Record<string, unknown>[]>;
      const database = openFixture(filename);
      try {
        const legacyMigrations = expected.schema_migrations?.map(({ version, name, checksum }) => ({
          version,
          name,
          checksum,
        }));
        expect(MIGRATION_MANIFEST
          .filter(({ version }) => version !== 21 && version !== 40 && version !== 41)
          .map(({ version, name, checksum }) => ({ version, name, checksum })))
          .toEqual(legacyMigrations);
        expect(MIGRATION_MANIFEST.map(({ version }) => version)).toEqual([1, 10, 20, 21, 30, 40, 41]);
        for (const [table, rows] of Object.entries(expected)) {
          expect(table).toMatch(/^[a-z_]+$/u);
          if (table === "schema_migrations") {
            continue;
          }
          expect(database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).toStrictEqual(rows);
        }
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(MIGRATION_MANIFEST.map(({ version, name, checksum }) => ({
          version,
          name,
          checksum,
        })));
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM model_capability_overrides",
        ).get()).toEqual({ count: 0 });
        expect(database.pragma("foreign_key_check")).toEqual([]);
        expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        closeDatabase(database);
      }
    });
  });

  it("preserves config and account preferences across updates, rollback and restart", async () => {
    await withFixtureCopy("preferences", async (filename) => {
      let database = openFixture(filename);
      try {
        const config = new RuntimeConfigStore(database, nowMs);
        config.seedIfEmpty({ GHC_GATEWAY_ADMISSION_ACTIVE_MAX: "9" });
        expect(config.readRevision()).toBe(2);
        expect(config.readSnapshot().admission).toEqual({ activeMax: 3, queueMax: 12 });
        const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
        const originalAccounts = accounts.list();
        expect(originalAccounts).toEqual([
          {
            accountId: PRIMARY_ACCOUNT, revision: 1, host: "github.com", userId: "86001",
            login: "synthetic-primary", displayName: "Synthetic fixture Ω", state: "active",
            authenticatedAtMs: 1_700_000_000_000,
          },
          {
            accountId: SECONDARY_ACCOUNT, revision: 1, host: "github.com", userId: "86002",
            login: null, displayName: null, state: "active", authenticatedAtMs: 1_700_000_000_000,
          },
          {
            accountId: "github.com/86003", revision: 3, host: "github.com", userId: "86003",
            login: "synthetic-removed", displayName: null, state: "removed", authenticatedAtMs: 1_700_000_000_000,
          },
        ]);
        expect(accounts.defaultPreference()).toEqual({ revision: 3, defaultAccountId: PRIMARY_ACCOUNT });
        expect(accounts.preferences.get(PRIMARY_ACCOUNT)).toEqual({
          accountId: PRIMARY_ACCOUNT, revision: 1, modelId: "synthetic-model", validity: "valid", catalogGeneration: 7,
        });
        const invalidPreference = {
          accountId: SECONDARY_ACCOUNT, revision: 2, modelId: "synthetic-missing",
          validity: "invalid", catalogGeneration: 8,
        };
        expect(accounts.preferences.get(SECONDARY_ACCOUNT)).toEqual(invalidPreference);

        const updatedConfig = { ...config.readSnapshot(), admission: { activeMax: 5, queueMax: 12 } };
        config.update(updatedConfig, 2);
        expect(() => config.update(updatedConfig, 2)).toThrow(RuntimeConfigError);
        expect(accounts.use(SECONDARY_ACCOUNT, 3)).toBe(4);
        const updatedPreference = {
          accountId: PRIMARY_ACCOUNT, revision: 2, modelId: "synthetic-updated",
          validity: "valid", catalogGeneration: 9,
        };
        expect(accounts.preferences.set(PRIMARY_ACCOUNT, {
          modelId: "synthetic-updated", catalogGeneration: 9,
        }, 1)).toEqual(updatedPreference);
        expect(() => accounts.preferences.set(PRIMARY_ACCOUNT, {
          modelId: "stale", catalogGeneration: 10,
        }, 1)).toThrow(PreferenceRevisionError);

        const rollback = new Error("synthetic rollback");
        expect(() => database.transaction(() => {
          accounts.use(PRIMARY_ACCOUNT, 4);
          accounts.preferences.set(PRIMARY_ACCOUNT, { modelId: "rolled-back", catalogGeneration: 10 }, 2);
          throw rollback;
        })()).toThrow(rollback);
        expect(accounts.defaultPreference()).toEqual({ revision: 4, defaultAccountId: SECONDARY_ACCOUNT });
        expect(accounts.preferences.get(PRIMARY_ACCOUNT)).toEqual(updatedPreference);

        closeDatabase(database);
        database = openFixture(filename);
        const reopenedConfig = new RuntimeConfigStore(database, nowMs);
        expect(reopenedConfig.readRevision()).toBe(3);
        expect(reopenedConfig.readSnapshot()).toEqual(updatedConfig);
        const reopenedAccounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
        expect(reopenedAccounts.defaultPreference()).toEqual({ revision: 4, defaultAccountId: SECONDARY_ACCOUNT });
        expect(reopenedAccounts.preferences.get(PRIMARY_ACCOUNT)).toEqual(updatedPreference);
        expect(reopenedAccounts.preferences.get(SECONDARY_ACCOUNT)).toEqual(invalidPreference);
        expect(reopenedAccounts.list()).toEqual(originalAccounts);
      } finally {
        closeDatabase(database);
      }
    });
  });

  it("preserves legacy Responses calls as unowned and persists new scoped history", async () => {
    await withFixtureCopy("history", async (filename) => {
      let database = openFixture(filename);
      const signal = new AbortController().signal;
      try {
        const history = new SqliteResponsesHistory(database, { nowMs });
        const initialInspection = {
          revision: 2, count: 2, receiptCount: 0, legacyCount: 2,
          untrackedContinuationBlocked: false,
          oldestAt: 1_700_000_000_000, newestAt: 1_700_000_000_000,
          ttlDays: 7, maxResponses: 512, maxReceipts: 2048,
        };
        expect(history.inspect()).toEqual(initialInspection);
        await expect(history.resolve("resp_synthetic_first", "github.com/1", signal))
          .resolves.toEqual({ kind: "legacy_unowned" });
        expect(history.inspect()).toEqual(initialInspection);

        const rollback = new Error("synthetic history rollback");
        expect(() => database.transaction(() => {
          expect(history.clear(2).count).toBe(0);
          throw rollback;
        })()).toThrow(rollback);
        expect(history.inspect()).toEqual(initialInspection);
        await expect(history.resolve("resp_synthetic_first", "github.com/1", signal))
          .resolves.toEqual({ kind: "legacy_unowned" });

        const newCall = { type: "function_call", call_id: "call_added", name: "synthetic_added", arguments: "{}" };
        const ownership = {
          accountId: "github.com/1",
          modelId: "gpt",
          upstreamOrigin: "https://api.githubcopilot.com",
          owner: "converted",
          upstreamProtocol: "chat",
          conversionVersion: "responses-chat-v1",
        } as const;
        await history.recordCheckpoint(
          { responseId: "resp_added", output: wire([newCall]) },
          ownership,
          "complete",
          signal,
        );
        expect(history.inspect()).toEqual({
          ...initialInspection, revision: 3, count: 3, receiptCount: 1,
        });
        expect(() => history.clear(2)).toThrow(ResponsesHistoryAdminError);
        closeDatabase(database);
        database = openFixture(filename);
        const reopened = new SqliteResponsesHistory(database, { nowMs });
        expect(reopened.inspect()).toEqual({
          ...initialInspection, revision: 3, count: 3, receiptCount: 1,
        });
        await expect(reopened.resolve("resp_synthetic_first", "github.com/1", signal))
          .resolves.toEqual({ kind: "legacy_unowned" });
        const newOutput = { type: "function_call_output", call_id: "call_added", output: "synthetic" };
        const resolution = await reopened.resolve("resp_added", "github.com/1", signal);
        if (resolution.kind !== "owned") {
          throw new Error("expected owned scoped response");
        }
        expect((await reopened.enrich(historyRequest([newOutput], "resp_added"), resolution.receipt, signal)).input)
          .toEqual(wire([newCall, newOutput]));

        expect(reopened.clear(3)).toEqual({
          ...initialInspection, revision: 4, count: 0, receiptCount: 0, legacyCount: 0,
          untrackedContinuationBlocked: false,
          oldestAt: null, newestAt: null,
        });
        closeDatabase(database);
        database = openFixture(filename);
        const cleared = new SqliteResponsesHistory(database, { nowMs });
        expect(cleared.inspect()).toEqual({
          ...initialInspection, revision: 4, count: 0, receiptCount: 0, legacyCount: 0,
          untrackedContinuationBlocked: false,
          oldestAt: null, newestAt: null,
        });
        await expect(cleared.resolve("resp_synthetic_first", "github.com/1", signal))
          .resolves.toEqual({ kind: "none" });
      } finally {
        closeDatabase(database);
      }
    });
  });

  it("serves legacy Usage Buckets and Operational Events and persists subsequent telemetry", async () => {
    await withFixtureCopy("telemetry", async (filename) => {
      let database = openFixture(filename);
      const signal = new AbortController().signal;
      const usageQuery = { fromMs: 1_699_999_200_000, toMs: 1_700_002_800_000, limit: 2, cursor: null };
      const eventQuery = { fromMs: null, toMs: null, limit: 1, cursor: null };
      try {
        const recorder = new TelemetryRecorder(database, nowMs);
        const admin = new SqliteAdminTelemetry(database, { recorder });
        expect(admin.snapshot()).toMatchObject({
          storage: { usageBucketCount: 5, eventCount: 2 }, pendingMutations: 0,
          droppedUsageUpdates: 0, droppedOperationalEvents: 0,
        });
        const totals = {
          requestCount: 5, errorCount: 1, inputTokens: 44, outputTokens: 28, cacheTokens: 12,
          latencySumMs: 2550.75, latencyMaxMs: 2500.75,
        };
        const firstUsagePage = await admin.queryUsage(usageQuery, signal);
        expect(firstUsagePage.totals).toEqual(totals);
        expect(firstUsagePage.items.map((item) => item.protocol)).toEqual(["anthropic", "ollama"]);
        expect(firstUsagePage.nextCursor).not.toBeNull();
        const legacyOllama = await admin.queryUsage({
          ...usageQuery, protocol: "ollama", limit: 10,
        }, signal);
        expect(legacyOllama.items).toEqual([{
          utcHour: "2023-11-14T22:00:00.000Z", accountId: PRIMARY_ACCOUNT,
          protocol: "ollama", resolvedModel: "synthetic-model", outcome: "success",
          requestCount: 1, errorCount: 0, inputTokens: 11, outputTokens: 7, cacheTokens: 3,
          latencySumMs: 12.5, latencyMaxMs: 12.5,
        }]);
        expect(legacyOllama.totals).toEqual({
          requestCount: 1, errorCount: 0, inputTokens: 11, outputTokens: 7, cacheTokens: 3,
          latencySumMs: 12.5, latencyMaxMs: 12.5,
        });
        const secondUsagePage = await admin.queryUsage({
          ...usageQuery, cursor: firstUsagePage.nextCursor,
        }, signal);
        expect(secondUsagePage.totals).toEqual(totals);
        expect(secondUsagePage.items.map((item) => item.protocol)).toEqual(["openai_chat", "openai_responses_bridge"]);
        expect(secondUsagePage.nextCursor).not.toBeNull();
        const lastUsagePage = await admin.queryUsage({
          ...usageQuery, cursor: secondUsagePage.nextCursor,
        }, signal);
        expect(lastUsagePage.items).toEqual([{
          utcHour: "2023-11-14T22:00:00.000Z", accountId: SECONDARY_ACCOUNT,
          protocol: "openai_responses_native", resolvedModel: "synthetic-model", outcome: "timeout",
          requestCount: 1, errorCount: 1, inputTokens: 0, outputTokens: 0, cacheTokens: 0,
          latencySumMs: 2500.75, latencyMaxMs: 2500.75,
        }]);
        expect(lastUsagePage.nextCursor).toBeNull();
        expect(lastUsagePage.totals).toEqual(totals);

        const firstEventPage = await admin.queryEvents(eventQuery, signal);
        expect(firstEventPage.items).toEqual([{
          eventId: "1", occurredAt: "2023-11-14T22:13:20.000Z", kind: "gateway_started", severity: "info", metadata: {},
        }]);
        expect(firstEventPage.nextCursor).not.toBeNull();
        const secondEventPage = await admin.queryEvents({ ...eventQuery, cursor: firstEventPage.nextCursor }, signal);
        expect(secondEventPage.items).toEqual([{
          eventId: "2", occurredAt: "2023-11-14T22:13:20.000Z", kind: "runtime_config_changed", severity: "info", metadata: {},
        }]);
        expect(secondEventPage.nextCursor).toBeNull();

        recorder.recordUsage({
          occurredAtMs: nowMs(), accountId: PRIMARY_ACCOUNT, protocol: "openai_chat",
          resolvedModel: "synthetic-model", outcome: "success", requestCount: 1, errorCount: 0,
          inputTokens: 11, outputTokens: 7, cacheTokens: 3, latencyMs: 20,
        });
        recorder.recordEvent({ occurredAtMs: nowMs(), kind: "gateway_stopped", severity: "info" });
        expect(admin.snapshot().pendingMutations).toBe(2);
        await recorder.flush(undefined, 1);
        expect(admin.snapshot()).toMatchObject({
          storage: { usageBucketCount: 5, eventCount: 2 }, pendingMutations: 1,
        });
        await recorder.flush();
        expect(admin.snapshot()).toMatchObject({
          storage: { usageBucketCount: 5, eventCount: 3 }, pendingMutations: 0,
          droppedUsageUpdates: 0, droppedOperationalEvents: 0,
        });
        closeDatabase(database);
        database = openFixture(filename);
        const reopened = new SqliteAdminTelemetry(database, { recorder: new TelemetryRecorder(database, nowMs) });
        expect(reopened.snapshot()).toMatchObject({
          storage: { usageBucketCount: 5, eventCount: 3 }, pendingMutations: 0,
          droppedUsageUpdates: 0, droppedOperationalEvents: 0,
        });
        expect((await reopened.queryUsage(usageQuery, signal)).totals).toEqual({
          requestCount: 6, errorCount: 1, inputTokens: 55, outputTokens: 35, cacheTokens: 15,
          latencySumMs: 2570.75, latencyMaxMs: 2500.75,
        });
        expect((await reopened.queryUsage({
          ...usageQuery, accountId: PRIMARY_ACCOUNT, protocol: "openai_chat",
        }, signal)).items).toEqual([{
          utcHour: "2023-11-14T22:00:00.000Z", accountId: PRIMARY_ACCOUNT,
          protocol: "openai_chat", resolvedModel: "synthetic-model", outcome: "success",
          requestCount: 2, errorCount: 0, inputTokens: 22, outputTokens: 14, cacheTokens: 6,
          latencySumMs: 32.5, latencyMaxMs: 20,
        }]);
        expect(await reopened.replayEvents("2", signal)).toEqual({
          found: true, latestEventId: "3", items: [{
            eventId: "3", occurredAt: "2023-11-14T22:13:20.000Z", kind: "gateway_stopped", severity: "info", metadata: {},
          }],
        });
      } finally {
        closeDatabase(database);
      }
    });
  });
});
