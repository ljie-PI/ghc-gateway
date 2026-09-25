import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EffectiveModelCapabilitySnapshot } from "../../src/copilot/capability_registry.js";
import type { ReasoningCarrierRecord } from "../../src/protocols/conversion/reasoning_carriers.js";
import { prepareConvertedRequest } from "../../src/protocols/conversion/planner.js";
import { PROTOCOL_REQUEST_CODECS } from "../../src/protocols/conversion/request/index.js";
import type { SemanticRequest } from "../../src/protocols/conversion/types.js";
import { cleanChatToolSchema } from "../../src/protocols/conversion/strict_schema.js";
import {
  isWireJsonObject,
  parseWireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("shared conversion request codecs", () => {

  it.each([
    ["chat", "94bdd4d3ec76e20ff9cd82c187bacf899d93cadcfc49d7a3f3e7155d9983bcf8"],
    ["messages", "e2a94e936e0c5916ee38197e8e6d8dd90970a70f9c7205835ce2990cd104fdb3"],
  ] as const)("flattens streaming Responses extended-tool history for %s", (target, digest) => {
    const converted = prepareConvertedRequest(
      "responses",
      target,
      body({
        model: "source",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "use tools" }] },
          { type: "custom_tool_call", call_id: "call_custom", name: "render", input: "raw" },
          { type: "custom_tool_call_output", call_id: "call_custom", output: " { \"ok\": true } " },
          { type: "function_call", call_id: "call_namespace", namespace: "ns", name: "lookup", arguments: "{\"q\":\"x\"}" },
          { type: "function_call_output", call_id: "call_namespace", output: "{\"ok\":true}" },
          { type: "tool_search_call", call_id: "call_search", execution: "client", arguments: { query: "mail" } },
          { type: "tool_search_output", call_id: "call_search", tools: [] },
        ],
        tools: [
          { type: "custom", name: "render", format: { type: "text" } },
          {
            type: "namespace",
            name: "ns",
            tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
          },
          { type: "tool_search" },
        ],
      }),
      "target",
      capability([target]),
    );

    expect(converted.stream).toBe(true);
    expect(sha256(converted.bytes)).toBe(digest);
    const payload = decoded(converted.bytes);
    const messages = payload.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>;
    const customResult = target === "chat"
      ? messages.find((message) => message.role === "tool" && message.tool_call_id === "call_custom")?.content
      : (messages.find((message) => Array.isArray(message.content)
        && message.content.some((block) => (block as { tool_use_id?: string }).tool_use_id === "call_custom"))
        ?.content as Array<{ content?: Array<{ text?: string }> }> | undefined)?.[0]?.content?.[0]?.text;
    expect(customResult).toBe(" { \"ok\": true } ");
    expect(converted.responseBindings?.bindings.map((binding) => binding.kind)).toEqual([
      "custom", "namespace", "tool_search",
    ]);
  });

  it.each([
    [
      "messages", "chat",
      {
        model: "source", max_tokens: 8,
        messages: [
          { role: "user", content: "start" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_dup", name: "lookup", input: { q: 1 } }] },
          { role: "user", content: "interleaved" },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_dup", content: "first" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_dup", name: "lookup", input: { q: 2 } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_orphan", content: "orphan" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_open", name: "lookup", input: {} }] },
        ],
        tools: [
          { name: "lookup", input_schema: { type: "object" } },
          { name: "lookup", input_schema: { type: "object", properties: { duplicate: { type: "boolean" } } } },
          { description: "missing name", input_schema: {} },
        ],
        tool_choice: { type: "tool", name: "missing" },
      },
      "a1a8903ee61a0566f6c510f9ff3d20ca193a2911af8f7632bf92cf1ecc4965ac",
    ],
    [
      "responses", "messages",
      {
        model: "source",
        input: [
          { role: "user", content: "start" },
          { type: "custom_tool_call", call_id: "call_dup", name: "missing", input: "raw" },
          { role: "user", content: "interleaved" },
          { type: "custom_tool_call_output", call_id: "call_dup", output: "first" },
          { type: "custom_tool_call", call_id: "call_dup", name: "missing", input: "again" },
          { type: "custom_tool_call_output", call_id: "call_orphan", output: "orphan" },
          { type: "function_call", call_id: "call_ns", namespace: "ns", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_ns", output: "ok" },
          { type: "function_call", call_id: "call_open", name: "open", arguments: "{}" },
        ],
        tools: [
          { type: "custom", name: "render" },
          { type: "custom", name: "render" },
          { type: "custom" },
        ],
        tool_choice: { type: "custom", name: "missing" },
      },
      "f3b4a5999cbe4ccf716623cf3243827daae26998dfd0dacc40612c4e73417264",
    ],
  ] as const)("encodes %s to %s tool history best-effort", (source, target, payload, digest) => {
    const converted = prepareConvertedRequest(source, target, body(payload), "target", capability([target]));
    expect(sha256(converted.bytes)).toBe(digest);
    expect(converted.degradations).toContain("request.option_omitted");
    if (source === "responses") {
      expect(converted.degradations).toContain("tools.history_omitted");
      const carrier = "ghcg-rsn-v1:responses_item:chat:01234567-89ab-4def-8123-456789abcdef";
      const collision = JSON.parse(JSON.stringify(payload)) as { tools: Array<Record<string, unknown>> };
      collision.tools[1] = { ...collision.tools[1], description: carrier };
      const namespace = JSON.parse(JSON.stringify(payload)) as { tools: Array<Record<string, unknown>> };
      namespace.tools.push({
        type: "namespace", name: "ns", description: carrier,
        tools: [{ type: "function", name: "valid-child", parameters: { type: "object" } }],
      });
      const format = JSON.parse(JSON.stringify(payload)) as { tools: Array<Record<string, unknown>> };
      format.tools.push({ type: "custom", name: "format-carrier", format: { type: carrier } });
      const nested = JSON.parse(JSON.stringify(payload)) as { tools: Array<Record<string, unknown>> };
      nested.tools.push({
        type: "function", strict: carrier,
        function: { name: "nested", parameters: { type: "object" }, strict: true },
      });
      const schema = JSON.parse(JSON.stringify(payload)) as { tools: Array<Record<string, unknown>> };
      schema.tools.push({ type: "function", name: "schema-carrier", parameters: { type: carrier } });
      const choice = { ...JSON.parse(JSON.stringify(payload)), tool_choice: { type: carrier, name: "render" } };
      const bareChoice = { ...JSON.parse(JSON.stringify(payload)), tool_choice: carrier };
      for (const unsafe of [collision, namespace, format, nested, schema, choice, bareChoice]) {
        expect(() => prepareConvertedRequest(source, target, body(unsafe), "target", capability([target]))).toThrow();
      }
      expect(() => prepareConvertedRequest("chat", "messages", body({
        model: "source", messages: [{ role: "user", content: "hi" }], tool_choice: carrier,
      }), "target", capability(["messages"]))).toThrow();
      expect(() => prepareConvertedRequest("responses", "messages", body({
        model: "source", input: "hi",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        tool_choice: carrier,
      }), "target", capability(["messages"]))).toThrow();
      const duplicateBytes = encoder.encode(
        `{"model":"source","input":"hi","tools":[{"type":"custom","name":"render"},{"type":"function","name":"schema-carrier","parameters":{"type":"object","type":"${carrier}"}}]}`,
      );
      const duplicateType = parseWireJson(duplicateBytes, { maxBytes: duplicateBytes.byteLength, maxDepth: 32 });
      if (!isWireJsonObject(duplicateType)) throw new Error("expected object");
      expect(() => prepareConvertedRequest("responses", "messages", duplicateType, "target", capability(["messages"]))).toThrow();
    }
  });

  it.each([
    [
      "chat", "messages",
      { model: "source", messages: [
        7,
        { role: "user", content: [{ type: "text", text: 7 }, { type: "other", text: "drop" }, { type: "text", text: "before" }] },
        { role: "assistant", content: null },
        { role: "assistant", content: null, tool_calls: [
          { id: "bad", type: "function", function: { arguments: "{}" } },
          { id: "good", type: "function", function: { name: "lookup", arguments: "{}" } },
        ] },
        { role: "user", content: "after" },
      ] },
      "a1ee8c3d34c93e5edd440e9e929bc0459f7e829972c0365bb80ff4034849ca19",
      ["chat.extensions_omitted"],
    ],
    [
      "messages", "chat",
      {
        model: "source", max_tokens: 8, system: [{ type: "text", text: 7 }, { type: "text", text: "system" }],
        messages: [
          { role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
          { role: "user", content: [{ type: "tool_use", id: "wrong", name: "lookup", input: {} }] },
          { role: "assistant", content: [{ type: "tool_result", tool_use_id: "wrong", content: "drop" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: 7 }] },
          { role: "assistant", content: [{ type: "thinking", thinking: "hidden", signature: 7 }] },
          { role: "user", content: "keep" },
        ],
      },
      "6f68f792500361a7f997818c2e6e14987016ad583669f1f7564a89e1b6102cd9",
      ["messages.extensions_omitted", "request.option_omitted", "reasoning.presentation_omitted"],
    ],
    [
      "responses", "chat",
      { model: "source", input: [
        7,
        { type: "message", content: [{ type: "input_text", text: "missing role" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: 7 }, { type: "other", text: "drop" }, { type: "input_text", text: "keep" }] },
      ] },
      "cd5d63aa5a365cea254b9c70d416ab00761140faf93ce467b9f7d1356a218c67",
      ["responses.extensions_omitted"],
    ],
  ] as const)("decodes malformed %s input best-effort for %s", (source, target, payload, digest, expectedDegradations) => {
    const converted = prepareConvertedRequest(source, target, body(payload), "target", capability([target]));
    expect(sha256(converted.bytes)).toBe(digest);
    expect(converted.degradations).toEqual(expectedDegradations);
    if (source === "messages") {
      const carrier = "ghcg-rsn-v1:responses_item:chat:01234567-89ab-4def-8123-456789abcdef";
      const unsafe = [
        { model: "source", max_tokens: 8, messages: [{ role: carrier, content: "drop" }] },
        { model: "source", max_tokens: 8, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: carrier }] }] },
        { model: "source", max_tokens: 8, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: carrier }] }] },
        { model: "source", max_tokens: 8, system: [{ type: "other", text: carrier }], messages: [{ role: "user", content: "hi" }] },
        { model: "source", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: carrier } }] }] },
        { model: "source", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: carrier } }] }] },
        { model: "source", max_tokens: 8, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "other", text: carrier }] }] }] },
      ];
      for (const candidate of unsafe) {
        expect(() => prepareConvertedRequest("messages", "chat", body(candidate), "target", capability(["chat"]))).toThrow();
      }
      expect(() => prepareConvertedRequest("chat", "messages", body({
        model: "source", messages: [{ role: "other", content: carrier }],
      }), "target", capability(["messages"]))).toThrow();
      expect(() => prepareConvertedRequest("chat", "messages", body({
        model: "source", messages: [{ role: "user", content: [{ text: carrier }] }],
      }), "target", capability(["messages"]))).toThrow();
      expect(() => prepareConvertedRequest("chat", "messages", body({
        model: "source", messages: [{ role: "tool", tool_call_id: "call", content: carrier }],
      }), "target", capability(["messages"]))).toThrow();
      for (const input of [
        [{ type: "message", role: "other", content: carrier }],
        [{ type: "message", role: "user", content: [{ text: carrier }] }],
        [{ type: "other", content: carrier }],
        [{ type: "function_call_output", call_id: "call", output: carrier }],
        [{ type: "function_call_output", call_id: "call", output: { value: carrier } }],
      ]) {
        expect(() => prepareConvertedRequest("responses", "chat", body({ model: "source", input }), "target", capability(["chat"]))).toThrow();
      }
    }
  });

  it.each(["chat", "messages", "responses"] as const)("drops foreign opaque reasoning for %s targets", (target) => {
    const foreign = target === "chat"
      ? { kind: "messages_block" as const, block: body({ type: "thinking", thinking: "hidden" }) }
      : { kind: "chat_state" as const, state: body({ reasoning_opaque: "provider-state" }) };
    const request: SemanticRequest = {
      source: "chat", stream: false, instructions: [], tools: [], items: [{
        type: "reasoning", parts: [{ presentation: "summary", index: 0, text: "visible" }], opaqueState: foreign,
      }], degradations: [],
    };
    const encoded = PROTOCOL_REQUEST_CODECS[target].encode(request, { resolvedModel: "target", capability: capability([target]) });
    expect(encoded.degradations).toEqual(target === "messages"
      ? ["reasoning.state_omitted", "messages.leading_user_synthesized"]
      : ["reasoning.state_omitted"]);
    const wire = decoder.decode(encoded.bytes);
    expect(wire).not.toContain(target === "chat" ? "hidden" : "provider-state");
    if (target === "chat") expect(wire).toContain("\"reasoning_content\":\"visible\"");
    if (target === "messages") expect(wire).toContain("\"thinking\":\"visible\"");
    if (target === "responses") expect(wire).not.toContain("visible");
  });

  it("uses the configured/default/ceiling/unknown Messages token hierarchy without raising explicit budgets", () => {
    expect(decoded(prepareConvertedRequest(
      "responses",
      "messages",
      body({ model: "source", input: "hi", max_output_tokens: 7 }),
      "target",
      capability(["messages"], "max_tokens", 99, 120),
    ).bytes)).toMatchObject({ max_tokens: 7 });

    expect(decoded(prepareConvertedRequest(
      "responses",
      "messages",
      body({ model: "source", input: "hi" }),
      "target",
      capability(["messages"], "max_tokens", 99, 120),
    ).bytes)).toMatchObject({ max_tokens: 99 });

    expect(decoded(prepareConvertedRequest(
      "responses",
      "messages",
      body({ model: "source", input: "hi" }),
      "target",
      capability(["messages"], "max_tokens", null, 5000),
    ).bytes)).toMatchObject({ max_tokens: 5000 });

    expect(decoded(prepareConvertedRequest(
      "responses",
      "messages",
      body({ model: "source", input: "hi" }),
      "target",
      capability(["messages"], "max_tokens", null, null),
    ).bytes)).toMatchObject({ max_tokens: 4096 });
  });

  it("projects nested tuple tool schemas only for converted Chat requests", () => {
    const schema = {
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: {
            where: {
              type: "array",
              items: {
                type: "array",
                prefixItems: [{ type: "string" }, { type: "number" }],
                items: false,
              },
            },
            legacy: {
              type: "array",
              items: [{ type: "string" }, { type: "number" }],
              additionalItems: false,
            },
            literal: { const: { prefixItems: [1, 2], items: [3, 4] } },
          },
        },
        prefixItems: { type: "string" },
      },
    };
    const request = body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      tools: [{ name: "ArtifactData", input_schema: schema }],
    });
    const chat = prepareConvertedRequest("messages", "chat", request, "target", capability(["chat"]));
    expect(decoded(chat.bytes).tools).toEqual([{
      type: "function",
      function: {
        name: "ArtifactData",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "object",
              properties: {
                where: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { anyOf: [{ type: "string" }, { type: "number" }] },
                    maxItems: 2,
                  },
                },
                legacy: {
                  type: "array",
                  items: { anyOf: [{ type: "string" }, { type: "number" }] },
                  maxItems: 2,
                },
                literal: { const: { prefixItems: [1, 2], items: [3, 4] } },
              },
            },
            prefixItems: { type: "string" },
          },
        },
        strict: false,
      },
    }]);
    expect(chat.degradations).toContain("request.option_omitted");

    const responses = prepareConvertedRequest("messages", "responses", request, "target", capability(["responses"]));
    expect(decoded(responses.bytes)).toMatchObject({
      tools: [{ parameters: schema }],
    });
    expect(responses.degradations).not.toContain("request.option_omitted");
  });

  it("leaves ordinary converted Chat tool schemas unchanged", () => {
    const schema = { type: "object", properties: { values: { type: "array", items: { type: "string" } } } };
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", input_schema: schema }],
    }), "target", capability(["chat"]));

    expect(decoded(converted.bytes).tools).toEqual([{
      type: "function",
      function: { name: "lookup", parameters: schema, strict: false },
    }]);
    expect(converted.degradations).toEqual([]);
  });

  it("keeps existing tuple bounds and permits unrestricted array tails", () => {
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", input_schema: {
        type: "object",
        properties: {
          capped: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            items: false,
            maxItems: 1,
          },
          open: { type: "array", prefixItems: [{ type: "string" }] },
        },
      } }],
    }), "target", capability(["chat"]));

    expect(decoded(converted.bytes)).toMatchObject({
      tools: [{ function: { parameters: { properties: {
        capped: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] },
          maxItems: 1,
        },
        open: { type: "array", items: {} },
      } } } }],
    });
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it("does not discard reasoning carriers from unrestricted tuple schemas", () => {
    const schema = body({
      type: "object",
      properties: {
        values: {
          type: "array",
          prefixItems: [{ const: "ghcg-rsn-v1:chat_state:chat:00000000-0000-4000-8000-000000000000" }],
        },
      },
    });
    expect(() => cleanChatToolSchema(schema)).toThrow("REQ-TARGET-C-TOOL-SCHEMA");
  });

  it("uses UTF-8 byte thresholds only for complete raw tool-result image data URLs", () => {
    const prefix = "data:image/png;base64,";
    const below = `${prefix}${"A".repeat(8191 - prefix.length)}`;
    const boundary = `${prefix}${"A".repeat(8192 - prefix.length)}`;
    const belowRequest = toolMediaChatRequest(below);
    const boundaryRequest = toolMediaChatRequest(boundary);

    expect(JSON.stringify(decoded(prepareConvertedRequest(
      "messages",
      "chat",
      body(belowRequest),
      "target",
      capability(["chat"]),
    ).bytes))).not.toContain("image_url");
    expect(JSON.stringify(decoded(prepareConvertedRequest(
      "messages",
      "chat",
      body(boundaryRequest),
      "target",
      capability(["chat"]),
    ).bytes))).toContain("image_url");
  });
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function capability(
  protocols: readonly ("chat" | "messages" | "responses")[],
  tokenField: "max_tokens" | "max_completion_tokens" = "max_tokens",
  defaultTokens: number | null = 4096,
  maxTokens: number | null = 16_384,
): EffectiveModelCapabilitySnapshot {
  const configuredDefault = {
    value: defaultTokens,
    source: defaultTokens === null ? "unknown" as const : "live" as const,
    conflict: false,
    liveState: defaultTokens === null ? "missing" as const : "value" as const,
  };
  return {
    accountId: "github.com/1",
    modelId: "target",
    name: "target",
    vendor: "test",
    protocols: { value: protocols, source: "live", conflict: false, liveState: "value" },
    maxInputTokens: { value: 128_000, source: "live", conflict: false, liveState: "value" },
    maxOutputTokens: { value: maxTokens, source: maxTokens === null ? "unknown" : "live", conflict: false, liveState: maxTokens === null ? "missing" : "value" },
    defaultOutputTokens: {
      configuration: configuredDefault,
      effective: defaultTokens ?? (maxTokens === null ? 4096 : Math.min(8192, maxTokens)),
      source: defaultTokens === null ? (maxTokens === null ? "unknown_fallback" : "known_ceiling") : "live",
      valid: true,
    },
    capabilities: {
      contextWindowTokens: 128_000,
      maxContextWindowTokens: 128_000,
      reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      reasoningProtocols: protocols,
      inputModalities: ["text", "image"],
      toolCalling: true,
      parallelToolCalling: true,
      reasoningSummaries: false,
      verbosity: false,
      search: false,
    },
    profile: {
      chatOutputTokenField: { value: tokenField, source: "live", conflict: false, liveState: "value" },
      supportedParameters: {
        value: [
          "temperature",
          "top_p",
          "response_format",
          "text.format",
          "output_config.format",
          "reasoning_effort",
          "reasoning",
          "reasoning.effort",
          "output_config.effort",
        ],
        source: "live",
        conflict: false,
        liveState: "value",
      },
      reasoningEfforts: {
        value: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        source: "live",
        conflict: false,
        liveState: "value",
      },
      unrecognizedReasoningEfforts: {
        value: [], source: "live", conflict: false, liveState: "value",
      },
    },
    revision: {
      credentialGeneration: 0,
      catalogGeneration: 1,
      builtinRevision: null,
    },
  };
}

