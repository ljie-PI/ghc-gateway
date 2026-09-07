import { describe, expect, it } from "vitest";
import { convertBufferedResponse } from "../../src/protocols/conversion/buffered.js";
import { convertProtocolStream } from "../../src/protocols/conversion/stream.js";
import type {
  ConvertedStreamEmission,
  InferenceProtocol,
} from "../../src/protocols/conversion/types.js";
import {
  createNativeMessagesStreamResponse,
  validatedNativeMessagesBody,
} from "../../src/protocols/anthropic_messages/native.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { createRequestAttempt } from "../../src/gateway/request_attempt.js";
import { createConvertedStreamResponse } from "../../src/gateway/converted_stream_response.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("shared conversion response codecs", () => {
  it("creates one fixed Responses envelope with text and parallel same-name tools", () => {
    const converted = convertBufferedResponse(encoder.encode(JSON.stringify({
      id: "chatcmpl_source",
      object: "chat.completion",
      created: 9,
      model: "source",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "answer",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"q\":\"a\"}" } },
            { id: "call_b", type: "function", function: { name: "lookup", arguments: "{\"q\":\"b\"}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    })), context("chat", "responses"));

    const payload = decoded(converted.bytes);
    expect(payload).toMatchObject({
      object: "response",
      created_at: 1_700_000_000,
      model: "target",
      status: "completed",
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3 },
      },
    });
    const output = payload.output as Array<Record<string, unknown>>;
    expect(output.map((item) => item.type)).toEqual(["message", "function_call", "function_call"]);
    expect(output.slice(1)).toMatchObject([
      { call_id: "call_a", name: "lookup", arguments: "{\"q\":\"a\"}" },
      { call_id: "call_b", name: "lookup", arguments: "{\"q\":\"b\"}" },
    ]);
    expect(output[1]?.id).not.toBe(output[1]?.call_id);
    expect(converted.checkpoint?.responseId).toBe(payload.id);
    expect(converted.observations.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 4,
      cacheReadTokens: 3,
    });
  });

  it("preserves refusal and incomplete state when converting Responses to Chat", () => {
    const converted = convertBufferedResponse(encoder.encode(JSON.stringify({
      id: "resp_source",
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [{
        id: "msg_source",
        type: "message",
        status: "incomplete",
        role: "assistant",
        content: [{ type: "refusal", refusal: "not allowed" }],
      }],
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 1 },
      },
    })), context("responses", "chat"));
    expect(decoded(converted.bytes)).toMatchObject({
      object: "chat.completion",
      created: 1_700_000_000,
      model: "target",
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, refusal: "not allowed" },
        finish_reason: "content_filter",
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 1 },
      },
    });
    expect(converted.observations.terminal).toBe("incomplete");
  });

  it("counts Messages cache tokens exactly once when converting to Responses", () => {
    const converted = convertBufferedResponse(encoder.encode(JSON.stringify({
      id: "msg_source",
      type: "message",
      role: "assistant",
      model: "source",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
      },
    })), context("messages", "responses"));
    expect(decoded(converted.bytes)).toMatchObject({
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        total_tokens: 13,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
      },
    });

    expect(converted.observations.usage).toEqual({
      inputTokens: 11,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 0,
    });
  });

  it("maps a Messages refusal to a restricted Responses result", () => {
    const converted = convertBufferedResponse(encoder.encode(JSON.stringify({
      id: "msg_refusal",
      type: "message",
      role: "assistant",
      model: "source",
      content: [{ type: "text", text: "cannot comply" }],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    })), context("messages", "responses"));
    expect(decoded(converted.bytes)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "cannot comply" }],
      }],
    });
    expect(converted.checkpoint).toMatchObject({ state: "route_only", output: [] });
  });

  it.each([
    ["multiple choices", { choices: [
      { message: { content: "a" }, finish_reason: "stop" },
      { message: { content: "b" }, finish_reason: "stop" },
    ] }],
    ["unknown finish", { choices: [{ message: { content: "a" }, finish_reason: "mystery" }] }],
    ["invalid complete tool arguments", {
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "x", arguments: "{" } }],
        },
        finish_reason: "tool_calls",
      }],
    }],
  ])("rejects unsafe Chat buffered behavior: %s", (_name, payload) => {
    expect(() => convertBufferedResponse(
      encoder.encode(JSON.stringify(payload)),
      context("chat", "messages"),
    )).toThrow();
  });

  it("streams parallel same-name Messages tools to monotonic Responses events across UTF-8/CRLF splits", async () => {
    const source = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_source",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "你好" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_a", name: "lookup", input: {} },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "call_b", name: "lookup", input: {} },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"q\":\"a\"}" },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{\"q\":\"b\"}" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 2 }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: {},
        usage: { output_tokens: 3, cache_read_input_tokens: 2 },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("").replace(/\n/gu, "\r\n");
    const emissions = await collectStream("messages", "responses", splitEveryByte(encoder.encode(source)));
    const text = wireText(emissions);
    expect(text).toContain("你好");
    expect(text).toContain("\"call_id\":\"call_a\"");
    expect(text).toContain("\"call_id\":\"call_b\"");
    expect(text.match(/event: response\.completed/gu)).toHaveLength(1);
    const sequences = responseSequences(text);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(text.match(/\\"q\\":\\"a\\"/gu)?.length).toBeGreaterThan(0);
    expect(emissions.filter((item) => item.kind === "terminal")).toHaveLength(1);
    expect(emissions.filter((item) => item.kind === "usage").at(-1)).toMatchObject({
      usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 2 },
    });
  });

  it("converts a final-only Responses stream to Chat without duplicate snapshots", async () => {
    const response = {
      id: "resp_source",
      object: "response",
      status: "completed",
      model: "source",
      output: [{
        id: "msg_source",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "final only", annotations: [] }],
      }],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    };
    const source = responseEvent(0, "response.completed", { response });
    const emissions = await collectStream("responses", "chat", chunks(encoder.encode(source)));
    const text = wireText(emissions);
    expect(text).toContain("final only");
    expect(text.match(/final only/gu)).toHaveLength(1);
    expect(text.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });

  it("reconciles Chat partial text with a final message snapshot", async () => {
    const source = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hel\"},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const text = wireText(await collectStream("chat", "responses", chunks(encoder.encode(source))));
    expect(text).toContain("\"text\":\"hello\"");
    expect(text).not.toContain("helhello");
  });

  it("keeps Messages tool blocks in source order when completion arrives out of order", async () => {
    const response = {
      id: "resp_tools",
      object: "response",
      status: "completed",
      output: [
        { id: "fc_a", type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}", status: "completed" },
        { id: "fc_b", type: "function_call", call_id: "call_b", name: "lookup", arguments: "{}", status: "completed" },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: { ...response.output[0], arguments: "", status: "in_progress" },
      }),
      responseEvent(1, "response.output_item.added", {
        output_index: 1,
        item: { ...response.output[1], arguments: "", status: "in_progress" },
      }),
      responseEvent(2, "response.function_call_arguments.delta", {
        item_id: "fc_a", output_index: 0, delta: "{}",
      }),
      responseEvent(3, "response.function_call_arguments.delta", {
        item_id: "fc_b", output_index: 1, delta: "{}",
      }),
      responseEvent(4, "response.function_call_arguments.done", {
        item_id: "fc_b", output_index: 1, name: "lookup", arguments: "{}",
      }),
      responseEvent(5, "response.function_call_arguments.done", {
        item_id: "fc_a", output_index: 0, name: "lookup", arguments: "{}",
      }),
      responseEvent(6, "response.completed", { response }),
    ].join("");
    const text = wireText(await collectStream("responses", "messages", chunks(encoder.encode(source))));
    expect(text.indexOf("\"id\": \"call_a\"")).toBeLessThan(text.indexOf("\"id\": \"call_b\""));
  });

  it("preserves multiple final-only Responses message items and mixed text/refusal content", async () => {
    const response = {
      id: "resp_source",
      object: "response",
      status: "completed",
      model: "source",
      output: [
        {
          id: "msg_one",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "one", annotations: [] }],
        },
        {
          id: "msg_two",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "two", annotations: [] },
            { type: "refusal", refusal: "refused" },
          ],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    };
    const emissions = await collectStream(
      "responses",
      "messages",
      chunks(encoder.encode(responseEvent(0, "response.completed", { response }))),
    );
    const text = wireText(emissions);
    expect(text).toContain("\"text\": \"one\"");
    expect(text).toContain("\"text\": \"two\"");
    expect(text).toContain("\"text\": \"refused\"");
    expect(text).toContain("\"stop_reason\": \"refusal\"");
    expect(text.match(/event: message_stop/gu)).toHaveLength(1);
  });

  it("preserves multiple content parts within one final-only Responses message", async () => {
    const response = {
      id: "resp_parts",
      object: "response",
      status: "completed",
      output: [{
        id: "msg_parts",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "one", annotations: [] },
          { type: "output_text", text: "two", annotations: [] },
        ],
      }],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    };
    const text = wireText(await collectStream(
      "responses",
      "chat",
      chunks(encoder.encode(responseEvent(0, "response.completed", { response }))),
    ));
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text.match(/data: \[DONE\]/gu)).toHaveLength(1);
    const messages = wireText(await collectStream(
      "responses",
      "messages",
      chunks(encoder.encode(responseEvent(0, "response.completed", { response }))),
    ));
    expect(messages).toContain("\"text\": \"one\"");
    expect(messages).toContain("\"text\": \"two\"");
    expect(messages.match(/event: message_stop/gu)).toHaveLength(1);
  });

  it("preserves ordered text/refusal/text parts after a tool in Messages output", async () => {
    const response = {
      id: "resp_parts_after_tool",
      object: "response",
      status: "completed",
      output: [
        { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
        {
          id: "msg_parts",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "A", annotations: [] },
            { type: "refusal", refusal: "B" },
            { type: "output_text", text: "C", annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    };
    const text = wireText(await collectStream(
      "responses",
      "messages",
      chunks(encoder.encode(responseEvent(0, "response.completed", { response }))),
    ));
    const a = text.indexOf("\"text\": \"A\"");
    const b = text.indexOf("\"text\": \"B\"");
    const c = text.indexOf("\"text\": \"C\"");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("keeps token-limited partial tool arguments incomplete instead of validating fabricated JSON", async () => {
    const source = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\"}}]},\"finish_reason\":\"length\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const emissions = await collectStream("chat", "responses", chunks(encoder.encode(source)));
    const text = wireText(emissions);
    expect(text).toContain("response.incomplete");
    expect(text).toContain("\"arguments\":\"{\\\"q\\\":\"");
    expect(text).not.toContain("response.function_call_arguments.done");
    expect(emissions.filter((item) => item.kind === "checkpoint")).toMatchObject([
      { intent: { state: "route_only", output: [] } },
    ]);
  });

  it("assembles late Chat tool-name fragments and rejects unresolved tool metadata", async () => {
    const complete = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"look\"}}]},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"up\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const emissions = await collectStream("chat", "responses", chunks(encoder.encode(complete)));
    expect(wireText(emissions)).toContain("\"name\":\"lookup\"");

    const missing = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(missing)),
        streamContext("chat", "responses"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it.each(["messages", "responses"] as const)(
    "fills delayed Chat tool identity from the final snapshot for %s",
    async (target) => {
      const source = [
        "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"type\":\"function\",\"function\":{\"arguments\":\"{\\\"q\\\":\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":1}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
      ].join("");
      const text = wireText(await collectStream("chat", target, chunks(encoder.encode(source))));
      expect(text).toContain("call_1");
      expect(text).toContain("lookup");
      expect(text).toContain("{\\\"q\\\":1}");
    },
  );

  it.each(["chat", "messages"] as const)(
    "keeps a buffered Responses part prefix ahead of later eligible deltas for %s",
    async (target) => {
      const message = {
        id: "msg_gap",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "A", annotations: [] },
          { type: "output_text", text: "BC", annotations: [] },
        ],
      };
      const source = [
        responseEvent(0, "response.output_item.added", {
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        }),
        responseEvent(1, "response.output_text.delta", {
          item_id: "msg_gap", output_index: 0, content_index: 0, delta: "A",
        }),
        responseEvent(2, "response.output_text.delta", {
          item_id: "msg_gap", output_index: 0, content_index: 1, delta: "B",
        }),
        responseEvent(3, "response.output_text.done", {
          item_id: "msg_gap", output_index: 0, content_index: 0, text: "A",
        }),
        responseEvent(4, "response.output_text.delta", {
          item_id: "msg_gap", output_index: 0, content_index: 1, delta: "C",
        }),
        responseEvent(5, "response.completed", {
          response: {
            id: "resp_gap",
            object: "response",
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
          },
        }),
      ].join("");
      const text = wireText(await collectStream("responses", target, chunks(encoder.encode(source))));
      expect(text.indexOf("A")).toBeLessThan(text.indexOf("BC"));
      expect(text).toContain(target === "chat" ? "data: [DONE]" : "event: message_stop");
    },
  );

  it.each(["messages", "responses"] as const)(
    "keeps final-only Chat text before its tool call when converting to %s",
    async (target) => {
      const source = [
        "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Before tool\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
      ].join("");
      const text = wireText(await collectStream("chat", target, chunks(encoder.encode(source))));
      const textPosition = target === "messages"
        ? text.indexOf("\"text\": \"Before tool\"")
        : text.indexOf("\"type\":\"response.output_text.delta\"");
      const toolPosition = target === "messages"
        ? text.indexOf("\"type\": \"tool_use\"")
        : text.indexOf("\"type\":\"function_call\"");
      expect(textPosition).toBeGreaterThanOrEqual(0);
      expect(toolPosition).toBeGreaterThan(textPosition);
    },
  );

  it("accepts Chat usage:null and preserves source tool indexes across delayed arguments", async () => {
    const source = [
      "data: {\"id\":\"x\",\"usage\":null,\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"lookup\"}},{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const text = wireText(await collectStream("chat", "responses", chunks(encoder.encode(source))));
    expect(text.indexOf("\"call_id\":\"call_a\"")).toBeLessThan(text.indexOf("\"call_id\":\"call_b\""));
    expect(text).toContain("response.completed");
  });

  it("rejects conflicting final arguments that were queued behind an earlier tool index", async () => {
    const source = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"lookup\"}},{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"x\\\":1}\"}}]},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"x\\\":2}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(source)),
        streamContext("chat", "responses"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("rejects a final Chat snapshot that omits a previously observed tool call", async () => {
    const source = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[]},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(source)),
        streamContext("chat", "responses"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("rejects a final Chat snapshot that nulls previously observed text", async () => {
    const source = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"discarded\"},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(source)),
        streamContext("chat", "responses"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("holds later Responses text behind an earlier unfinished Messages tool block", async () => {
    const response = {
      id: "resp_order",
      object: "response",
      status: "completed",
      output: [
        { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
        {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "after", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: { ...response.output[0], arguments: "", status: "in_progress" },
      }),
      responseEvent(1, "response.output_item.added", {
        output_index: 1,
        item: { ...response.output[1], content: [], status: "in_progress" },
      }),
      responseEvent(2, "response.output_text.delta", {
        item_id: "msg_1", output_index: 1, content_index: 0, delta: "after",
      }),
      responseEvent(3, "response.function_call_arguments.delta", {
        item_id: "fc_1", output_index: 0, delta: "{}",
      }),
      responseEvent(4, "response.function_call_arguments.done", {
        item_id: "fc_1", output_index: 0, name: "lookup", arguments: "{}",
      }),
      responseEvent(5, "response.completed", { response }),
    ].join("");
    const text = wireText(await collectStream("responses", "messages", chunks(encoder.encode(source))));
    expect(text.indexOf("\"id\": \"call_1\"")).toBeLessThan(text.indexOf("\"text\": \"after\""));
  });

  it("keeps Messages text behind an earlier completed but buffered Responses tool", async () => {
    const tool = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
      status: "completed",
    };
    const message = {
      id: "msg_after_tool",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "AFTER", annotations: [] }],
    };
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: { ...tool, status: "in_progress", arguments: "" },
      }),
      responseEvent(1, "response.function_call_arguments.done", {
        item_id: "fc_1", output_index: 0, name: "lookup", arguments: "{}",
      }),
      responseEvent(2, "response.output_item.done", { output_index: 0, item: tool }),
      responseEvent(3, "response.output_item.added", {
        output_index: 1,
        item: { ...message, status: "in_progress", content: [] },
      }),
      responseEvent(4, "response.output_text.delta", {
        item_id: "msg_after_tool", output_index: 1, content_index: 0, delta: "AFTER",
      }),
      responseEvent(5, "response.completed", {
        response: {
          id: "resp_tool_then_text",
          object: "response",
          status: "completed",
          output: [tool, message],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      }),
    ].join("");
    const text = wireText(await collectStream("responses", "messages", chunks(encoder.encode(source))));
    expect(text.indexOf("\"type\": \"tool_use\"")).toBeLessThan(text.indexOf("\"text\": \"AFTER\""));
  });

  it("holds later Responses messages until earlier message content is reconciled for Messages", async () => {
    const first = {
      id: "msg_first",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "FIRST", annotations: [] }],
    };
    const second = {
      id: "msg_second",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "SECOND", annotations: [] }],
    };
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: { ...first, status: "in_progress", content: [] },
      }),
      responseEvent(1, "response.output_item.added", {
        output_index: 1,
        item: { ...second, status: "in_progress", content: [] },
      }),
      responseEvent(2, "response.output_text.delta", {
        item_id: "msg_second",
        output_index: 1,
        content_index: 0,
        delta: "SECOND",
      }),
      responseEvent(3, "response.completed", {
        response: {
          id: "resp_messages",
          object: "response",
          status: "completed",
          output: [first, second],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      }),
    ].join("");
    const text = wireText(await collectStream("responses", "messages", chunks(encoder.encode(source))));
    expect(text.indexOf("\"text\": \"FIRST\"")).toBeLessThan(text.indexOf("\"text\": \"SECOND\""));
  });

  it.each(["chat", "messages"] as const)(
    "reconciles earlier Responses message suffixes before later messages for %s",
    async (target) => {
      const first = {
        id: "msg_first",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "AB", annotations: [] }],
      };
      const second = {
        id: "msg_second",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "C", annotations: [] }],
      };
      const source = [
        responseEvent(0, "response.output_item.added", {
          output_index: 0,
          item: { ...first, status: "in_progress", content: [] },
        }),
        responseEvent(1, "response.output_item.added", {
          output_index: 1,
          item: { ...second, status: "in_progress", content: [] },
        }),
        responseEvent(2, "response.output_text.delta", {
          item_id: "msg_first", output_index: 0, content_index: 0, delta: "A",
        }),
        responseEvent(3, "response.output_text.delta", {
          item_id: "msg_second", output_index: 1, content_index: 0, delta: "C",
        }),
        responseEvent(4, "response.completed", {
          response: {
            id: "resp_suffix_order",
            object: "response",
            status: "completed",
            output: [first, second],
            usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
          },
        }),
      ].join("");
      const text = wireText(await collectStream("responses", target, chunks(encoder.encode(source))));
      const firstPosition = target === "chat"
        ? text.indexOf("\"content\":\"A\"")
        : text.indexOf("\"text\": \"A\"");
      const suffixPosition = target === "chat"
        ? text.indexOf("\"content\":\"B\"")
        : text.indexOf("\"text\": \"B\"");
      const secondPosition = target === "chat"
        ? text.indexOf("\"content\":\"C\"")
        : text.indexOf("\"text\": \"C\"");
      expect(firstPosition).toBeGreaterThanOrEqual(0);
      expect(suffixPosition).toBeGreaterThan(firstPosition);
      expect(secondPosition).toBeGreaterThan(suffixPosition);
    },
  );

  it.each(["chat", "messages"] as const)(
    "streams the established primary Responses content prefix incrementally to %s",
    async (target) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* source(): AsyncIterable<Uint8Array> {
        yield encoder.encode([
          responseEvent(0, "response.output_item.added", {
            output_index: 0,
            item: {
              id: "msg_incremental",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          }),
          responseEvent(1, "response.output_text.delta", {
            item_id: "msg_incremental",
            output_index: 0,
            content_index: 0,
            delta: "A",
          }),
        ].join(""));
        await gate;
        yield encoder.encode([
          responseEvent(2, "response.output_text.delta", {
            item_id: "msg_incremental",
            output_index: 0,
            content_index: 0,
            delta: "B",
          }),
          responseEvent(3, "response.completed", {
            response: {
              id: "resp_incremental",
              object: "response",
              status: "completed",
              output: [{
                id: "msg_incremental",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "AB", annotations: [] }],
              }],
              usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
            },
          }),
        ].join(""));
      }
      const iterator = convertProtocolStream(
        source(),
        streamContext("responses", target),
      )[Symbol.asyncIterator]();
      let prefix = "";
      try {
        for (let index = 0; index < 8 && !prefix.includes("A"); index += 1) {
          const next = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => setTimeout(
              () => reject(new Error("primary Responses prefix was not emitted incrementally")),
              500,
            )),
          ]);
          if (next.done) {
            break;
          }
          if (next.value.kind === "wire") {
            prefix += decoder.decode(next.value.bytes);
          }
        }
        expect(prefix).toContain("A");
        expect(prefix).not.toContain("response.completed");
      } finally {
        release();
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
      }
    },
  );

  it.each(["chat", "messages"] as const)(
    "advances incremental Responses delivery after a completed earlier reasoning item for %s",
    async (target) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* source(): AsyncIterable<Uint8Array> {
        yield encoder.encode([
          responseEvent(0, "response.output_item.added", {
            output_index: 0,
            item: { id: "rs_0", type: "reasoning", status: "in_progress", summary: [] },
          }),
          responseEvent(1, "response.output_item.done", {
            output_index: 0,
            item: { id: "rs_0", type: "reasoning", status: "completed", summary: [] },
          }),
          responseEvent(2, "response.output_item.added", {
            output_index: 1,
            item: {
              id: "msg_after_reasoning",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          }),
          responseEvent(3, "response.output_text.delta", {
            item_id: "msg_after_reasoning",
            output_index: 1,
            content_index: 0,
            delta: "A",
          }),
        ].join(""));
        await gate;
        yield encoder.encode(responseEvent(4, "response.completed", {
          response: {
            id: "resp_after_reasoning",
            object: "response",
            status: "completed",
            output: [
              { id: "rs_0", type: "reasoning", status: "completed", summary: [] },
              {
                id: "msg_after_reasoning",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "A", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }));
      }
      const iterator = convertProtocolStream(
        source(),
        streamContext("responses", target),
      )[Symbol.asyncIterator]();
      let prefix = "";
      try {
        for (let index = 0; index < 10 && !prefix.includes("A"); index += 1) {
          const next = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => setTimeout(
              () => reject(new Error("Responses frontier did not advance after completed reasoning")),
              500,
            )),
          ]);
          if (next.done) {
            break;
          }
          if (next.value.kind === "wire") {
            prefix += decoder.decode(next.value.bytes);
          }
        }
        expect(prefix).toContain("A");
        expect(prefix).not.toContain("response.completed");
      } finally {
        release();
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
      }
    },
  );

  it.each(["chat", "messages"] as const)(
    "orders an earlier terminal-only Responses item before an observed later item for %s",
    async (target) => {
      const first = {
        id: "msg_terminal_first",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "FIRST", annotations: [] }],
      };
      const second = {
        id: "msg_observed_second",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "SECOND", annotations: [] }],
      };
      const source = [
        responseEvent(0, "response.output_item.added", {
          output_index: 1,
          item: { ...second, status: "in_progress", content: [] },
        }),
        responseEvent(1, "response.output_text.delta", {
          item_id: "msg_observed_second", output_index: 1, content_index: 0, delta: "SECOND",
        }),
        responseEvent(2, "response.completed", {
          response: {
            id: "resp_terminal_order",
            object: "response",
            status: "completed",
            output: [first, second],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        }),
      ].join("");
      const text = wireText(await collectStream("responses", target, chunks(encoder.encode(source))));
      expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
    },
  );

  it.each(["chat", "messages"] as const)(
    "preserves Responses content-part order when a later part streams first for %s",
    async (target) => {
      const message = {
        id: "msg_parts",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "FIRST", annotations: [] },
          { type: "output_text", text: "SECOND", annotations: [] },
        ],
      };
      const source = [
        responseEvent(0, "response.output_item.added", {
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        }),
        responseEvent(1, "response.content_part.added", {
          item_id: "msg_parts",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
        responseEvent(2, "response.content_part.added", {
          item_id: "msg_parts",
          output_index: 0,
          content_index: 1,
          part: { type: "output_text", text: "", annotations: [] },
        }),
        responseEvent(3, "response.output_text.delta", {
          item_id: "msg_parts", output_index: 0, content_index: 1, delta: "SECOND",
        }),
        responseEvent(4, "response.completed", {
          response: {
            id: "resp_parts",
            object: "response",
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        }),
      ].join("");
      const text = wireText(await collectStream("responses", target, chunks(encoder.encode(source))));
      expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
    },
  );

  it.each(["arguments", "call_id", "name"] as const)(
    "rejects null final Responses tool %s after valid stream metadata",
    async (field) => {
      const finalTool: Record<string, unknown> = {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      };
      finalTool[field] = null;
      const source = [
        responseEvent(0, "response.output_item.added", {
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "",
            status: "in_progress",
          },
        }),
        responseEvent(1, "response.function_call_arguments.done", {
          item_id: "fc_1", output_index: 0, name: "lookup", arguments: "{}",
        }),
        responseEvent(2, "response.completed", {
          response: {
            id: "resp_tool_null",
            object: "response",
            status: "completed",
            output: [finalTool],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      ].join("");
      await expect(async () => {
        for await (const _emission of convertProtocolStream(
          chunks(encoder.encode(source)),
          streamContext("responses", "chat"),
        )) {
          void _emission;
        }
      }).rejects.toThrow();
    },
  );

  it.each(["chat", "messages"] as const)(
    "rejects terminal growth of an item after its done snapshot advanced %s delivery",
    async (target) => {
      const source = [
        responseEvent(0, "response.output_item.added", {
          output_index: 0,
          item: {
            id: "msg_done_first",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
        responseEvent(1, "response.output_text.delta", {
          item_id: "msg_done_first", output_index: 0, content_index: 0, delta: "A",
        }),
        responseEvent(2, "response.output_item.done", {
          output_index: 0,
          item: {
            id: "msg_done_first",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "A", annotations: [] }],
          },
        }),
        responseEvent(3, "response.output_item.added", {
          output_index: 1,
          item: {
            id: "msg_live_second",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
        responseEvent(4, "response.output_text.delta", {
          item_id: "msg_live_second", output_index: 1, content_index: 0, delta: "B",
        }),
        responseEvent(5, "response.completed", {
          response: {
            id: "resp_late_growth",
            object: "response",
            status: "completed",
            output: [
              {
                id: "msg_done_first",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "A+", annotations: [] }],
              },
              {
                id: "msg_live_second",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "B", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        }),
      ].join("");
      await expect(async () => {
        for await (const _emission of convertProtocolStream(
          chunks(encoder.encode(source)),
          streamContext("responses", target),
        )) {
          void _emission;
        }
      }).rejects.toThrow();
    },
  );

  it("rejects contradictory Responses content-part and terminal snapshots", async () => {
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: {
          id: "msg_conflict",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }),
      responseEvent(1, "response.content_part.done", {
        item_id: "msg_conflict",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "ORIGINAL", annotations: [] },
      }),
      responseEvent(2, "response.completed", {
        response: {
          id: "resp_content_conflict",
          object: "response",
          status: "completed",
          output: [{
            id: "msg_conflict",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "REPLACEMENT", annotations: [] }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(source)),
        streamContext("responses", "chat"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("preserves Chat text after a buffered tool and emits refusal text once", async () => {
    const source = [
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"before\"},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"after\",\"refusal\":\"no\"},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const text = wireText(await collectStream("chat", "messages", chunks(encoder.encode(source))));
    expect(text).toContain("\"text\": \"before\"");
    expect(text).toContain("\"text\": \"after\"");
    expect(text.match(/"text": "no"/gu)).toHaveLength(1);
    expect(text.match(/event: message_stop/gu)).toHaveLength(1);
  });

  it("rejects conflicting Responses tool identity snapshots", async () => {
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_a",
          name: "lookup",
          arguments: "",
          status: "in_progress",
        },
      }),
      responseEvent(1, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_b",
          name: "delete",
          arguments: "{}",
          status: "completed",
        },
      }),
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(source)),
        streamContext("responses", "chat"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("preserves an explicit empty Messages tool input when no deltas follow", async () => {
    const source = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_empty_tool",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 1 },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("");
    const text = wireText(await collectStream("messages", "responses", chunks(encoder.encode(source))));
    expect(text).toContain("\"arguments\":\"{}\"");
    expect(text).toContain("response.completed");
  });

  it("retains an announced empty Messages text item before a following Responses tool", async () => {
    const source = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_empty_text",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 1 },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("");
    const text = wireText(await collectStream("messages", "responses", chunks(encoder.encode(source))));
    expect(text).toContain("\"output_index\":0,\"item\":{\"type\":\"message\"");
    expect(text).toContain("\"output_index\":1,\"item\":{\"type\":\"function_call\"");
    expect(text).toContain("\"content\":[{\"type\":\"output_text\",\"text\":\"\"");
    expect(text).toContain("response.completed");
  });

  it("rejects contradictory Responses terminal status and missing final observed items", async () => {
    const contradictory = responseEvent(0, "response.completed", {
      response: {
        id: "resp_bad",
        object: "response",
        status: "incomplete",
        output: [],
      },
    });
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(contradictory)),
        streamContext("responses", "chat"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();

    const missing = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      responseEvent(1, "response.output_text.delta", {
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "partial",
      }),
      responseEvent(2, "response.completed", {
        response: {
          id: "resp_bad",
          object: "response",
          status: "completed",
          output: [],
        },
      }),
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(missing)),
        streamContext("responses", "chat"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();

    const omittedItemDoneContent = [
      responseEvent(0, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "final", annotations: [] }],
        },
      }),
      responseEvent(1, "response.completed", {
        response: {
          id: "resp_bad",
          object: "response",
          status: "completed",
          output: [{
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [],
          }],
        },
      }),
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(omittedItemDoneContent)),
        streamContext("responses", "chat"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("preserves text/tool/text item order in Messages-to-Responses streams", async () => {
    const source = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_order",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "after" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 2 }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 2 },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("");
    const events = wireText(await collectStream("messages", "responses", chunks(encoder.encode(source))));
    const terminal = events
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      .find((event) => event.type === "response.completed");
    const response = terminal?.response as { output?: Array<Record<string, unknown>> };
    expect(response.output?.map((item) => item.type)).toEqual(["message", "function_call", "message"]);
    expect(response.output?.[0]).toMatchObject({ content: [{ text: "before" }] });
    expect(response.output?.[2]).toMatchObject({ content: [{ text: "after" }] });
  });

  it("marks a late Messages refusal as incomplete without rewriting emitted text", async () => {
    const source = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_refusal",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "cannot comply" },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "refusal" },
        usage: { output_tokens: 1 },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("");
    const text = wireText(await collectStream("messages", "responses", chunks(encoder.encode(source))));
    expect(text).toContain("response.incomplete");
    expect(text).toContain("\"reason\":\"content_filter\"");
    expect(text).toContain("cannot comply");
    expect(text).not.toContain("response.completed");
  });

  it("rejects unsupported substantive final output rather than returning empty success", async () => {
    const response = {
      id: "resp_source",
      object: "response",
      status: "completed",
      output: [{ id: "ig_1", type: "image_generation_call", status: "completed", result: "abc" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const generator = convertProtocolStream(
      chunks(encoder.encode(responseEvent(0, "response.completed", { response }))),
      streamContext("responses", "chat"),
    );
    await expect(async () => {
      for await (const _emission of generator) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("rejects conflicting final snapshots and never emits a success terminal", async () => {
    const source = [
      responseEvent(0, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_source", type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      responseEvent(1, "response.output_text.delta", {
        item_id: "msg_source",
        output_index: 0,
        content_index: 0,
        delta: "a",
      }),
      responseEvent(2, "response.output_text.done", {
        item_id: "msg_source",
        output_index: 0,
        content_index: 0,
        text: "b",
      }),
    ].join("");
    const generator = convertProtocolStream(chunks(encoder.encode(source)), streamContext("responses", "chat"));
    await expect(async () => {
      for await (const _emission of generator) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("rejects missing terminals and bounded-accumulator overflow", async () => {
    const truncated = convertProtocolStream(
      chunks(encoder.encode(messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }))),
      streamContext("messages", "chat"),
    );
    await expect(async () => {
      for await (const _emission of truncated) {
        void _emission;
      }
    }).rejects.toThrow();

    const overflow = convertProtocolStream(
      chunks(encoder.encode([
        "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"12345\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
      ].join(""))),
      { ...streamContext("chat", "messages"), accumulatorBytes: 4 },
    );
    await expect(async () => {
      for await (const _emission of overflow) {
        void _emission;
      }
    }).rejects.toThrow();

    const prestartOverflow = convertProtocolStream(
      chunks(encoder.encode([
        "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"12345\"}}]},\"finish_reason\":\"length\"}]}\n\n",
        "data: [DONE]\n\n",
      ].join(""))),
      { ...streamContext("chat", "messages"), accumulatorBytes: 4 },
    );
    await expect(async () => {
      for await (const _emission of prestartOverflow) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("bounds ignored Responses item indexes and requires Messages tool block closure", async () => {
    const reasoningEvents = Array.from({ length: 10 }, (_, index) => responseEvent(
      index,
      "response.output_item.added",
      {
        output_index: index,
        item: { id: `rs_${index}`, type: "reasoning", status: "in_progress", summary: [] },
      },
    )).join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(reasoningEvents)),
        { ...streamContext("responses", "chat"), accumulatorBytes: 64 },
      )) {
        void _emission;
      }
    }).rejects.toThrow();

    const largeInitialTool = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_large",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: { value: "x".repeat(2048) },
        },
      }),
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(largeInitialTool)),
        { ...streamContext("messages", "responses"), accumulatorBytes: 512 },
      )) {
        void _emission;
      }
    }).rejects.toThrow();

    const largeItemId = responseEvent(0, "response.output_item.added", {
      output_index: 0,
      item: {
        id: `fc_${"x".repeat(2048)}`,
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "",
        status: "in_progress",
      },
    });
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(largeItemId)),
        { ...streamContext("responses", "chat"), accumulatorBytes: 512 },
      )) {
        void _emission;
      }
    }).rejects.toThrow();

    const contentIndexes = Array.from({ length: 10 }, (_, index) => responseEvent(
      index,
      "response.output_text.done",
      {
        item_id: "msg_1",
        output_index: 0,
        content_index: index,
        text: "",
      },
    )).join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(contentIndexes)),
        { ...streamContext("responses", "chat"), accumulatorBytes: 256 },
      )) {
        void _emission;
      }
    }).rejects.toThrow();

    const unclosedTool = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_unclosed",
          type: "message",
          role: "assistant",
          content: [],
          model: "source",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      messageEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("");
    await expect(async () => {
      for await (const _emission of convertProtocolStream(
        chunks(encoder.encode(unclosedTool)),
        streamContext("messages", "responses"),
      )) {
        void _emission;
      }
    }).rejects.toThrow();
  });

  it("rejects malformed final-only Responses output values", async () => {
    for (const output of [
      [false],
      [{
        id: "msg_bad",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [false],
      }],
    ]) {
      const source = responseEvent(0, "response.completed", {
        response: {
          id: "resp_bad",
          object: "response",
          status: "completed",
          output,
        },
      });
      await expect(async () => {
        for await (const _emission of convertProtocolStream(
          chunks(encoder.encode(source)),
          streamContext("responses", "chat"),
        )) {
          void _emission;
        }
      }).rejects.toThrow();
    }
  });

  it("uses one absolute first-semantic deadline across usage-only emissions", async () => {
    async function* delayedUsage(): AsyncIterable<Uint8Array> {
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield encoder.encode(`data: ${JSON.stringify({
          id: "usage_only",
          choices: [],
          usage: { prompt_tokens: index + 1 },
        })}\n\n`);
      }
      yield encoder.encode(`data: ${JSON.stringify({
        id: "late",
        choices: [{ index: 0, delta: { content: "late" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`);
    }
    const config = defaultRuntimeConfigSnapshot();
    const signal = new AbortController().signal;
    await expect(createConvertedStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: delayedUsage(),
        async cancel() {},
      },
      plan: {
        kind: "converted",
        source: "responses",
        target: "chat",
        stream: true,
        requestModel: "target",
        request: {
          body: { kind: "object", members: [] },
          bytes: encoder.encode("{}"),
          stream: true,
          hasVisionInput: false,
          initiator: "user",
          messagesBetaFeatures: [],
          degradations: [],
        },
      },
      scope: {
        requestId: "req_deadline",
        signal,
        deliverySignal: signal,
        config: {
          ...config,
          timeouts: { ...config.timeouts, firstByteMs: 50 },
        },
        attempt: createRequestAttempt({
          requestId: "req_deadline",
          protocol: "openai_responses_bridge",
          abortedErrorCount: 1,
        }),
      },
      model: "target",
      createUuid: () => "00000000-0000-4000-8000-000000000104",
      nowUnixSeconds: () => 1_700_000_000,
      headers: {},
      onTerminal: () => undefined,
    })).rejects.toMatchObject({ failure: { kind: "upstream_timeout" } });
  });

  it("finishes a native Messages stream at message_stop without waiting for upstream EOF", async () => {
    let cancelled = false;
    async function* openAfterTerminal(): AsyncIterable<Uint8Array> {
      const payload = [
        messageEvent("message_start", {
          type: "message_start",
          message: {
            id: "msg_native",
            type: "message",
            role: "assistant",
            content: [],
            model: "native",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        }),
        messageEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1, cache_read_input_tokens: 2 },
        }),
        messageEvent("message_stop", { type: "message_stop" }),
      ].join("").replace(/\n/gu, "\r\n");
      for await (const part of splitEveryByte(encoder.encode(payload))) {
        yield part;
      }
      await new Promise<never>(() => undefined);
    }
    const result: Array<{ readonly kind: string }> = [];
    const controller = new AbortController();
    const response = await createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: openAfterTerminal(),
        async cancel() {
          cancelled = true;
        },
      },
      scope: {
        requestId: "req_native",
        signal: controller.signal,
        deliverySignal: controller.signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: (value) => result.push(value),
    });

    const text = await response.text();
    const expected = [
      messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_native",
          type: "message",
          role: "assistant",
          content: [],
          model: "native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }),
      messageEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1, cache_read_input_tokens: 2 },
      }),
      messageEvent("message_stop", { type: "message_stop" }),
    ].join("").replace(/\n/gu, "\r\n");
    expect(text).toBe(expected);
    expect(cancelled).toBe(true);
    expect(result).toMatchObject([{
      kind: "success",
      usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 2 },
    }]);
  });

  it.each([
    "{\"type\":\"error\",\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}",
    "{\"type\":\"message\",\"type\":\"error\",\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}",
    "{\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}",
    "{\"type\":null,\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}",
  ])("rejects native buffered Messages error envelopes before delivery", (payload) => {
    expect(() => validatedNativeMessagesBody(encoder.encode(payload), 1_048_576)).toThrow();
  });

  it("bounds native Messages pre-semantic buffering", async () => {
    let cancelled = false;
    const config = defaultRuntimeConfigSnapshot();
    await expect(createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: chunks(encoder.encode(": comment larger than the captured accumulator\n\n")),
        async cancel() {
          cancelled = true;
        },
      },
      scope: {
        requestId: "req_native_limit",
        signal: new AbortController().signal,
        deliverySignal: new AbortController().signal,
        config: {
          ...config,
          limits: { ...config.limits, accumulatorBytes: 8 },
        },
        attempt: createRequestAttempt({
          requestId: "req_native_limit",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    })).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it("withholds fragmented native Messages error diagnostics", async () => {
    async function* upstream(): AsyncIterable<Uint8Array> {
      yield encoder.encode(messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_error",
          type: "message",
          role: "assistant",
          content: [],
          model: "native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }));
      yield encoder.encode("event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"secret");
      yield encoder.encode("\"}}\n\n");
    }
    const signal = new AbortController().signal;
    const response = await createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: upstream(),
        async cancel() {},
      },
      scope: {
        requestId: "req_native_error",
        signal,
        deliverySignal: signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native_error",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("missing response body");
    }
    const first = await reader.read();
    expect(decoder.decode(first.value)).not.toContain("secret");
    await expect(reader.read()).rejects.toThrow();
  });

  it.each([
    "{\"error\":{\"type\":\"api_error\",\"message\":\"synthetic-sensitive-diagnostic\"}}",
    "{\"error\":\"synthetic-sensitive-diagnostic\"",
  ])("withholds native Messages event:error diagnostics without a valid type discriminator", async (diagnostic) => {
    const signal = new AbortController().signal;
    async function* upstream(): AsyncIterable<Uint8Array> {
      yield encoder.encode(messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_error_event",
          type: "message",
          role: "assistant",
          content: [],
          model: "native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }));
      yield encoder.encode(`event: error\ndata: ${diagnostic}\n\n`);
    }
    const response = await createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: upstream(),
        async cancel() {},
      },
      scope: {
        requestId: "req_native_error_event",
        signal,
        deliverySignal: signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native_error_event",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("missing response body");
    }
    let delivered = "";
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          return;
        }
        delivered += decoder.decode(next.value, { stream: true });
      }
    })()).rejects.toThrow();
    expect(delivered).not.toContain("synthetic-sensitive-diagnostic");
  });

  it("recognizes a BOM-prefixed native Messages error event without forwarding its diagnostics", async () => {
    const signal = new AbortController().signal;
    await expect(createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: chunks(encoder.encode([
          "\uFEFFevent: error\ndata: {\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}\n\n",
          messageEvent("message_start", {
            type: "message_start",
            message: {
              id: "msg_after_error",
              type: "message",
              role: "assistant",
              content: [],
              model: "native",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }),
          messageEvent("message_stop", { type: "message_stop" }),
        ].join(""))),
        async cancel() {},
      },
      scope: {
        requestId: "req_native_bom_error",
        signal,
        deliverySignal: signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native_bom_error",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    })).rejects.toThrow();
  });

  it("rejects duplicate native Messages type discriminators before forwarding diagnostics", async () => {
    async function* upstream(): AsyncIterable<Uint8Array> {
      yield encoder.encode(messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_duplicate_type",
          type: "message",
          role: "assistant",
          content: [],
          model: "native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }));
      yield encoder.encode(
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"type\":\"error\",\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}\n\n",
      );
    }
    const signal = new AbortController().signal;
    const response = await createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: upstream(),
        async cancel() {},
      },
      scope: {
        requestId: "req_native_duplicate_type",
        signal,
        deliverySignal: signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native_duplicate_type",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("missing response body");
    }
    let delivered = "";
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          return;
        }
        delivered += decoder.decode(next.value, { stream: true });
      }
    })()).rejects.toThrow();
    expect(delivered).not.toContain("synthetic-sensitive-diagnostic");
  });

  it("fails closed on unparseable native Messages data before forwarding diagnostics", async () => {
    const nested = `${"[".repeat(65)}"synthetic-sensitive-diagnostic"${"]".repeat(65)}`;
    async function* upstream(): AsyncIterable<Uint8Array> {
      yield encoder.encode(messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_unparseable_error",
          type: "message",
          role: "assistant",
          content: [],
          model: "native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }));
      yield encoder.encode(`event: message_delta\ndata: {"type":"error","error":${nested}}\n\n`);
    }
    const signal = new AbortController().signal;
    const response = await createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: upstream(),
        async cancel() {},
      },
      scope: {
        requestId: "req_native_unparseable",
        signal,
        deliverySignal: signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native_unparseable",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("missing response body");
    }
    let delivered = "";
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          return;
        }
        delivered += decoder.decode(next.value, { stream: true });
      }
    })()).rejects.toThrow();
    expect(delivered).not.toContain("synthetic-sensitive-diagnostic");
  });

  it.each([
    "{\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}",
    "{\"type\":null,\"error\":{\"message\":\"synthetic-sensitive-diagnostic\"}}",
  ])("rejects untyped native Messages stream diagnostics before forwarding", async (payload) => {
    async function* upstream(): AsyncIterable<Uint8Array> {
      yield encoder.encode(messageEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_untyped_error",
          type: "message",
          role: "assistant",
          content: [],
          model: "native",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }));
      yield encoder.encode(`event: message_delta\ndata: ${payload}\n\n`);
    }
    const signal = new AbortController().signal;
    const response = await createNativeMessagesStreamResponse({
      upstream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: upstream(),
        async cancel() {},
      },
      scope: {
        requestId: "req_native_untyped",
        signal,
        deliverySignal: signal,
        config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({
          requestId: "req_native_untyped",
          protocol: "anthropic",
          abortedErrorCount: 1,
        }),
      },
      onTerminal: () => undefined,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("missing response body");
    }
    let delivered = "";
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          return;
        }
        delivered += decoder.decode(next.value, { stream: true });
      }
    })()).rejects.toThrow();
    expect(delivered).not.toContain("synthetic-sensitive-diagnostic");
  });
});

