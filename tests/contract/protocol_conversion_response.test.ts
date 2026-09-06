import { describe, expect, it } from "vitest";
import { convertBufferedResponse } from "../../src/protocols/conversion/buffered.js";
import { convertProtocolStream } from "../../src/protocols/conversion/stream.js";
import type {
  ConvertedStreamEmission,
  InferenceProtocol,
} from "../../src/protocols/conversion/types.js";
import { createNativeMessagesStreamResponse } from "../../src/protocols/anthropic_messages/native.js";
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
