import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { withSetupCleanup, startHttpCopilot, closeAll, jsonStream, waitForHttp, assertTransportReleased, assertHeldHttpExchangeReleased } from "../../scripts/tooling/test_support/http_copilot.js";
import type { HttpExpectation } from "../../scripts/tooling/test_support/copilot_http.js";
import type { CopilotTransportDeps } from "../../src/copilot/transport.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { testModelCapabilityRegistry } from "./model_capability_registry_harness.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import { TokenRefreshError } from "../../src/copilot/token_refresh.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { migration as reasoningCarriersMigration } from "../../src/persistence/migrations/042_responses_reasoning_carriers.js";
import { SqliteResponsesHistory } from "../../src/protocols/openai_responses/history.js";
import { createOpenaiResponsesRoute } from "../../src/protocols/openai_responses/endpoint.js";
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
    const { gw, upstream, close } = await responsesGateway({ usageUpdates });
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
      expect(upstream.requests).toEqual([]);
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/responses", body: jsonStream(false), reply: {
      status: 200,
      headers: {},
      body: new TextEncoder().encode("{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":1}}"),
    } }];
    const { gw, upstream, history, close } = await responsesGateway({ expectations, usageUpdates });
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
      expect(upstream.requests.map((entry) => [entry.path, JSON.parse(new TextDecoder().decode(entry.body)).stream === true])).toEqual([["/responses", false]]);
      expect(new TextDecoder().decode(upstream.requests[0]?.body)).toBe("{\"model\":\"native\",\"previous_response_id\":\"upstream-owned\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":\"hi\"}],\"reasoning\":{\"encrypted_content\":\"secret-state\"},\"stream\":false}");
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(false), reply: {
      status: 200,
      headers: {},
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
    } }];
    const { gw, upstream, history, close } = await responsesGateway({ expectations, usageUpdates });
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
      expect(upstream.requests.map((entry) => [entry.path, JSON.parse(new TextDecoder().decode(entry.body)).stream === true])).toEqual([["/chat/completions", false]]);
      expect(new TextDecoder().decode(upstream.requests[0]?.body)).toContain("\"model\":\"chat\"");
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

  it.each([201])(
    "presents extended-tools upstream %i success as the legacy 200 response",
    async (upstreamStatus) => {
      const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(false), reply: {
        status: upstreamStatus,
        headers: {},
        body: text(JSON.stringify({
          id: "chatcmpl_extended",
          created: 1_700_000_000,
          model: "chat",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_render",
                type: "function",
                function: { name: "render", arguments: "{\"input\":\"draw\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })),
      } }];
      const { gw, upstream, history, close } = await responsesGateway({ expectations });
      try {
        const response = await gw.fetch(responsesRequest({
          model: "chat",
          input: "render",
          tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        }));

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("{\"id\":\"resp_Z2hjLWdhdGV3YXk6Z2l0aHViX2NvcGlsb3Q7Y2hhdDtjaGF0OzAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMQ==\",\"object\":\"response\",\"created_at\":1700000000,\"status\":\"completed\",\"error\":null,\"incomplete_details\":null,\"instructions\":null,\"metadata\":{},\"model\":\"chat\",\"output\":[{\"type\":\"custom_tool_call\",\"id\":\"fc_00000000-0000-4000-8000-000000000001\",\"call_id\":\"call_render\",\"name\":\"render\",\"status\":\"completed\",\"input\":\"draw\"}],\"parallel_tool_calls\":true,\"temperature\":null,\"tool_choice\":\"auto\",\"tools\":[],\"top_p\":null,\"max_output_tokens\":null,\"previous_response_id\":null,\"reasoning\":null,\"text\":{},\"truncation\":\"disabled\",\"usage\":{\"input_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens\":1,\"output_tokens_details\":{\"reasoning_tokens\":0},\"total_tokens\":3}}");
        expect(history.inspect()).toEqual({
          revision: 1,
          count: 1,
          receiptCount: 1,
          legacyCount: 0,
          untrackedContinuationBlocked: false,
          oldestAt: 1_700_000_000_000,
          newestAt: 1_700_000_000_000,
          ttlDays: 7,
          maxResponses: 512,
          maxReceipts: 2_048,
        });
        expect(upstream.requests).toMatchObject([{ path: "/chat/completions", method: "POST" }]);
        expect(upstream.requests).toHaveLength(1);
        expect(upstream.requests[0]?.headers.get("authorization")).toBe("Bearer http-test-t");
      } finally {
        await close();
      }
    },
  );

  it("sanitizes an actual empty upstream 204 without history, checkpoint or receipt", async () => {
    const { gw, upstream, backend, history, close } = await responsesGateway({ expectations: [{
      method: "POST", path: "/chat/completions", body: jsonStream(false), reply: { status: 204 },
    }] });
    try {
      const response = await gw.fetch(responsesRequest({ model: "chat", input: "render", tools: [{ type: "custom", name: "render", format: { type: "text" } }] }));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}");
      expect(history.inspect()).toMatchObject({ revision: 0, count: 0, receiptCount: 0, legacyCount: 0 });
      expect(upstream.requests).toHaveLength(1);
      upstream.assertSatisfied();
      assertTransportReleased(backend);
    } finally { await close(); }
  });

  it("preserves an ordinary converted upstream 201 status", async () => {
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(false), reply: {
      status: 201,
      headers: {},
      body: text("{\"id\":\"chatcmpl_ordinary\",\"created\":1700000000,\"model\":\"chat\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"done\"},\"finish_reason\":\"stop\"}]}"),
    } }];
    const { gw, upstream, close } = await responsesGateway({ expectations });
    try {
      const response = await gw.fetch(responsesRequest({ model: "chat", input: "hello" }));
      expect(response.status).toBe(201);
      await response.text();
      expect(upstream.requests).toMatchObject([{ path: "/chat/completions", method: "POST" }]);
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.headers.get("authorization")).toBe("Bearer http-test-t");
    } finally {
      await close();
    }
  });

  it.each([
    ["media traversal beyond its bound", deeplyNestedToolOutput(34)],
    ["malformed nested JSON", "{\"nested\":"],
  ])("rejects extended tool-result %s before inference", async (_caseName, output) => {
    const { gw, upstream, history, close } = await responsesGateway();
    try {
      const response = await gw.fetch(responsesRequest({
        model: "chat",
        input: [
          { type: "custom_tool_call", call_id: "call_custom", name: "render", input: "raw" },
          { type: "custom_tool_call_output", call_id: "call_custom", output },
        ],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("{\"error\":{\"message\":\"invalid request\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":null}}");
      expect(history.inspect()).toMatchObject({ count: 0, receiptCount: 0, legacyCount: 0 });
      expect(upstream.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "schema"],
    ["number", 1],
  ] as const)("rejects explicit %s extended function parameters before inference", async (_caseName, parameters) => {
    const { gw, upstream, history, close } = await responsesGateway();
    try {
      const response = await gw.fetch(responsesRequest({
        model: "chat",
        input: "hi",
        tools: [{
          type: "namespace",
          name: "docs",
          tools: [{ type: "function", name: "lookup", parameters }],
        }],
      }));

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("{\"error\":{\"message\":\"invalid request\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":null}}");
      expect(history.inspect()).toMatchObject({ count: 0, receiptCount: 0, legacyCount: 0 });
      expect(upstream.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it("pins a known converted continuation to Chat before native-first selection", async () => {
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(false), reply: {
      status: 200,
      headers: {},
      body: text("{\"id\":\"chatcmpl_next\",\"model\":\"dual\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}"),
    } }];
    const { gw, upstream, history, close } = await responsesGateway({ expectations });
    try {
      const ownership = {
        accountId: "github.com/1",
        modelId: "dual",
        upstreamOrigin: upstream.origin,
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
      expect(upstream.requests.map((entry) => [entry.path, JSON.parse(new TextDecoder().decode(entry.body)).stream === true])).toEqual([["/chat/completions", false]]);
      const forwarded = new TextDecoder().decode(upstream.requests[0]?.body);
      expect(forwarded).not.toContain("previous_response_id");
      expect(forwarded).toContain("\"tool_call_id\":\"call_owned\"");
    } finally {
      await close();
    }
  });

  it("rejects cross-account, model, protocol, origin, and unknown converted continuations", async () => {
    const { gw, upstream, history, close } = await responsesGateway();
    try {
      const signal = new AbortController().signal;
      await history.recordReceipt({
        accountId: "github.com/2",
        responseId: "resp_foreign",
        modelId: "native",
        upstreamOrigin: upstream.origin,
        owner: "native",
        upstreamProtocol: "responses",
        conversionVersion: null,
        checkpointState: "complete",
      }, signal);
      await history.recordReceipt({
        accountId: "github.com/1",
        responseId: "resp_chat_route",
        modelId: "native",
        upstreamOrigin: upstream.origin,
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
          previous_response_id: "resp_Z2hjLWdhdGV3YXk6Z2l0aHViX2NvcGlsb3Q7bmF0aXZlO3Jlc3BfdW5rbm93bg==",
          input: "hi",
        },
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
      expect(upstream.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it("uses Responses SSE bytes for native and bridge streams without DONE markers", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/responses", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      text("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":1}}}}\n\n"),
    ]) } },
    { method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      text("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\n"),
      text("data: [DONE]\n\n"),
    ]) } }];
    const { gw, close } = await responsesGateway({ expectations, usageUpdates });
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/responses", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([text("event: wrong\ndata: {\"type\":\"response.completed\"}\n\n")]) } }];
    const { gw, close } = await responsesGateway({ expectations, usageUpdates });
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
      expect(timeoutGateway.upstream.requests).toHaveLength(0);
    } finally {
      await timeoutGateway.close();
    }

    const authUsage: UsageUpdate[] = [];
    const authGateway = await responsesGateway({
      refreshCopilotToken: async () => { throw new TokenRefreshError("unauthorized", "secret-token https://unsafe.example/private"); },
      usageUpdates: authUsage,
    });
    try {
      const response = await authGateway.gw.fetch(responsesRequest({ model: "native", input: "hi" }));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"authentication failed\",\"type\":\"authentication_error\",\"param\":null,\"code\":null}}",
      );
      expect(authUsage).toMatchObject([{ outcome: "authentication_error" }]);
      expect(authGateway.upstream.requests).toHaveLength(0);
    } finally {
      await authGateway.close();
    }
  });

  it.each(["native", "chat"] as const)("normalizes %s transport timeout before commitment", async (model) => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1_000;
    const { gw, upstream, backend, close } = await responsesGateway({ runtime, expectations: [{
      method: "POST", path: model === "native" ? "/responses" : "/chat/completions", body: jsonStream(false),
      reply: { stream: async (exchange) => { await exchange.waitForClose(); } },
    }] });
    try {
      const pending = gw.fetch(responsesRequest({ model, input: "hi" }));
      await waitForHttp(() => upstream.streams.length === 1);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
      await assertHeldHttpExchangeReleased(upstream, backend);
    } finally {
      await close();
    }
  });

  it("normalizes native truncation and bridge error events before commitment", async () => {
    const nativeGateway = await responsesGateway({
      expectations: [{ method: "POST", path: "/responses", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([]) } }],
    });
    try {
      const response = await nativeGateway.gw.fetch(responsesRequest({ model: "native", input: "hi", stream: true }));
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("\"message\":\"upstream request failed\"");
    } finally {
      await nativeGateway.close();
    }

    const bridgeGateway = await responsesGateway({
      expectations: [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([text("event: error\ndata: {\"error\":{\"message\":\"secret-token https://unsafe.example/private\"}}\n\n")]) } }],
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
    runtime.timeouts.totalMs = 1_500;
    const timedOutGateway = await responsesGateway({
      runtime,
      expectations: [{ method: "POST", path: model === "native" ? "/responses" : "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => { await exchange.waitForClose(); } },
      }],
      usageUpdates: timeoutUsage,
    });
    try {
      const pending = timedOutGateway.gw.fetch(responsesRequest({ model, input: "hi", stream: true }));
      await waitForHttp(() => timedOutGateway.upstream.streams.length === 1);
      const response = await pending;
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
      await assertHeldHttpExchangeReleased(timedOutGateway.upstream, timedOutGateway.backend);
    } finally {
      await timedOutGateway.close();
    }

    const abortedUsage: UsageUpdate[] = [];
    const clientGateway = await responsesGateway({
      expectations: [{ method: "POST", path: model === "native" ? "/responses" : "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => { await exchange.waitForClose(); } },
      }],
      usageUpdates: abortedUsage,
    });
    try {
      const controller = new AbortController();
      const pending = clientGateway.gw.fetch(responsesRequest(
        { model, input: "hi", stream: true },
        controller.signal,
      ));
      await waitForHttp(() => clientGateway.upstream.streams.length === 1);
      controller.abort();
      const response = await pending;
      expect(response.body).toBeNull();
      expect(abortedUsage).toHaveLength(1);
      expect(abortedUsage).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "aborted",
      }]);
      await assertHeldHttpExchangeReleased(clientGateway.upstream, clientGateway.backend);
    } finally {
      await clientGateway.close();
    }
  });

  it.each(["native", "chat"] as const)("does not let %s comments satisfy the first semantic deadline", async (model) => {
    let sent = false;
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1_000;
    const { gw, upstream, backend, close } = await responsesGateway({
      runtime,
      usageUpdates,
      expectations: [{ method: "POST", path: model === "native" ? "/responses" : "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
          await exchange.write(text(": keepalive\n\n"));
          sent = true;
          await exchange.waitForClose();
        } },
      }],
    });
    try {
      const pending = gw.fetch(responsesRequest({ model, input: "hi", stream: true }));
      await waitForHttp(() => sent);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "timeout",
      }]);
      await assertHeldHttpExchangeReleased(upstream, backend);
    } finally {
      await close();
    }
  });

  it("keeps bridge response.created behind an empty upstream Chat chunk", async () => {
    let sent = false;
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1_000;
    const { gw, upstream, backend, close } = await responsesGateway({
      runtime,
      usageUpdates,
      expectations: [{ method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
          await exchange.write(text("data: {\"id\":\"chatcmpl_empty\",\"choices\":[]}\n\n"));
          await exchange.write(text("data: {\"id\":\"chatcmpl_empty_object\",\"choices\":[{}]}\n\n"));
          sent = true;
          await exchange.waitForClose();
        } },
      }],
    });
    try {
      const pending = gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
      await waitForHttp(() => sent);
      const response = await pending;
      expect(response.status).toBe(504);
      const body = await response.text();
      expect(body).not.toContain("response.created");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        protocol: "openai_responses_bridge",
        outcome: "timeout",
      }]);
      await assertHeldHttpExchangeReleased(upstream, backend);
    } finally {
      await close();
    }
  });

  it("rejects malformed non-object bridge choices before response.created", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, close } = await responsesGateway({
      usageUpdates,
      expectations: [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([text("data: {\"id\":\"chatcmpl_bad\",\"choices\":[null]}\n\n")]) } }],
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

  it("releases the HTTP bridge socket, lease and accounting before close hooks", async () => {
    const usageUpdates: UsageUpdate[] = [];
    let closeSawReleased = false;
    const opened = await responsesGateway({
      usageUpdates,
      onClose: () => {
        assertTransportReleased(opened.backend);
        closeSawReleased = usageUpdates.length === 1;
      },
      expectations: [{ method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
          await exchange.write(text("data: {\"id\":\"chatcmpl_live\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"));
          await exchange.waitForClose();
        } },
      }],
    });
    try {
      const response = await opened.gw.fetch(responsesRequest({ model: "chat", input: "hi", stream: true }));
      const reader = response.body!.getReader();
      let delivered = "";
      while (!delivered.includes("response.output_text.delta")) {
        const next = await reader.read();
        expect(next.done).toBe(false);
        delivered += new TextDecoder().decode(next.value);
      }
      await opened.gw.close();
      await waitForHttp(() => opened.upstream.streams[0]?.closed === true);
      expect(opened.upstream.streams[0]?.ended).toBe(false);
      assertTransportReleased(opened.backend);
      expect(closeSawReleased).toBe(true);
      expect(usageUpdates).toMatchObject([{ outcome: "aborted", protocol: "openai_responses_bridge" }]);
      expect(usageUpdates).toHaveLength(1);
    } finally { await opened.close(); }
  });

  it.each([
    { model: "native" as const, deadline: "idle" as const },
    { model: "chat" as const, deadline: "idle" as const },
    { model: "native" as const, deadline: "total" as const },
    { model: "chat" as const, deadline: "total" as const },
  ])("keeps postcommit $model $deadline timeout terminal semantics and one usage", async ({ model, deadline }) => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    // Competing deadlines exceed the HTTP mock's failure bound and cannot mask this one.
    runtime.timeouts.streamIdleMs = deadline === "idle" ? 1_000 : 60_000;
    runtime.timeouts.totalMs = deadline === "total" ? 1_500 : 60_000;
    const { gw, upstream, backend, close } = await responsesGateway({
      runtime,
      usageUpdates,
      expectations: [{ method: "POST", path: model === "native" ? "/responses" : "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
          await exchange.write(text(model === "native"
            ? "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_live\",\"output\":[]}}\n\n"
            : "data: {\"id\":\"chatcmpl_live\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"));
          await exchange.waitForClose();
        } },
      }],
    });
    try {
      const pending = gw.fetch(responsesRequest({ model, input: "hi", stream: true }));
      await waitForHttp(() => upstream.streams.length === 1);
      const response = await pending;
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
      expect(delivered).toContain(model === "native" ? "event: response.created" : "event: response.output_text.delta");
      expect(delivered).not.toContain("response.completed");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        protocol: model === "native" ? "openai_responses_native" : "openai_responses_bridge",
        outcome: "timeout",
      }]);
      await assertHeldHttpExchangeReleased(upstream, backend);
    } finally {
      await close();
    }
  });

  async function responsesGateway(options: {
    readonly expectations?: readonly HttpExpectation[];
    readonly refreshCopilotToken?: CopilotTransportDeps["refreshCopilotToken"];
    readonly usageUpdates?: UsageUpdate[];
    readonly catalogError?: unknown;
    readonly runtime?: ReturnType<typeof defaultRuntimeConfigSnapshot>;
    readonly onClose?: () => void;
  } = {}) {
    return await withSetupCleanup(async (own) => {
      const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-responses-"));
      own(() => rm(dir, { recursive: true, force: true }));
      const database = openDatabase({
        path: path.join(dir, "state.db"),
        migrations: [
          embedMigration(runtimeConfigMigration),
          embedMigration(accountsMigration),
          embedMigration(responsesHistoryMigration),
          embedMigration(responsesContinuationMigration),
          embedMigration(reasoningCarriersMigration),
        ],
        nowMs,
      });
      own(() => closeDatabase(database));
      const credentials = new MemoryCredentialStore();
      const accountCoordinator = new AccountCoordinator();
      const accounts = new AccountDirectory(database, credentials, accountCoordinator, nowMs);
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
              endpointModel("native", ["/responses"]),
              endpointModel("chat", ["/chat/completions"], "max_tokens"),
              endpointModel("dual", ["/responses", "/chat/completions"], "max_tokens"),
            ],
          };
        },
      });
      const history = new SqliteResponsesHistory(database, { nowMs });
      const http = await startHttpCopilot({ credentials, accountCoordinator, nowMs,
        ...(options.refreshCopilotToken === undefined ? {} : { refreshCopilotToken: options.refreshCopilotToken }),
        expectations: options.expectations ?? [{ method: "POST", path: "/responses", body: jsonStream(false), reply: { status: 200, headers: {}, body: text("{\"id\":\"resp_1\",\"output\":[]}") } },
          { method: "POST", path: "/chat/completions", body: jsonStream(false), reply: { status: 200, headers: {}, body: text("{\"id\":\"chatcmpl_1\",\"model\":\"chat\",\"choices\":[]}") } } ] });
      own(() => http.close());
      const registry = testModelCapabilityRegistry(catalog);
      own(() => registry.close());
      const gw = await createGateway({
        startup: parseStartupConfig([], {}, { homedir: dir }),
        runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
      }, [createOpenaiResponsesRoute({
        directory: accounts,
        registry,
        preferences: accounts.preferences,
        copilot: http.backend,
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
      own(() => gw.close());
      return {
        gw,
        backend: http.backend,
        upstream: http.upstream,
        history,
        async close() {
          await closeAll([() => gw.close(), () => registry.close(), () => http.close(), () => closeDatabase(database), () => rm(dir, { recursive: true, force: true })]);
        },
      };
    });
  }

  function endpointModel(
    id: string,
    supportedEndpoints: readonly string[],
    chatOutputTokenField?: "max_tokens" | "max_completion_tokens",
  ) {
    return {
      id, name: id, vendor: "github", model_picker_enabled: true,
      model_info: {
        supported_endpoints: supportedEndpoints,
        ...(chatOutputTokenField === undefined ? {} : { chat_output_token_field: chatOutputTokenField }),
      },
      capabilities: { supports: {
        tool_calls: true, parallel_tool_calls: true, vision: true, tool_search: true,
      } },
    };
  }

  function deeplyNestedToolOutput(depth: number): unknown {
    let output: unknown = "ordinary non-media content";
    for (let index = 0; index < depth; index += 1) {
      output = { nested: output };
    }
    return output;
  }

  function responsesRequest(body: unknown, signal?: AbortSignal): Request {
    return new Request("http://127.0.0.1:31400/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  function text(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }
});