function context(source: InferenceProtocol, target: InferenceProtocol) {
  return {
    source,
    target,
    model: "target",
    maxBytes: 1_048_576,
    createUuid: () => "00000000-0000-4000-8000-000000000104",
    nowUnixSeconds: () => 1_700_000_000,
  };
}

function streamContext(source: InferenceProtocol, target: InferenceProtocol) {
  return {
    source,
    target,
    model: "target",
    eventLimitBytes: 1_048_576,
    accumulatorBytes: 1_048_576,
    createUuid: () => "00000000-0000-4000-8000-000000000104",
    nowUnixSeconds: () => 1_700_000_000,
  };
}

async function collectStream(
  source: InferenceProtocol,
  target: InferenceProtocol,
  bytes: AsyncIterable<Uint8Array>,
): Promise<ConvertedStreamEmission[]> {
  const output: ConvertedStreamEmission[] = [];
  for await (const emission of convertProtocolStream(bytes, streamContext(source, target))) {
    output.push(emission);
  }
  return output;
}

function wireText(emissions: readonly ConvertedStreamEmission[]): string {
  return emissions
    .filter((item): item is Extract<ConvertedStreamEmission, { readonly kind: "wire" }> => item.kind === "wire")
    .map((item) => decoder.decode(item.bytes))
    .join("");
}

function decoded(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

function messageEvent(type: string, payload: Readonly<Record<string, unknown>>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseEvent(
  sequenceNumber: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return messageEvent(type, { type, sequence_number: sequenceNumber, ...payload });
}

function responseSequences(text: string): number[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { sequence_number?: number })
    .map((event) => event.sequence_number)
    .filter((value): value is number => value !== undefined);
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

async function* splitEveryByte(value: Uint8Array): AsyncIterable<Uint8Array> {
  for (let index = 0; index < value.byteLength; index += 1) {
    yield value.slice(index, index + 1);
  }
}
