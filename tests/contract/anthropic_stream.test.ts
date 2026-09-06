import { describe, expect, it } from "vitest";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";
import { anthropicGateway, anthropicRequest, sse } from "./anthropic_harness.js";

const decoder = new TextDecoder();

describe("Anthropic stream lifecycle", () => {
  it("emits signed thinking blocks with Python-compatible SSE text", async () => {
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
        "event: content_block_start\ndata: {\"type\": \"content_block_start\", \"index\": 0, \"content_block\": {\"type\": \"thinking\", \"thinking\": \"signed plan\", \"signature\": \"sigT\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\": \"content_block_delta\", \"index\": 0, \"delta\": {\"type\": \"signature_delta\", \"signature\": \"sigT\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\": \"content_block_stop\", \"index\": 0}\n\n",
        "event: message_delta\ndata: {\"type\": \"message_delta\", \"delta\": {\"stop_reason\": \"end_turn\"}, \"usage\": {\"input_tokens\": 0, \"output_tokens\": 0}}\n\n",
        "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n",
      ].join(""));
    } finally {
      await close();
    }
  });

  it("uses only the last tool-bearing choice while preserving text from all choices", async () => {
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
      const text = await response.text();
      expect(text).toContain("\"text\": \"A\"");
      expect(text).toContain("\"text\": \"B\"");
      expect(text).toContain("\"id\": \"call_second\"");
      expect(text).toContain("\"name\": \"second\"");
      expect(text).toContain("\"partial_json\": \"{\\\"y\\\":2}\"");
      expect(text).not.toContain("call_first");
      expect(text).not.toContain("\"name\": \"first\"");
      expect(text).not.toContain("\"partial_json\": \"{\\\"x\\\":1}\"");
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
      expect(await response.text()).toBe([
        "event: message_start\ndata: {\"type\": \"message_start\", \"message\": {\"id\": \"msg_00000000-0000-4000-8000-0000000000aa\", \"type\": \"message\", \"role\": \"assistant\", \"content\": [], \"model\": \"gpt\", \"stop_reason\": null, \"stop_sequence\": null, \"usage\": {\"input_tokens\": 0, \"output_tokens\": 0, \"cache_creation_input_tokens\": 0, \"cache_read_input_tokens\": 0}}}\n\n",
        "event: content_block_start\ndata: {\"type\": \"content_block_start\", \"index\": 0, \"content_block\": {\"type\": \"thinking\", \"thinking\": \"\", \"signature\": \"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\": \"content_block_delta\", \"index\": 0, \"delta\": {\"type\": \"thinking_delta\", \"thinking\": \"plan\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\": \"content_block_stop\", \"index\": 0}\n\n",
        "event: content_block_start\ndata: {\"type\": \"content_block_start\", \"index\": 1, \"content_block\": {\"type\": \"text\", \"text\": \"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\": \"content_block_delta\", \"index\": 1, \"delta\": {\"type\": \"text_delta\", \"text\": \"h\\u00e9\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\": \"content_block_stop\", \"index\": 1}\n\n",
        "event: content_block_start\ndata: {\"type\": \"content_block_start\", \"index\": 2, \"content_block\": {\"type\": \"tool_use\", \"id\": \"call_1\", \"name\": \"lookup\", \"input\": {}, \"provider_specific_fields\": {\"signature\": \"sigA\"}}}\n\n",
        "event: content_block_delta\ndata: {\"type\": \"content_block_delta\", \"index\": 2, \"delta\": {\"type\": \"input_json_delta\", \"partial_json\": \"{\\\"a\\\":\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\": \"content_block_delta\", \"index\": 2, \"delta\": {\"type\": \"input_json_delta\", \"partial_json\": \"1}\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\": \"content_block_stop\", \"index\": 2}\n\n",
        "event: message_delta\ndata: {\"type\": \"message_delta\", \"delta\": {\"stop_reason\": \"tool_use\"}, \"usage\": {\"input_tokens\": 8, \"output_tokens\": 4, \"cache_read_input_tokens\": 2}}\n\n",
        "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n",
      ].join(""));
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
});
