import { describe, expect, it } from "vitest";
import { serializeAnthropicMessagesErrorBody, encodeAnthropicMessagesSseEvent } from "../../src/protocols/anthropic_messages/wire.js";

describe("Anthropic wire helpers", () => {
  it("uses native compact error JSON with request ID equality", () => {
    expect(serializeAnthropicMessagesErrorBody("invalid_request_error", "invalid request", "req_1")).toBe("{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid request\"},\"request_id\":\"req_1\"}");
  });

  it("uses Python default json.dumps spacing and ASCII escaping for SSE", () => {
    expect(new TextDecoder().decode(encodeAnthropicMessagesSseEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hé" },
    }))).toBe("event: content_block_delta\ndata: {\"type\": \"content_block_delta\", \"index\": 0, \"delta\": {\"type\": \"text_delta\", \"text\": \"h\\u00e9\"}}\n\n");
  });
});
