import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MESSAGES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";

describe("official Anthropic Messages SDK via Mock Copilot Replay", () => {
  let harness: ReplaySdkHarness;
  let client: Anthropic;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    client = new Anthropic({
      apiKey: "local-gateway",
      baseURL: harness.baseUrl,
      fetch: harness.fetch,
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream messages from recorded upstream replay", async () => {
    const message = await client.messages.create({
      model: MESSAGES_MODEL,
      max_tokens: 32,
      messages: [{ role: "user", content: "sdk-messages-nonstream" }],
    });

    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.content[0]?.type).toBe("text");
    if (message.content[0]?.type === "text") {
      expect(message.content[0].text).toBe("pong");
    }
    expect(message.stop_reason).toBe("end_turn");

    const receipt = harness.receipts.find((r) => r.matchedCaseId === "replay.messages.plain-text.nonstream");
    expect(receipt).toBeDefined();
    expect(receipt?.method).toBe("POST");
    expect(receipt?.path).toBe("/v1/messages");
    expect(receipt?.model).toBe(MESSAGES_MODEL);
    expect(receipt?.stream).toBe(false);
  });

  it("iterates stream messages from recorded upstream replay", async () => {
    const stream = await client.messages.create({
      model: MESSAGES_MODEL,
      max_tokens: 32,
      messages: [{ role: "user", content: "sdk-messages-stream" }],
      stream: true,
    });

    const eventTypes: string[] = [];
    let text = "";
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
      }
    }

    expect(eventTypes[0]).toBe("message_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes.at(-1)).toBe("message_stop");
    expect(text).toBe("pong");

    const receipt = harness.receipts.find((r) => r.matchedCaseId === "replay.messages.plain-text.stream");
    expect(receipt).toBeDefined();
    expect(receipt?.method).toBe("POST");
    expect(receipt?.path).toBe("/v1/messages");
    expect(receipt?.model).toBe(MESSAGES_MODEL);
    expect(receipt?.stream).toBe(true);
  });
});
