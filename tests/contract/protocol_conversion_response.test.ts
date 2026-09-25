import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convertBufferedPlannedResponse, convertBufferedResponse } from "../../src/protocols/conversion/buffered.js";
import { convertProtocolStream } from "../../src/protocols/conversion/stream.js";
import type {
  ConvertedProtocolPlan,
  ConvertedStreamEmission,
  InferenceProtocol,
  ResponsesToolBindingLedger,
} from "../../src/protocols/conversion/types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const emptyBody = { kind: "object", members: [] } as const;

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

  it("restores buffered extended tools with cc-switch IDs and fallbacks", () => {
    const converted = convertBufferedPlannedResponse(encoder.encode(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [
            { id: "call_custom", type: "function", function: { name: "render", arguments: "{\"input\":\"hello\",\"extra\":1}" } },
            { id: "call_namespace", type: "function", function: { name: "ns__lookup", arguments: "{\"q\":\"x\"}" } },
            { id: "call_search", type: "function", function: { name: "tool_search", arguments: "raw-search" } },
            { id: "call_unknown", type: "function", function: { name: "invented", arguments: "{}" } },
          ],
        },
        finish_reason: "length",
      }],
    })), extendedPlan(), {
      maxBytes: 1_048_576,
      createUuid: () => "00000000-0000-4000-8000-000000000104",
      nowUnixSeconds: () => 1_700_000_000,
    });

    const output = decoded(converted.bytes).output as Array<Record<string, unknown>>;
    expect(output).toMatchObject([
      { id: "ctc_call_custom", type: "custom_tool_call", name: "render", input: "hello" },
      { id: "fc_call_namespace", type: "function_call", name: "lookup", namespace: "ns" },
      { type: "tool_search_call", arguments: { query: "raw-search" } },
      { id: "fc_call_unknown", type: "function_call", name: "invented" },
    ]);
    expect(output[2]).not.toHaveProperty("id");
    expect(decoded(converted.bytes).status).toBe("incomplete");
    expect(output.map((item) => item.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(converted.observations.degradations).toContain("request.option_omitted");
  });

  it.each([
    ["chat", chatExtendedStream, "a40adb87aaa0054c60d4c4ec43a89217ef3f9822602e6db2b69b727ec74cdc5e"],
    ["messages", messagesExtendedStream, "932d8a9da8c4a8a946ce5a21859c01c649dc6c231508aafe1ca2ffdd1fdb8246"],
  ] as const)("restores the complete ordered extended-tool %s stream", async (source, sourceWire, digest) => {
    const emissions = await collectStreamWithBindings(
      source,
      chunks(encoder.encode(sourceWire())),
      extendedBindings(),
    );
    expect(emissionDigest(emissions)).toBe(digest);
    expect(emissions.filter((emission) => emission.kind === "degradation")).toEqual(
      source === "chat" ? [{ kind: "degradation", ruleId: "request.option_omitted" }] : [],
    );
    expect(emissions.find((emission) => emission.kind === "terminal")).toEqual({
      kind: "terminal", terminal: source === "chat" ? "incomplete" : "completed",
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


function extendedPlan(): ConvertedProtocolPlan {
  return {
    kind: "converted",
    source: "responses",
    target: "chat",
    stream: false,
    requestModel: "target",
    request: {
      body: emptyBody,
      bytes: encoder.encode("{}"),
      stream: false,
      hasVisionInput: false,
      initiator: "user",
      messagesBetaFeatures: [],
      degradations: [],
      responseBindings: extendedBindings(),
    },
  };
}

function extendedBindings(): ResponsesToolBindingLedger {
  return {
    kind: "responses_extended_tools",
    bindings: [
      { kind: "custom", chatName: "render", sourceName: "render" },
      { kind: "namespace", chatName: "ns__lookup", sourceName: "lookup", namespace: "ns" },
      { kind: "tool_search", chatName: "tool_search", sourceName: "tool_search" },
    ],
    calls: [],
    results: [],
    chatMessages: [],
    chatPrefixMembers: [],
  };
}

async function collectStreamWithBindings(
  source: InferenceProtocol,
  bytes: AsyncIterable<Uint8Array>,
  responseBindings: ResponsesToolBindingLedger,
): Promise<ConvertedStreamEmission[]> {
  const output: ConvertedStreamEmission[] = [];
  let sequence = 0;
  const createUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  for await (const emission of convertProtocolStream(bytes, {
    ...streamContext(source, "responses"),
    createUuid,
    responseBindings,
  })) {
    output.push(emission);
  }
  return output;
}


function emissionDigest(emissions: readonly ConvertedStreamEmission[]): string {
  const normalized = emissions.map((emission) => emission.kind === "wire"
    ? { kind: "wire", text: decoder.decode(emission.bytes) }
    : emission);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function chatExtendedStream(): string {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl_extended",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { index: 0, id: "call_custom", type: "function", function: { name: "render", arguments: "{\"input\":\"hello\",\"extra\":1}" } },
          { index: 1, id: "call_namespace", type: "function", function: { name: "ns__lookup", arguments: "{\"q\":\"x\"}" } },
          { index: 2, id: "call_search", type: "function", function: { name: "tool_search", arguments: "raw-search" } },
          { index: 3, id: "call_unknown", type: "function", function: { name: "invented", arguments: "{}" } },
        ] },
        finish_reason: "length",
      }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function messagesExtendedStream(): string {
  const tools = [
    { index: 0, id: "call_custom", name: "render", arguments: "{\"input\":\"hello\"}" },
    { index: 1, id: "call_namespace", name: "ns__lookup", arguments: "{\"q\":\"x\"}" },
    { index: 2, id: "call_search", name: "tool_search", arguments: "{\"query\":\"mail\"}" },
  ];
  return [
    messageEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_extended", type: "message", role: "assistant", model: "source", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    ...tools.flatMap((tool) => [
      messageEvent("content_block_start", {
        type: "content_block_start", index: tool.index,
        content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
      }),
      messageEvent("content_block_delta", {
        type: "content_block_delta", index: tool.index,
        delta: { type: "input_json_delta", partial_json: tool.arguments },
      }),
      messageEvent("content_block_stop", { type: "content_block_stop", index: tool.index }),
    ]),
    messageEvent("message_delta", {
      type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    messageEvent("message_stop", { type: "message_stop" }),
  ].join("");
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

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}
