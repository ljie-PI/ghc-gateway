import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as configMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import { migration as historyMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as ownershipMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { createAnthropicMessagesRoute } from "../../src/protocols/anthropic_messages/endpoint.js";
import { createOpenAiChatRoute } from "../../src/protocols/openai_chat/endpoint.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { convertBufferedResponse } from "../../src/protocols/conversion/buffered.js";
import { convertProtocolStream } from "../../src/protocols/conversion/stream.js";
import type { InferenceProtocol, SemanticUsage } from "../../src/protocols/conversion/types.js";
import { TelemetryRecorder, type UsageUpdate } from "../../src/telemetry/recorder.js";
import { testModelCapabilityRegistry } from "./model_capability_registry_harness.js";

const encoder = new TextEncoder();
const protocols = ["chat", "messages", "responses"] as const;
type Counters = Record<string, unknown>;
const nowMs = (): number => 1_700_000_000_000;
const uuid = (): string => "00000000-0000-4000-8000-000000000001";

// Independent examples: Chat separate output is 9 + 13; inclusive input is
// 31, of which 3 is read from cache and 5 written. Messages raw input is 23.
const snapshots: Record<InferenceProtocol, Counters[]> = {
  chat: [
    { prompt_tokens: 31, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
    { reasoning_tokens: 13, prompt_tokens_details: { cache_write_tokens: 5 } },
    { completion_tokens: 9 },
    { completion_tokens: 9 },
  ],
  messages: [
    { input_tokens: 23, output_tokens: 7, cache_read_input_tokens: 3 },
    { cache_creation_input_tokens: 5 },
    { output_tokens: 22 },
    { output_tokens: 22 },
  ],
  responses: [
    { input_tokens: 31, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } },
    { input_tokens_details: { cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 13 } },
    { output_tokens: 22 },
    { output_tokens: 22 },
  ],
};
const completeUsage: Record<InferenceProtocol, Counters> = {
  chat: { prompt_tokens: 31, completion_tokens: 9, reasoning_tokens: 13, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } },
  messages: { input_tokens: 23, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
  responses: { input_tokens: 31, output_tokens: 22, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 13 } },
};
const chatCases: Array<{ name: string; updates: Counters[]; outputs: number[]; reasoning: number[] }> = [
  { name: "completion then separate reasoning then revised completion", updates: [{ completion_tokens: 7 }, { reasoning_tokens: 13 }, { completion_tokens: 9 }], outputs: [7, 20, 22], reasoning: [0, 13, 13] },
  { name: "combined then revised completion", updates: [{ completion_tokens: 7, reasoning_tokens: 13 }, { completion_tokens: 9 }], outputs: [20, 22], reasoning: [13, 13] },
  { name: "reverse arrival and repeated snapshots", updates: [{ reasoning_tokens: 13 }, { completion_tokens: 7 }, { reasoning_tokens: 13 }, { completion_tokens: 7 }], outputs: [13, 20, 20, 20], reasoning: [13, 13, 13, 13] },
  { name: "absent versus explicit zero", updates: [{ completion_tokens: 7, reasoning_tokens: 13 }, {}, { reasoning_tokens: 0 }, { completion_tokens: 0 }], outputs: [20, 20, 7, 0], reasoning: [13, 13, 0, 0] },
  { name: "nested subset supersedes separate form", updates: [{ completion_tokens: 7, reasoning_tokens: 13 }, { completion_tokens_details: { reasoning_tokens: 3 } }, { completion_tokens: 9 }, { reasoning_tokens: 17 }], outputs: [20, 7, 9, 9], reasoning: [13, 3, 3, 3] },
  { name: "nested zero remains authoritative across partial events", updates: [{ completion_tokens_details: { reasoning_tokens: 0 } }, { completion_tokens: 7, reasoning_tokens: 13 }, { completion_tokens_details: {} }, { completion_tokens_details: { reasoning_tokens: 2 } }], outputs: [0, 7, 7, 7], reasoning: [0, 0, 0, 2] },
];