function body(value: unknown): WireJsonObject {
  return rawBody(JSON.stringify(value));
}

function rawBody(value: string): WireJsonObject {
  const bytes = encoder.encode(value);
  const parsed = parseWireJson(bytes, { maxBytes: bytes.byteLength, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) {
    throw new Error("expected object");
  }
  return parsed;
}

function decoded(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

function toolMediaChatRequest(content: string) {
  return {
    model: "source",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content }],
      },
    ],
    max_tokens: 8,
  };
}

describe("representative request mappings", () => {
  it("maps Chat to Messages without losing images, tools, format, stop, or parallel constraints", () => {
    const converted = prepareConvertedRequest("chat", "messages", body({
      model: "source",
      messages: [
        { role: "system", content: "system" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"_business\":1}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      max_completion_tokens: 64,
      stop: ["END"],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { _business: { type: "integer" } },
          },
          strict: true,
        },
      }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      parallel_tool_calls: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object", properties: { _business: { type: "integer" } } },
          strict: true,
        },
      },
      reasoning_effort: "high",
    }), "target", capability(["messages"]));

    expect(decoded(converted.bytes)).toEqual({
      model: "target",
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { _business: 1 } }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "result" }],
            cache_control: { type: "ephemeral" },
          }],
        },
      ],
      max_tokens: 64,
      stop_sequences: ["END"],
      tools: [{
        name: "lookup",
        description: "Lookup",
        input_schema: {
          type: "object",
          properties: { _business: { type: "integer" } },
        },
        strict: true,
        cache_control: { type: "ephemeral" },
      }],
      tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { _business: { type: "integer" } } },
        },
      },
    });
  });

  it("maps Messages to Responses and records only finite content-free degradation IDs", () => {
    const converted = prepareConvertedRequest("messages", "responses", body({
      model: "source",
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "call_1",
            name: "lookup",
            input: { q: "x" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "ok" }],
            is_error: true,
          }],
        },
      ],
      max_tokens: 32,
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      thinking: { type: "enabled", budget_tokens: 8000 },
      output_config: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    }), "target", capability(["responses"]));

    expect(decoded(converted.bytes)).toMatchObject({
      model: "target",
      instructions: "system",
      max_output_tokens: 32,
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: {}, additionalProperties: false },
          strict: true,
        },
      },
    });

    expect(converted.degradations).toEqual([
      "cache.control_omitted",
      "reasoning.budget_coarsened",
    ]);
  });

  it("accepts Codex reasoning carriers with nullable content", () => {
    const token = "ghcg-rsn-v1:chat_state:responses:01234567-89ab-4def-8123-456789abcdef";
    const record: ReasoningCarrierRecord = {
      token, sourceKind: "chat_state", state: "complete", storedBytes: 1,
      payload: body({ state: { reasoning_text: "private" } }),
      projection: body({ type: "reasoning", text: "visible" }),
    };
    const decodedRequest = PROTOCOL_REQUEST_CODECS.responses.decode(body({
      model: "source",
      input: [{
        type: "reasoning", id: "rs_1",
        summary: [{ type: "summary_text", text: "visible" }],
        content: null, encrypted_content: token,
      }],
    }), new Map([[token, record]]));

    expect(decodedRequest.items).toEqual([{
      type: "reasoning",
      parts: [{ presentation: "summary", index: 0, text: "visible" }],
      opaqueState: { kind: "chat_state", state: body({ reasoning_text: "private" }) },
    }]);
    expect(decodedRequest.degradations).toEqual(["request.option_omitted", "responses.extensions_omitted"]);

    const malformed = body({
      model: "source",
      input: [{
        type: "reasoning", id: "rs_1",
        summary: [{ type: "summary_text", text: "visible" }],
        content: {}, encrypted_content: token,
      }],
    });
    expect(() => PROTOCOL_REQUEST_CODECS.responses.decode(malformed, new Map([[token, record]]))).toThrow();
  });

  it("maps Responses to Chat with separate call and item IDs and preserves tool-result binding", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      instructions: "system",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "https://example.test/image.png", detail: "high" },
          ],
        },
        {
          type: "function_call",
          id: "fc_item",
          call_id: "call_1",
          name: "lookup",
          arguments: "{\"q\":\"x\"}",
        },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
      max_output_tokens: 24,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: false }],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
      reasoning: { effort: "low", summary: "auto", encrypted_content: "opaque" },
    }), "target", capability(["chat"], "max_completion_tokens"));

    expect(decoded(converted.bytes)).toMatchObject({
      model: "target",
      max_completion_tokens: 24,
      parallel_tool_calls: false,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "system" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "high" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });

    expect(converted.degradations).toEqual([
      "request.option_omitted",
      "reasoning.presentation_omitted",
      "reasoning.state_omitted",
    ]);
  });
});
