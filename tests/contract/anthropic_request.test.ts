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

  it("converts Claude Code extension headers and body fields with one Responses operation", async () => {
    const responseBody = new TextEncoder().encode(JSON.stringify({
      id: "resp_compat",
      object: "response",
      status: "completed",
      output: [{
        id: "msg_compat",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }));
    const { gw, capturedRequests, close } = await anthropicGateway({
      catalogFetch: () => ({ data: [{
        id: "responses",
        name: "responses",
        vendor: "github",
        model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/responses"], max_output_tokens: 16_384 },
        capabilities: { supports: { tool_calls: true, parallel_tool_calls: true, vision: true } },
      }] }),
      expectations: [{
        method: "POST",
        path: "/responses",
        body: jsonStream(false),
        reply: { status: 200, body: responseBody },
      }],
    });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "responses",
        max_tokens: 16,
        messages: [{ role: "user", content: [{ type: "text", text: "hi", optional_extension: true }] }],
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        independent_extension: { enabled: true },
      }, {
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27",
      }));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-ghcg-upstream-protocol")).toBe("responses");
      await response.text();
      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0]?.path).toBe("/responses");
      expect(capturedRequests[0]?.headers.has("anthropic-beta")).toBe(false);
      const converted = new TextDecoder().decode(capturedRequests[0]?.body);
      expect(converted).not.toContain("context_management");
      expect(converted).not.toContain("independent_extension");
      expect(converted).not.toContain("optional_extension");
    } finally {
      await close();
    }
  });

  it.each([
    ["invalid role", { messages: [{ role: "system", content: "hi" }] }],
    ["orphan tool result", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }] }] }],
    ["continuation ownership", { previous_response_id: "resp_external" }],
    ["synthetic tool ownership", { messages: [{ role: "user", content: "hi", tool_call_id: "call_1" }] }],
    ["synthetic reasoning carrier", { messages: [{ role: "user", content: [{ type: "text", text: "hi", signature: "ghcg-rsn-v1:synthetic" }] }] }],
    ["ambiguous reasoning carrier", { messages: [{ role: "user", content: [{ type: "text", text: "hi", optional_extension: { opaque: "ghcg-rsn-v1:synthetic" } }] }] }],
    ["sensitive nested tool extension", {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "ok", tool_call_id: "call_external" }],
          }],
        },
      ],
    }],
  ] as const)("still rejects malformed Messages core with extensions: %s", async (_name, extra) => {
    const { gw, upstream, close } = await anthropicGateway({ expectations: [] });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        ...extra,
      }));
      expect(response.status).toBe(400);
      await response.text();
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it.each([
    ["top-level continuation", { previous_response_id: "resp_external" }],
    ["message ownership field", { messages: [{ role: "user", content: "hi", tool_call_id: "call_1" }] }],
    ["numeric content", { messages: [{ role: "user", content: 1 }] }],
    ["missing tool input", { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup" }] }] }],
    ["unclosed tool call", { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] }] }],
    ["duplicate tool call ID", {
      messages: [{ role: "assistant", content: [
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      ] }],
    }],
    ["duplicate tool result", {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: "ok" },
          { type: "tool_result", tool_use_id: "call_1", content: "again" },
        ] },
      ],
    }],
    ["new call after a partial parallel result", {
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "call_1", name: "lookup", input: {} },
          { type: "tool_use", id: "call_2", name: "lookup", input: {} },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_3", name: "lookup", input: {} }] },
      ],
    }],
    ["interleaved tool round", {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        { role: "user", content: "interleaved" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      ],
    }],
    ["unknown block in tool round", {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "document", source: { type: "text", data: "interleaved" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      ],
    }],
    ["top-level ownership field", { tool_call_id: "call_1" }],
    ["metadata ownership field", { metadata: { tool_call_id: "call_1" } }],
    ["carrier-shaped tool input", {
      messages: [{
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: { type: "thinking", signature: "ghcg-rsn-v1:synthetic" },
        }],
      }],
    }],
    ["carrier-shaped top-level extension", {
      optional_extension: { type: "thinking", signature: "ghcg-rsn-v1:synthetic" },
    }],
    ["carrier-shaped text", {
      messages: [{ role: "user", content: "ghcg-rsn-v1:synthetic" }],
    }],
    ["duplicate image source type", { duplicateImageSourceType: true }],
    ["temperature out of range", { temperature: 2 }],
    ["top_p out of range", { top_p: -1 }],
    ["invalid output effort", { output_config: { effort: 1 } }],
    ["empty stop sequence", { stop_sequences: [""] }],
    ["empty tool name", { tools: [{ name: "", input_schema: {} }] }],
    ["assistant image", {
      messages: [{
        role: "assistant",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/x" } }],
      }],
    }],
    ["invalid tool-result error", {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok", is_error: "yes" }] },
      ],
    }],
    ["invalid MCP result content", {
      messages: [{
        role: "assistant",
        content: [
          { type: "mcp_tool_use", id: "mcp_1", name: "lookup", server_name: "docs", input: {} },
          { type: "mcp_tool_result", tool_use_id: "mcp_1", content: { unexpected: true } },
        ],
      }],
    }],
    ["invalid managed result ownership", {
      messages: [{
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ tool_call_id: "external" }] },
        ],
      }],
    }],
    ["browser state for non-browser tool", {
      tools: [{ name: "lookup", input_schema: {} }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        { role: "user", content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "browser_state", tabs: [] }],
        }] },
      ],
    }],
    ["browser state with wrong toolset", {
      tools: [{ type: "browser_toolset_20260801" }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "navigate", toolset_name: "computer_toolset_20260801", input: {} }] },
        { role: "user", content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          toolset_name: "computer_toolset_20260801",
          content: [{ type: "browser_state", tabs: [] }],
        }] },
      ],
    }],
    ["user thinking carrier", {
      messages: [{
        role: "user",
        content: [{ type: "thinking", thinking: "plan", signature: "ghcg-rsn-v1:synthetic" }],
      }],
    }],
    ["invalid parallel choice", {
      tools: [{ name: "lookup", input_schema: {} }],
      tool_choice: { type: "auto", disable_parallel_tool_use: "yes" },
    }],
    ["duplicate tool names", {
      tools: [{ name: "lookup", input_schema: {} }, { name: "lookup", input_schema: {} }],
    }],
    ["missing chosen tool", {
      tools: [{ name: "lookup", input_schema: {} }],
      tool_choice: { type: "tool", name: "missing" },
    }],
    ["parallel choice without tools", { tool_choice: { type: "auto", disable_parallel_tool_use: true } }],
    ["invalid tool strict", { tools: [{ name: "lookup", input_schema: {}, strict: "yes" }] }],
    ["malformed output format", { output_config: { format: { type: "json_schema", schema: "wrong" } } }],
    ["malformed output format name", { output_config: { format: { type: "json_schema", name: 1, schema: {} } } }],
    ["malformed output format description", { output_config: { format: { type: "json_schema", description: 1, schema: {} } } }],
    ["empty output effort", { output_config: { effort: "" } }],
    ["empty output format name", { output_config: { format: { type: "json_schema", name: "", schema: {} } } }],
    ["invalid tool description", { tools: [{ name: "lookup", description: 1, input_schema: {} }] }],
    ["invalid image URL", {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "not-a-url" } }] }],
    }],
    ["invalid base64 image", {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "%%%" } }] }],
    }],
    ["empty thinking signature", {
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "" }] }],
    }],
    ["invalid input image detail", {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "input_image", image_url: "https://example.com/x", detail: 1 }],
          }],
        },
      ],
    }],
    ["malformed document", {
      messages: [{ role: "user", content: [{ type: "document", source: 17 }] }],
    }],
    ["document text source missing media type", {
      messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "reference" } }] }],
    }],
    ["invalid document citations", {
      messages: [{ role: "user", content: [{
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "reference" },
        citations: { enabled: "yes" },
      }] }],
    }],
    ["invalid document title", {
      messages: [{ role: "user", content: [{
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "reference" },
        title: 1,
      }] }],
    }],
    ["duplicate tool input key", { duplicateToolInput: true }],
    ["duplicate tool schema key", { duplicateToolSchema: true }],
    ["duplicate core", { duplicateMaxTokens: true }],
  ] as const)("rejects malformed native Messages core before inference: %s", async (_name, extra) => {
    const { duplicateImageSourceType, duplicateMaxTokens, duplicateToolInput, duplicateToolSchema, ...bodyExtra } = extra as typeof extra & {
      readonly duplicateImageSourceType?: boolean;
      readonly duplicateMaxTokens?: boolean;
      readonly duplicateToolInput?: boolean;
      readonly duplicateToolSchema?: boolean;
    };
    const { gw, upstream, close } = await anthropicGateway({
      expectations: [],
      catalogFetch: () => ({ data: [{
        id: "native-messages",
        name: "native-messages",
        vendor: "github",
        model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/messages"] },
      }] }),
    });
    try {
      const base = {
        model: "native-messages",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        ...bodyExtra,
      };
      const body = duplicateMaxTokens
        ? "{\"model\":\"native-messages\",\"max_tokens\":16,\"max_tokens\":17,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
        : duplicateImageSourceType
          ? "{\"model\":\"native-messages\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"type\":\"url\",\"url\":\"https://example.com/x\"}}]}]}"
          : duplicateToolInput
            ? "{\"model\":\"native-messages\",\"max_tokens\":16,\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"lookup\",\"input\":{\"q\":1,\"q\":2}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call_1\",\"content\":\"ok\"}]}]}"
            : duplicateToolSchema
              ? "{\"model\":\"native-messages\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"tools\":[{\"name\":\"lookup\",\"input_schema\":{\"type\":\"object\",\"type\":\"array\"}}]}"
              : JSON.stringify(base);
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body,
      }));
      expect(response.status).toBe(400);
      await response.text();
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rejects a gateway carrier when no carrier store can claim it", async () => {
    const { gw, upstream, close } = await anthropicGateway({
      expectations: [],
      catalogFetch: () => ({ data: [{
        id: "native-messages",
        name: "native-messages",
        vendor: "github",
        model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/messages"] },
      }] }),
    });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "native-messages",
        max_tokens: 16,
        messages: [{
          role: "assistant",
          content: [{ type: "thinking", thinking: "plan", signature: "ghcg-rsn-v1:synthetic" }],
        }],
      }));
      expect(response.status).toBe(400);
      await response.text();
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it.each([
    { type: "document", source: { type: "text", media_type: "text/plain", data: "reference" } },
    { type: "document", source: { type: "content", content: "reference" } },
    { type: "document", source: { type: "content", content: [{ type: "text", text: "reference" }] } },
    { type: "image", source: { type: "file", file_id: "file_1" } },
    { type: "search_result", source: "docs", title: "result", content: [{ type: "text", text: "found" }] },
  ])("preserves valid native extension block $type", async (block) => {
    const { gw, upstream, close } = await anthropicGateway({
      catalogFetch: () => ({ data: [{
        id: "native-messages",
        name: "native-messages",
        vendor: "github",
        model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/messages"] },
      }] }),
      expectations: [{
        method: "POST",
        path: "/v1/messages",
        body: jsonStream(false),
        reply: { body: new TextEncoder().encode("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}") },
      }],
    });
    try {
      const body = {
        model: "native-messages",
        max_tokens: 16,
        messages: [{ role: "user", content: [block] }],
      };
      const response = await gw.fetch(anthropicRequest(body));
      expect(response.status).toBe(200);
      await response.text();
      expect(new TextDecoder().decode(upstream.requests[0]?.body)).toBe(JSON.stringify(body));
    } finally {
      await close();
    }
  });

  it("preserves a valid native server-tool call/result round", async () => {
    const { gw, upstream, close } = await anthropicGateway({
      catalogFetch: () => ({ data: [{
        id: "native-messages", name: "native-messages", vendor: "github", model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/messages"] },
      }] }),
      expectations: [{
        method: "POST", path: "/v1/messages", body: jsonStream(false),
        reply: { body: new TextEncoder().encode("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}") },
      }],
    });
    try {
      const body = {
        model: "native-messages",
        max_tokens: 16,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "test" } },
              {
                type: "web_search_tool_result",
                tool_use_id: "srv_1",
                content: [{
                  type: "web_search_result",
                  encrypted_content: "provider-opaque",
                  title: "result",
                  url: "https://example.com",
                }],
              },
            ],
          },
        ],
      };
      const response = await gw.fetch(anthropicRequest(body));
      expect(response.status).toBe(200);
      await response.text();
      expect(new TextDecoder().decode(upstream.requests[0]?.body)).toBe(JSON.stringify(body));
    } finally {
      await close();
    }
  });

  it("accepts native server tools in forced tool choice", async () => {
    const { gw, upstream, close } = await anthropicGateway({
      catalogFetch: () => ({ data: [{
        id: "native-messages", name: "native-messages", vendor: "github", model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/messages"] },
      }] }),
      expectations: [{
        method: "POST", path: "/v1/messages", body: jsonStream(false),
        reply: { body: new TextEncoder().encode("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}") },
      }],
    });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "native-messages", max_tokens: 16, messages: [{ role: "user", content: "search" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        tool_choice: { type: "tool", name: "web_search", disable_parallel_tool_use: true },
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it.each([
    [
      { type: "server_tool_use", id: "srv_1", name: "advisor", input: {} },
      { type: "advisor_tool_result", tool_use_id: "srv_1", content: { type: "advisor_tool_result_error", error_code: "unavailable" } },
    ],
    [
      { type: "mcp_tool_use", id: "mcp_1", name: "lookup", server_name: "docs", input: {} },
      { type: "mcp_tool_result", tool_use_id: "mcp_1", content: "ok", is_error: false },
    ],
  ])("preserves additional native managed-tool call/result families %#", async (call, result) => {
    const { gw, upstream, close } = await anthropicGateway({
      catalogFetch: () => ({ data: [{
        id: "native-messages", name: "native-messages", vendor: "github", model_picker_enabled: true,
        model_info: { supported_endpoints: ["/v1/messages"] },
      }] }),
      expectations: [{
        method: "POST", path: "/v1/messages", body: jsonStream(false),
        reply: { body: new TextEncoder().encode("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}") },
      }],
    });
    try {
      const body = {
        model: "native-messages", max_tokens: 16, messages: [{ role: "assistant", content: [call, result] }],
      };
      const response = await gw.fetch(anthropicRequest(body));
      expect(response.status).toBe(200);
      await response.text();
      expect(new TextDecoder().decode(upstream.requests[0]?.body)).toBe(JSON.stringify(body));
    } finally {
      await close();
    }
  });

  it.each([
    ["empty token", "claude-code-20250219,"],
    ["token count", Array.from({ length: 65 }, (_, index) => `beta-${index}`).join(",")],
    ["byte count", "a".repeat(8 * 1024 + 1)],
    ["whitespace byte count", " ".repeat(8 * 1024 + 1)],
  ])("rejects structurally invalid bounded beta lists: %s", async (_name, beta) => {
    const { gw, upstream, close } = await anthropicGateway({ expectations: [] });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }, { "anthropic-beta": beta }));
      expect(response.status).toBe(400);
      await response.text();
      expect(upstream.requests).toHaveLength(0);
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
