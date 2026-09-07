import { describe, expect, it } from "vitest";
import type { EffectiveModelCapabilitySnapshot } from "../../src/copilot/capability_registry.js";
import { planProtocolExecution, prepareConvertedRequest } from "../../src/protocols/conversion/planner.js";
import {
  isWireJsonObject,
  parseWireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("shared conversion request codecs", () => {
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
      system: [{ type: "text", text: "system" }],
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
          content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "result" }] }],
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

  it.each(["chat", "responses"] as const)(
    "preserves a valid content-free Messages tool result when converting to %s",
    (target) => {
      const converted = prepareConvertedRequest("messages", target, body({
        model: "source",
        messages: [
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
    "rejects an explicit false Messages JSON-schema strictness for %s",
    (target) => {
      expect(() => prepareConvertedRequest("messages", target, body({
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
      }), "target", capability([target]))).toThrow();
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
      "reasoning.presentation_omitted",
      "reasoning.state_omitted",
    ]);
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

  it("replays converter-emitted Responses message IDs and annotations through Messages", () => {
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
            annotations: [{ type: "url_citation", url: "https://example.test" }],
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
    ["unknown top-level key", "{\"model\":\"x\",\"messages\":[],\"unknown\":null}"],
    ["duplicate top-level key", "{\"model\":\"x\",\"model\":\"y\",\"messages\":[]}"],
    ["bad explicit null", "{\"model\":\"x\",\"messages\":null}"],
    ["n greater than one", "{\"model\":\"x\",\"messages\":[],\"n\":2}"],
    ["missing tool name", "{\"model\":\"x\",\"messages\":[],\"tools\":[{\"type\":\"function\",\"function\":{\"parameters\":{}}}]}"],
    ["orphan tool result", "{\"model\":\"x\",\"messages\":[{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"x\"}]}"],
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

  it.each([
    ["malformed cache control", {
      model: "source",
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: 17 }] }],
      max_tokens: 8,
    }],
    ["malformed Messages metadata", {
      model: "source",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      metadata: { user_id: 17 },
    }],
    ["unknown Responses reasoning item key", {
      model: "source",
      input: [{ type: "reasoning", summary: [], unknown: null }],
    }],
    ["unknown tool-result image key", {
      model: "source",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
              unknown: null,
            }],
          }],
        },
      ],
      max_tokens: 8,
    }],
  ])("rejects strict nested protocol shape: %s", (_name, request) => {
    const source = "input" in request ? "responses" : "messages";
    expect(() => prepareConvertedRequest(
      source,
      source === "messages" ? "chat" : "messages",
      body(request),
      "target",
      capability([source === "messages" ? "chat" : "messages"]),
    )).toThrow();
  });

  it("rejects an unclosed Responses tool round before converting to Messages", () => {
    expect(() => prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "unrelated" }] },
      ],
    }), "target", capability(["messages"]))).toThrow();
  });

  it.each(["chat", "messages"] as const)(
    "rejects a new tool round before every prior parallel call has a result for %s",
    (target) => {
      expect(() => prepareConvertedRequest("responses", target, body({
        model: "source",
        input: [
          { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" },
          { type: "function_call", call_id: "call_b", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_a", output: "a" },
          { type: "function_call", call_id: "call_c", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_b", output: "b" },
          { type: "function_call_output", call_id: "call_c", output: "c" },
        ],
      }), "target", capability([target]))).toThrow();
    },
  );

  it("rejects assistant content inserted after only part of a parallel Chat tool round", () => {
    expect(() => prepareConvertedRequest("responses", "chat", body({
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
    }), "target", capability(["chat"]))).toThrow();
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
          { type: "input_text", text: "[cc-switch:tool-result-error]" },
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
    expect(chat).toContain("[cc-switch:tool-result-error]");
  });

  it("extracts nested JSON-encoded Responses tool-result images on the approved content path", () => {
    const converted = decoded(prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
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

  it("rejects unknown fields in nested JSON-encoded tool-result media", () => {
    expect(() => prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
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
    }), "target", capability(["messages"]))).toThrow();
  });

  it("extracts a nested approved whole-string tool-result image data URL", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(8192)}`;
    const converted = decoded(prepareConvertedRequest("responses", "messages", body({
      model: "source",
      input: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: { content: dataUrl },
        },
      ],
    }), "target", capability(["messages"])).bytes);
    expect(converted.messages).toMatchObject([
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
    discovered: true,
    configured: false,
    verified: true,
    enabled: true,
    visible: true,
    override: null,
    protocols: { value: protocols, source: "live", conflict: false, liveState: "value" },
    maxInputTokens: { value: 128_000, source: "live", conflict: false, liveState: "value" },
    maxOutputTokens: { value: maxTokens, source: maxTokens === null ? "unknown" : "live", conflict: false, liveState: maxTokens === null ? "missing" : "value" },
    defaultOutputTokens: {
      configuration: configuredDefault,
      effective: defaultTokens ?? (maxTokens === null ? 4096 : Math.min(8192, maxTokens)),
      source: defaultTokens === null ? (maxTokens === null ? "unknown_fallback" : "known_ceiling") : "live",
      valid: true,
    },
    profile: {
      chatOutputTokenField: { value: tokenField, source: "live", conflict: false, liveState: "value" },
    },
    revision: {
      credentialGeneration: 0,
      catalogGeneration: 1,
      overrideRevision: 0,
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
