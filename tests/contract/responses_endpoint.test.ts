import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import type { NativeResponsesUpstreamRequest } from "../../src/copilot/upstream_types.js";
import type { ChatRequest } from "../../src/protocols/chat_completions/types.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

const nowMs = (): number => 1_700_000_000_000;

describe("Responses endpoint", () => {
  it("registers only /v1/responses and rejects explicit unknown models before upstream", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, backend, close } = await responsesGateway({ usageUpdates });
    try {
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/responses", { method: "POST" }))).status).toBe(404);
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/openai/v1/responses", { method: "POST" }))).status).toBe(404);
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/v1/responses/compact", { method: "POST" }))).status).toBe(404);

      const unknown = await gw.fetch(responsesRequest({ model: "missing", input: "hi" }));
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe("{\"error\":{\"message\":\"model not found\",\"type\":\"not_found_error\",\"param\":null,\"code\":null}}");
      expect(backend.captured).toEqual([]);
      expect(usageUpdates).toMatchObject([{
        protocol: "openai_responses_bridge",
        outcome: "client_error",
        accountId: "github.com/1",
        resolvedModel: "missing",
        requestCount: 1,
        errorCount: 1,
      }]);
    } finally {
      await close();
    }
  });

  it("executes native non-stream without Chat bridge or local history", async () => {
    const usageUpdates: UsageUpdate[] = [];
    let captured: NativeResponsesUpstreamRequest | undefined;
    const backend = new ScriptedCopilotBackend({
      responses(request) {
        captured = request;
        return {
          status: 200,
          headers: new Headers(),
          body: new TextEncoder().encode("{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":1}}"),
        };
      },
    });
    const { gw, history, close } = await responsesGateway({ backend, usageUpdates });
    try {
      const response = await gw.fetch(responsesRequest({
        model: "native",
        previous_response_id: "upstream-owned",
        input: [{ type: "message", role: "user", content: "hi" }],
        reasoning: { encrypted_content: "secret-state" },
        stream: false,
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("req_responses");
      expect(await response.text()).toBe("{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":1}}");
      expect(backend.captured.map((entry) => entry.kind)).toEqual(["responses"]);
      expect(new TextDecoder().decode(captured?.body)).toBe("{\"model\":\"native\",\"previous_response_id\":\"upstream-owned\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":\"hi\"}],\"reasoning\":{\"encrypted_content\":\"secret-state\"},\"stream\":false}");
      expect(history.inspect().count).toBe(0);
      expect(usageUpdates).toMatchObject([{
        protocol: "openai_responses_native",
        outcome: "success",
        inputTokens: 1,
        outputTokens: 0,
        cacheTokens: 0,
      }]);
    } finally {
      await close();
    }
  });

  it("executes bridge non-stream and commits history before success bytes", async () => {
    const usageUpdates: UsageUpdate[] = [];
    let captured: ChatRequest | undefined;
    const backend = new ScriptedCopilotBackend({
      chat(request) {
        captured = request;
        return {
          status: 200,
          headers: new Headers(),
          body: new TextEncoder().encode(JSON.stringify({
            id: "chatcmpl_bridge",
            created: 1700000000,
            model: "chat",
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: "done",
                tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
              },
            }],
            usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
          })),
        };
      },
    });
    const { gw, history, close } = await responsesGateway({ backend, usageUpdates });
    try {
      const response = await gw.fetch(responsesRequest({
        model: "chat",
        input: "hi",
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      }));
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as { id: string; output: Array<{ type: string; call_id?: string }> };
      expect(body.output.map((item) => item.type)).toEqual(["message", "function_call"]);
      expect(body.output[1]?.call_id).toBe("call_1");
      expect(history.inspect().count).toBe(1);
      expect(backend.captured.map((entry) => entry.kind)).toEqual(["chat"]);
      expect(new TextDecoder().decode(captured?.body)).toContain("\"model\":\"chat\"");
      expect(usageUpdates).toMatchObject([{
        protocol: "openai_responses_bridge",
        outcome: "success",
        inputTokens: 9,
        outputTokens: 4,
        cacheTokens: 3,
      }]);
    } finally {
      await close();
    }
  });

  it("uses Responses SSE bytes for native and bridge streams without DONE markers", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      responsesStream: [
        text("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":1}}}}\n\n"),
      ],
      chatStream: [
        text("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\n"),
        text("data: [DONE]\n\n"),
      ],
    });
    const { gw, close } = await responsesGateway({ backend, usageUpdates });
    try {
      const native = await gw.fetch(responsesRequest({ model: "native", input: "hi", stream: true }));
      expect(native.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(await native.text()).toBe("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":1}}}}\n\n");

      const bridge = await gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
      const bridgeText = await bridge.text();
      expect(bridgeText).toContain("event: response.created\n");
      expect(bridgeText).toContain("event: response.completed\n");
      expect(bridgeText).not.toContain("[DONE]");
      expect(usageUpdates).toMatchObject([
        { protocol: "openai_responses_native", outcome: "success", inputTokens: 5, outputTokens: 2, cacheTokens: 1 },
        { protocol: "openai_responses_bridge", outcome: "success", inputTokens: 7, outputTokens: 3, cacheTokens: 2 },
      ]);
    } finally {
      await close();
    }
  });

  it("returns a pre-commit JSON error for malformed native stream before first byte", async () => {
    const backend = new ScriptedCopilotBackend({
      responsesStream: [text("event: wrong\ndata: {\"type\":\"response.completed\"}\n\n")],
    });
    const { gw, close } = await responsesGateway({ backend });
    try {
      const response = await gw.fetch(responsesRequest({ model: "native", input: "hi", stream: true }));
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.text()).toBe("{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}");
    } finally {
      await close();
    }
  });

  async function responsesGateway(options: {
    readonly backend?: ScriptedCopilotBackend;
    readonly usageUpdates?: UsageUpdate[];
  } = {}): Promise<{
    readonly gw: Gateway;
    readonly backend: ScriptedCopilotBackend;
    readonly history: SqliteResponsesHistory;
    close(): Promise<void>;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-responses-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [
        embedMigration(runtimeConfigMigration),
        embedMigration(accountsMigration),
        embedMigration(responsesHistoryMigration),
      ],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return {
          data: [
            { id: "native", name: "Native", vendor: "github", model_picker_enabled: true, model_info: { mode: "responses" } },
            { id: "chat", name: "Chat", vendor: "github", model_picker_enabled: true, model_info: { mode: "chat" } },
          ],
        };
      },
    });
    const history = new SqliteResponsesHistory(database, { nowMs });
    const backend = options.backend ?? new ScriptedCopilotBackend({
      responses: { status: 200, headers: new Headers(), body: text("{\"id\":\"resp_1\",\"output\":[]}") },
      chat: { status: 200, headers: new Headers(), body: text("{\"id\":\"chatcmpl_1\",\"model\":\"chat\",\"choices\":[]}") },
    });
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [createResponsesRoute({
      directory: accounts,
      catalog,
      preferences: accounts.preferences,
      copilot: backend,
      history,
      nowUnixSeconds: () => 1_700_000_000,
      createUuid: () => "00000000-0000-4000-8000-000000000001",
      ...(options.usageUpdates === undefined
        ? {}
        : { usageRecorder: { recordUsage: (update: UsageUpdate) => options.usageUpdates?.push(update) } }),
    })], { createRequestId: () => "req_responses" });
    return {
      gw,
      backend,
      history,
      async close() {
        await gw.close();
        closeDatabase(database);
      },
    };
  }

  function responsesRequest(body: unknown): Request {
    return new Request("http://127.0.0.1:31400/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function text(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }
});
