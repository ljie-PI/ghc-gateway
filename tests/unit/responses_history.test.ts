import { SqliteDatabase as Database } from "../../src/persistence/sqlite.js";
import { describe, expect, it } from "vitest";
import { applyMigrations, embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { migration as reasoningCarriersMigration } from "../../src/persistence/migrations/042_responses_reasoning_carriers.js";
import { decodeResponsesRequest } from "../../src/protocols/openai_responses/decoder.js";
import {
  RESPONSES_CHAT_CONVERSION_VERSION,
  RESPONSES_MESSAGES_CONVERSION_VERSION,
  ResponsesContinuationError,
  SqliteResponsesHistory,
  type ResponsesContinuationOwnership,
  type ResponsesHistoryRecord,
  type ResponsesRouteReceipt,
} from "../../src/protocols/openai_responses/history.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";

const LIMITS = { maxBytes: 8192, maxDepth: 64 } as const;
const SIGNAL = new AbortController().signal;

function objectFromJson(json: string): WireJsonObject {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(isWireJsonObject(value)).toBe(true);
  return value as WireJsonObject;
}

function outputFromJson(json: string): readonly WireJson[] {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(isWireJsonArray(value)).toBe(true);
  return (value as { items: readonly WireJson[] }).items;
}

function callRecord(responseId: string, callId: string, name: string): ResponsesHistoryRecord {
  return {
    responseId,
    output: outputFromJson(
      `[{"type":"function_call","call_id":"${callId}","name":"${name}","arguments":"{}"}]`,
    ),
  };
}

function ownership(
  accountId: string,
  modelId = "gpt",
  protocol: "chat" | "messages" = "chat",
): ResponsesContinuationOwnership {
  return {
    accountId,
    modelId,
    upstreamOrigin: "https://api.githubcopilot.com",
    owner: "converted",
    upstreamProtocol: protocol,
    conversionVersion: protocol === "chat"
      ? RESPONSES_CHAT_CONVERSION_VERSION
      : RESPONSES_MESSAGES_CONVERSION_VERSION,
  };
}

function nativeOwnership(accountId: string, modelId = "gpt"): ResponsesContinuationOwnership {
  return {
    accountId,
    modelId,
    upstreamOrigin: "https://api.githubcopilot.com",
    owner: "native",
    upstreamProtocol: "responses",
    conversionVersion: null,
  };
}

function history(
  options: ConstructorParameters<typeof SqliteResponsesHistory>[1] = {},
): { readonly database: Database; readonly store: SqliteResponsesHistory } {
  const database = new Database(":memory:");
  applyMigrations(database, [
    embedMigration(runtimeConfigMigration),
    embedMigration(responsesHistoryMigration),
    embedMigration(responsesContinuationMigration),
    embedMigration(reasoningCarriersMigration),
  ], () => 1_700_000_000_000);
  return { database, store: new SqliteResponsesHistory(database, { nowMs: () => 1_700_000_000_000, ...options }) };
}

async function owned(
  store: SqliteResponsesHistory,
  responseId: string,
  accountId: string,
): Promise<ResponsesRouteReceipt> {
  const resolution = await store.resolve(responseId, accountId, SIGNAL);
  expect(resolution.kind).toBe("owned");
  if (resolution.kind !== "owned") {
    throw new Error("expected owned receipt");
  }
  return resolution.receipt;
}

function restoredName(input: WireJson | undefined): string | undefined {
  if (!isWireJsonArray(input)) {
    return undefined;
  }
  const item = input.items.find((candidate) => isWireJsonObject(candidate)
    && memberValues(candidate, "type")[0] === "function_call");
  return isWireJsonObject(item) ? memberValues(item, "name")[0] as string | undefined : undefined;
}

describe("Responses continuation history", () => {
  it("does not resurrect a receipt that expires inside checkpoint cleanup", async () => {
    const database = new Database(":memory:");
    const base = 1_700_000_000_000;
    let checkpointing = false;
    let checkpointClockReads = 0;
    const nowMs = (): number => {
      if (!checkpointing) {
        return base;
      }
      checkpointClockReads += 1;
      return checkpointClockReads <= 2 ? base + 86_400_000 - 1 : base + 86_400_000;
    };
    applyMigrations(database, [
      embedMigration(runtimeConfigMigration),
      embedMigration(responsesHistoryMigration),
      embedMigration(responsesContinuationMigration),
      embedMigration(reasoningCarriersMigration),
    ], () => base);
    const store = new SqliteResponsesHistory(database, { nowMs, ttlDays: 1 });
    try {
      await store.recordReceipt({
        ...ownership("github.com/1"),
        responseId: "resp_expiring",
        checkpointState: "route_only",
      }, SIGNAL);
      checkpointing = true;
      await expect(store.recordCheckpoint(
        callRecord("resp_expiring", "call_1", "lookup"),
        ownership("github.com/1"),
        "partial",
        SIGNAL,
      )).rejects.toMatchObject({ code: "expired" });
      expect(database.prepare(
        "SELECT checkpoint_state FROM response_route_receipts WHERE account_id = ? AND response_id = ?",
      ).get("github.com/1", "resp_expiring")).toMatchObject({ checkpoint_state: "expired" });
      expect(database.prepare(
        "SELECT revision FROM responses_continuation_state WHERE singleton_id = 1",
      ).get()).toMatchObject({ revision: 2 });
      await expect(store.resolve("resp_expiring", "github.com/1", SIGNAL))
        .resolves.toMatchObject({ kind: "expired" });
    } finally {
      database.close();
    }
  });

  it("isolates identical response and call IDs by bound account", async () => {
    const { database, store } = history();
    try {
      await store.recordCheckpoint(callRecord("resp_same", "call_same", "account_one"), ownership("github.com/1"), "complete", SIGNAL);
      await store.recordCheckpoint(callRecord("resp_same", "call_same", "account_two"), ownership("github.com/2"), "complete", SIGNAL);

      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"previous_response_id\":\"resp_same\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call_same\",\"output\":\"ok\"}}",
      ));
      const one = await store.enrich(request, await owned(store, "resp_same", "github.com/1"), SIGNAL);
      const two = await store.enrich(request, await owned(store, "resp_same", "github.com/2"), SIGNAL);

      expect(restoredName(one.input)).toBe("account_one");
      expect(restoredName(two.input)).toBe("account_two");
      expect(store.inspect()).toMatchObject({ count: 2, receiptCount: 2, legacyCount: 0 });
    } finally {
      database.close();
    }
  });

  it("never falls back to a global call ID after scoped lookup", async () => {
    const { database, store } = history();
    try {
      await store.recordCheckpoint(callRecord("resp_one", "call_shared", "one"), ownership("github.com/1"), "complete", SIGNAL);
      await store.recordCheckpoint(callRecord("resp_two", "call_other", "two"), ownership("github.com/1"), "complete", SIGNAL);
      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"previous_response_id\":\"resp_two\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call_shared\",\"output\":\"ok\"}}",
      ));

      await expect(store.enrich(request, await owned(store, "resp_two", "github.com/1"), SIGNAL))
        .rejects.toMatchObject({ code: "checkpoint_unavailable" });
    } finally {
      database.close();
    }
  });

  it("rejects model, protocol, and owner reuse of an existing scoped response ID", async () => {
    const { database, store } = history();
    try {
      await store.recordReceipt({
        ...ownership("github.com/1", "model-a"),
        responseId: "resp_claimed",
        checkpointState: "route_only",
      }, SIGNAL);
      await expect(store.recordReceipt({
        ...ownership("github.com/1", "model-b"),
        responseId: "resp_claimed",
        checkpointState: "route_only",
      }, SIGNAL)).rejects.toBeInstanceOf(ResponsesContinuationError);
      await expect(store.recordReceipt({
        ...ownership("github.com/1", "model-a", "messages"),
        responseId: "resp_claimed",
        checkpointState: "route_only",
      }, SIGNAL)).rejects.toMatchObject({ code: "ownership_conflict" });
      await expect(store.recordReceipt({
        ...nativeOwnership("github.com/1", "model-a"),
        responseId: "resp_claimed",
        checkpointState: "complete",
      }, SIGNAL)).rejects.toMatchObject({ code: "ownership_conflict" });
    } finally {
      database.close();
    }
  });

  it("uses a first-writer claim under concurrent same-ID records", async () => {
    const { database, store } = history();
    try {
      const results = await Promise.allSettled([
        store.recordReceipt({
          ...ownership("github.com/1", "model-a"),
          responseId: "resp_race",
          checkpointState: "route_only",
        }, SIGNAL),
        store.recordReceipt({
          ...ownership("github.com/1", "model-b"),
          responseId: "resp_race",
          checkpointState: "route_only",
        }, SIGNAL),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((await owned(store, "resp_race", "github.com/1")).modelId).toBe("model-a");
    } finally {
      database.close();
    }
  });

  it("keeps native receipts content-free and refuses local enrichment", async () => {
    const { database, store } = history();
    try {
      await store.recordReceipt({
        ...nativeOwnership("github.com/1"),
        responseId: "resp_native",
        checkpointState: "complete",
      }, SIGNAL);
      const receipt = await owned(store, "resp_native", "github.com/1");
      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"previous_response_id\":\"resp_native\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call\",\"output\":\"ok\"}}",
      ));
      await expect(store.enrich(request, receipt, SIGNAL))
        .rejects.toMatchObject({ code: "checkpoint_unavailable" });
      expect(store.inspect()).toMatchObject({ count: 0, receiptCount: 1 });
    } finally {
      database.close();
    }
  });

  it("preserves legacy rows as unowned and unusable", async () => {
    const { database, store } = history();
    try {
      database.prepare(
        "INSERT INTO responses (response_id, insertion_seq, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)",
      ).run("resp_legacy", 1, 1_700_000_000_000, 1_700_604_800_000);
      database.prepare(
        "INSERT INTO response_calls (response_id, ordinal, call_id, kind, item_json) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "resp_legacy",
        0,
        "call_legacy",
        "function_call",
        "{\"type\":\"function_call\",\"call_id\":\"call_legacy\",\"name\":\"legacy\",\"arguments\":\"{}\"}",
      );

      await expect(store.resolve("resp_legacy", "github.com/1", SIGNAL))
        .resolves.toEqual({ kind: "legacy_unowned" });
      expect(store.inspect()).toMatchObject({ count: 1, receiptCount: 0, legacyCount: 1 });
    } finally {
      database.close();
    }
  });
});

