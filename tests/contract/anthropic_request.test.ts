import { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { HttpCopilotBackend } from "../../src/copilot/transport.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { EndpointDiscovery } from "../../src/copilot/endpoint_discovery.js";
import { anthropicGateway, anthropicRequest, decodeChatBody } from "./anthropic_harness.js";
import { jsonStream, waitForHttp, assertHeldHttpExchangeReleased } from "../../scripts/tooling/test_support/http_copilot.js";
import type { HttpRequestObservation } from "../../scripts/tooling/test_support/copilot_http.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import { TokenRefreshError } from "../../src/copilot/token_refresh.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

describe("Anthropic request route", () => {
  it("rolls back SQLite, registry, real transport and HTTP listener when gateway construction fails", async () => {
    const backendClose = vi.spyOn(HttpCopilotBackend.prototype, "close");
    const registryClose = vi.spyOn(ModelCapabilityRegistry.prototype, "close");
    const discoveryClose = vi.spyOn(EndpointDiscovery.prototype, "close");
    const listenerClose = vi.spyOn(Server.prototype, "close");
    const databaseClose = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      await expect(anthropicGateway({
        get runtime(): never { throw new Error("synthetic gateway setup failure"); },
      })).rejects.toThrow("synthetic gateway setup failure");
      expect(backendClose).toHaveBeenCalledTimes(1);
      expect(registryClose).toHaveBeenCalledTimes(1);
      expect(discoveryClose).toHaveBeenCalledTimes(1);
      expect(listenerClose).toHaveBeenCalledTimes(1);
      expect(databaseClose).toHaveBeenCalledTimes(1);
      expect((listenerClose.mock.contexts[0] as Server).listening).toBe(false);
      expect((backendClose.mock.contexts[0] as HttpCopilotBackend).inspect()).toMatchObject({ closed: true, responseLeases: 0, pools: { active: 0, waiters: 0 } });
    } finally { vi.restoreAllMocks(); }
  });

  it("degrades prompt-caching beta hints on converted requests instead of rejecting them", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        tools: [{
          name: "lookup",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        }],
      }, {
        "anthropic-beta": "prompt-caching-2024-07-31",
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(capturedRequests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("degrades interleaved-thinking beta on a complete converted tool round", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan", signature: "opaque" },
              { type: "tool_use", id: "call_1", name: "lookup", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
          },
        ],
      }, {
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(capturedRequests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("observes pre-endpoint body failures once without coupling accounting to the presenter", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, close } = await anthropicGateway({ usageUpdates });
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: "{\"messages\":",
      }));
      expect(response.status).toBe(400);
      expect(usageUpdates).toMatchObject([{
        protocol: "anthropic",
        outcome: "client_error",
        requestCount: 1,
        errorCount: 1,
      }]);
    } finally {
      await close();
    }
  });

  it("requires the exact Messages version header and never forwards it to Chat", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      for (const [name, headers] of [
        ["missing", { "anthropic-version": undefined }],
        ["empty", { "anthropic-version": "" }],
        ["wrong", { "anthropic-version": "2024-01-01" }],
        ["merged", { "anthropic-version": "2023-06-01, 2023-06-01" }],
      ] as const) {
        const actualHeaders: Record<string, string> = { "content-type": "application/json" };
        if (headers["anthropic-version"] !== undefined) {
          actualHeaders["anthropic-version"] = headers["anthropic-version"];
        }
        const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/messages", {
          method: "POST",
          headers: actualHeaders,
          body: JSON.stringify({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        }));
        expect(response.status, name).toBe(400);
        expect(response.headers.get("request-id")).toBe("req_test_1");
        expect(await response.text()).toBe("{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid request\"},\"request_id\":\"req_test_1\"}");
      }

      const ok = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(ok.status).toBe(200);
      expect(capturedRequests).toHaveLength(1);
      expect(new TextDecoder().decode(capturedRequests[0]?.body)).not.toContain("anthropic-version");
      expect(capturedRequests[0]?.headers.has("anthropic-version")).toBe(false);
    } finally {
      await close();
    }
  });

  it("applies the registry output default without masking invalid explicit limits", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      const defaulted = await gw.fetch(anthropicRequest({
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }));
      expect(defaulted.status).toBe(200);
      expect(decodeChatBody(capturedRequests[0] as HttpRequestObservation).max_tokens).toBe(4096);

      const invalid = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 0,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }));
      expect(invalid.status).toBe(400);
      expect(capturedRequests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("resolves missing model only through a valid visible preference and rejects explicit unknown models", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway({ preferredModel: "gpt" });
    try {
      const preferred = await gw.fetch(anthropicRequest({ max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(preferred.status).toBe(200);
      expect(decodeChatBody(capturedRequests[0] as HttpRequestObservation).model).toBe("gpt");

      const unknown = await gw.fetch(anthropicRequest({ model: "no-such-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe("{\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model not found\"},\"request_id\":\"req_test_1\"}");
      expect(capturedRequests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("preserves model catalog timeout, network, and invalid-response failure categories", async () => {
    for (const [failureKind, expected] of [
      ["upstream_timeout", { status: 504, type: "timeout_error", message: "upstream timeout" }],
      ["upstream_network", { status: 502, type: "api_error", message: "upstream request failed" }],
      ["invalid_upstream_response", { status: 502, type: "api_error", message: "invalid upstream response" }],
    ] as const) {
      const { gw, close } = await anthropicGateway({
        catalogFetch() {
          throw new CapiFetchError(502, undefined, failureKind);
        },
      });
      try {
        const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
        expect(response.status).toBe(expected.status);
        expect(await response.text()).toBe(JSON.stringify({
          type: "error",
          error: { type: expected.type, message: expected.message },
          request_id: "req_test_1",
        }));
      } finally {
        await close();
      }
    }
  });

  it.each([
    [new TokenRefreshError("missing", "secret-token"), 401, "authentication_error"],
    [new TokenRefreshError("unauthorized", "secret-token"), 401, "authentication_error"],
    [new TokenRefreshError("network", "private upstream URL"), 502, "upstream_error"],
    [new TokenRefreshError("timeout", "private upstream URL"), 504, "timeout"],
  ])("normalizes bind failure %# for Messages", async (bindError, status, outcome) => {
    const usageUpdates: UsageUpdate[] = [];
    const { gw, upstream, close } = await anthropicGateway({
      usageUpdates,
      missingCredentials: bindError.code === "missing",
      refreshCopilotToken: async () => { throw bindError; },
    });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }));
      expect(response.status).toBe(status);
      expect(response.headers.get("request-id")).toBe("req_test_1");
      expect(await response.text()).not.toContain("secret-token");
      expect(usageUpdates).toMatchObject([{ outcome }]);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("normalizes transport timeout and malformed buffered output before commitment", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    // Other deadlines must not substitute for the transport first-byte deadline.
    runtime.timeouts.firstByteMs = 1_000;
    const timeoutGateway = await anthropicGateway({
      runtime,
      expectations: [{ method: "POST", path: "/chat/completions", body: jsonStream(false),
        reply: { stream: async (exchange) => { await exchange.waitForClose(); } },
      }],
    });
    try {
      const pending = timeoutGateway.gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }));
      await waitForHttp(() => timeoutGateway.upstream.streams.length === 1);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.text()).toContain("\"type\":\"timeout_error\"");
      expect(timeoutGateway.upstream.requests).toHaveLength(1);
      await assertHeldHttpExchangeReleased(timeoutGateway.upstream, timeoutGateway.backend);
    } finally {
      await timeoutGateway.close();
    }

    const parserGateway = await anthropicGateway({
      expectations: [{ method: "POST", path: "/chat/completions", body: jsonStream(false),
        reply: { status: 200, body: new TextEncoder().encode("{\"choices\":") },
      }],
    });
    try {
      const response = await parserGateway.gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }));
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("\"message\":\"invalid upstream response\"");
    } finally {
      await parserGateway.close();
    }
  });

  it("rejects unknown fields and lossy legacy schema/media behavior before inference", async () => {
    const { gw, upstream, close } = await anthropicGateway({ expectations: [] });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt-5",
        max_tokens: 64,
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ["END"],
        stream: true,
        system: [
          { type: "text", text: "x-anthropic-billing-header:\n\nbill me elsewhere" },
          { type: "text", text: "second" },
        ],
        metadata: { dropped: true },
        context_management: { dropped: true },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" }, cache_control: { type: "ephemeral" } },
              { type: "document", source: { type: "text", data: "drop" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "tool_use", id: "call_1", name: "lookup", input: { z: 1, a: [true, null] } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: { b: 2, a: 1 }, is_error: true },
              { type: "text", text: "continue" },
            ],
          },
        ],
        tools: [
          { type: "BatchTool", name: "ignored" },
          {
            name: "lookup",
            description: "Lookup",
            input_schema: {
              properties: {
                url: { type: "string", format: "uri" },
                nested: { items: { properties: { link: { type: "string", format: "uri" } } } },
                untouched: { oneOf: [{ type: "string", format: "uri" }] },
              },
            },
            strict: true,
          },
        ],
        tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
        output_config: { effort: "max", format: { type: "json_schema" } },
      }));

      expect(response.status).toBe(400);
      expect(upstream.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it("maps official Anthropic xhigh effort for reasoning-capable models", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "reason" }],
        output_config: { effort: "xhigh" },
      }));

      expect(response.status).toBe(200);
      expect(decodeChatBody(capturedRequests[0] as HttpRequestObservation)).toMatchObject({
        model: "gpt-5",
        reasoning_effort: "xhigh",
      });
    } finally {
      await close();
    }
  });

  it("rejects orphan parallel tool results instead of converting them to user text", async () => {
    const { gw, upstream, close } = await anthropicGateway({ expectations: [] });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 1,
        stream: false,
        messages: [{
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "image", source: { media_type: "image/png", data: "abc" } }],
            },
            { type: "tool_result", tool_use_id: "call_2", content: "plain" },
            { type: "text", text: "after tools" },
          ],
        }],
      }));

      expect(response.status).toBe(400);
      expect(upstream.requests).toEqual([]);
    } finally {
      await close();
    }
  });
});
