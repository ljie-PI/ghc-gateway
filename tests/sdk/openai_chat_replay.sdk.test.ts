import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";

describe("official OpenAI Chat SDK via Mock Copilot Replay", () => {
  let harness: ReplaySdkHarness;
  let client: OpenAI;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    client = new OpenAI({
      apiKey: "local-gateway",
      baseURL: harness.openAiBaseUrl,
      fetch: harness.fetch,
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream chat completion from recorded upstream replay", async () => {
    const nonstream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-nonstream" }],
    });

    expect(nonstream.choices[0]?.message.content).toBe("pong");

    // Assert that the replay server received exactly the matched request
    const receipt = harness.receipts.find((r) => r.matchedCaseId === "replay.chat.plain-text.nonstream");
    expect(receipt).toBeDefined();
    expect(receipt?.method).toBe("POST");
    expect(receipt?.path).toBe("/chat/completions");
    expect(receipt?.model).toBe(CHAT_MODEL);
    expect(receipt?.stream).toBe(false);
  });

  it("iterates stream chat completion from recorded upstream replay", async () => {
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-stream" }],
      stream: true,
    });

    const chunks: string[] = [];
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta.content;
      if (content) {
        chunks.push(content);
      }
    }

    expect(chunks.join("")).toBe("pong");

    const receipt = harness.receipts.find((r) => r.matchedCaseId === "replay.chat.plain-text.stream");
    expect(receipt).toBeDefined();
    expect(receipt?.method).toBe("POST");
    expect(receipt?.path).toBe("/chat/completions");
    expect(receipt?.model).toBe(CHAT_MODEL);
    expect(receipt?.stream).toBe(true);
  });
});