function inputJson(input: WireJson | undefined): unknown {
  if (input === undefined) {
    return undefined;
  }
  return JSON.parse(new TextDecoder().decode(serializeWireJson(input))) as unknown;
}

describe("Responses history retained safety evidence", () => {
  it("writes v2 replay groups in exact order and excludes trailing reasoning", async () => {
    const { database, store } = history();
    try {
      await store.recordCheckpoint({
        responseId: "resp_ordered",
        output: outputFromJson(JSON.stringify([
          { type: "reasoning", id: "rs_a", encrypted_content: "opaque-a", summary: [] },
          { type: "function_call", call_id: "call_a", name: "first", arguments: "{}" },
          { type: "custom_tool_call", call_id: "call_b", name: "second", input: "raw" },
          { type: "reasoning", id: "rs_b", encrypted_content: "opaque-b", summary: [] },
          { type: "message", role: "assistant", content: [] },
          { type: "tool_search_call", call_id: "call_c", arguments: { query: "docs" } },
          { type: "reasoning", id: "rs_trailing", encrypted_content: "drop", summary: [] },
        ])),
      }, ownership("github.com/1"), "complete", SIGNAL);
      const receipt = await owned(store, "resp_ordered", "github.com/1");

      expect(database.prepare(
        `SELECT group_ordinal, item_ordinal, item_kind, call_id
           FROM response_scoped_replay_items
           WHERE account_id = ? AND response_id = ?
           ORDER BY group_ordinal, item_ordinal`,
      ).all("github.com/1", "resp_ordered")).toEqual([
        { group_ordinal: 0, item_ordinal: 0, item_kind: "reasoning", call_id: null },
        { group_ordinal: 0, item_ordinal: 1, item_kind: "function_call", call_id: "call_a" },
        { group_ordinal: 0, item_ordinal: 2, item_kind: "custom_tool_call", call_id: "call_b" },
        { group_ordinal: 1, item_ordinal: 0, item_kind: "reasoning", call_id: null },
        { group_ordinal: 1, item_ordinal: 1, item_kind: "tool_search_call", call_id: "call_c" },
      ]);
      expect(database.prepare(
        "SELECT replay_format_version, replay_item_count FROM response_scoped_checkpoints WHERE response_id = ?",
      ).get("resp_ordered")).toEqual({ replay_format_version: 2, replay_item_count: 5 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM response_scoped_calls WHERE account_id = ? AND response_id = ?",
      ).get("github.com/1", "resp_ordered")).toEqual({ count: 0 });

      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"previous_response_id\":\"resp_ordered\",\"input\":[{\"type\":\"function_call_output\",\"call_id\":\"call_a\",\"output\":\"a\"},{\"type\":\"custom_tool_call_output\",\"call_id\":\"call_b\",\"output\":\"b\"},{\"type\":\"tool_search_output\",\"call_id\":\"call_c\",\"tools\":[]}]}",
      ));
      const enriched = await store.enrich(
        request,
        receipt,
        SIGNAL,
      );
      expect(inputJson(enriched.input)).toEqual([
        { type: "reasoning", id: "rs_a", encrypted_content: "opaque-a", summary: [] },
        { type: "function_call", call_id: "call_a", name: "first", arguments: "{}" },
        { type: "custom_tool_call", call_id: "call_b", name: "second", input: "raw" },
        { type: "reasoning", id: "rs_b", encrypted_content: "opaque-b", summary: [] },
        { type: "tool_search_call", call_id: "call_c", arguments: { query: "docs" } },
        { type: "function_call_output", call_id: "call_a", output: "a" },
        { type: "custom_tool_call_output", call_id: "call_b", output: "b" },
        { type: "tool_search_output", call_id: "call_c", tools: [] },
      ]);

      const repeatedCall = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"input\":[{\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"\",\"arguments\":\"\"},{\"type\":\"function_call_output\",\"call_id\":\"call_a\",\"output\":\"a\"}]}",
      ));
      expect(inputJson((await store.enrich(
        repeatedCall,
        receipt,
        SIGNAL,
      )).input)).toEqual([
        { type: "reasoning", id: "rs_a", encrypted_content: "opaque-a", summary: [] },
        { type: "function_call", call_id: "call_a", name: "first", arguments: "{}" },
        { type: "custom_tool_call", call_id: "call_b", name: "second", input: "raw" },
        { type: "reasoning", id: "rs_b", encrypted_content: "opaque-b", summary: [] },
        { type: "tool_search_call", call_id: "call_c", arguments: { query: "docs" } },
        { type: "function_call_output", call_id: "call_a", output: "a" },
      ]);

      database.prepare(
        "UPDATE response_route_receipts SET conversion_version = 'responses-chat-v1' WHERE response_id = ?",
      ).run("resp_ordered");
      await expect(store.enrich(request, receipt, SIGNAL))
        .rejects.toMatchObject({ code: "checkpoint_unavailable" });
      await expect(store.resolve("resp_ordered", "github.com/1", SIGNAL))
        .rejects.toMatchObject({ code: "checkpoint_unavailable" });
    } finally {
      database.close();
    }
  });

  it("replaces an earlier partial snapshot with the completed replay", async () => {
    const { database, store } = history();
    try {
      await store.recordCheckpoint(
        callRecord("resp_replaced", "call_a", "first"),
        ownership("github.com/1"),
        "partial",
        SIGNAL,
      );
      await store.recordCheckpoint({
        responseId: "resp_replaced",
        output: outputFromJson(
          "[{\"type\":\"reasoning\",\"id\":\"rs_final\",\"summary\":[]},{\"type\":\"function_call\",\"call_id\":\"call_b\",\"name\":\"second\",\"arguments\":\"{}\"}]",
        ),
      }, ownership("github.com/1"), "complete", SIGNAL);

      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call_b\",\"output\":\"ok\"}}",
      ));
      expect(inputJson((await store.enrich(
        request,
        await owned(store, "resp_replaced", "github.com/1"),
        SIGNAL,
      )).input)).toEqual([
        { type: "reasoning", id: "rs_final", summary: [] },
        { type: "function_call", call_id: "call_b", name: "second", arguments: "{}" },
        { type: "function_call_output", call_id: "call_b", output: "ok" },
      ]);
    } finally {
      database.close();
    }
  });

  it("enforces item, item-byte, aggregate-byte, and stored metadata bounds", async () => {
    const create = (options: ConstructorParameters<typeof SqliteResponsesHistory>[1]) => {
      const database = new Database(":memory:");
      applyMigrations(database, [
        embedMigration(runtimeConfigMigration),
        embedMigration(responsesHistoryMigration),
        embedMigration(responsesContinuationMigration),
        embedMigration(reasoningCarriersMigration),
      ], () => 1_700_000_000_000);
      return {
        database,
        store: new SqliteResponsesHistory(database, { nowMs: () => 1_700_000_000_000, ...options }),
      };
    };
    for (const [name, options, record] of [
      ["item-count", { maxReplayItems: 1 }, {
        responseId: "resp_count",
        output: outputFromJson("[{\"type\":\"function_call\",\"call_id\":\"a\",\"name\":\"a\",\"arguments\":\"{}\"},{\"type\":\"function_call\",\"call_id\":\"b\",\"name\":\"b\",\"arguments\":\"{}\"}]"),
      }],
      ["item-bytes", { maxReplayItemBytes: 16 }, callRecord("resp_item_bytes", "call_a", "lookup")],
      ["aggregate-bytes", { maxReplayBytes: 100 }, {
        responseId: "resp_total_bytes",
        output: outputFromJson("[{\"type\":\"function_call\",\"call_id\":\"a\",\"name\":\"a\",\"arguments\":\"{}\"},{\"type\":\"function_call\",\"call_id\":\"b\",\"name\":\"b\",\"arguments\":\"{}\"}]"),
      }],
    ] as const) {
      const bounded = create(options);
      try {
        await expect(bounded.store.recordCheckpoint(record, ownership("github.com/1"), "complete", SIGNAL), name)
          .rejects.toMatchObject({ code: "checkpoint_unavailable" });
        expect(bounded.store.inspect()).toMatchObject({ count: 0, receiptCount: 0 });
      } finally {
        bounded.database.close();
      }
    }

    const bounded = create({ maxReplayItems: 4, maxReplayItemBytes: 512, maxReplayBytes: 1024 });
    try {
      await bounded.store.recordCheckpoint(
        callRecord("resp_tampered", "call_tampered", "lookup"),
        ownership("github.com/1"),
        "complete",
        SIGNAL,
      );
      bounded.database.prepare(
        "UPDATE response_scoped_checkpoints SET replay_item_count = 4 WHERE response_id = ?",
      ).run("resp_tampered");
      await expect(bounded.store.resolve("resp_tampered", "github.com/1", SIGNAL))
        .rejects.toMatchObject({ code: "checkpoint_unavailable" });
      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call_tampered\",\"output\":\"ok\"}}",
      ));
      await expect(bounded.store.enrich(
        request,
        {
          ...ownership("github.com/1"),
          responseId: "resp_tampered",
          checkpointState: "complete",
          expiresAt: 1_700_604_800_000,
        },
        SIGNAL,
      )).rejects.toMatchObject({ code: "checkpoint_unavailable" });
      await expect(bounded.store.recordCheckpoint(
        callRecord("resp_tampered", "call_tampered", "lookup"),
        ownership("github.com/1"),
        "complete",
        SIGNAL,
      )).rejects.toMatchObject({ code: "checkpoint_unavailable" });
    } finally {
      bounded.database.close();
    }
  });

  it("fails closed when persisted replay JSON disagrees with its metadata", async () => {
    const { database, store } = history();
    try {
      await store.recordCheckpoint(
        callRecord("resp_tampered_json", "call_tampered", "lookup"),
        ownership("github.com/1"),
        "complete",
        SIGNAL,
      );
      const tampered = "{\"type\":\"function_call\",\"call_id\":\"different\",\"name\":\"lookup\",\"arguments\":\"{}\"}";
      database.prepare(
        `UPDATE response_scoped_replay_items
           SET item_json = ?, item_bytes = length(CAST(? AS BLOB))
           WHERE response_id = ?`,
      ).run(tampered, tampered, "resp_tampered_json");
      database.prepare(
        `UPDATE response_scoped_checkpoints
           SET replay_bytes = (SELECT SUM(item_bytes) FROM response_scoped_replay_items WHERE response_id = ?)
           WHERE response_id = ?`,
      ).run("resp_tampered_json", "resp_tampered_json");
      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call_tampered\",\"output\":\"ok\"}}",
      ));
      await expect(store.enrich(
        request,
        {
          ...ownership("github.com/1"),
          responseId: "resp_tampered_json",
          checkpointState: "complete",
          expiresAt: 1_700_604_800_000,
        },
        SIGNAL,
      )).rejects.toMatchObject({ code: "checkpoint_unavailable" });
    } finally {
      database.close();
    }
  });
});
