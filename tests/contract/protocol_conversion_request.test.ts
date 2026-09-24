import { describe, expect, it } from "vitest";
import type { EffectiveModelCapabilitySnapshot } from "../../src/copilot/capability_registry.js";
import { planProtocolExecution, prepareConvertedRequest } from "../../src/protocols/conversion/planner.js";
import {
  isWireJsonObject,
  parseWireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";
import type { ReasoningCarrierRecord } from "../../src/protocols/conversion/reasoning_carriers.js";
import { validateMessagesRequestSecurity } from "../../src/protocols/anthropic_messages/request_validation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("shared conversion request codecs", () => {
  it("rejects one gateway carrier reused across Messages reasoning slots", () => {
    expect(() => validateMessagesRequestSecurity(body({
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "one", signature: "ghcg-rsn-v1:synthetic" },
          { type: "thinking", thinking: "two", signature: "ghcg-rsn-v1:synthetic" },
        ],
      }],
    }))).toThrow();
  });

  it("routes Responses through the current native-first conversion matrix", () => {
    const request = body({ model: "source", input: "hi", stream: true });
    expect(planProtocolExecution({
      source: "responses",
      body: request,
      stream: true,
      resolvedModel: "target",
      capability: capability(["responses"]),
    })).toMatchObject({ kind: "native", source: "responses", target: "responses", stream: true });
    expect(planProtocolExecution({
      source: "responses",
      body: request,
      stream: true,
      resolvedModel: "target",
      capability: capability(["chat", "responses"]),
    })).toMatchObject({ kind: "native", target: "responses" });
    expect(planProtocolExecution({
      source: "responses",
      body: request,
      stream: true,
      resolvedModel: "target",
      capability: capability(["chat"]),
    })).toMatchObject({ kind: "converted", target: "chat" });
    expect(planProtocolExecution({
      source: "responses",
      body: request,
      stream: true,
      resolvedModel: "target",
      capability: capability(["messages"]),
    })).toMatchObject({ kind: "converted", target: "messages" });

    const unknown = capability(["chat"]);
    expect(() => planProtocolExecution({
      source: "responses",
      body: request,
      stream: true,
      resolvedModel: "target",
      capability: {
        ...unknown,
        protocols: {
          value: null,
          source: "unknown",
          conflict: false,
          liveState: "missing",
        },
      },
    })).toThrow();
  });

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

  it.each([
    ["chat", {
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          description: "Return the amount in EUR, not USD.",
          schema: { type: "object" },
          strict: true,
        },
      },
    }],
    ["responses", {
      model: "source",
      input: "hi",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          description: "Return the amount in EUR, not USD.",
          schema: { type: "object" },
          strict: true,
        },
      },
    }],
  ] as const)("rejects %s structured-output descriptions that Messages cannot represent", (source, request) => {
    expect(() => prepareConvertedRequest(source, "messages", body(request), "target", capability(["messages"])))
      .toThrow();
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

  it.each(["chat", "responses"] as const)(
    "omits ordinary Messages extensions but validates known core fields for %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "hi", block_extension: { enabled: true } }],
          message_extension: true,
        }],
        max_tokens: 8,
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        metadata: { user_id: "user-1", optional_extension: { enabled: true } },
        top_level_extension: { enabled: true },
      }), "target", capability([target]));

      expect(converted.degradations).toContain("messages.extensions_omitted");
      expect(decoded(converted.bytes)).toMatchObject({ metadata: { user_id: "user-1" } });
      expect(decoded(converted.bytes)).not.toHaveProperty("context_management");
      const malformedOptional = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: "wrong",
        context_management: {},
      }), "target", capability([target]));
      const malformedBody = decoded(malformedOptional.bytes);
      if (target === "chat") {
        expect(malformedBody).toMatchObject({ max_tokens: 4096 });
      } else {
        expect(malformedBody).not.toHaveProperty("max_output_tokens");
      }
    },
  );

  it("omits duplicate unknown Messages extensions and keeps the first known duplicate", () => {
    const converted = prepareConvertedRequest("messages", "chat", rawBody(
      "{\"model\":\"source\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\",\"extension\":1,\"extension\":2}],\"max_tokens\":8,\"extension\":3,\"extension\":4}",
    ), "target", capability(["chat"]));
    expect(converted.degradations).toContain("messages.extensions_omitted");
    const duplicateRole = prepareConvertedRequest("messages", "chat", rawBody(
      "{\"model\":\"source\",\"messages\":[{\"role\":\"user\",\"role\":\"assistant\",\"content\":\"hi\"}],\"max_tokens\":8}",
    ), "target", capability(["chat"]));
    expect(decoded(duplicateRole.bytes)).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
  });

  it.each([
    ["top-level thinking", { thinking: { type: "adaptive", optional_extension: true } }],
    ["thinking block", {
      messages: [{
        role: "assistant",
        content: [{ type: "thinking", thinking: "plan", signature: "opaque", optional_extension: true }],
      }],
    }],
    ["redacted thinking block", {
      messages: [{
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque", optional_extension: true }],
      }],
    }],
  ] as const)("omits ordinary Messages %s extensions", (_name, extra) => {
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      ...extra,
    }), "target", capability(["chat"]));
    expect(converted.degradations).toContain("messages.extensions_omitted");
  });

  it.each(["chat", "responses"] as const)(
    "preserves a valid content-free Messages tool result when converting to %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [
          { role: "user", content: "Use the tool." },
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
            content: [{ type: "tool_result", tool_use_id: "call_1" }],
          },
        ],
        max_tokens: 32,
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
      }), "target", capability([target]));

      const request = decoded(converted.bytes);
      if (target === "chat") {
        expect(request.messages).toEqual([
          { role: "user", content: "Use the tool." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "" },
        ]);
        return;
      }
      expect(request.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use the tool." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{\"q\":\"x\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [],
        },
      ]);
    },
  );

  it.each(["chat", "responses"] as const)(
    "rejects object-shaped Messages tool result content before converting to %s",
    (target) => {
      expect(() => prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [
          { role: "user", content: "Use the tool." },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "call_1",
              content: {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "QUJD" },
                unsupported_core_constraint: null,
              },
            }],
          },
        ],
        max_tokens: 8,
      }), "target", capability([target]))).toThrow();
    },
  );

  it.each(["chat", "responses"] as const)(
    "rejects an incompatible strict Messages tool schema before converting to %s",
    (target) => {
      expect(() => prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        tools: [{
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {
              location: { type: "string" },
              unit: { type: "string" },
            },
            required: ["location"],
            additionalProperties: false,
          },
          strict: true,
        }],
      }), "target", capability([target]))).toThrow();
    },
  );

  it.each(["chat", "responses"] as const)(
    "preserves a compatible strict Messages tool schema for %s",
    (target) => {
      expect(() => prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        tools: [{
          name: "lookup",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
            additionalProperties: false,
          },
          strict: true,
        }],
      }), "target", capability([target]))).not.toThrow();
    },
  );

  it.each(["chat", "responses"] as const)(
    "omits a valid Messages tool cache hint through finite degradation for %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        tools: [{
          name: "lookup",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        }],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("cache.control_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).not.toContain("cache_control");
    },
  );

  it("accepts Messages structured output without a source name using the fixed response name", () => {
    const converted = prepareConvertedRequest("messages", "responses", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    }), "target", capability(["responses"]));
    expect(decoded(converted.bytes)).toMatchObject({
      text: {
        format: {
          type: "json_schema",
          name: "response",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });
  });

  it.each(["chat", "responses"] as const)(
    "preserves the guaranteed Messages JSON-schema constraint when converting to %s",
    (target) => {
      const converted = decoded(prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      }), "target", capability([target])).bytes);
      if (target === "chat") {
        expect(converted.response_format).toMatchObject({
          type: "json_schema",
          json_schema: { strict: true },
        });
        return;
      }
      expect(converted.text).toMatchObject({
        format: { type: "json_schema", strict: true },
      });
    },
  );

  it.each(["chat", "responses"] as const)(
    "omits an explicit false Messages JSON-schema strictness for %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object" },
            strict: false,
          },
        },
      }), "target", capability([target]));
      expect(converted.degradations).toContain("request.option_omitted");
      expect(decoder.decode(converted.bytes)).not.toContain("json_schema");
    },
  );

  it.each(["chat", "responses"] as const)(
    "rejects a Messages schema with optional non-nullable properties for strict %s output",
    (target) => {
      expect(() => prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                required_value: { type: "string" },
                optional_value: { type: "string" },
              },
              required: ["required_value"],
              additionalProperties: false,
            },
          },
        },
      }), "target", capability([target]))).toThrow();
    },
  );

  it("accepts Chat assistant tool history with omitted optional content", () => {
    const converted = prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [{
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        }],
      }, {
        role: "tool",
        tool_call_id: "call_1",
        content: "ok",
      }],
    }), "target", capability(["responses"]));
    expect(decoded(converted.bytes)).toMatchObject({
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });
  });

  it.each(["messages", "responses"] as const)(
    "degrades valid Chat reasoning_items without rejecting a complete tool round for %s",
    (target) => {
      const converted = prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [
          { role: "user", content: "Use the tool." },
          {
            role: "assistant",
            content: null,
            reasoning_items: [{
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "opaque",
            }],
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("reasoning.state_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).not.toContain("reasoning_items");
    },
  );

  it.each(["messages", "responses"] as const)(
    "omits malformed optional Chat reasoning_items for %s",
    (target) => {
      const converted = prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [{ role: "assistant", content: "ok", reasoning_items: 17 }],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("request.option_omitted");
      expect(converted.degradations).toContain("reasoning.state_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).toContain("ok");
    },
  );

  it.each(["messages", "responses"] as const)(
    "omits malformed optional Chat tool_calls for %s",
    (target) => {
      const converted = prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [{ role: "assistant", content: "ok", tool_calls: 17 }],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("request.option_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).toContain("ok");
    },
  );

  it.each(["messages", "responses"] as const)(
    "omits malformed optional Chat assistant content for %s",
    (target) => {
      const converted = prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [{
          role: "assistant",
          content: 17,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }],
        }, {
          role: "tool",
          tool_call_id: "call_1",
          content: "ok",
        }],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("request.option_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).toContain("call_1");
    },
  );

  it.each(["messages", "responses"] as const)(
    "omits a valid reasoning-only Chat history entry without rejecting later tools for %s",
    (target) => {
      const converted = prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            reasoning_items: [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" }],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("reasoning.state_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).toContain("call_1");
    },
  );

  it.each(["messages", "responses"] as const)(
    "accepts generated Chat reasoning_content as omitted presentation for %s",
    (target) => {
      const converted = prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: null, reasoning_content: "visible plan" },
          { role: "user", content: "continue" },
        ],
      }), "target", capability([target]));
      expect(converted.degradations).toContain("reasoning.presentation_omitted");
      expect(JSON.stringify(decoded(converted.bytes))).not.toContain("visible plan");
    },
  );

  it("preserves source function-tool strictness defaults across OpenAI protocols", () => {
    const chatToResponses = decoded(prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: { name: "lookup", parameters: { type: "object" } },
      }],
    }), "target", capability(["responses"])).bytes);
    expect(chatToResponses.tools).toMatchObject([{ type: "function", name: "lookup", strict: false }]);

    expect(() => prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: "hi",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    }), "target", capability(["chat"]))).toThrow();

    const strictCompatible = decoded(prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: "hi",
      tools: [{
        type: "function",
        name: "strict_lookup",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        strict: true,
      }],
    }), "target", capability(["chat"])).bytes);
    expect(strictCompatible.tools).toMatchObject([{
      type: "function",
      function: { name: "strict_lookup", strict: true },
    }]);
  });

  it.each(["messages", "responses"] as const)(
    "accepts nullable Chat assistant refusal in a complete tool round for %s",
    (target) => {
      expect(() => prepareConvertedRequest("chat", target, body({
        model: "source",
        messages: [
          { role: "user", content: "Use the tool." },
          {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      }), "target", capability([target]))).not.toThrow();
    },
  );

  it("rejects a Chat sampling value outside the Messages target range", () => {
    expect(() => prepareConvertedRequest("chat", "messages", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      temperature: 1.5,
    }), "target", capability(["messages"]))).toThrow();
  });

  it("rejects conditional sampling and format fields when model support is unknown", () => {
    const base = capability(["responses"]);
    const unknown = {
      ...base,
      profile: {
        ...base.profile,
        supportedParameters: {
          value: null,
          source: "unknown" as const,
          conflict: false,
          liveState: "missing" as const,
        },
      },
    };
    expect(() => prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
    }), "target", unknown)).toThrow();
    expect(() => prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    }), "target", unknown)).toThrow();
  });

  it.each([
    ["chat", "responses", { model: "source", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }],
    ["messages", "chat", { model: "source", messages: [{ role: "user", content: "hi" }], max_tokens: 8, output_config: { effort: "high" } }],
  ] as const)("degrades unsupported optional reasoning for %s to %s", (source, target, request) => {
    const base = capability([target]);
    const unsupportedReasoning = {
      ...base,
      capabilities: { ...base.capabilities, reasoningProtocols: [] },
    };
    const converted = prepareConvertedRequest(source, target, body(request), "target", unsupportedReasoning);
    expect(converted.degradations).toContain("reasoning.presentation_omitted");
    expect(JSON.stringify(decoded(converted.bytes))).not.toContain("reasoning");
    expect(JSON.stringify(decoded(converted.bytes))).not.toContain("effort");
  });

  it("degrades an unsupported reasoning effort tier even when the target accepts the parameter", () => {
    const base = capability(["chat"]);
    const lowOnly = {
      ...base,
      capabilities: { ...base.capabilities, reasoningLevels: ["low"] as const },
    };
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      thinking: { type: "adaptive" },
    }), "target", lowOnly);
    expect(converted.degradations).toContain("reasoning.presentation_omitted");
    expect(decoded(converted.bytes)).not.toHaveProperty("reasoning_effort");
  });

  it("prefers a target that supports the requested reasoning level", () => {
    const base = capability(["chat", "messages"]);
    const plan = planProtocolExecution({
      source: "responses",
      body: body({
        model: "source",
        input: "hi",
        reasoning: { effort: "high" },
      }),
      stream: false,
      resolvedModel: "target",
      capability: {
        ...base,
        capabilities: {
          ...base.capabilities,
          reasoningLevels: ["high"],
          reasoningProtocols: ["messages"],
        },
      },
    });
    expect(plan).toMatchObject({ kind: "converted", target: "messages" });
    expect(plan.kind === "converted" ? decoded(plan.request.bytes) : null).toMatchObject({
      output_config: { effort: "high" },
    });
  });

  it.each([
    ["chat", "responses"],
    ["chat", "messages"],
    ["messages", "chat"],
    ["messages", "responses"],
    ["responses", "chat"],
    ["responses", "messages"],
  ] as const)("preserves max reasoning when converting %s to %s", (source, target) => {
    const converted = prepareConvertedRequest(
      source,
      target,
      reasoningRequest(source, "max"),
      "target",
      capability([target]),
    );
    expect(reasoningEffort(decoded(converted.bytes), target)).toBe("max");
    expect(converted.degradations).not.toContain("reasoning.budget_coarsened");
  });

  it("coarsens max to xhigh only when the converted target declares xhigh", () => {
    const base = capability(["chat"]);
    const xhighOnly = {
      ...base,
      capabilities: {
        ...base.capabilities,
        reasoningLevels: ["xhigh"] as const,
      },
    };
    const converted = prepareConvertedRequest(
      "responses",
      "chat",
      reasoningRequest("responses", "max"),
      "target",
      xhighOnly,
    );
    expect(decoded(converted.bytes)).toMatchObject({ reasoning_effort: "xhigh" });
    expect(converted.degradations).toContain("reasoning.budget_coarsened");
  });

  it("prefers a max-to-xhigh target over a target that would omit reasoning", () => {
    const base = capability(["chat", "messages"]);
    const xhighMessages = {
      ...base,
      capabilities: {
        ...base.capabilities,
        reasoningLevels: ["xhigh"] as const,
        reasoningProtocols: ["messages"] as const,
      },
    };
    const plan = planProtocolExecution({
      source: "responses",
      body: reasoningRequest("responses", "max"),
      stream: false,
      resolvedModel: "target",
      capability: xhighMessages,
    });
    expect(plan).toMatchObject({ kind: "converted", target: "messages" });
    expect(plan.kind === "converted" ? decoded(plan.request.bytes) : null).toMatchObject({
      output_config: { effort: "xhigh" },
    });
    expect(plan.kind === "converted" ? plan.request.degradations : []).toContain("reasoning.budget_coarsened");
  });

  it.each(["chat", "messages"] as const)(
    "strictly validates generated Responses reasoning items before converting to %s",
    (target) => {
      const converted = prepareConvertedRequest("responses", target, body({
        model: "source",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          {
            type: "reasoning",
            id: "rs_1",
            status: "completed",
            summary: [{ type: "summary_text", text: "visible plan" }],
            content: [{ type: "reasoning_text", text: "detail" }],
            encrypted_content: "opaque",
          },
        ],
      }), "target", capability([target]));
      expect(converted.degradations).toEqual(["request.option_omitted", "reasoning.state_omitted"]);
      for (const tolerated of [
        { type: "reasoning", summary: [{ type: "unknown", text: "plan" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan", unknown: true }] },
      ]) {
        expect(() => prepareConvertedRequest("responses", target, body({
          model: "source",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
            tolerated,
          ],
        }), "target", capability([target]))).not.toThrow();
      }
      for (const malformed of [
        { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: 1 }] },
        { type: "reasoning", summary: [], encrypted_content: {} },
      ]) {
        expect(() => prepareConvertedRequest("responses", target, body({
          model: "source",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
            malformed,
          ],
        }), "target", capability([target]))).toThrow();
      }
      const malformedStatus = prepareConvertedRequest("responses", target, body({
        model: "source",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          { type: "reasoning", status: "failed", summary: [] },
        ],
      }), "target", capability([target]));
      expect(malformedStatus.degradations).toContain("request.option_omitted");
    },
  );

  it("restores source-bound carrier state and rejects a changed visible projection", () => {
    const token = "ghcg-rsn-v1:messages_block:responses:01234567-89ab-4def-8123-456789abcdef";
    const record: ReasoningCarrierRecord = {
      token,
      sourceKind: "messages_block",
      state: "complete",
      payload: body({
        kind: "messages_block",
        state: { type: "thinking", thinking: "visible plan", signature: "provider-signature" },
      }),
      projection: body({ type: "reasoning", text: "visible plan" }),
      storedBytes: 1,
    };
    const input = body({
      model: "source",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use the tool." }],
      }, {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible plan" }],
        encrypted_content: token,
      }, {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      }, {
        type: "function_call_output",
        call_id: "call_1",
        output: "ok",
      }],
    });
    const plan = planProtocolExecution({
      source: "responses",
      body: input,
      stream: false,
      resolvedModel: "target",
      capability: capability(["messages"]),
      forcedTarget: "messages",
      carrierRecords: new Map([[token, record]]),
    });
    const converted = plan.kind === "converted" ? decoded(plan.request.bytes) : undefined;
    expect((converted?.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([
        { type: "thinking", thinking: "visible plan", signature: "provider-signature" },
      ]),
    });

    const changed = body({
      model: "source",
      input: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: "changed" }],
        encrypted_content: token,
      }],
    });
    expect(() => planProtocolExecution({
      source: "responses",
      body: changed,
      stream: false,
      resolvedModel: "target",
      capability: capability(["messages"]),
      forcedTarget: "messages",
      carrierRecords: new Map([[token, record]]),
    })).toThrow();
  });

  it("keeps the first conflicting Chat reasoning value and ignores nested extensions", () => {
    for (const [assistant, degradation] of [
      [{ role: "assistant", content: null, reasoning_text: "A", reasoning_content: "B" }, "reasoning.presentation_omitted"],
      [{ role: "assistant", content: null, reasoning: { text: "plan", unknown: true } }, "chat.extensions_omitted"],
      [{ role: "assistant", content: null, reasoning_details: [{ text: "plan", unknown: true }] }, "chat.extensions_omitted"],
      [{ role: "assistant", content: null, reasoning_details: [{ type: 17, text: "plan" }] }, "chat.extensions_omitted"],
      [{
        role: "assistant",
        content: null,
        thinking_blocks: [{ type: "thinking", thinking: "plan", unknown: true }],
      }, "chat.extensions_omitted"],
    ]) {
      const converted = prepareConvertedRequest("chat", "responses", body({
        model: "source",
        messages: [{ role: "user", content: "hi" }, assistant],
      }), "target", capability(["responses"]));
      expect(converted.degradations).toContain(degradation);
    }
  });

  it("rejects gateway carriers hidden in omitted reasoning members", () => {
    const carrier = "ghcg-rsn-v1:synthetic";
    expect(() => prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [{
        role: "assistant",
        content: null,
        reasoning: { text: "plan", unknown: carrier },
      }],
    }), "target", capability(["responses"]))).toThrow();
    expect(() => prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: "plan", unknown: carrier }],
      }],
    }), "target", capability(["chat"]))).toThrow();
  });

  it.each([
    {
      source: "messages" as const,
      target: "chat" as const,
      request: body({
        model: "source",
        max_tokens: 8,
        messages: [
          { role: "user", content: "keep" },
          { role: "future_role", content: "drop" },
        ],
      }),
      omitted: "future_role",
      degradation: "messages.extensions_omitted",
    },
    {
      source: "responses" as const,
      target: "chat" as const,
      request: body({
        model: "source",
        input: [
          { type: "message", role: "user", content: "keep" },
          { type: "message", role: "future_role", content: "drop" },
        ],
      }),
      omitted: "future_role",
      degradation: "responses.extensions_omitted",
    },
  ])("drops unknown $source message roles", ({ source, target, request, omitted, degradation }) => {
    const converted = prepareConvertedRequest(source, target, request, "target", capability([target]));
    expect(decoder.decode(converted.bytes)).not.toContain(omitted);
    expect(converted.degradations).toContain(degradation);
  });

  it("drops unknown Chat tool-call types and their orphaned results", () => {
    const converted = prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [
        { role: "user", content: "keep" },
        {
          role: "assistant",
          content: "keep",
          tool_calls: [{
            id: "call_1",
            type: "future_tool",
            function: { name: "lookup", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "drop" },
      ],
    }), "target", capability(["responses"]));
    expect(decoder.decode(converted.bytes)).not.toContain("call_1");
    expect(converted.degradations).toContain("chat.extensions_omitted");
    expect(converted.degradations).toContain("tools.history_omitted");
  });

  it.each(["chat", "responses"] as const)("omits unknown converted %s image detail", (source) => {
    const request = source === "chat"
      ? body({
        model: "source",
        messages: [{
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/image.png", detail: "future" } }],
        }],
      })
      : body({
        model: "source",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.test/image.png", detail: "future" }],
        }],
      });
    const target = source === "chat" ? "responses" : "chat";
    const converted = prepareConvertedRequest(source, target, request, "target", capability([target]));
    expect(decoder.decode(converted.bytes)).not.toContain("future");
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it.each([
    ["Chat tool", "chat", "responses", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      tools: [{ type: 17 }],
    }],
    ["Messages tool", "messages", "chat", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
      tools: [{ type: 17, name: "drop", input_schema: {} }],
    }],
    ["Responses tool", "responses", "chat", {
      model: "source",
      input: "keep",
      tools: [{ type: 17 }],
    }],
    ["Chat content", "chat", "responses", {
      model: "source",
      messages: [{ role: "user", content: [{ type: 17, text: "drop" }, { type: "text", text: "keep" }] }],
    }],
    ["Messages system", "messages", "chat", {
      model: "source",
      system: [{ type: 17, text: "drop" }],
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
    }],
    ["Messages content", "messages", "chat", {
      model: "source",
      messages: [{ role: "user", content: [{ type: 17, text: "drop" }, { type: "text", text: "keep" }] }],
      max_tokens: 8,
    }],
    ["Messages image source", "messages", "chat", {
      model: "source",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: 17, url: "https://example.test/drop" } },
          { type: "text", text: "keep" },
        ],
      }],
      max_tokens: 8,
    }],
    ["Responses content", "responses", "chat", {
      model: "source",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: 17, text: "drop" }, { type: "input_text", text: "keep" }],
      }],
    }],
    ["Responses input item", "responses", "chat", {
      model: "source",
      input: [
        { type: "message", role: "user", content: "keep" },
        { type: 17, extension: true },
      ],
    }],
  ] as const)("drops malformed %s discriminators", (_name, source, target, request) => {
    const converted = prepareConvertedRequest(source, target, body(request), "target", capability([target]));
    expect(converted.degradations.some((rule) => (
      rule === "request.option_omitted" || rule === `${source}.extensions_omitted`
    ))).toBe(true);
  });

  it("rejects gateway carriers hidden in ignored recognized duplicates", () => {
    expect(() => prepareConvertedRequest(
      "chat",
      "responses",
      rawBody(
        "{\"model\":\"source\",\"model\":\"ghcg-rsn-v1:synthetic\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
      ),
      "target",
      capability(["responses"]),
    )).toThrow();
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

  it.each([
    ["target", null, "max_tokens"],
    ["o3-mini", null, "max_completion_tokens"],
    ["o4-mini", null, "max_completion_tokens"],
    ["gpt-4o", null, "max_tokens"],
    ["target", "max_completion_tokens", "max_completion_tokens"],
    ["o3-mini", "max_tokens", "max_tokens"],
  ] as const)("uses the %s Chat token field declared as %s like cc-switch: %s", (modelId, declared, expected) => {
    const base = capability(["chat"]);
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: "hi",
      max_output_tokens: 9,
    }), modelId, {
      ...base,
      modelId,
      profile: {
        ...base.profile,
        chatOutputTokenField: declared === null
          ? { value: null, source: "unknown", conflict: false, liveState: "missing" }
          : { value: declared, source: "live", conflict: false, liveState: "value" },
      },
    });
    const sent = decoded(converted.bytes);
    expect(sent[expected]).toBe(9);
    expect(sent[expected === "max_tokens" ? "max_completion_tokens" : "max_tokens"]).toBeUndefined();
  });

  it("maps a Messages output budget to max_tokens for an undeclared Chat model", () => {
    const base = capability(["chat"]);
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }), "gemini-3.8-flash", {
      ...base,
      modelId: "gemini-3.8-flash",
      profile: {
        ...base.profile,
        chatOutputTokenField: { value: null, source: "unknown", conflict: false, liveState: "missing" },
      },
    });
    expect(decoded(converted.bytes)).toMatchObject({ model: "gemini-3.8-flash", max_tokens: 64 });
  });

  it.each(["chat", "messages"] as const)(
    "rejects a Responses tool result without required output before converting to %s",
    (target) => {
      expect(() => prepareConvertedRequest("responses", target, body({
        model: "source",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
          },
        ],
      }), "target", capability([target]))).toThrow();
    },
  );

  it.each([
    ["chat", { type: "url_citation", url: "https://example.test/source", title: "Source", start_index: 0, end_index: 6 }],
    ["chat", { type: "file_citation", file_id: "file_1", filename: "source.txt", index: 0 }],
    ["messages", { type: "url_citation", url: "https://example.test/source", title: "Source", start_index: 0, end_index: 6 }],
    ["messages", { type: "file_citation", file_id: "file_1", filename: "source.txt", index: 0 }],
  ] as const)("rejects cited Responses assistant history before converting to %s", (target, citation) => {
    const request = body({
      model: "source",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier", annotations: [] }] },
        {
          type: "message",
          id: "msg_cited",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "uncited" },
            { type: "output_text", text: "source", annotations: [citation] },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] },
      ],
    });
    expect(() => planProtocolExecution({
      source: "responses",
      body: request,
      stream: false,
      resolvedModel: "target",
      capability: capability([target]),
    })).toThrowError("unsupported_semantics");
  });

  it.each([
    ["chat", "commentary", "intermediate"],
    ["chat", "final_answer", [{ type: "output_text", text: "answer", annotations: [] }]],
    ["messages", "commentary", [{ type: "output_text", text: "intermediate", annotations: [] }]],
    ["messages", "final_answer", "answer"],
  ] as const)("rejects Responses assistant phase before converting to %s: %s", (target, phase, content) => {
    expect(() => planProtocolExecution({
      source: "responses",
      body: body({
        model: "source",
        input: [
          { type: "message", role: "user", content: "question" },
          { type: "message", role: "assistant", content: "earlier" },
          { type: "message", role: "assistant", phase, content },
          { type: "message", role: "user", content: "follow up" },
        ],
      }),
      stream: false,
      resolvedModel: "target",
      capability: capability([target]),
    })).toThrowError("unsupported_semantics");
  });

  it.each(["chat", "messages"] as const)(
    "accepts empty assistant citations and null or absent phase when converting Responses to %s",
    (target) => {
      const converted = prepareConvertedRequest("responses", target, body({
        model: "source",
        input: [
          { type: "message", role: "user", content: "question" },
          { type: "message", role: "assistant", phase: null, content: [{ type: "output_text", text: "first", annotations: [] }] },
          { type: "message", role: "user", content: "follow up" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "second" }] },
          { type: "message", role: "user", content: "next" },
        ],
      }), "target", capability([target]));
      expect(decoded(converted.bytes).messages).toEqual(target === "chat"
        ? [
          { role: "user", content: "question" },
          { role: "assistant", content: "first" },
          { role: "user", content: "follow up" },
          { role: "assistant", content: "second" },
          { role: "user", content: "next" },
        ]
        : [
          { role: "user", content: [{ type: "text", text: "question" }] },
          { role: "assistant", content: [{ type: "text", text: "first" }] },
          // The newest message and the second-newest user message carry cache breakpoints.
          { role: "user", content: [{ type: "text", text: "follow up", cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: [{ type: "text", text: "second" }] },
          { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
        ]);
      expect(converted.degradations).toEqual(["request.option_omitted"]);
    },
  );

  it("passes cited and phased assistant history through native Responses without conversion", () => {
    const request = body({
      model: "source",
      input: [
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{
            type: "output_text",
            text: "answer",
            annotations: [{
              type: "url_citation",
              url: "https://example.test/source",
              title: "Source",
              start_index: 0,
              end_index: 6,
            }],
          }],
        },
        { type: "message", role: "user", content: "follow up" },
      ],
    });
    expect(planProtocolExecution({
      source: "responses",
      body: request,
      stream: false,
      resolvedModel: "target",
      capability: capability(["responses", "chat"]),
    })).toMatchObject({ kind: "native", source: "responses", target: "responses" });
  });

  it("replays converter-emitted Responses message IDs and empty annotations through Messages", () => {
    const converted = prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        { type: "message", id: "msg_user", role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "message",
          id: "msg_assistant",
          status: "completed",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "answer",
            annotations: [],
          }],
        },
      ],
    }), "target", capability(["messages"]));
    expect(decoded(converted.bytes)).toMatchObject({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
    });
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

  it.each([
    ["bad explicit null", "{\"model\":\"x\",\"messages\":null}"],
    ["n greater than one", "{\"model\":\"x\",\"messages\":[],\"n\":2}"],
    ["missing tool name", "{\"model\":\"x\",\"messages\":[],\"tools\":[{\"type\":\"function\",\"function\":{\"parameters\":{}}}]}"],
    ["invalid complete arguments", "{\"model\":\"x\",\"messages\":[{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"x\",\"arguments\":\"{\"}}]}]}"],
  ])("rejects %s before producing target bytes", (_name, json) => {
    expect(() => prepareConvertedRequest(
      "chat",
      "responses",
      rawBody(json),
      "target",
      capability(["responses"]),
    )).toThrow();
  });

  it("keeps the first duplicate top-level field before producing target bytes", () => {
    const converted = prepareConvertedRequest(
      "chat",
      "responses",
      rawBody("{\"model\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\"first\"}],\"messages\":null}"),
      "target",
      capability(["responses"]),
    );
    expect(decoded(converted.bytes)).toMatchObject({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }],
    });
  });

  it("does not fall through a malformed first duplicate token limit", () => {
    const converted = prepareConvertedRequest(
      "chat",
      "responses",
      rawBody(
        "{\"model\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":\"bad\",\"max_tokens\":7}",
      ),
      "target",
      capability(["responses"]),
    );
    expect(decoded(converted.bytes)).not.toHaveProperty("max_output_tokens");
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it("omits an orphan Chat tool result as an incomplete history round", () => {
    const converted = prepareConvertedRequest(
      "chat",
      "responses",
      rawBody("{\"model\":\"x\",\"messages\":[{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"x\"}]}"),
      "target",
      capability(["responses"]),
    );
    expect((decoded(converted.bytes).input as unknown[])).toEqual([]);
    expect(converted.degradations).toContain("tools.history_omitted");
  });

  it.each(["chat", "responses"] as const)("omits ordinary %s extensions while retaining strict core fields", (source) => {
    const request = source === "chat"
      ? rawBody("{\"model\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\",\"extension\":1,\"extension\":2}],\"extension\":3,\"extension\":4}")
      : rawBody("{\"model\":\"x\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":\"hi\",\"extension\":1,\"extension\":2}],\"extension\":3,\"extension\":4}");
    const target = source === "chat" ? "responses" : "chat";
    const converted = prepareConvertedRequest(source, target, request, "target", capability([target]));
    expect(converted.degradations).toContain(`${source}.extensions_omitted`);
  });

  it.each(["chat", "responses"] as const)("omits malformed independent %s presentation options", (source) => {
    const request = source === "chat"
      ? body({ model: "x", messages: [{ role: "user", content: "hi" }], stream_options: 17, metadata: { user: 17 } })
      : body({
        model: "x",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi", annotations: 17 }],
        }],
        stream_options: 17,
        metadata: { user: 17 },
        reasoning: { summary: 17 },
      });
    const target = source === "chat" ? "responses" : "chat";
    const converted = prepareConvertedRequest(source, target, request, "target", capability([target]));
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it.each(["chat", "responses"] as const)("omits malformed converted %s choice counts", (source) => {
    const request = source === "chat"
      ? body({ model: "x", messages: [{ role: "user", content: "hi" }], n: 0 })
      : body({ model: "x", input: "hi", n: "bad" });
    const target = source === "chat" ? "responses" : "chat";
    const converted = prepareConvertedRequest(source, target, request, "target", capability([target]));
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it.each([
    ["Messages output config", "messages", "chat", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      output_config: 17,
    }],
    ["Responses reasoning config", "responses", "chat", {
      model: "x",
      input: "hi",
      reasoning: 17,
    }],
    ["Messages system", "messages", "chat", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      system: 17,
    }],
    ["Chat tools", "chat", "responses", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: 17,
    }],
    ["Messages tools", "messages", "chat", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      tools: 17,
    }],
    ["Responses tools", "responses", "chat", {
      model: "x",
      input: "hi",
      tools: 17,
    }],
    ["Chat tool choice", "chat", "responses", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: 17,
    }],
    ["Messages tool choice", "messages", "chat", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      tool_choice: 17,
    }],
    ["Responses tool choice", "responses", "chat", {
      model: "x",
      input: "hi",
      tool_choice: 17,
    }],
    ["Chat tool-choice discriminator", "chat", "responses", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: 17 },
    }],
    ["Messages tool-choice discriminator", "messages", "chat", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      tool_choice: { type: 17 },
    }],
    ["Responses tool-choice discriminator", "responses", "chat", {
      model: "x",
      input: "hi",
      tool_choice: { type: 17 },
    }],
    ["Responses instructions", "responses", "chat", {
      model: "x",
      input: "hi",
      instructions: { bad: true },
    }],
    ["Responses text", "responses", "chat", {
      model: "x",
      input: "hi",
      text: 17,
    }],
  ] as const)("omits malformed optional %s containers", (_name, source, target, request) => {
    const converted = prepareConvertedRequest(source, target, body(request), "target", capability([target]));
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it.each([
    ["chat", "messages", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "future",
    }],
    ["messages", "chat", {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      output_config: { effort: "future" },
    }],
    ["responses", "chat", {
      model: "x",
      input: "hi",
      reasoning: { effort: "future" },
    }],
  ] as const)("omits unknown converted %s reasoning effort", (source, target, request) => {
    const converted = prepareConvertedRequest(source, target, body(request), "target", capability([target]));
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it("preserves opaque metadata and duplicate tool-argument members", () => {
    const metadata = decoded(prepareConvertedRequest("chat", "responses", rawBody(
      "{\"model\":\"x\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"metadata\":{\"nested\":{\"enabled\":true},\"tag\":\"first\",\"tag\":\"second\"}}",
    ), "target", capability(["responses"])).bytes);
    expect(metadata.metadata).toEqual({ nested: { enabled: true }, tag: "first" });

    const argumentsBody = decoded(prepareConvertedRequest("chat", "responses", body({
      model: "x",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"x\":1,\"x\":2}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    }), "target", capability(["responses"])).bytes);
    expect(argumentsBody.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", arguments: "{\"x\":1,\"x\":2}" }),
    ]));
  });

  it("drops unknown content and hosted-tool discriminators but rejects direct continuation conversion", () => {
    for (const request of [
      body({ model: "x", input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }),
      body({ model: "x", input: [{ type: "message", role: "user", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] }] }),
      body({ model: "x", input: "hi", tools: [{ type: "web_search_preview" }] }),
    ]) {
      const converted = prepareConvertedRequest("responses", "chat", request, "target", capability(["chat"]));
      expect(converted.degradations).toContain("responses.extensions_omitted");
    }
    expect(() => prepareConvertedRequest(
      "responses",
      "chat",
      body({ model: "x", previous_response_id: "resp_external", input: "hi" }),
      "target",
      capability(["chat"]),
    )).toThrow();
  });

  it("rejects recognized unrepresentable controls instead of treating them as extensions", () => {
    for (const extra of [
      { modalities: ["audio"] },
      { conversation: "conv_1" },
      { truncation: "auto" },
      { service_tier: "priority" },
      { logprobs: true },
    ]) {
      expect(() => prepareConvertedRequest(
        "responses",
        "chat",
        body({ model: "x", input: "hi", ...extra }),
        "target",
        capability(["chat"]),
      )).toThrow();
    }
  });

  it("rejects a gateway carrier in the non-authorized top-level Responses reasoning state slot", () => {
    expect(() => prepareConvertedRequest("responses", "chat", body({
      model: "x",
      input: "hi",
      reasoning: { encrypted_content: "ghcg-rsn-v1:synthetic" },
    }), "target", capability(["chat"]))).toThrow();
  });

  it("omits a false parallel control when the target cannot parallelize", () => {
    const base = capability(["chat"]);
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "x",
      input: "hi",
      tools: [{ type: "function", name: "lookup", parameters: {}, strict: false }],
      parallel_tool_calls: false,
    }), "target", {
      ...base,
      capabilities: { ...base.capabilities, parallelToolCalling: false },
    });
    expect(decoded(converted.bytes)).not.toHaveProperty("parallel_tool_calls");
    expect(converted.degradations).toContain("tools.parallel_control_omitted");
  });

  it("omits ordinary nested extensions in the Responses extended-tool adapter", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: [
        {
          type: "custom_tool_call",
          id: 17,
          status: "unknown",
          call_id: "call_custom",
          name: "render",
          input: "draw",
          extension: true,
        },
        {
          type: "custom_tool_call_output",
          id: 17,
          status: "unknown",
          call_id: "call_custom",
          output: "done",
          extension: true,
        },
      ],
      stream_options: 17,
      text: 17,
      tools: [{ type: "custom", name: "render", format: { type: "text", extension: true }, extension: true }],
      tool_choice: { type: "future", name: "render" },
    }), "target", capability(["chat"]));
    expect(converted.degradations).toContain("responses.extensions_omitted");
    expect(converted.degradations).toContain("request.option_omitted");
    expect(decoder.decode(converted.bytes)).not.toContain("\"extension\"");
    expect(decoder.decode(converted.bytes)).not.toContain("\"id\":17");
    expect(decoder.decode(converted.bytes)).not.toContain("\"status\":\"unknown\"");
    expect(decoder.decode(converted.bytes)).not.toContain("stream_options");
    expect(decoder.decode(converted.bytes)).not.toContain("\"text\":17");
    expect(decoder.decode(converted.bytes)).not.toContain("tool_choice");
  });

  it("omits extended-tool rounds whose declaration discriminator is unknown", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: [
        { type: "custom_tool_call", call_id: "call_omitted", name: "render", input: "draw" },
        { type: "custom_tool_call_output", call_id: "call_omitted", output: "done" },
      ],
      tools: [{ type: "future_custom", name: "render" }],
    }), "target", capability(["chat"]));
    expect(decoder.decode(converted.bytes)).not.toContain("call_omitted");
    expect(converted.degradations).toContain("responses.extensions_omitted");
    expect(converted.degradations).toContain("tools.history_omitted");
  });

  it("omits malformed extended-tool format and execution options", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      response_format: { type: 17 },
      input: [
        {
          type: "tool_search_call",
          call_id: "call_search",
          arguments: { query: "docs" },
          execution: 17,
        },
        { type: "tool_search_output", call_id: "call_search", tools: [] },
      ],
      tools: [{ type: "tool_search" }],
    }), "target", capability(["chat"]));
    expect(decoder.decode(converted.bytes)).not.toContain("execution");
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it("omits a malformed optional extended function-call namespace", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: [
        {
          type: "function_call",
          call_id: "call_lookup",
          name: "lookup",
          namespace: 17,
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_lookup", output: "done" },
      ],
      tools: [{ type: "function", name: "lookup", parameters: {} }],
    }), "target", capability(["chat"]));
    expect(decoder.decode(converted.bytes)).not.toContain("namespace");
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it.each(["chat", "responses"] as const)("rejects a carrier hidden in an omitted %s extension", (source) => {
    const request = source === "chat"
      ? body({ model: "x", messages: [{ role: "user", content: "hi" }], extension: "ghcg-rsn-v1:synthetic" })
      : body({ model: "x", input: "hi", extension: { encrypted_content: "ghcg-rsn-v1:synthetic" } });
    const target = source === "chat" ? "responses" : "chat";
    expect(() => prepareConvertedRequest(source, target, request, "target", capability([target]))).toThrow();
  });

  it("rejects a carrier hidden in a malformed optional scalar", () => {
    expect(() => prepareConvertedRequest("chat", "responses", body({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      temperature: { extension: "ghcg-rsn-v1:synthetic" },
    }), "target", capability(["responses"]))).toThrow();
  });

  it("rejects a carrier hidden in an omitted Responses tool declaration", () => {
    expect(() => prepareConvertedRequest("responses", "chat", body({
      model: "x",
      input: "hi",
      tools: ["ghcg-rsn-v1:synthetic"],
    }), "target", capability(["chat"]))).toThrow();
  });

  it.each([
    ["metadata", { metadata: { user: "ghcg-rsn-v1:synthetic" } }],
    ["stream options", { stream_options: { extension: "ghcg-rsn-v1:synthetic" } }],
    ["reasoning summary", { reasoning: { summary: "ghcg-rsn-v1:synthetic" } }],
    ["message ID", { input: [{ type: "message", id: "ghcg-rsn-v1:synthetic", role: "user", content: "hi" }] }],
    ["annotations", { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi", annotations: ["ghcg-rsn-v1:synthetic"] }] }] }],
    ["nested extended ID", {
      input: [
        { type: "custom_tool_call", id: { value: "ghcg-rsn-v1:synthetic" }, call_id: "call_1", name: "render", input: "x" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "ok" },
      ],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    }],
  ] as const)("rejects a carrier hidden in recognized Responses %s", (_name, extra) => {
    expect(() => prepareConvertedRequest("responses", "chat", body({
      model: "x",
      input: "hi",
      ...extra,
    }), "target", capability(["chat"]))).toThrow();
  });

  it("rejects non-client or carrier-bearing tool-search execution controls", () => {
    for (const execution of ["server", { value: "ghcg-rsn-v1:synthetic" }]) {
      expect(() => prepareConvertedRequest("responses", "chat", body({
        model: "source",
        input: [{ type: "tool_search_call", call_id: "call_1", arguments: { query: "docs" }, execution }],
        tools: [{ type: "tool_search" }],
      }), "target", capability(["chat"]))).toThrow();
    }
  });

  it.each(["chat", "responses"] as const)("rejects empty assistant-only %s input instead of synthesizing", (source) => {
    const request = source === "chat"
      ? body({ model: "source", messages: [{ role: "assistant", content: "" }] })
      : body({ model: "source", input: [{ type: "message", role: "assistant", content: [] }] });
    expect(() => prepareConvertedRequest(source, "messages", request, "target", capability(["messages"]))).toThrow();
  });

  it("sanitizes discovered tool extensions before embedding tool-search output in Chat", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: [
        { type: "tool_search_call", call_id: "search_1", arguments: { query: "docs" } },
        {
          type: "tool_search_output",
          call_id: "search_1",
          tools: [{ type: "function", name: "lookup", parameters: {}, strict: false, extension: true }],
        },
      ],
      tools: [{ type: "tool_search" }],
    }), "target", capability(["chat"]));
    expect(decoder.decode(converted.bytes)).not.toContain("\"extension\"");
    expect(converted.degradations).toContain("responses.extensions_omitted");
  });

  it.each([
    ["malformed cache control", {
      model: "source",
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: 17 }] }],
      max_tokens: 8,
    }, "request.option_omitted"],
    ["malformed Messages metadata", {
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      metadata: { user_id: 17 },
    }, "request.option_omitted"],
    ["unknown Responses reasoning item key", {
      model: "source",
      input: [
        { type: "message", role: "user", content: "keep" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], unknown: null },
      ],
    }, "responses.extensions_omitted"],
  ] as const)("omits malformed optional nested protocol shape: %s", (_name, request, degradation) => {
    const source = "input" in request ? "responses" : "messages";
    const converted = prepareConvertedRequest(
      source,
      source === "messages" ? "chat" : "messages",
      body(request),
      "target",
      capability([source === "messages" ? "chat" : "messages"]),
    );
    expect(converted.degradations).toContain(degradation);
  });

  it.each([
    ["Messages system block", "messages", "chat", {
      model: "source",
      system: [{ type: "future_system", text: "drop" }],
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
    }, "messages.extensions_omitted"],
    ["Messages image source", "messages", "chat", {
      model: "source",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "keep" },
          { type: "image", source: { type: "future_image", url: "https://example.test/drop" } },
        ],
      }],
      max_tokens: 8,
    }, "messages.extensions_omitted"],
    ["Messages tool-result content", "messages", "chat", {
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "future_result" }] }],
        },
      ],
      max_tokens: 8,
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    }, "messages.extensions_omitted"],
    ["Chat output format", "chat", "responses", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      response_format: { type: "future_format" },
    }, "chat.extensions_omitted"],
    ["Messages output format", "messages", "chat", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
      output_config: { format: { type: "future_format" } },
    }, "messages.extensions_omitted"],
    ["Responses output format", "responses", "chat", {
      model: "source",
      input: "keep",
      text: { format: { type: "future_format" } },
    }, "responses.extensions_omitted"],
    ["Messages thinking", "messages", "chat", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
      thinking: { type: "future_thinking" },
    }, "messages.extensions_omitted"],
    ["malformed Chat output format", "chat", "responses", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      response_format: { type: 17 },
    }, "request.option_omitted"],
    ["malformed Messages output format", "messages", "chat", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
      output_config: { format: { type: 17 } },
    }, "request.option_omitted"],
    ["malformed Responses output format", "responses", "chat", {
      model: "source",
      input: "keep",
      text: { format: { type: 17 } },
    }, "request.option_omitted"],
    ["malformed Messages thinking", "messages", "chat", {
      model: "source",
      messages: [{ role: "user", content: "keep" }],
      max_tokens: 8,
      thinking: { type: 17 },
    }, "request.option_omitted"],
  ] as const)("drops unknown %s discriminator", (_name, source, target, request, degradation) => {
    const converted = prepareConvertedRequest(source, target, body(request), "target", capability([target]));
    expect(converted.degradations).toContain(degradation);
  });

  it("omits malformed Responses text.format before checking response_format conflicts", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: "keep",
      text: { format: { type: 17 } },
      response_format: { type: "json_object" },
    }), "target", capability(["chat"]));
    expect(decoded(converted.bytes)).toMatchObject({ response_format: { type: "json_object" } });
    expect(converted.degradations).toContain("request.option_omitted");
  });

  it.each(["image", "input_image"] as const)("ignores an ordinary nested Messages %s tool-result extension", (type) => {
    const image = type === "image"
      ? { type, source: { type: "base64", media_type: "image/png", data: "QUJD" }, optional_extension: null }
      : { type, image_url: "https://example.com/image.png", optional_extension: null };
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [image],
          }],
        },
      ],
      max_tokens: 8,
    }), "target", capability(["chat"]));
    expect(converted.degradations).toContain("messages.extensions_omitted");
  });

  it.each([
    ["Messages", "messages", {
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [null, { type: "text", text: "ok" }],
          }],
        },
      ],
      max_tokens: 8,
    }],
    ["Responses", "responses", {
      model: "source",
      input: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [null, { type: "input_text", text: "ok" }],
        },
      ],
    }],
  ] as const)("drops malformed %s tool-result array items", (_name, source, request) => {
    const converted = prepareConvertedRequest(source, "chat", body(request), "target", capability(["chat"]));
    expect(converted.degradations).toContain(`${source}.extensions_omitted`);
    expect(JSON.stringify(decoded(converted.bytes))).toContain("ok");
  });

  it("omits an unclosed Responses tool round before converting to Messages", () => {
    const converted = prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "unrelated" }] },
      ],
    }), "target", capability(["messages"]));
    expect(decoded(converted.bytes)).toMatchObject({
      messages: [{ role: "user", content: [
        { type: "text", text: "hi" },
        { type: "text", text: "unrelated" },
      ] }],
    });
    expect(converted.degradations).toContain("tools.history_omitted");
  });

  it("synthesizes one fixed leading Messages user for assistant-first Chat and Responses histories", () => {
    const chat = prepareConvertedRequest("chat", "messages", body({
      model: "source",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    }), "target", capability(["messages"]));

    const responses = prepareConvertedRequest("responses", "messages", body({
      model: "source",
      instructions: "system context is not a user turn",
      input: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    }), "target", capability(["messages"]));

    for (const converted of [chat, responses]) {
      expect((decoded(converted.bytes).messages as unknown[])[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "(continuing the conversation)" }],
      });
      expect(converted.degradations).toContain("messages.leading_user_synthesized");
    }
  });

  it.each(["", []] as const)(
    "synthesizes before empty leading Chat user context and Messages tools: %j",
    (content) => {
      const converted = prepareConvertedRequest("chat", "messages", body({
        model: "source",
        messages: [
          { role: "user", content },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      }), "target", capability(["messages"]));
      expect((decoded(converted.bytes).messages as unknown[])[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "(continuing the conversation)" }],
      });
    },
  );

  it.each(["chat", "responses"] as const)("does not synthesize a Messages turn for empty %s input alone", (source) => {
    const request = source === "chat"
      ? body({ model: "source", messages: [{ role: "user", content: "" }] })
      : body({ model: "source", input: [{ type: "message", role: "user", content: [] }] });
    expect(() => prepareConvertedRequest(source, "messages", request, "target", capability(["messages"]))).toThrow();
  });

  it("synthesizes before an empty leading Responses user message and Messages tools", () => {
    const converted = prepareConvertedRequest("responses", "messages", body({
      model: "source",
      instructions: "system instructions are not a user turn",
      input: [
        { type: "message", role: "user", content: [] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    }), "target", capability(["messages"]));
    expect((decoded(converted.bytes).messages as unknown[])[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "(continuing the conversation)" }],
    });
  });

  it("rejects developer authority promotion on Chat and Responses to Messages conversions", () => {
    expect(() => prepareConvertedRequest("chat", "messages", body({
      model: "source",
      messages: [
        { role: "system", content: "system rule" },
        { role: "developer", content: "developer rule" },
        { role: "user", content: "question" },
      ],
    }), "target", capability(["messages"]))).toThrow();

    expect(() => prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "system rule" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "developer rule" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
      ],
    }), "target", capability(["messages"]))).toThrow();
  });

  it.each(["chat", "messages"] as const)(
    "omits a new tool round before every prior parallel call has a result for %s",
    (target) => {
      const prepare = () => prepareConvertedRequest("responses", target, body({
        model: "source",
        input: [
          { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" },
          { type: "function_call", call_id: "call_b", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_a", output: "a" },
          { type: "function_call", call_id: "call_c", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_b", output: "b" },
          { type: "function_call_output", call_id: "call_c", output: "c" },
        ],
      }), "target", capability([target]));
      if (target === "messages") {
        expect(prepare).toThrow();
      } else {
        expect(prepare().degradations).toContain("tools.history_omitted");
      }
    },
  );

  it("omits a partial parallel Chat tool round while preserving unrelated assistant content", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: [
        { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" },
        { type: "function_call", call_id: "call_b", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_a", output: "a" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "next" }],
        },
        { type: "function_call_output", call_id: "call_b", output: "b" },
      ],
    }), "target", capability(["chat"]));
    expect(decoded(converted.bytes)).toMatchObject({
      messages: [{ role: "assistant", content: "next" }],
    });
    expect(converted.degradations).toContain("tools.history_omitted");
  });

  it.each([
    ["tools", { capabilities: { toolCalling: false } }],
    ["parallel tools", { capabilities: { parallelToolCalling: false } }],
    ["images", { capabilities: { inputModalities: ["text"] as const } }],
  ] as const)("rejects converted target without %s capability", (_name, override) => {
    const base = capability(["chat"]);
    const target = {
      ...base,
      capabilities: { ...base.capabilities, ...override.capabilities },
    };
    const request = _name === "images"
      ? body({ model: "source", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] }] })
      : body({
        model: "source",
        input: "hi",
        tools: [{ type: "function", name: "lookup", parameters: {} }],
        ...(_name === "parallel tools" ? { parallel_tool_calls: true } : {}),
      });
    expect(() => prepareConvertedRequest("responses", "chat", request, "target", target)).toThrow();
  });

  it("preserves a valid Messages text/tool/text round followed by its bound result", () => {
    const request = body({
      model: "source",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            { type: "tool_use", id: "call_1", name: "lookup", input: {} },
            { type: "text", text: "after" },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
        },
      ],
      max_tokens: 8,
    });
    const converted = prepareConvertedRequest("messages", "responses", request, "target", capability(["responses"]));
    expect(decoded(converted.bytes)).toMatchObject({
      input: [
        { type: "message", role: "assistant", content: [{ text: "before" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "message", role: "assistant", content: [{ text: "after" }] },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });
    expect(() => prepareConvertedRequest(
      "messages",
      "chat",
      request,
      "target",
      capability(["chat"]),
    )).toThrow();
    expect(planProtocolExecution({
      source: "messages",
      body: request,
      stream: false,
      resolvedModel: "target",
      capability: capability(["chat", "responses"]),
    })).toMatchObject({ kind: "converted", target: "responses" });
  });

  it("preserves Messages tool errors with explicit compatible markers", () => {
    const request = {
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "failed", is_error: true }],
        },
      ],
      max_tokens: 8,
    };
    const responses = decoded(prepareConvertedRequest(
      "messages",
      "responses",
      body(request),
      "target",
      capability(["responses"]),
    ).bytes);
    expect(responses).toMatchObject({
      input: [{
        type: "function_call",
      }, {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "[ghc-gateway:tool-result-error]" },
          { type: "input_text", text: "failed" },
        ],
      }],
    });
    const chat = JSON.stringify(decoded(prepareConvertedRequest(
      "messages",
      "chat",
      body(request),
      "target",
      capability(["chat"]),
    ).bytes));
    expect(chat).toContain("[ghc-gateway:tool-result-error]");
  });

  it("extracts nested JSON-encoded Responses tool-result images on the approved content path", () => {
    const converted = decoded(prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use the tool." }],
        },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: {
            content: JSON.stringify({
              type: "input_image",
              image_url: "data:image/png;base64,QUJD",
            }),
          },
        },
      ],
    }), "target", capability(["messages"])).bytes);
    expect(converted.messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Use the tool." }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1" }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
        }],
      },
    ]);
  });

  it("omits unknown fields in nested JSON-encoded tool-result media", () => {
    const converted = prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use the tool." }],
        },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: {
            content: JSON.stringify({
              type: "input_image",
              image_url: "data:image/png;base64,QUJD",
              unsupported_core_constraint: null,
            }),
          },
        },
      ],
    }), "target", capability(["messages"]));
    expect(converted.degradations).toContain("responses.extensions_omitted");
    expect(decoder.decode(converted.bytes)).not.toContain("unsupported_core_constraint");
  });

  it("extracts a nested approved whole-string tool-result image data URL", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(8192)}`;
    const converted = decoded(prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use the tool." }],
        },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: { content: dataUrl },
        },
      ],
    }), "target", capability(["messages"])).bytes);
    expect(converted.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Use the tool." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1" }] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text" },
            { type: "image", source: { type: "base64", media_type: "image/png" } },
          ],
        }],
      },
    ]);
  });

  it("extracts nested JSON-encoded Chat image_url tool-result media", () => {
    const converted = decoded(prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: JSON.stringify({
              content: [{
                type: "image_url",
                image_url: { url: "data:image/png;base64,QUJD" },
              }],
            }),
          }],
        },
      ],
      max_tokens: 8,
    }), "target", capability(["chat"])).bytes);
    expect(converted.messages).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1" },
      {
        role: "user",
        content: [
          { type: "text" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      },
    ]);
  });

  it("keeps shallow media extraction independent of unrelated deep business data", () => {
    let business: unknown = "leaf";
    for (let depth = 0; depth < 70; depth += 1) {
      business = { next: business };
    }
    const converted = decoded(prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: JSON.stringify({
              business,
              content: [{
                type: "image_url",
                image_url: { url: "data:image/png;base64,QUJD" },
              }],
            }),
          }],
        },
      ],
      max_tokens: 8,
    }), "target", capability(["chat"])).bytes);
    expect(JSON.stringify(converted)).toContain("data:image/png;base64,QUJD");
  });

  it("coarsens minimal reasoning to a supported Messages effort", () => {
    const converted = prepareConvertedRequest("chat", "messages", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "minimal",
    }), "target", capability(["messages"]));
    expect(decoded(converted.bytes)).toMatchObject({
      output_config: { effort: "low" },
    });
    expect(converted.degradations).toContain("reasoning.budget_coarsened");
  });

  it("preserves explicit OpenAI reasoning disablement and maps it to no Messages reasoning", () => {
    const chatToResponses = decoded(prepareConvertedRequest("chat", "responses", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    }), "target", capability(["responses"])).bytes);
    expect(chatToResponses).toMatchObject({ reasoning: { effort: "none" } });

    const chatToMessages = decoded(prepareConvertedRequest("chat", "messages", body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    }), "target", capability(["messages"])).bytes);
    expect(chatToMessages.output_config).toBeUndefined();

    const responsesToChat = decoded(prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: "hi",
      reasoning: { effort: "none" },
    }), "target", capability(["chat"])).bytes);
    expect(responsesToChat).toMatchObject({ reasoning_effort: "none" });

    const responsesToMessages = decoded(prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: "hi",
      reasoning: { effort: "none" },
    }), "target", capability(["messages"])).bytes);
    expect(responsesToMessages.output_config).toBeUndefined();
  });

  it.each(["chat", "responses"] as const)(
    "uses explicit Messages effort over adaptive thinking for %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }), "target", capability([target]));
      const request = decoded(converted.bytes);
      if (target === "chat") {
        expect(request).toMatchObject({ reasoning_effort: "high" });
      } else {
        expect(request).toMatchObject({ reasoning: { effort: "high" } });
      }
      expect(converted.degradations).toContain("reasoning.budget_coarsened");
    },
  );

  it.each(["chat", "responses"] as const)(
    "uses explicit Messages effort over enabled thinking budget fallback for %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8192,
        thinking: { type: "enabled", budget_tokens: 4096 },
        output_config: { effort: "high" },
      }), "target", capability([target]));
      const request = decoded(converted.bytes);
      if (target === "chat") {
        expect(request).toMatchObject({ reasoning_effort: "high" });
      } else {
        expect(request).toMatchObject({ reasoning: { effort: "high" } });
      }
      expect(converted.degradations).toContain("reasoning.budget_coarsened");
    },
  );

  it("extracts documented JSON-encoded content media without scanning unrelated business keys", () => {
    const embedded = JSON.stringify({
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      }],
      business: { image: "not protocol media" },
    });
    const converted = prepareConvertedRequest("messages", "chat", body({
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: embedded }],
        },
      ],
      max_tokens: 8,
    }), "target", capability(["chat"]));
    const output = JSON.stringify(decoded(converted.bytes));
    expect(output).toContain("image_url");
    expect(output).toContain("not protocol media");
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

  it("encodes a custom Responses tool directly as the final Chat request and captures restoration bindings", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      input: "render",
      max_output_tokens: 7,
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      tool_choice: { type: "custom", name: "render" },
    }), "target", capability(["chat"]));

    const expected = {
      model: "target",
      messages: [{ role: "user", content: "render" }],
      tools: [{
        type: "function",
        function: {
          name: "render",
          description: "Original tool definition:\n```json\n{\"format\":{\"type\":\"text\"},\"name\":\"render\",\"type\":\"custom\"}\n```",
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.",
              },
            },
            required: ["input"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "render" } },
      max_tokens: 7,
    };
    expect(decoded(converted.bytes)).toEqual(expected);
    expect(decoder.decode(converted.bytes)).toBe(JSON.stringify(expected));
    expect(converted.responseBindings).toEqual({
      kind: "responses_extended_tools",
      bindings: [{ kind: "custom", chatName: "render", sourceName: "render" }],
      calls: [],
      results: [],
      chatMessages: [{
        kind: "object",
        members: [
          { key: "role", value: "user" },
          { key: "content", value: "render" },
        ],
      }],
      chatPrefixMembers: [],
    });
  });

  it("captures immutable custom call and result identity for buffered restoration", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      input: [
        {
          type: "custom_tool_call",
          id: "ct_item",
          call_id: "call_custom",
          name: "render",
          input: "raw input",
          status: "completed",
        },
        {
          type: "custom_tool_call_output",
          id: "ct_result",
          call_id: "call_custom",
          output: "done",
          status: "failed",
        },
      ],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    }), "target", capability(["chat"]));

    expect(converted.responseBindings).toMatchObject({
      calls: [{
        kind: "custom",
        chatName: "render",
        sourceName: "render",
        itemId: "ct_item",
        callId: "call_custom",
        status: "completed",
        rawCustomInput: "raw input",
      }],
      results: [{
        kind: "custom",
        itemId: "ct_result",
        callId: "call_custom",
        status: "failed",
      }],
    });
    expect(Object.isFrozen(converted.responseBindings)).toBe(true);
    expect(Object.isFrozen(converted.responseBindings?.calls)).toBe(true);
  });

  it("fails closed when namespace projection collides with a flat tool name", () => {
    expect(() => prepareConvertedRequest("responses", "chat", body({
      input: "collision",
      tools: [
        { type: "function", name: "ns__lookup", parameters: { type: "object" }, strict: false },
        {
          type: "namespace",
          name: "ns",
          tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: false }],
        },
      ],
    }), "target", capability(["chat"]))).toThrow();
  });

  it("preserves accepted Responses reasoning and multipart ordering in exact extended Chat bytes", () => {
    const converted = prepareConvertedRequest("responses", "chat", body({
      model: "source",
      instructions: "top",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "inline" }] },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "first" },
            { type: "input_image", image_url: "https://example.test/a.png", detail: "high" },
            { type: "input_text", text: "second" },
          ],
        },
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
        { type: "custom_tool_call", call_id: "call_custom", name: "render", input: "raw" },
        { type: "tool_search_call", call_id: "call_search", arguments: { query: "docs" } },
        { type: "custom_tool_call_output", call_id: "call_custom", output: "done" },
        { type: "tool_search_output", call_id: "call_search", tools: [] },
      ],
      tools: [
        { type: "custom", name: "render", format: { type: "text" } },
        { type: "tool_search" },
      ],
    }), "target", capability(["chat"]));

    expect(decoder.decode(converted.bytes)).toBe("{\"model\":\"target\",\"messages\":[{\"role\":\"system\",\"content\":\"top\\n\\ninline\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://example.test/a.png\"}},{\"type\":\"text\",\"text\":\"second\"}]},{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_custom\",\"type\":\"function\",\"function\":{\"name\":\"render\",\"arguments\":\"{\\\"input\\\":\\\"raw\\\"}\"}},{\"id\":\"call_search\",\"type\":\"function\",\"function\":{\"name\":\"tool_search\",\"arguments\":\"{\\\"query\\\":\\\"docs\\\"}\"}}],\"reasoning_content\":\"plan\"},{\"role\":\"tool\",\"tool_call_id\":\"call_custom\",\"content\":\"{\\\"call_id\\\":\\\"call_custom\\\",\\\"output\\\":\\\"done\\\",\\\"type\\\":\\\"custom_tool_call_output\\\"}\"},{\"role\":\"tool\",\"tool_call_id\":\"call_search\",\"content\":\"{\\\"call_id\\\":\\\"call_search\\\",\\\"tools\\\":[],\\\"type\\\":\\\"tool_search_output\\\"}\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"render\",\"description\":\"Original tool definition:\\n```json\\n{\\\"format\\\":{\\\"type\\\":\\\"text\\\"},\\\"name\\\":\\\"render\\\",\\\"type\\\":\\\"custom\\\"}\\n```\",\"parameters\":{\"type\":\"object\",\"properties\":{\"input\":{\"type\":\"string\",\"description\":\"Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.\"}},\"required\":[\"input\"]}}},{\"type\":\"function\",\"function\":{\"name\":\"tool_search\",\"description\":\"Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"Search query for tools or connectors to load.\"},\"limit\":{\"type\":\"integer\",\"description\":\"Maximum number of tool groups to return.\"}},\"required\":[\"query\"]}}}]}");
  });
});

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

function reasoningRequest(
  source: "chat" | "messages" | "responses",
  effort: string,
): WireJsonObject {
  if (source === "chat") {
    return body({ model: "source", messages: [{ role: "user", content: "hi" }], reasoning_effort: effort });
  }
  if (source === "messages") {
    return body({
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      output_config: { effort },
    });
  }
  return body({ model: "source", input: "hi", reasoning: { effort } });
}

function reasoningEffort(
  request: Record<string, unknown>,
  target: "chat" | "messages" | "responses",
): unknown {
  if (target === "chat") return request.reasoning_effort;
  if (target === "messages") return (request.output_config as Record<string, unknown> | undefined)?.effort;
  return (request.reasoning as Record<string, unknown> | undefined)?.effort;
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
