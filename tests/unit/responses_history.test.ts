import { SqliteDatabase as Database } from "../../src/persistence/sqlite.js";
import { describe, expect, it } from "vitest";
import { applyMigrations, embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import {
  ResponsesContinuationError,
  SqliteResponsesHistory,
  type ResponsesContinuationOwnership,
  type ResponsesHistoryRecord,
  type ResponsesRouteReceipt,
} from "../../src/protocols/responses/history.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
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
    conversionVersion: protocol === "chat" ? "responses-chat-v1" : "responses-messages-v1",
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

function history(): { readonly database: Database; readonly store: SqliteResponsesHistory } {
  const database = new Database(":memory:");
  applyMigrations(database, [
    embedMigration(runtimeConfigMigration),
    embedMigration(responsesHistoryMigration),
    embedMigration(responsesContinuationMigration),
  ], () => 1_700_000_000_000);
  return { database, store: new SqliteResponsesHistory(database, { nowMs: () => 1_700_000_000_000 }) };
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

  it("supports a future Messages-owned minimal tool checkpoint without replay claims", async () => {
    const { database, store } = history();
    try {
      await store.recordCheckpoint(
        callRecord("resp_messages", "call_m", "lookup"),
        ownership("github.com/1", "claude", "messages"),
        "partial",
        SIGNAL,
      );
      const request = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"claude\",\"previous_response_id\":\"resp_messages\",\"input\":{\"type\":\"function_call_output\",\"call_id\":\"call_m\",\"output\":\"ok\"}}",
      ));
      const enriched = await store.enrich(
        request,
        await owned(store, "resp_messages", "github.com/1"),
        SIGNAL,
      );
      expect(restoredName(enriched.input)).toBe("lookup");
      expect((await owned(store, "resp_messages", "github.com/1")).checkpointState).toBe("partial");

      const textOnly = decodeResponsesRequest(objectFromJson(
        "{\"model\":\"claude\",\"previous_response_id\":\"resp_messages\",\"input\":\"continue\"}",
      ));
      await expect(store.enrich(textOnly, await owned(store, "resp_messages", "github.com/1"), SIGNAL))
        .rejects.toMatchObject({ code: "checkpoint_unavailable" });
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
