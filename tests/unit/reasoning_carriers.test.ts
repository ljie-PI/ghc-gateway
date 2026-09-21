import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as historyMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as ownershipMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { migration as carriersMigration } from "../../src/persistence/migrations/042_responses_reasoning_carriers.js";
import {
  ReasoningCarrierError,
  SqliteReasoningCarrierStore,
  type ReasoningCarrierBinding,
} from "../../src/protocols/conversion/reasoning_carriers.js";
import { isWireJsonObject, parseWireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";

const directories: string[] = [];
const migrations = [runtimeConfigMigration, historyMigration, ownershipMigration, carriersMigration].map(embedMigration);
const binding: ReasoningCarrierBinding = {
  accountId: "github.com/1",
  modelId: "gpt",
  upstreamOrigin: "https://api.githubcopilot.com",
  sourceProtocol: "messages",
  wireProtocol: "responses",
  conversionVersion: "responses-messages-v2",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("reasoning carrier store", () => {
  it("keeps partial carriers unavailable until atomic promotion", () => {
    const database = openDatabase({ path: ":memory:", migrations, nowMs: () => 1000 });
    try {
      const store = new SqliteReasoningCarrierStore(database, {
        nowMs: () => 1000,
        createId: () => "01234567-89ab-4def-8123-456789abcdef",
      });
      const created = store.create({
        binding,
        sourceKind: "messages_block",
        state: "partial",
        responseId: "resp_1",
        payload: object({ kind: "messages_block", state: { type: "thinking", thinking: "plan", signature: "sig" } }),
        projection: object({ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] }),
      });
      expect(created.token).toBe("ghcg-rsn-v1:messages_block:responses:01234567-89ab-4def-8123-456789abcdef");
      expect(() => store.resolve(created.token, binding)).toThrow(ReasoningCarrierError);
      store.promote([created.token], binding);
      expect(store.claim(created.token, binding.accountId, "responses")).toEqual(binding);
      expect(store.resolve(created.token, binding)).toMatchObject({
        token: created.token,
        sourceKind: "messages_block",
        state: "complete",
        responseId: "resp_1",
      });
    } finally {
      closeDatabase(database);
    }
  });

  it("fails closed for tampering, binding changes, expiry and byte overflow", () => {
    let now = 1000;
    const database = openDatabase({ path: ":memory:", migrations, nowMs: () => now });
    try {
      const store = new SqliteReasoningCarrierStore(database, {
        nowMs: () => now,
        ttlMs: 10,
        maxItemBytes: 128,
        createId: () => "01234567-89ab-4def-8123-456789abcdef",
      });
      const created = store.create({
        binding,
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "redacted_thinking", data: "opaque" } }),
        projection: object({ type: "reasoning", summary: [] }),
      });
      for (const [token, changed] of [
        [`${created.token}x`, binding],
        [created.token.replace("messages_block", "responses_item"), binding],
        [created.token, { ...binding, accountId: "github.com/2" }],
        [created.token, { ...binding, modelId: "other" }],
        [created.token, { ...binding, upstreamOrigin: "https://other.example" }],
        [created.token, { ...binding, sourceProtocol: "chat" as const }],
        [created.token, { ...binding, conversionVersion: "responses-messages-v3" }],
      ] as const) {
        expect(() => store.resolve(token, changed)).toThrow(ReasoningCarrierError);
      }
      expect(() => store.claim(
        "ghcg-rsn-v2:messages_block:responses:01234567-89ab-4def-8123-456789abcdef",
        binding.accountId,
        "responses",
      )).toThrow(ReasoningCarrierError);
      now = 1010;
      expect(() => store.resolve(created.token, binding)).toThrow(ReasoningCarrierError);

      expect(() => store.create({
        binding,
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "redacted_thinking", data: "界".repeat(100) } }),
        projection: object({ type: "reasoning", summary: [] }),
      })).toThrow(ReasoningCarrierError);
    } finally {
      closeDatabase(database);
    }
  });

  it("survives database restart without exposing private values in errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ghcg-carriers-"));
    directories.push(directory);
    const databasePath = path.join(directory, "state.db");
    const first = openDatabase({ path: databasePath, migrations, nowMs: () => 1000 });
    let token = "";
    try {
      token = new SqliteReasoningCarrierStore(first, {
        nowMs: () => 1000,
        createId: () => "11234567-89ab-4def-8123-456789abcdef",
      }).create({
        binding,
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "thinking", thinking: "private-plan", signature: "private-signature" } }),
        projection: object({ type: "reasoning", summary: [{ type: "summary_text", text: "private-plan" }] }),
      }).token;
    } finally {
      closeDatabase(first);
    }

    const reopened = openDatabase({ path: databasePath, migrations, nowMs: () => 1001 });
    try {
      const store = new SqliteReasoningCarrierStore(reopened, { nowMs: () => 1001 });
      expect(store.resolve(token, binding).token).toBe(token);
      let error: unknown;
      try {
        store.resolve(token, { ...binding, accountId: "private-account" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ReasoningCarrierError);
      const diagnostic = String(error);
      for (const privateValue of [token, "private-plan", "private-signature", "private-account"]) {
        expect(diagnostic).not.toContain(privateValue);
      }
    } finally {
      closeDatabase(reopened);
    }
  });

  it("rejects source-kind bindings that do not match the original protocol", () => {
    const database = openDatabase({ path: ":memory:", migrations, nowMs: () => 1000 });
    try {
      const store = new SqliteReasoningCarrierStore(database, {
        nowMs: () => 1000,
        createId: () => "01234567-89ab-4def-8123-456789abcdef",
      });
      expect(() => store.create({
        binding: { ...binding, sourceProtocol: "chat" },
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "redacted_thinking", data: "opaque" } }),
        projection: object({ type: "reasoning", text: "" }),
      })).toThrow(ReasoningCarrierError);
    } finally {
      closeDatabase(database);
    }
  });

  it("clears account-owned carriers and rejects tampered stored byte metadata", () => {
    const database = openDatabase({ path: ":memory:", migrations, nowMs: () => 1000 });
    try {
      let index = 0;
      const store = new SqliteReasoningCarrierStore(database, {
        nowMs: () => 1000,
        createId: () => `01234567-89ab-4def-8123-456789abcde${index++}`,
      });
      const first = store.create({
        binding,
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "redacted_thinking", data: "opaque" } }),
        projection: object({ type: "reasoning", text: "" }),
      });
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare("UPDATE reasoning_carriers SET stored_bytes = stored_bytes + 1 WHERE token = ?").run(first.token);
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(() => store.resolve(first.token, binding)).toThrow(ReasoningCarrierError);

      const second = store.create({
        binding,
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "redacted_thinking", data: "opaque-2" } }),
        projection: object({ type: "reasoning", text: "" }),
      });
      store.clearAccount(binding.accountId);
      expect(() => store.claim(second.token, binding.accountId, "responses")).toThrow(ReasoningCarrierError);
    } finally {
      closeDatabase(database);
    }
  });

  it("recomputes expiry and evicts oldest rows when runtime bounds change", () => {
    let now = 1000;
    let index = 0;
    const database = openDatabase({ path: ":memory:", migrations, nowMs: () => now });
    try {
      const store = new SqliteReasoningCarrierStore(database, {
        nowMs: () => now,
        ttlMs: 10 * 86_400_000,
        maxStoredBytes: 180,
        createId: () => `01234567-89ab-4def-8123-456789abcde${index++}`,
      });
      const create = (data: string) => store.create({
        binding,
        sourceKind: "messages_block",
        state: "complete",
        payload: object({ kind: "messages_block", state: { type: "redacted_thinking", data } }),
        projection: object({ type: "reasoning", text: "" }),
      });
      const first = create("first");
      const second = create("second");
      expect(() => store.claim(first.token, binding.accountId, "responses")).toThrow(ReasoningCarrierError);
      expect(store.claim(second.token, binding.accountId, "responses")).toEqual(binding);

      store.setTtlDays(1);
      now += 86_400_000;
      expect(() => store.claim(second.token, binding.accountId, "responses")).toThrow(ReasoningCarrierError);
    } finally {
      closeDatabase(database);
    }
  });
});

function object(value: unknown): WireJsonObject {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const parsed = parseWireJson(bytes, { maxBytes: bytes.byteLength, maxDepth: 32 });
  if (!isWireJsonObject(parsed)) throw new Error("expected object");
  return parsed;
}
