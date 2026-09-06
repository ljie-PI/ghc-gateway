import { describe, expect, it } from "vitest";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";
import { anthropicGateway, anthropicRequest, sse } from "./anthropic_harness.js";

const decoder = new TextDecoder();

describe("Anthropic stream lifecycle", () => {
  it("omits nonportable thinking signatures without changing successful terminal semantics", async () => {
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        sse({
          id: "chunk_1",
          choices: [{
            delta: { thinking_blocks: [{ type: "thinking", thinking: "signed plan", signature: "sigT" }] },
            finish_reason: "stop",
          }],
        }),
        new TextEncoder().encode("data: [DONE]\n\n"),
      ],
    });
    const { gw, close } = await anthropicGateway({ backend });
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
    const backend = new ScriptedCopilotBackend({
      chatStream: [
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
      ],
    });
    const { gw, close } = await anthropicGateway({ backend });
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
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        sse({ id: "chunk_1", choices: [{ delta: { reasoning_content: "plan" } }] }),
        sse({ id: "chunk_2", choices: [{ delta: { content: "hé" } }] }),
        sse({ id: "chunk_3", choices: [{ delta: { tool_calls: [{ id: "call.1__thought__sigA", type: "function", function: { name: "lookup", arguments: "{\"a\":" } }] } }] }),
        sse({ id: "chunk_4", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
        sse({ id: "chunk_5", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, cache_read_input_tokens: 2 } }),
        new TextEncoder().encode("data: [DONE]\n\n"),
      ],
    });
    const { gw, close } = await anthropicGateway({
      backend,
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
      expect(usageUpdates).toMatchObject([{
        protocol: "anthropic",
        outcome: "success",
        inputTokens: 8,
        outputTokens: 4,
        cacheTokens: 2,
      }]);
    } finally {
      await close();
    }
  });

  it("classifies post-commit parser failures without synthetic success terminals", async () => {
    const usageUpdates: UsageUpdate[] = [];
    async function* brokenStream(): AsyncIterable<Uint8Array> {
      yield sse({ id: "chunk_1", choices: [{ delta: { content: "partial" } }] });
      throw new TypeError("network failed");
    }
    const backend = new ScriptedCopilotBackend({ chatStream: brokenStream() });
    const { gw, close } = await anthropicGateway({ backend, usageUpdates });
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

  it("keeps synthetic message_start behind the first semantic deadline", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1;
    runtime.timeouts.streamIdleMs = 60_000;
    const backend = new ScriptedCopilotBackend({
      chatStream: (request) => commentThenStall(request.signal),
    });
    const { gw, close } = await anthropicGateway({ backend, runtime, usageUpdates });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
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
    runtime.timeouts.firstByteMs = 1;
    runtime.timeouts.streamIdleMs = 60_000;
    const backend = new ScriptedCopilotBackend({
      chatStream: (request) => emptyChunkThenStall(request.signal),
    });
    const { gw, close } = await anthropicGateway({ backend, runtime, usageUpdates });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
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
    runtime.timeouts.streamIdleMs = 1;
    const backend = new ScriptedCopilotBackend({
      chatStream: contentThenStall(),
    });
    const { gw, close } = await anthropicGateway({ backend, runtime, usageUpdates });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }));
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

async function* commentThenStall(signal: AbortSignal): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(": keepalive\n\n");
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

async function* contentThenStall(): AsyncIterable<Uint8Array> {
  yield sse({ id: "chunk_1", choices: [{ delta: { content: "partial" } }] });
  await new Promise<void>(() => undefined);
}

async function* emptyChunkThenStall(signal: AbortSignal): AsyncIterable<Uint8Array> {
  yield sse({ id: "chunk_empty", choices: [] });
  yield sse({ id: "chunk_empty_object", choices: [{}] });
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}
