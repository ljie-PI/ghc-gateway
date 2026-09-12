import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { testModelCapabilityRegistry } from "./model_capability_registry_harness.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import { TokenRefreshError } from "../../src/copilot/token_refresh.js";
import { UpstreamTimeoutError } from "../../src/copilot/transport.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import type { NativeResponsesUpstreamRequest } from "../../src/copilot/upstream_types.js";
import type { ChatRequest } from "../../src/protocols/chat_completions/types.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

const nowMs = (): number => 1_700_000_000_000;

describe("Responses endpoint", () => {
  it("observes pre-endpoint body failures once without coupling accounting to the presenter", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, close } = await responsesGateway({ usageUpdates });
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"input\":",
      }));
      expect(response.status).toBe(400);
      expect(usageUpdates).toMatchObject([{
        protocol: "openai_responses_unknown",
        outcome: "client_error",
        requestCount: 1,
        errorCount: 1,
      }]);
    } finally {
      await close();
    }
  });

  it("registers only /v1/responses and rejects explicit unknown models before upstream", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, backend, close } = await responsesGateway({ usageUpdates });
    try {
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/responses", { method: "POST" }))).status).toBe(404);
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/openai/v1/responses", { method: "POST" }))).status).toBe(404);
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/v1/responses/compact", { method: "POST" }))).status).toBe(404);

      const malformedContinuation = await gw.fetch(responsesRequest({
        model: "native",
        previous_response_id: 8,
        input: "hi",
      }));
      expect(malformedContinuation.status).toBe(400);
      await malformedContinuation.text();

      const unknown = await gw.fetch(responsesRequest({ model: "missing", input: "hi" }));
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe("{\"error\":{\"message\":\"model not found\",\"type\":\"not_found_error\",\"param\":null,\"code\":null}}");
      expect(backend.captured).toEqual([]);
      expect(usageUpdates).toMatchObject([
        {
          protocol: "openai_responses_unknown",
          outcome: "client_error",
          accountId: "unbound",
          resolvedModel: "unresolved",
        },
        {
          protocol: "openai_responses_unknown",
          outcome: "client_error",
          accountId: "github.com/1",
          resolvedModel: "missing",
          requestCount: 1,
          errorCount: 1,
        },
      ]);
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
      expect(history.inspect().receiptCount).toBe(1);
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
                tool_calls: [{
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
                }],
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
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: false }],
      }));
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as { id: string; output: Array<{ type: string; call_id?: string }> };
      expect(body.output.map((item) => item.type)).toEqual(["message", "function_call"]);
      expect(body.output[1]?.call_id).toBe("call_1");
      expect(history.inspect().count).toBe(1);
      expect(history.inspect().receiptCount).toBe(1);
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

  it("pins a known converted continuation to Chat before native-first selection", async () => {
    let captured: ChatRequest | undefined;
    const backend = new ScriptedCopilotBackend({
      chat(request) {
        captured = request;
        return {
          status: 200,
          headers: new Headers(),
          body: text("{\"id\":\"chatcmpl_next\",\"model\":\"dual\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}"),
        };
      },
    });
    const { gw, history, close } = await responsesGateway({ backend });
    try {
      const ownership = {
        accountId: "github.com/1",
        modelId: "dual",
        upstreamOrigin: "https://api.githubcopilot.com",
        owner: "converted",
        upstreamProtocol: "chat",
        conversionVersion: "responses-chat-v1",
      } as const;
      await history.recordCheckpoint({
        responseId: "resp_converted",
        output: [{
          kind: "object",
          members: [
            { key: "type", value: "function_call" },
            { key: "call_id", value: "call_owned" },
            { key: "name", value: "lookup" },
            { key: "arguments", value: "{}" },
          ],
        }],
      }, ownership, "complete", new AbortController().signal);

      const response = await gw.fetch(responsesRequest({
        model: "dual",
        previous_response_id: "resp_converted",
        input: { type: "function_call_output", call_id: "call_owned", output: "ok" },
      }));
      expect(response.status).toBe(200);
      expect(backend.captured.map((entry) => entry.kind)).toEqual(["chat"]);
      const forwarded = new TextDecoder().decode(captured?.body);
      expect(forwarded).not.toContain("previous_response_id");
      expect(forwarded).toContain("\"tool_call_id\":\"call_owned\"");
    } finally {
      await close();
    }
  });

  it("rejects cross-account, model, protocol, origin, and unknown converted continuations", async () => {
    const { gw, backend, history, close } = await responsesGateway();
    try {
      const signal = new AbortController().signal;
      await history.recordReceipt({
        accountId: "github.com/2",
        responseId: "resp_foreign",
        modelId: "native",
        upstreamOrigin: "https://api.githubcopilot.com",
        owner: "native",
        upstreamProtocol: "responses",
        conversionVersion: null,
        checkpointState: "complete",
      }, signal);
      await history.recordReceipt({
        accountId: "github.com/1",
        responseId: "resp_chat_route",
        modelId: "native",
        upstreamOrigin: "https://api.githubcopilot.com",
        owner: "converted",
        upstreamProtocol: "chat",
        conversionVersion: "responses-chat-v1",
        checkpointState: "complete",
      }, signal);
      await history.recordReceipt({
        accountId: "github.com/1",
        responseId: "resp_other_origin",
        modelId: "native",
        upstreamOrigin: "https://other.example",
        owner: "native",
        upstreamProtocol: "responses",
        conversionVersion: null,
        checkpointState: "complete",
      }, signal);

      const requests = [
        { model: "native", previous_response_id: "resp_foreign", input: "hi" },
        { model: "chat", previous_response_id: "resp_chat_route", input: "hi" },
        { model: "native", previous_response_id: "resp_chat_route", input: "hi" },
        { model: "native", previous_response_id: "resp_other_origin", input: "hi" },
        { model: "chat", previous_response_id: "external_unknown", input: "hi" },
        {
          model: "native",
          previous_response_id: "resp_bGl0ZWxsbTpjdXN0b21fbGxtX3Byb3ZpZGVyOmdpdGh1Yl9jb3BpbG90O21vZGVsX2lkOmNoYXQ7cmVzcG9uc2VfaWQ6b2xk",
          input: "hi",
        },
      ];
      for (const body of requests) {
        const response = await gw.fetch(responsesRequest(body));
        expect(response.status).toBe(409);
        await response.text();
      }
      expect(backend.captured).toEqual([]);
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
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      responsesStream: [text("event: wrong\ndata: {\"type\":\"response.completed\"}\n\n")],
    });
    const { gw, close } = await responsesGateway({ backend, usageUpdates });
    try {
      const response = await gw.fetch(responsesRequest({ model: "native", input: "hi", stream: true }));
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.text()).toBe("{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        accountId: "github.com/1",
        protocol: "openai_responses_native",
        resolvedModel: "native",
        outcome: "upstream_error",
      }]);
    } finally {
      await close();
    }
  });

  it("normalizes catalog timeout and bind authentication with safe Responses errors", async () => {
    const timeoutUsage: UsageUpdate[] = [];
    const timeoutGateway = await responsesGateway({
      catalogError: new CapiFetchError(502, undefined, "upstream_timeout"),
      usageUpdates: timeoutUsage,
    });
    try {
      const response = await timeoutGateway.gw.fetch(responsesRequest({ model: "native", input: "hi" }));
      expect(response.status).toBe(504);
      expect(response.headers.get("x-request-id")).toBe("req_responses");
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
      expect(timeoutUsage).toMatchObject([{ outcome: "timeout" }]);
    } finally {
      await timeoutGateway.close();
    }

    const authUsage: UsageUpdate[] = [];
    const authGateway = await responsesGateway({
      backend: new ScriptedCopilotBackend({
        bindError: new TokenRefreshError("unauthorized", "secret-token https://unsafe.example/private"),
      }),
      usageUpdates: authUsage,
    });
    try {
      const response = await authGateway.gw.fetch(responsesRequest({ model: "native", input: "hi" }));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"authentication failed\",\"type\":\"authentication_error\",\"param\":null,\"code\":null}}",
      );
      expect(authUsage).toMatchObject([{ outcome: "authentication_error" }]);
    } finally {
      await authGateway.close();
    }
  });

  it.each(["native", "chat"] as const)("normalizes %s transport timeout before commitment", async (model) => {
    const timeout = (): never => {
      throw new UpstreamTimeoutError();
    };
    const backend = new ScriptedCopilotBackend({
      responses: timeout,
      chat: timeout,
    });
    const { gw, close } = await responsesGateway({ backend });
    try {
      const response = await gw.fetch(responsesRequest({ model, input: "hi" }));
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("normalizes native truncation and bridge error events before commitment", async () => {
    const nativeGateway = await responsesGateway({
      backend: new ScriptedCopilotBackend({ responsesStream: [] }),
    });
    try {
      const response = await nativeGateway.gw.fetch(responsesRequest({ model: "native", input: "hi", stream: true }));
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("\"message\":\"upstream request failed\"");
    } finally {
      await nativeGateway.close();
    }

    const bridgeGateway = await responsesGateway({
      backend: new ScriptedCopilotBackend({
        chatStream: [text("event: error\ndata: {\"error\":{\"message\":\"secret-token https://unsafe.example/private\"}}\n\n")],
      }),
    });
    try {
      const response = await bridgeGateway.gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream request failed\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await bridgeGateway.close();
    }
  });

  it.each(["native", "chat"] as const)("keeps %s internal deadline distinct from client abort before commitment", async (model) => {
    const timeoutUsage: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.totalMs = 1;
    const timedOutGateway = await responsesGateway({
      runtime,
      backend: new ScriptedCopilotBackend({
        responsesStream: (request) => stalledStream(request.signal),
        chatStream: (request) => stalledStream(request.signal),
      }),
      usageUpdates: timeoutUsage,
    });
    try {
      const response = await timedOutGateway.gw.fetch(responsesRequest({ model, input: "hi", stream: true }));
      expect(response.status).toBe(504);
      expect(response.headers.get("x-request-id")).toBe("req_responses");
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
      expect(timeoutUsage).toHaveLength(1);
      expect(timeoutUsage).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "timeout",
      }]);
    } finally {
      await timedOutGateway.close();
    }

    const abortedUsage: UsageUpdate[] = [];
    const clientGateway = await responsesGateway({
      backend: new ScriptedCopilotBackend({
        responsesStream: (request) => stalledStream(request.signal),
        chatStream: (request) => stalledStream(request.signal),
      }),
      usageUpdates: abortedUsage,
    });
    try {
      const controller = new AbortController();
      const pending = clientGateway.gw.fetch(responsesRequest(
        { model, input: "hi", stream: true },
        controller.signal,
      ));
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const response = await pending;
      expect(response.body).toBeNull();
      expect(abortedUsage).toHaveLength(1);
      expect(abortedUsage).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "aborted",
      }]);
    } finally {
      await clientGateway.close();
    }
  });

  it.each(["native", "chat"] as const)("does not let %s comments satisfy the first semantic deadline", async (model) => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1;
    runtime.timeouts.streamIdleMs = 60_000;
    const { gw, close } = await responsesGateway({
      runtime,
      usageUpdates,
      backend: new ScriptedCopilotBackend({
        responsesStream: (request) => commentThenStall(request.signal),
        chatStream: (request) => commentThenStall(request.signal),
      }),
    });
    try {
      const response = await gw.fetch(responsesRequest({ model, input: "hi", stream: true }));
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "timeout",
      }]);
    } finally {
      await close();
    }
  });

  it("keeps bridge response.created behind an empty upstream Chat chunk", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1;
    runtime.timeouts.streamIdleMs = 60_000;
    const { gw, close } = await responsesGateway({
      runtime,
      usageUpdates,
      backend: new ScriptedCopilotBackend({
        chatStream: (request) => emptyChatThenStall(request.signal),
      }),
    });
    try {
      const response = await gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
      expect(response.status).toBe(504);
      const body = await response.text();
      expect(body).not.toContain("response.created");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        protocol: "openai_responses_bridge",
        outcome: "timeout",
      }]);
    } finally {
      await close();
    }
  });

  it("rejects malformed non-object bridge choices before response.created", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, close } = await responsesGateway({
      usageUpdates,
      backend: new ScriptedCopilotBackend({
        chatStream: [text("data: {\"id\":\"chatcmpl_bad\",\"choices\":[null]}\n\n")],
      }),
    });
    try {
      const response = await gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("response.created");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ outcome: "upstream_error" }]);
    } finally {
      await close();
    }
  });

  it("awaits bridge iterator cleanup before gateway close hooks", async () => {
    let iteratorReturned = false;
    let closeSawReturn = false;
    const { gw, close } = await responsesGateway({
      onClose: () => {
        closeSawReturn = iteratorReturned;
      },
      backend: new ScriptedCopilotBackend({
        chatStream: (request) => delayedReturnStream(request.signal, () => {
          iteratorReturned = true;
        }),
      }),
    });
    const response = await gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await close();
    expect(closeSawReturn).toBe(true);
  });

  it.each([
    { model: "native" as const, deadline: "idle" as const },
    { model: "chat" as const, deadline: "idle" as const },
    { model: "native" as const, deadline: "total" as const },
    { model: "chat" as const, deadline: "total" as const },
  ])("keeps postcommit $model $deadline timeout terminal semantics and one usage", async ({ model, deadline }) => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.streamIdleMs = deadline === "idle" ? 1 : 60_000;
    runtime.timeouts.totalMs = deadline === "total" ? 20 : 60_000;
    const { gw, close } = await responsesGateway({
      runtime,
      usageUpdates,
      backend: new ScriptedCopilotBackend({
        responsesStream: (request) => responseEventThenStall(request.signal),
        chatStream: (request) => chatEventThenStall(request.signal),
      }),
    });
    try {
      const response = await gw.fetch(responsesRequest({ model, input: "hi", stream: true }));
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      let delivered = "";
      await expect((async () => {
        for (;;) {
          const next = await reader?.read();
          if (next?.done !== false) {
            return;
          }
          delivered += new TextDecoder().decode(next.value, { stream: true });
        }
      })()).rejects.toThrow();
      expect(delivered).not.toContain("response.completed");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "timeout",
      }]);
    } finally {
      await close();
    }
  });

  async function responsesGateway(options: {
    readonly backend?: ScriptedCopilotBackend;
    readonly usageUpdates?: UsageUpdate[];
    readonly catalogError?: unknown;
    readonly runtime?: ReturnType<typeof defaultRuntimeConfigSnapshot>;
    readonly onClose?: () => void;
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
        embedMigration(responsesContinuationMigration),
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
        if (options.catalogError !== undefined) {
          throw options.catalogError;
        }
        return {
          data: [
            { id: "native", name: "Native", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/responses"] } },
            { id: "chat", name: "Chat", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } },
            { id: "dual", name: "Dual", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/responses", "/chat/completions"], chat_output_token_field: "max_tokens" } },
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
      runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
    }, [createResponsesRoute({
      directory: accounts,
      registry: testModelCapabilityRegistry(catalog),
      preferences: accounts.preferences,
      copilot: backend,
      history,
      nowUnixSeconds: () => 1_700_000_000,
      createUuid: () => "00000000-0000-4000-8000-000000000001",
      ...(options.usageUpdates === undefined
        ? {}
        : { usageRecorder: { recordUsage: (update: UsageUpdate) => options.usageUpdates?.push(update) } }),
    })], {
      createRequestId: () => "req_responses",
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    });
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

  function responsesRequest(body: unknown, signal?: AbortSignal): Request {
    return new Request("http://127.0.0.1:31400/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async function* stalledStream(signal: AbortSignal): AsyncIterable<Uint8Array> {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    yield text("");
  }

  async function* commentThenStall(signal: AbortSignal): AsyncIterable<Uint8Array> {
    yield text(": keepalive\n\n");
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }

  async function* responseEventThenStall(signal: AbortSignal): AsyncIterable<Uint8Array> {
    yield text("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_live\",\"output\":[]}}\n\n");
    await waitForAbort(signal);
  }

  async function* chatEventThenStall(signal: AbortSignal): AsyncIterable<Uint8Array> {
    yield text("data: {\"id\":\"chatcmpl_live\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
    await waitForAbort(signal);
  }

  async function* emptyChatThenStall(signal: AbortSignal): AsyncIterable<Uint8Array> {
    yield text("data: {\"id\":\"chatcmpl_empty\",\"choices\":[]}\n\n");
    yield text("data: {\"id\":\"chatcmpl_empty_object\",\"choices\":[{}]}\n\n");
    await waitForAbort(signal);
  }

  async function waitForAbort(signal: AbortSignal): Promise<void> {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }

  function delayedReturnStream(signal: AbortSignal, onReturn: () => void): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let first = true;
        return {
          next: async () => {
            if (first) {
              first = false;
              return {
                done: false,
                value: text("data: {\"id\":\"chatcmpl_live\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"),
              };
            }
            await waitForAbort(signal);
            return { done: true, value: undefined };
          },
          return: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            onReturn();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  function text(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }
});
