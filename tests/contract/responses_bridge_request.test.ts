import { describe, expect, it } from "vitest";
import type { ResolvedModel } from "../../src/protocols/model_catalog/resolver.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import {
  buildChatBridgeRequest,
  convertResponsesRequest,
} from "../../src/protocols/responses/bridge_request.js";
import type { ChatBridgePlan } from "../../src/protocols/responses/planner.js";
import { buildRequestToolContext } from "../../src/protocols/responses/tool_context.js";
import {
  isWireJsonObject,
  parseWireJson,
  serializeWireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";

const LIMITS = { maxBytes: 65_536, maxDepth: 64 } as const;

describe("Responses bridge request conversion", () => {
  it("converts top-level fields, input parts, calls, tools, reasoning, and prompt cache", () => {
    const request = requestFromJson(JSON.stringify({
      model: "o1",
      instructions: ["sys", { text: "dev" }, ""],
      input: [
        { role: "system", content: "later system" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            { type: "input_image", image_url: "https://example.test/a.png" },
            { type: "input_file", file_id: "file_1", filename: "a.txt" },
            { type: "input_audio", input_audio: { data: "abc", format: "wav" } },
          ],
        },
        { type: "reasoning", summary: [{ text: "plan" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"z\":1,\"a\":2}" },
        { type: "custom_tool_call", call_id: "call_2", name: "render", input: "card" },
        { type: "tool_search_call", call_id: "call_3", arguments: { query: "docs" } },
        { type: "function_call_output", call_id: "call_1", output: "{\"b\":2,\"a\":1}" },
      ],
      max_output_tokens: 9,
      max_tokens: 7,
      temperature: 0.2,
      stream: true,
      stream_options: { other: "keep", include_usage: false },
      tools: [
        { type: "function", name: "lookup", description: "Lookup", parameters: { type: "string", x: 1 }, strict: true },
        { type: "namespace", name: "ns", tools: [{ type: "function", name: "child", parameters: {} }] },
        { type: "custom", name: "render", input_format: "text" },
        { type: "tool_search" },
      ],
      tool_choice: { type: "function", name: "child", namespace: "ns" },
      parallel_tool_calls: true,
      prompt_cache_key: "  cache-key  ",
      previous_response_id: "drop",
      store: true,
      text: { format: "drop" },
      reasoning: { effort: "max" },
    }));
    const toolContext = buildRequestToolContext(request);
    const converted = convertResponsesRequest(request, {
      resolvedModel: "o1",
      toolContext,
      chatOutputTokenField: "max_completion_tokens",
      reasoningConfig: { supportsEffort: true, effortValueMode: "openrouter" },
      upstreamHost: "api.openai.com",
      promptCacheRouting: "auto",
    });

    expect(json(converted)).toEqual({
      model: "o1",
      messages: [
        { role: "system", content: "sys\n\ndev\n\nlater system" },
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image_url", image_url: { url: "https://example.test/a.png" } },
            { type: "file", file: { file_id: "file_1", filename: "a.txt" } },
            { type: "input_audio", input_audio: { data: "abc", format: "wav" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"a\":2,\"z\":1}" } },
            { id: "call_2", type: "function", function: { name: "render", arguments: "{\"input\":\"card\"}" } },
            { id: "call_3", type: "function", function: { name: "tool_search", arguments: "{\"query\":\"docs\"}" } },
          ],
          reasoning_content: "plan",
        },
        { role: "tool", tool_call_id: "call_1", content: "{\"a\":1,\"b\":2}" },
      ],
      max_completion_tokens: 9,
      max_tokens: 7,
      temperature: 0.2,
      stream: true,
      stream_options: { other: "keep", include_usage: true },
      parallel_tool_calls: true,
      thinking: { type: "enabled" },
      reasoning_effort: "xhigh",
      tools: [
        { type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", x: 1 }, strict: true } },
        { type: "function", function: { name: "ns__child", description: null, parameters: { type: "object" } } },
        {
          type: "function",
          function: {
            name: "render",
            description: expect.stringContaining("Original tool definition:"),
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: expect.stringContaining("Raw string input"),
                },
              },
              required: ["input"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "tool_search",
            description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
            parameters: expect.objectContaining({ type: "object", required: ["query"] }),
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "ns__child" } },
      prompt_cache_key: "cache-key",
    });
    expect(JSON.stringify(json(converted))).not.toContain("previous_response_id");
    expect(JSON.stringify(json(converted))).not.toContain("store");
  });

  it("uses history before ToolContext and removes tool_choice when no tools survive", async () => {
    const events: string[] = [];
    const request = requestFromJson(JSON.stringify({
      model: "gpt",
      input: [{ type: "function_call_output", call_id: "call_restored", output: "ok" }],
      tool_choice: "none",
      parallel_tool_calls: true,
    }));
    const plan: ChatBridgePlan = {
      kind: "chat_bridge",
      originalRequest: request,
      resolvedModel: resolved("gpt"),
      continuation: {
        accountId: "github.com/1",
        responseId: "resp_previous",
        modelId: "gpt",
        upstreamOrigin: "https://api.githubcopilot.com",
        owner: "converted",
        upstreamProtocol: "chat",
        conversionVersion: "responses-chat-v1",
        checkpointState: "complete",
        expiresAt: 1_700_604_800_000,
      },
    };
    const converted = await buildChatBridgeRequest(plan, {
      async enrich(_input) {
        events.push("history");
        return requestFromJson(JSON.stringify({
          model: "gpt",
          input: [
            { type: "function_call", call_id: "call_restored", name: "late", arguments: "{}" },
            { type: "function_call_output", call_id: "call_restored", output: "ok" },
          ],
          tools: [{ type: "function", name: "late", parameters: {} }],
        }));
      },
      async resolve() {
        return { kind: "none" };
      },
      async recordReceipt() {
        throw new Error("recordReceipt must not be called by request conversion");
      },
      async recordCheckpoint() {
        throw new Error("record must not be called by request conversion");
      },
    }, { reasoningConfig: null }, new AbortController().signal);
    events.push("converted");

    expect(events).toEqual(["history", "converted"]);
    expect(json(converted)).toMatchObject({
      model: "gpt",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_restored", type: "function", function: { name: "late", arguments: "{}" } }],
          reasoning_content: "tool call",
        },
        { role: "tool", tool_call_id: "call_restored", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "late", description: null, parameters: { type: "object" } } }],
    });
    expect(json(converted)).not.toHaveProperty("tool_choice");
    expect(json(converted)).not.toHaveProperty("parallel_tool_calls");

    const noTools = requestFromJson(JSON.stringify({
      model: "gpt",
      input: "hi",
      tool_choice: "none",
      parallel_tool_calls: true,
    }));
    const noToolsConverted = convertResponsesRequest(noTools, {
      resolvedModel: "gpt",
      toolContext: buildRequestToolContext(noTools),
      reasoningConfig: null,
    });
    expect(json(noToolsConverted)).not.toHaveProperty("tool_choice");
    expect(json(noToolsConverted)).not.toHaveProperty("parallel_tool_calls");
  });

  it("relocates tool-output media and supports reasoning effort modes", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(8192)}`;
    const residual = "b".repeat(8192);
    const encodedOutput = JSON.stringify({
      media: { type: "input_image", image_url: dataUrl },
      residual,
    });
    const request = requestFromJson(JSON.stringify({
      model: "gpt",
      input: [
        { type: "custom_tool_call_output", call_id: "call_media", output: [{ type: "input_image", image_url: dataUrl }] },
        { type: "tool_search_output", call_id: "call_json_media", output: encodedOutput },
      ],
      reasoning: { effort: "low" },
      tools: [{ type: "custom", name: "render" }],
    }));
    const converted = convertResponsesRequest(request, {
      resolvedModel: "gpt",
      toolContext: buildRequestToolContext(request),
      reasoningConfig: { supportsEffort: true, effortParam: "reasoning.effort", effortValueMode: "low_high" },
      promptCacheRouting: "disabled",
      clientSessionId: "session",
    });
    expect(json(converted)).toMatchObject({
      messages: [
        {
          role: "tool",
          tool_call_id: "call_media",
          content: "{\"call_id\":\"call_media\",\"output\":[\"[cc-switch: tool result media moved to the following user message]\"],\"type\":\"custom_tool_call_output\"}",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "[cc-switch: media output of tool call call_media]" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_json_media",
          content: "{\"call_id\":\"call_json_media\",\"output\":\"{\\\"media\\\":\\\"[cc-switch: tool result media moved to the following user message]\\\",\\\"residual\\\":\\\"[cc-switch: omitted 8192 bytes]\\\"}\",\"type\":\"tool_search_output\"}",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "[cc-switch: media output of tool call call_json_media]" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      thinking: { type: "enabled" },
      reasoning: { effort: "low" },
    });
    expect(json(converted)).not.toHaveProperty("prompt_cache_key");
  });

  it("classifies a missing Chat token dialect as unavailable capability", () => {
    const request = requestFromJson("{\"model\":\"chat\",\"input\":\"hi\",\"max_output_tokens\":9}");
    expect(() => convertResponsesRequest(request, {
      resolvedModel: "chat",
      toolContext: buildRequestToolContext(request),
      reasoningConfig: null,
      chatOutputTokenField: null,
    })).toThrow(expect.objectContaining({
      failure: expect.objectContaining({ kind: "unsupported_semantics" }),
    }));
  });

  function requestFromJson(source: string) {
    const parsed = parseWireJson(new TextEncoder().encode(source), LIMITS);
    expect(isWireJsonObject(parsed)).toBe(true);
    return decodeResponsesRequest(parsed as WireJsonObject);
  }

  function json(value: WireJsonObject): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(serializeWireJson(value))) as Record<string, unknown>;
  }

  function resolved(model: string): ResolvedModel {
    return {
      upstreamModel: model,
      source: "explicit",
      requestedModel: model,
      capability: capability(model, ["chat"]),
    };
  }

  function capability(modelId: string, protocols: readonly ("chat" | "responses")[]): ResolvedModel["capability"] {
    return {
      accountId: "test", modelId, name: modelId, vendor: "test",
      discovered: true, configured: false, verified: true, enabled: true, visible: true, override: null,
      protocols: { value: protocols, source: "live", conflict: false, liveState: "value" },
      maxInputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
      maxOutputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
      defaultOutputTokens: {
        configuration: { value: null, source: "unknown", conflict: false, liveState: "missing" },
        effective: 4096, source: "unknown_fallback", valid: true,
      },
      profile: {
        chatOutputTokenField: { value: "max_tokens", source: "builtin", conflict: false, liveState: "missing" },
      },
      revision: { credentialGeneration: 0, catalogGeneration: 0, overrideRevision: 0, builtinRevision: null },
    };
  }
});
