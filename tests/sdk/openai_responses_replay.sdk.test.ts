import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";

describe("official OpenAI Responses SDK via Mock Copilot Replay", () => {
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

  it("deserializes non-stream responses from recorded upstream replay", async () => {
    const nonstream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-nonstream",
    });

    expect(nonstream.output_text).toBe("pong");
    expect(nonstream.status).toBe("completed");

    const receipt = harness.receipts.find((r) => r.matchedCaseId === "replay.responses.plain-text.nonstream");
    expect(receipt).toBeDefined();
    expect(receipt?.method).toBe("POST");
    expect(receipt?.path).toBe("/responses");
    expect(receipt?.model).toBe(NATIVE_RESPONSES_MODEL);
    expect(receipt?.stream).toBe(false);
  });

  it("iterates stream responses from recorded upstream replay", async () => {
    const stream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-stream",
      stream: true,
    });

    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toContain("response.completed");

    const receipt = harness.receipts.find((r) => r.matchedCaseId === "replay.responses.plain-text.stream");
    expect(receipt).toBeDefined();
    expect(receipt?.method).toBe("POST");
    expect(receipt?.path).toBe("/responses");
    expect(receipt?.model).toBe(NATIVE_RESPONSES_MODEL);
    expect(receipt?.stream).toBe(true);
  });
});
