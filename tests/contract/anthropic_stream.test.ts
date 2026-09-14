import { createNativeMessagesStreamResponse } from "../../src/protocols/anthropic_messages/native.js";
import { createRequestAttempt } from "../../src/gateway/request_attempt.js";
import { getStreamExecutionHandle } from "../../src/gateway/stream_execution.js";
import { describe, expect, it } from "vitest";
import { jsonStream, assertTransportReleased, waitForHttp } from "../../scripts/tooling/test_support/http_copilot.js";
import type { HttpExpectation, HttpStreamControl } from "../../scripts/tooling/test_support/copilot_http.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";
import { anthropicGateway, anthropicRequest, sse } from "./anthropic_harness.js";

const decoder = new TextDecoder();

describe("Anthropic stream lifecycle", () => {
  it("omits nonportable thinking signatures without changing successful terminal semantics", async () => {
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      sse({
        id: "chunk_1",
        choices: [{
          delta: { thinking_blocks: [{ type: "thinking", thinking: "signed plan", signature: "sigT" }] },
          finish_reason: "stop",
        }],
      }),
      new TextEncoder().encode("data: [DONE]\n\n"),
    ]) } }];
    const { gw, close } = await anthropicGateway({ expectations });
    try {
      const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: true }));
      expect(await response.text()).toBe([
        "event: message_start\ndata: {\"type\": \"message_start\", \"message\": {\"id\": \"msg_00000000-0000-4000-8000-000000000001\", \"type\": \"message\", \"role\": \"assistant\", \"content\": [], \"model\": \"gpt\", \"stop_reason\": null, \"stop_sequence\": null, \"usage\": {\"input_tokens\": 0, \"output_tokens\": 0, \"cache_creation_input_tokens\": 0, \"cache_read_input_tokens\": 0}}}\n\n",
        "event: message_delta\ndata: {\"type\": \"message_delta\", \"delta\": {\"stop_reason\": \"end_turn\"}, \"usage\": {\"input_tokens\": 0, \"output_tokens\": 0}}\n\n",
        "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n",
      ].join(""));
    } finally {
      await close();
    }
  });

  it("rejects multi-choice streams instead of dropping one choice", async () => {
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      sse({
        id: "chunk_1",
        choices: [
          {
            delta: {
              content: "A",
              tool_calls: [{ id: "call_first", type: "function", function: { name: "first", arguments: "{\"x\":1}" } }],
            },
          },
          {
            delta: {
              content: "B",
              tool_calls: [{ id: "call_second", type: "function", function: { name: "second", arguments: "{\"y\":2}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      new TextEncoder().encode("data: [DONE]\n\n"),
    ]) } }];
    const { gw, close } = await anthropicGateway({ expectations });
    try {
      const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: true }));
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain("invalid upstream response");
      expect(text).not.toContain("event: message_stop");
    } finally {
      await close();
    }
  });

  it("emits Python-compatible SSE for block switches, signed thinking, delayed usage, and message_stop", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      sse({ id: "chunk_1", choices: [{ delta: { reasoning_content: "plan" } }] }),
      sse({ id: "chunk_2", choices: [{ delta: { content: "hé" } }] }),
      sse({ id: "chunk_3", choices: [{ delta: { tool_calls: [{ id: "call.1__thought__sigA", type: "function", function: { name: "lookup", arguments: "{\"a\":" } }] } }] }),
      sse({ id: "chunk_4", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
      sse({ id: "chunk_5", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, cache_read_input_tokens: 2 } }),
      new TextEncoder().encode("data: [DONE]\n\n"),
    ]) } }];
    const { gw, close } = await anthropicGateway({
      expectations,
      createUuid: (() => {
        const values = ["00000000-0000-4000-8000-0000000000aa"];
        return () => values.shift() ?? "00000000-0000-4000-8000-0000000000ff";
      })(),
      usageUpdates,
    });
    try {
      const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: true }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("request-id")).toBe("req_test_1");
      const text = await response.text();
      expect(text).toContain("\"text\": \"h\\u00e9\"");
      expect(text).toContain("\"id\": \"call.1__thought__sigA\"");
      expect(text).toContain("\"partial_json\": \"{\\\"a\\\":1}\"");
      expect(text).not.toContain("thinking_delta");
      expect(text).not.toContain("signature_delta");
      expect(text.match(/event: message_stop/gu)).toHaveLength(1);
      expect(text).toContain("\"cache_read_input_tokens\": 2");
      expect(text).toContain("\"input_tokens\": 8");
      expect(usageUpdates).toMatchObject([{
        protocol: "anthropic",
        outcome: "success",
        // Chat prompt 10 already includes cache-read 2; Messages wire remains 8.
        inputTokens: 10,
        outputTokens: 4,
        cacheTokens: 2,
      }]);
    } finally {
      await close();
    }
  });

  it("classifies post-commit parser failures without synthetic success terminals", async () => {
    const usageUpdates: UsageUpdate[] = [];
    let exchange: HttpStreamControl | undefined;
    const { gw, close } = await anthropicGateway({ usageUpdates, expectations: [{
      method: "POST", path: "/chat/completions", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (control) => {
        exchange = control;
        await control.write(sse({ id: "chunk_1", choices: [{ delta: { content: "partial" } }] }));
      } },
    }] });
    try {
      const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: true }));
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("expected stream body");
      }
      let text = "";
      await expect((async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            return;
          }
          text += decoder.decode(next.value, { stream: true });
          if (text.includes("event: content_block_delta")) exchange?.disconnect();
        }
      })()).rejects.toThrow();
      expect(text).toContain("event: content_block_delta");
      expect(text).not.toContain("event: message_stop");
      expect(text).not.toContain("event: error");
      expect(usageUpdates).toMatchObject([{
        protocol: "anthropic",
        outcome: "upstream_error",
      }]);
    } finally {
      await close();
    }
  });

  it("preserves native keepalive ordering while finalizing usage and iterator cleanup once", async () => {
    const usageUpdates: UsageUpdate[] = [];

    const records = [
      ": keepalive\n\n",
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":0}}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ];
    const opened = await anthropicGateway({
      usageUpdates, catalogFetch: nativeMessagesCatalog,
      expectations: [{ method: "POST", path: "/v1/messages", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
          for (const record of records) await exchange.write(new TextEncoder().encode(record));
          await exchange.waitForClose();
        } },
      }],
    });
    try {
      const response = await opened.gw.fetch(anthropicRequest({
        model: "claude-native",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(records.join(""));
      await waitForHttp(() => opened.upstream.streams[0]?.closed === true);
      expect(opened.upstream.streams[0]?.ended).toBe(false);
      assertTransportReleased(opened.backend);
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ outcome: "success", inputTokens: 2, outputTokens: 0 }]);
    } finally {
      await opened.close();
    }
  });

  it("returns the native Messages raw iterator once while preserving keepalive and terminal records", async () => {
    const records = [
      ": keepalive\n\n",
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":0}}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ];
    let returned = 0;
    let canceled = 0;
    let terminals = 0;
    const signal = new AbortController().signal;
    const response = await createNativeMessagesStreamResponse({
      upstream: { status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: { async *[Symbol.asyncIterator]() {
          try { for (const record of records) yield new TextEncoder().encode(record); }
          finally { returned += 1; }
        } },
        cancel: async () => { canceled += 1; },
      },
      scope: { requestId: "req_test_1", signal, deliverySignal: signal, config: defaultRuntimeConfigSnapshot(),
        attempt: createRequestAttempt({ requestId: "req_test_1", protocol: "anthropic", abortedErrorCount: 1 }),
      },
      onTerminal: (result) => {
        expect(result).toMatchObject({ kind: "success", usage: { inputTokens: 2, outputTokens: 0 } });
        terminals += 1;
      },
    });
    expect(await response.text()).toBe(records.join(""));
    await getStreamExecutionHandle(response)?.completion;
    expect({ returned, canceled, terminals }).toEqual({ returned: 1, canceled: 1, terminals: 1 });
  });

  it("times out a native keepalive-only stream before committing any stream bytes", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 250;
    runtime.timeouts.streamIdleMs = 60_000;
    let sent = false;
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/v1/messages", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
        await exchange.write(new TextEncoder().encode(": keepalive\n\n"));
        sent = true;
        await exchange.waitForClose();
      } },
    }];
    const opened = await anthropicGateway({
      expectations,
      runtime,
      usageUpdates,
      catalogFetch: nativeMessagesCatalog,
    });
    try {
      const pending = opened.gw.fetch(anthropicRequest({
        model: "claude-native",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
      await waitForHttp(() => sent);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"type\":\"error\",\"error\":{\"type\":\"timeout_error\",\"message\":\"upstream timeout\"},\"request_id\":\"req_test_1\"}",
      );
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ outcome: "timeout" }]);
    } finally {
      await opened.close();
    }
  });

  it("keeps synthetic message_start behind the first semantic deadline", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 250;
    runtime.timeouts.streamIdleMs = 60_000;
    let sent = false;
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
        await exchange.write(new TextEncoder().encode(": keepalive\n\n"));
        sent = true;
        await exchange.waitForClose();
      } },
    }];
    const { gw, close } = await anthropicGateway({ expectations, runtime, usageUpdates });
    try {
      const pending = gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
      await waitForHttp(() => sent);
      const response = await pending;
      expect(response.status).toBe(504);
      const body = await response.text();
      expect(body).toBe(
        "{\"type\":\"error\",\"error\":{\"type\":\"timeout_error\",\"message\":\"upstream timeout\"},\"request_id\":\"req_test_1\"}",
      );
      expect(body).not.toContain("message_start");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{
        accountId: "github.com/1",
        protocol: "anthropic",
        resolvedModel: "gpt",
        outcome: "timeout",
      }]);
    } finally {
      await close();
    }
  });

  it("does not let empty Chat chunks release synthetic Messages preambles", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 250;
    runtime.timeouts.streamIdleMs = 60_000;
    let sent = false;
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
        await exchange.write(sse({ id: "chunk_empty", choices: [] }));
        await exchange.write(sse({ id: "chunk_empty_object", choices: [{}] }));
        sent = true;
        await exchange.waitForClose();
      } },
    }];
    const { gw, close } = await anthropicGateway({ expectations, runtime, usageUpdates });
    try {
      const pending = gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
      await waitForHttp(() => sent);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.text()).not.toContain("message_start");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ outcome: "timeout" }]);
    } finally {
      await close();
    }
  });

  it("records a committed Messages idle timeout without message_stop", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.streamIdleMs = 250;
    let sent = false;
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
        await exchange.write(sse({ id: "chunk_1", choices: [{ delta: { content: "partial" } }] }));
        sent = true;
        await exchange.waitForClose();
      } },
    }];
    const { gw, close } = await anthropicGateway({ expectations, runtime, usageUpdates });
    try {
      const pending = gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
      await waitForHttp(() => sent);
      const response = await pending;
      const reader = response.body?.getReader();
      let delivered = "";
      await expect((async () => {
        for (;;) {
          const next = await reader?.read();
          if (next?.done !== false) {
            return;
          }
          delivered += decoder.decode(next.value, { stream: true });
        }
      })()).rejects.toThrow();
      expect(delivered).toContain("event: content_block_delta");
      expect(delivered).not.toContain("event: message_stop");
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ outcome: "timeout" }]);
    } finally {
      await close();
    }
  });
});

function nativeMessagesCatalog() {
  return {
    data: [{
      id: "claude-native",
      name: "Claude Native",
      vendor: "test",
      model_picker_enabled: true,
      capabilities: { type: "chat" },
      model_info: { supported_endpoints: ["/v1/messages"] },
    }],
  };
}
