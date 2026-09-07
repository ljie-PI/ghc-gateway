import { describe, expect, it } from "vitest";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";
import { anthropicGateway, anthropicRequest } from "./anthropic_harness.js";

describe("Anthropic non-stream response", () => {
  it("rejects multiple choices and invalid complete tool arguments without repair", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      chat: {
        status: 200,
        headers: new Headers(),
        body: new TextEncoder().encode(JSON.stringify({
          id: "chatcmpl_42",
          model: "gpt",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                reasoning_content: "fallback thought",
                content: "answer",
                tool_calls: [{
                  id: "call.bad__thought__sig",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"city\":\"Zürich\"," },
                  thought_signature: "signed",
                }],
              },
            },
            {
              finish_reason: "stop",
              message: {
                thinking_blocks: [
                  { type: "thinking", thinking: "   ", signature: "drop" },
                  { type: "redacted_thinking", data: "" },
                  { type: "thinking", thinking: "second thought", signature: "sig2" },
                ],
                content: "",
              },
            },
          ],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 7,
            _cache_read_input_tokens: 5,
            prompt_tokens_details: {
              cache_write_tokens: 3,
              web_search_requests: 2,
            },
          },
        })),
      },
    });
    const { gw, close } = await anthropicGateway({ backend, usageUpdates });
    try {
      const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(response.status).toBe(502);
      expect(response.headers.get("request-id")).toBe("req_test_1");
      expect(JSON.parse(await response.text())).toMatchObject({
        type: "error",
        error: {
          type: "api_error",
          message: "invalid upstream response",
        },
      });
      expect(usageUpdates).toMatchObject([{
        protocol: "anthropic",
        outcome: "upstream_error",
        resolvedModel: "gpt",
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
      }]);
    } finally {
      await close();
    }
  });

  it("rebuilds upstream HTTP errors with Anthropic's native error shape", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      chat: {
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        body: new TextEncoder().encode("{\"leak\":\"upstream\"}"),
      },
    });
    const { gw, close } = await anthropicGateway({ backend, usageUpdates });
    try {
      const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("120");
      expect(response.headers.get("request-id")).toBe("req_test_1");
      expect(await response.text()).toBe("{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"upstream request failed\"},\"request_id\":\"req_test_1\"}");
      expect(usageUpdates).toMatchObject([{
        protocol: "anthropic",
        outcome: "upstream_error",
        accountId: "github.com/1",
        resolvedModel: "gpt",
        requestCount: 1,
        errorCount: 1,
      }]);
    } finally {
      await close();
    }
  });
});
