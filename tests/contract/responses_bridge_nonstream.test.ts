import { describe, expect, it } from "vitest";
import { convertChatResponseToResponses, managedResponseId } from "../../src/protocols/responses/bridge_nonstream.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import { buildRequestToolContext } from "../../src/protocols/responses/tool_context.js";
import { isWireJsonArray, isWireJsonObject, parseWireJson, serializeWireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";

const LIMITS = { maxBytes: 65_536, maxDepth: 64 } as const;

describe("Responses bridge non-stream conversion", () => {
  it("builds envelope defaults, ordered output, managed ID, usage, provider fields, and history record", () => {
    const request = requestFromJson(JSON.stringify({
      model: "gpt",
      tools: [
        { type: "function", name: "lookup", parameters: {} },
        { type: "namespace", name: "ns", tools: [{ type: "function", name: "child", parameters: {} }] },
        { type: "custom", name: "render" },
        { type: "tool_search" },
      ],
    }));
    let uuid = 0;
    const result = convertChatResponseToResponses(wireObject(JSON.stringify({
      id: "chatcmpl_1",
      created: 1700000000,
      model: "gpt",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            reasoning_content: "plan",
            thinking_blocks: [{ type: "thinking", thinking: "hidden", signature: "sig" }],
            content: "answer",
            annotations: [
              { type: "url_citation", start_index: 0, end_index: 4, url: "https://example.test", title: "Example" },
              { type: "other", drop: true },
            ],
            tool_calls: [
              { id: "call_fn", function: { name: "lookup", arguments: "{\"raw\":true}", status: "in_progress" }, provider_specific_fields: { a: 1 } },
              { id: "call_ns", function: { name: "ns__child", arguments: "{}" } },
              { id: "call_custom", function: { name: "render", arguments: "{\"input\":\"card\"}" } },
              { id: "call_search", function: { name: "tool_search", arguments: "{\"query\":\"docs\"}" } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        cost: 0.5,
        prompt_tokens_details: { cached_tokens: 1, text_tokens: 4, cache_creation_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3, image_tokens: 1 },
      },
      _hidden_params: { provider_specific_fields: { vendor: "x" } },
    })), {
      originalRequest: request,
      toolContext: buildRequestToolContext(request),
      customLlmProvider: "github_copilot",
      modelId: "gpt",
      createUuid: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
    });

    expect(json(result.response)).toEqual({
      id: managedResponseId("chatcmpl_1", "github_copilot", "gpt"),
      object: "response",
      created_at: 1700000000,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      model: "gpt",
      output: [
        {
          type: "reasoning",
          id: "rs_00000000-0000-4000-8000-000000000001",
          status: "completed",
          content: [{ type: "reasoning_text", text: "plan" }],
          summary: [],
          encrypted_content: "[{\"type\":\"thinking\",\"thinking\":\"hidden\",\"signature\":\"sig\"}]",
        },
        {
          type: "message",
          id: "msg_00000000-0000-4000-8000-000000000002",
          status: "completed",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "answer",
            annotations: [{ type: "url_citation", start_index: 0, end_index: 4, url: "https://example.test", title: "Example" }],
          }],
        },
        { type: "function_call", id: "call_fn", call_id: "call_fn", name: "lookup", arguments: "{\"raw\":true}", status: "in_progress", provider_specific_fields: { a: 1 } },
        { type: "function_call", id: "call_ns", call_id: "call_ns", name: "child", namespace: "ns", arguments: "{}", status: "completed" },
        { type: "custom_tool_call", id: "call_custom", call_id: "call_custom", name: "render", status: "completed", input: "card" },
        { type: "tool_search_call", call_id: "call_search", status: "completed", execution: "client", arguments: { query: "docs" } },
      ],
      parallel_tool_calls: false,
      temperature: 0,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      max_output_tokens: null,
      previous_response_id: null,
      reasoning: null,
      text: {},
      truncation: null,
      user: null,
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 1, text_tokens: 4, cache_creation_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 3, image_tokens: 1 },
        cost: 0.5,
      },
      _hidden_params: { provider_specific_fields: { vendor: "x" } },
      vendor: "x",
    });
    const outputValue = result.response.members.find((member) => member.key === "output")?.value;
    expect(isWireJsonArray(outputValue)).toBe(true);
    expect(result.historyRecord).toEqual({
      responseId: json(result.response).id,
      output: isWireJsonArray(outputValue) ? outputValue.items : [],
    });
  });

  it("handles empty choices, incomplete status, images, idempotent managed IDs, and malformed custom/search args", () => {
    const request = requestFromJson(JSON.stringify({ model: "gpt", tools: [{ type: "custom", name: "render" }, { type: "tool_search" }] }));
    const managed = managedResponseId("chatcmpl_2", undefined, undefined);
    const empty = convertChatResponseToResponses(wireObject(JSON.stringify({ id: managed, model: "gpt", choices: [] })), {
      originalRequest: request,
      toolContext: buildRequestToolContext(request),
      createUuid: () => "00000000-0000-4000-8000-000000000099",
    });
    expect(json(empty.response)).toMatchObject({ id: managed, status: "completed", output: [] });

    let uuid = 0;
    const result = convertChatResponseToResponses(wireObject(JSON.stringify({
      id: "chatcmpl_3",
      model: "gpt",
      choices: [{
        finish_reason: "length",
        message: {
          images: ["data:image/png;base64,abc", "rawbase64"],
          tool_calls: [
            { id: "call_custom", function: { name: "render", arguments: "not-json" } },
            { id: "call_search", function: { name: "tool_search", arguments: "plain query" } },
          ],
        },
      }],
    })), {
      originalRequest: request,
      toolContext: buildRequestToolContext(request),
      createUuid: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
    });
    expect(json(result.response)).toMatchObject({
      status: "incomplete",
      output: [
        { type: "image_generation_call", id: "ig_00000000-0000-4000-8000-000000000001", status: "incomplete", result: "abc" },
        { type: "image_generation_call", id: "ig_00000000-0000-4000-8000-000000000002", status: "incomplete", result: "rawbase64" },
        { type: "custom_tool_call", input: "not-json" },
        { type: "tool_search_call", arguments: { query: "plain query" } },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  });

  it("falls back from zero cache_write_tokens to cache_creation_tokens", () => {
    const request = requestFromJson(JSON.stringify({ model: "gpt" }));
    const result = convertChatResponseToResponses(wireObject(JSON.stringify({
      id: "chatcmpl_4",
      model: "gpt",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
          cache_creation_tokens: 4,
        },
      },
    })), {
      originalRequest: request,
      toolContext: buildRequestToolContext(request),
      createUuid: () => "00000000-0000-4000-8000-000000000001",
    });
    expect(json(result.response).usage).toEqual({
      input_tokens: 10,
      output_tokens: 1,
      total_tokens: 11,
      input_tokens_details: {
        cached_tokens: 0,
        cache_creation_tokens: 4,
      },
    });
  });

  function requestFromJson(source: string) {
    return decodeResponsesRequest(wireObject(source));
  }

  function wireObject(source: string): WireJsonObject {
    const parsed = parseWireJson(new TextEncoder().encode(source), LIMITS);
    expect(isWireJsonObject(parsed)).toBe(true);
    return parsed as WireJsonObject;
  }

  function json(value: WireJsonObject): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(serializeWireJson(value))) as Record<string, unknown>;
  }
});
