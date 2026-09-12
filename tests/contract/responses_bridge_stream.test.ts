import { describe, expect, it } from "vitest";
import {
  convertChatStream,
  encodeManagedResponseId,
  type ResponsesBridgeStreamContext,
  type ResponsesStreamEmission,
} from "../../src/protocols/responses/bridge_stream.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import type { ResponsesRequest } from "../../src/protocols/responses/dto.js";
import { buildRequestToolContext } from "../../src/protocols/responses/tool_context.js";
import {
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";

const LIMITS = { maxBytes: 65_536, maxDepth: 64 } as const;

describe("Responses bridge stream conversion", () => {
  it("primes the initial response from the first chunk, handles empty/non-object chunks, and never parses raw SSE", async () => {
    const context = streamContext({
      model: "gpt-4.1",
      request: {
        model: "gpt-4.1",
        instructions: "sys",
        temperature: 0.2,
        text: { format: { type: "text" } },
        metadata: { trace: "a" },
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      },
      uuids: ["00000000-0000-4000-8000-000000000001"],
    });
    const emissions = await collect(convertChatStream(stream([
      { payload: jsonValue("data: {\"id\":\"not-a-chat-chunk\"}\n\n") },
    ]), context));

    expect(types(emissions)).toEqual(["response.created", "response.in_progress", "response.completed"]);
    const created = eventJson(emissions[0]);
    expect(created).toMatchObject({
      type: "response.created",
      sequence_number: 1,
      response: {
        id: managed("resp_00000000-0000-4000-8000-000000000001", "openai", "gpt-4.1"),
        object: "response",
        created_at: 1_700_000_000,
        status: "in_progress",
        instructions: "sys",
        max_output_tokens: null,
        model: "gpt-4.1",
        output: [],
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: true,
        tool_choice: "auto",
        top_p: 1,
        temperature: 0.2,
        text: { format: { type: "text" } },
        metadata: { trace: "a" },
      },
    });
    expect((eventJson(emissions[2]).response as { output: unknown[] }).output).toEqual([]);

    const alreadyManaged = managed("chatcmpl_1", "openai", "gpt-4.1");
    expect(encodeManagedResponseId(alreadyManaged, context)).toBe(alreadyManaged);

    const empty = await collect(convertChatStream(stream([]), streamContext({
      request: { model: "gpt-4.1", input: "hi" },
      uuids: ["00000000-0000-4000-8000-000000000002"],
    })));
    expect(types(empty)).toEqual(["response.created", "response.in_progress", "response.completed"]);
  });

  it("emits independent reasoning and text lifecycles with ordered checkpoints and sequence numbers", async () => {
    const context = streamContext({
      request: { model: "gpt-4.1", input: "hi" },
      uuids: [
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000011",
      ],
    });
    const emissions = await collect(convertChatStream(stream([
      chunk({
        id: "chatcmpl_reason",
        choices: [{ delta: { role: "assistant", reasoning_content: "think" }, finish_reason: null }],
      }),
      chunk({
        choices: [{
          delta: {
            content: "hello",
            annotations: [{ type: "url_citation", start_index: 0, end_index: 5, url: "https://example.test", title: "Example" }],
          },
          finish_reason: "stop",
        }],
      }),
    ]), context));

    expect(types(emissions)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.annotation.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(sequences(emissions)).toEqual([...Array.from({ length: emissions.length }, (_unused, index) => index + 1)]);
    const checkpoints = emissions.filter((emission) => emission.kind === "checkpoint");
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((emission) => eventJson(emission).type)).toEqual([
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect((checkpoints[0] as Extract<ResponsesStreamEmission, { kind: "checkpoint" }>).historyRecord.output)
      .toHaveLength(1);
    expect((checkpoints[1] as Extract<ResponsesStreamEmission, { kind: "checkpoint" }>).historyRecord.output)
      .toHaveLength(2);
    expect((eventJson(emissions.at(-1)).response as { output: Array<{ id: string; type: string }> }).output)
      .toEqual([
        expect.objectContaining({ type: "reasoning", id: "rs_00000000-0000-4000-8000-000000000010" }),
        expect.objectContaining({ type: "message", id: "msg_00000000-0000-4000-8000-000000000011" }),
      ]);
  });

  it("restores function, namespace, custom, tool-search, sparse, ambiguous, and late tool calls", async () => {
    const context = streamContext({
      request: {
        model: "gpt-4.1",
        input: "use tools",
        tools: [
          { type: "function", name: "lookup", parameters: {} },
          { type: "namespace", name: "ns", tools: [{ type: "function", name: "child", parameters: {} }] },
          { type: "custom", name: "render" },
          { type: "tool_search" },
        ],
      },
    });
    const emissions = await collect(convertChatStream(stream([
      chunk({
        id: "chatcmpl_tools",
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: "call_func", type: "function", function: { name: "lookup", arguments: "abcdefghijklmnop" } },
              { index: 2, id: "call_ns", type: "function", function: { name: "ns__child", arguments: "{\"long\":\"12345678901\"}" } },
            ],
          },
          finish_reason: null,
        }],
      }),
      chunk({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: "QRST" } },
              { index: 0, id: "call_other", type: "function", function: { name: "lookup", arguments: "x" } },
              { index: 0, function: { arguments: "SKIP" } },
              { index: 3, id: "call_custom", type: "function", function: { name: "render", arguments: "{\"input\":\"custom payload\"}" } },
              { index: 4, id: "call_search", type: "function", function: { name: "tool_search", arguments: "{\"query\":\"docs\",\"limit\":2}" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      }),
      chunk({
        choices: [{
          delta: {},
          message: {
            tool_calls: [
              { index: 5, id: "call_late", type: "function", function: { name: "lookup", arguments: "late-arguments" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      }),
    ]), context));

    const toolEvents = emissions.map(eventJson).filter((event) => String(event.type).includes("tool_call")
      || String(event.type).includes("function_call"));
    expect(toolEvents.some((event) => JSON.stringify(event).includes("SKIP"))).toBe(false);
    for (const event of toolEvents.filter((item) => item.type === "response.function_call_arguments.delta"
      || item.type === "response.custom_tool_call_input.delta")) {
      expect((event.delta as string).length).toBeLessThanOrEqual(10);
    }
    expect(toolEvents.filter((event) => event.type === "response.function_call_arguments.done")
      .map((event) => event.name)).toEqual(["lookup", "child", "lookup", "tool_search", "lookup"]);

    const completed = eventJson(emissions.at(-1)).response as { output: Array<Record<string, unknown>> };
    expect(completed.output).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call_func", name: "lookup", arguments: "abcdefghijklmnopQRST" }),
      expect.objectContaining({ type: "function_call", call_id: "call_ns", name: "child", namespace: "ns" }),
      expect.objectContaining({ type: "function_call", call_id: "call_other", name: "lookup", arguments: "x" }),
      expect.objectContaining({ type: "custom_tool_call", call_id: "call_custom", name: "render", input: "custom payload" }),
      expect.objectContaining({ type: "tool_search_call", call_id: "call_search", execution: "client", arguments: { query: "docs", limit: 2 } }),
      expect.objectContaining({ type: "function_call", call_id: "call_late", name: "lookup", arguments: "late-arguments" }),
    ]);
    expect(completed.output.some((item) => item.type === "message")).toBe(false);
    expect(types(emissions)).toContain("response.custom_tool_call_input.done");
    expect(types(emissions).filter((type) => type === "response.output_item.done")).toHaveLength(6);
  });

  it("accumulates provider fields and usage in the completed response", async () => {
    const context = streamContext({
      request: { model: "gpt-4.1", input: "hi" },
      uuids: ["00000000-0000-4000-8000-000000000020"],
    });
    const emissions = await collect(convertChatStream(stream([
      chunk({
        id: "chatcmpl_provider",
        provider_specific_fields: { a: 1, keep: ["first"] },
        choices: [{ delta: { content: "x", provider_specific_fields: { a: 2, b: true } }, finish_reason: null }],
      }),
      chunk({
        provider_specific_fields: { keep: ["last"] },
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    ]), context));

    expect(eventJson(emissions.at(-1)).response).toMatchObject({
      usage: { input_tokens: 3, output_tokens: 4 },
      _hidden_params: {
        provider_specific_fields: {
          a: 2,
          b: true,
          keep: ["last"],
        },
      },
    });
  });

  it("captures stream created_at once for created, in-progress, and completed responses", async () => {
    let calls = 0;
    const context = streamContext({
      request: { model: "gpt-4.1", input: "hi" },
      uuids: ["00000000-0000-4000-8000-000000000040"],
    });
    const emissions = await collect(convertChatStream(stream([
      chunk({ id: "chatcmpl_clock", choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }),
    ]), {
      ...context,
      nowUnixSeconds: () => {
        calls += 1;
        return calls === 1 ? 1_700_000_000 : 1_800_000_000;
      },
    }));

    expect(calls).toBe(1);
    expect(eventJson(emissions[0]).response).toMatchObject({ created_at: 1_700_000_000 });
    expect(eventJson(emissions[1]).response).toMatchObject({ created_at: 1_700_000_000 });
    expect(eventJson(emissions.at(-1)).response).toMatchObject({ created_at: 1_700_000_000 });
  });

  it("propagates exceptions without synthesizing response.failed", async () => {
    const failure = new Error("boom");
    const iterator = convertChatStream(throwingChunks(failure), streamContext({
      request: { model: "gpt-4.1", input: "hi" },
    }))[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBe(failure);
  });

  it("is pull-based and returns the upstream iterator when the consumer stops", async () => {
    let reads = 0;
    let returned = false;
    const source: AsyncIterable<{ payload: WireJsonObject }> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            reads += 1;
            return { done: false, value: chunk({ id: "chatcmpl_pull", choices: [{ delta: { content: "x" } }] }) };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const iterator = convertChatStream(source, streamContext({
      request: { model: "gpt-4.1", input: "hi" },
      uuids: ["00000000-0000-4000-8000-000000000030"],
    }))[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.kind).toBe("event");
    expect(reads).toBe(1);
    expect((await iterator.next()).value?.kind).toBe("event");
    expect(reads).toBe(1);
    await iterator.return?.();
    expect(returned).toBe(true);
  });

  async function collect(source: AsyncIterable<ResponsesStreamEmission>): Promise<ResponsesStreamEmission[]> {
    const output: ResponsesStreamEmission[] = [];
    for await (const emission of source) {
      output.push(emission);
    }
    return output;
  }

  async function* stream(chunks: readonly { readonly payload: WireJson }[]): AsyncIterable<{ readonly payload: WireJson }> {
    for (const value of chunks) {
      yield value;
    }
  }

  async function* throwingChunks(error: Error): AsyncIterable<{ payload: WireJson }> {
    if (error.message === "__never__") {
      yield { payload: null };
    }
    throw error;
  }

  function streamContext(options: {
    readonly request: Record<string, unknown>;
    readonly model?: string;
    readonly uuids?: readonly string[];
  }): ResponsesBridgeStreamContext {
    const request = requestFromJson(options.request);
    const uuids = [...(options.uuids ?? [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000007",
    ])];
    return {
      originalRequest: request,
      toolContext: buildRequestToolContext(request),
      model: options.model ?? "gpt-4.1",
      nowUnixSeconds: () => 1_700_000_000,
      uuid: () => uuids.shift() ?? "00000000-0000-4000-8000-ffffffffffff",
      customLlmProvider: "openai",
      modelId: "gpt-4.1",
    };
  }

  function chunk(value: Record<string, unknown>): { payload: WireJsonObject } {
    const parsed = jsonValue(value);
    expect(isWireJsonObject(parsed)).toBe(true);
    return { payload: parsed as WireJsonObject };
  }

  function requestFromJson(value: Record<string, unknown>): ResponsesRequest {
    const parsed = jsonValue(value);
    expect(isWireJsonObject(parsed)).toBe(true);
    return decodeResponsesRequest(parsed as WireJsonObject);
  }

  function jsonValue(value: unknown): WireJson {
    const parsed = parseWireJson(new TextEncoder().encode(JSON.stringify(value)), LIMITS);
    return parsed;
  }

  function eventJson(emission: ResponsesStreamEmission | undefined): Record<string, unknown> {
    expect(emission).toBeDefined();
    return JSON.parse(new TextDecoder().decode(serializeWireJson(emission?.event as WireJsonObject))) as Record<string, unknown>;
  }

  function types(emissions: readonly ResponsesStreamEmission[]): string[] {
    return emissions.map((emission) => {
      const value = memberValues(emission.event, "type")[0];
      expect(typeof value).toBe("string");
      return value as string;
    });
  }

  function sequences(emissions: readonly ResponsesStreamEmission[]): number[] {
    return emissions.map((emission) => {
      const value = eventJson(emission).sequence_number;
      expect(typeof value).toBe("number");
      return value as number;
    });
  }

  function managed(id: string, provider: string, modelId: string): string {
    return `resp_${Buffer.from(
      `litellm:custom_llm_provider:${provider};model_id:${modelId};response_id:${id}`,
      "utf8",
    ).toString("base64")}`;
  }
});