describe("content-free protocol usage accounting", () => {
  it.each(chatCases)("merges Chat $name through public stream conversion", async ({ updates, outputs, reasoning }) => {
    for (const target of ["responses", "messages"] as const) {
      const converted = await convertStream("chat", target, updates);
      expect(converted.usage.map((usage) => usage.outputTokens)).toEqual(outputs);
      expect(converted.usage.map((usage) => usage.reasoningTokens)).toEqual(reasoning);
      const events = converted.wire.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      expect(target === "messages" ? events.find((event) => event.type === "message_delta").usage.output_tokens : events.find((event) => event.type === "response.completed").response.usage.output_tokens).toBe(outputs.at(-1));
    }
  });

  it.each([0, 3])("keeps buffered nested reasoning %i a subset and nested cache zero authoritative", (reasoning) => {
    const result = convertBufferedResponse(buffered("chat", {
      prompt_tokens: 11, completion_tokens: 7, reasoning_tokens: 13,
      completion_tokens_details: { reasoning_tokens: reasoning },
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      cache_read_input_tokens: 3, cache_creation_input_tokens: 5,
    }), context("chat", "responses"));
    expect(result.observations.usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: reasoning });
  });

  it.each(protocols)("preserves %s partial cache snapshots, updates and zero without adding inclusive subsets", async (source) => {
    const updates: Counters[] = source === "chat" ? [
      { prompt_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
      { prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
      {}, { prompt_tokens: 0 },
    ] : source === "messages" ? [
      { input_tokens: 3, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
      { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      {}, { input_tokens: 0 },
    ] : [
      { input_tokens: 11, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } },
      { input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      {}, { input_tokens: 0 },
    ];
    const result = await convertStream(source, source === "responses" ? "chat" : "responses", updates);
    expect(result.usage.map((usage) => usage.inputTokens)).toEqual(source === "messages" ? [11, 3, 3, 0] : [11, 11, 11, 0]);
    expect(result.usage.map((usage) => usage.cacheReadTokens)).toEqual([3, 0, 0, 0]);
    expect(result.usage.map((usage) => usage.cacheWriteTokens)).toEqual([5, 0, 0, 0]);
  });

  it.each(protocols)("maps buffered and streamed %s source usage independently of target wire", async (source) => {
    for (const target of protocols.filter((protocol) => protocol !== source)) {
      const result = convertBufferedResponse(buffered(source, completeUsage[source]), context(source, target));
      const expected = { inputTokens: 31, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 5, reasoningTokens: source === "messages" ? 0 : 13 };
      expect(result.observations.usage).toEqual(expected);
      const streamed = await convertStream(source, target, snapshots[source]);
      expect(streamed.usage.at(-1)).toEqual(expected);
      const expectedWire = target === "messages"
        ? { input_tokens: 23, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 }
        : target === "chat"
          ? { prompt_tokens: 31, completion_tokens: 22, total_tokens: 53, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } }
          : { input_tokens: 31, output_tokens: 22, total_tokens: 53, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } };
      expect(JSON.parse(new TextDecoder().decode(result.bytes)).usage).toMatchObject(expectedWire);
      const events = streamed.wire.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      const terminalUsage = target === "messages"
        ? events.find((event) => event.type === "message_delta").usage
        : target === "chat"
          ? events.findLast((event) => event.usage != null).usage
          : events.find((event) => event.type === "response.completed").response.usage;
      expect(terminalUsage).toMatchObject(expectedWire);
    }
  });

  for (const source of protocols) {
    for (const target of protocols) {
      it.each([false, true])(`records ${source} -> ${target} stream=%s once per request with inclusive Usage Buckets`, async (stream) => {
        const harness = await usageGateway(source, snapshots[source], completeUsage[source]);
        try {
          // Two requests exercise persisted bucket accumulation, not SSE summation.
          for (let index = 0; index < 2; index += 1) {
            const response = await harness.gw.fetch(request(target, stream));
            expect(response.status).toBe(200);
            expect(response.headers.get("x-ghcg-upstream-protocol")).toBe(source);
            const wire = await response.text();
            expect(response.headers.get("content-type")).toBe(stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
            if (source === target) {
              expect(wire).toBe(stream ? streamWire(source, snapshots[source]) : new TextDecoder().decode(buffered(source, completeUsage[source])));
            }
            await harness.recorder.flush();
          }
          expect(harness.backend.captured.map((entry) => entry.kind)).toEqual([stream ? `${source}-stream` : source, stream ? `${source}-stream` : source]);
          expect(harness.updates).toHaveLength(2);
          for (const update of harness.updates) {
            expect(update).toEqual({ occurredAtMs: nowMs(), accountId: "github.com/1", protocol: target === "chat" ? "openai_chat" : target === "messages" ? "anthropic" : source === "responses" ? "openai_responses_native" : "openai_responses_bridge", resolvedModel: "test-model", outcome: "success", requestCount: 1, errorCount: 0, inputTokens: 31, outputTokens: 22, cacheTokens: 8, latencyMs: 0 });
          }
          expect(harness.database.prepare("SELECT request_count, error_count, input_tokens, output_tokens, cache_tokens FROM usage_buckets").all()).toEqual([{ request_count: 2, error_count: 0, input_tokens: 62, output_tokens: 44, cache_tokens: 16 }]);
        } finally {
          await harness.close();
        }
      });
    }
  }

  it.each([
    { source: "chat" as const, usage: { prompt_tokens: 11, completion_tokens: 7, reasoning_tokens: 13, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 }, expected: { inputTokens: 11, outputTokens: 7, cacheTokens: 0 } },
    { source: "chat" as const, usage: { prompt_tokens: 11, completion_tokens: 7, reasoning_tokens: 13, completion_tokens_details: { reasoning_tokens: 3 }, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 }, expected: { inputTokens: 11, outputTokens: 7, cacheTokens: 8 } },
    { source: "chat" as const, usage: { prompt_tokens: 11, completion_tokens: 7, reasoning_tokens: 13, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 }, expected: { inputTokens: 11, outputTokens: 20, cacheTokens: 8 } },
    { source: "responses" as const, usage: { input_tokens: 11, output_tokens: 7, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } }, expected: { inputTokens: 11, outputTokens: 7, cacheTokens: 5 } },
    { source: "responses" as const, usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, expected: { inputTokens: 0, outputTokens: 0, cacheTokens: 0 } },
  ])("preserves native $source non-default status, wire and counter precedence", async ({ source, usage, expected }) => {
    const harness = await usageGateway(source, [completeUsage[source], usage, {}], usage, 201);
    try {
      const bufferedResponse = await harness.gw.fetch(request(source, false));
      expect(bufferedResponse.status).toBe(201);
      expect(await bufferedResponse.text()).toBe(new TextDecoder().decode(buffered(source, usage)));
      expect(bufferedResponse.headers.get("x-request-id")).toBe("req_usage");
      expect(bufferedResponse.headers.get("cache-control")).toBe("no-store");
      const streamedResponse = await harness.gw.fetch(request(source, true));
      expect(await streamedResponse.text()).toBe(streamWire(source, [completeUsage[source], usage, {}]));
      expect(harness.updates).toHaveLength(2);
      expect(harness.updates).toMatchObject([expected, expected]);
    } finally { await harness.close(); }
  });

  it.each(chatCases)("native Chat retains wire and observes $name", async ({ updates, outputs }) => {
    const harness = await usageGateway("chat", updates, {});
    try {
      const response = await harness.gw.fetch(request("chat", true));
      expect(await response.text()).toBe(streamWire("chat", updates));
      expect(harness.updates).toHaveLength(1);
      expect(harness.updates[0]).toMatchObject({ inputTokens: 0, outputTokens: outputs.at(-1), cacheTokens: 0 });
    } finally { await harness.close(); }
  });
});

function context(source: InferenceProtocol, target: InferenceProtocol) {
  return { source, target, model: "test-model", maxBytes: 100_000, eventLimitBytes: 100_000, accumulatorBytes: 100_000, createUuid: uuid, nowUnixSeconds: () => nowMs() / 1000 };
}
function buffered(source: InferenceProtocol, usage: Counters): Uint8Array {
  return encoder.encode(JSON.stringify(source === "chat" ? {
    id: "chat_test", object: "chat.completion", model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage,
  } : source === "messages" ? {
    id: "msg_test", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage,
  } : {
    id: "resp_test", object: "response", status: "completed", model: "test-model", output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage,
  }));
}
function event(type: string, payload: Counters): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}
function streamWire(source: InferenceProtocol, updates: Counters[]): string {
  if (source === "chat") {
    return `data: ${JSON.stringify({ id: "chat_test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`
      + updates.map((usage) => `data: ${JSON.stringify({ id: "chat_test", choices: [], usage })}\n\n`).join("") + "data: [DONE]\n\n";
  }
  if (source === "messages") {
    return event("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: updates[0] } })
      + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } })
      + event("content_block_stop", { index: 0 })
      + updates.slice(1).map((usage) => event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage })).join("")
      + event("message_stop", {});
  }
  return updates.map((usage, index) => index === updates.length - 1
    ? event("response.completed", { sequence_number: index, response: JSON.parse(new TextDecoder().decode(buffered("responses", usage))) })
    : event(index === 0 ? "response.created" : "response.in_progress", { sequence_number: index, response: { id: "resp_test", object: "response", status: "in_progress", output: [], usage } })).join("");
}
async function* chunks(wire: string): AsyncIterable<Uint8Array> {
  const bytes = encoder.encode(wire);
  // Split independently of JSON/SSE boundaries.
  for (let index = 0; index < bytes.length; index += 17) yield bytes.subarray(index, index + 17);
}
async function convertStream(source: InferenceProtocol, target: InferenceProtocol, updates: Counters[]) {
  const usage: SemanticUsage[] = [];
  let wire = "";
  for await (const emission of convertProtocolStream(chunks(streamWire(source, updates)), context(source, target))) {
    if (emission.kind === "usage") usage.push(emission.usage);
    if (emission.kind === "wire") wire += new TextDecoder().decode(emission.bytes);
  }
  return { usage, wire };
}
function request(target: InferenceProtocol, stream: boolean): Request {
  const route = target === "chat" ? "/v1/chat/completions" : `/v1/${target}`;
  const input = target === "responses" ? { input: "hi" } : { messages: [{ role: "user", content: "hi" }] };
  return new Request(`http://127.0.0.1:31400${route}`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "test-model", ...input, max_tokens: target === "messages" ? 100 : undefined, stream }) });
}
async function usageGateway(source: InferenceProtocol, updates: Counters[], usage: Counters, status = 200) {
  const database = openDatabase({ path: ":memory:", migrations: [configMigration, accountsMigration, telemetryMigration, historyMigration, ownershipMigration].map(embedMigration), nowMs });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
  await directory.upsertAuthenticated({ host: "github.com", userId: "1", secret: { generation: 0, githubToken: "test-token" } });
  const catalog = new CopilotModelCatalog({ async fetch() { return { data: [{ id: "test-model", name: "Test", vendor: "test", model_picker_enabled: true, model_info: { supported_endpoints: [source === "chat" ? "/chat/completions" : `/v1/${source}`], chat_output_token_field: "max_tokens" } }] }; } }, () => new Date(nowMs()));
  const backend = new ScriptedCopilotBackend({
    chat: () => ({ status, headers: new Headers(), body: buffered(source, usage) }),
    messages: () => ({ status, headers: new Headers(), body: buffered(source, usage) }),
    responses: () => ({ status, headers: new Headers(), body: buffered(source, usage) }),
    chatStream: [encoder.encode(streamWire(source, updates))],
    messagesStream: [encoder.encode(streamWire(source, updates))],
    responsesStream: [encoder.encode(streamWire(source, updates))],
  });
  const recorder = new TelemetryRecorder(database, nowMs);
  const observations: UsageUpdate[] = [];
  const dependencies = { directory, preferences: directory.preferences, registry: testModelCapabilityRegistry(catalog), copilot: backend, nowMs, createUuid: uuid, usageRecorder: { recordUsage(update: UsageUpdate) { observations.push(update); recorder.recordUsage(update); } } };
  const history = new SqliteResponsesHistory(database, { nowMs });
  const gw = await createGateway({ startup: parseStartupConfig([], {}, { homedir: "." }), runtime: defaultRuntimeConfigSnapshot() }, [createOpenAiChatRoute(dependencies), createAnthropicMessagesRoute(dependencies), createResponsesRoute({ ...dependencies, history, nowUnixSeconds: () => nowMs() / 1000 })], { createRequestId: () => "req_usage" });
  return { gw, database, recorder, updates: observations, backend, close: async () => { await gw.close(); closeDatabase(database); } };
}
