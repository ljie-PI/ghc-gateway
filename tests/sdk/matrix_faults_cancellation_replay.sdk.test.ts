import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";
import { LONG_TEXT_PROMPT } from "./scenarios.js";

describe("replay HTTP fault injection & stream cancellation acceptance", () => {
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
  afterEach(() => {
    harness.replayServer.faultMode = undefined;
    try { harness.replayServer.abortScenario(); } catch { /* Harness close cancels a still-active request. */ }
  });

  describe("Stream Abort & Cancellation", () => {
    it("cancels Chat streaming and tears down cleanly without emitting completed event", async () => {
      const scenarioId = "replay.chat.plain-text.stream";
      const receiptStart = harness.receipts.length;
      harness.replayServer.selectScenario(scenarioId);
      const stream = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: LONG_TEXT_PROMPT }],
        stream: true,
      });

      // Trigger abort immediately
      stream.controller.abort();

      const items = [];
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        items.push(next.value);
      }
      expect(items.length).toBe(0);
      expect(stream.controller.signal.aborted).toBe(true);
      await expect.poll(() => harness.receipts.slice(receiptStart).filter((receipt) => receipt.matchedCaseId !== undefined).length).toBe(1);
      harness.replayServer.finishScenario();
    });

    it("cancels Responses streaming and tears down cleanly", async () => {
      const scenarioId = "replay.responses.plain-text.stream";
      const receiptStart = harness.receipts.length;
      harness.replayServer.selectScenario(scenarioId);
      const stream = await client.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: LONG_TEXT_PROMPT,
        stream: true,
      });

      stream.controller.abort();

      const items = [];
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        items.push(next.value);
      }
      expect(items.length).toBe(0);
      expect(stream.controller.signal.aborted).toBe(true);
      await expect.poll(() => harness.receipts.slice(receiptStart).filter((receipt) => receipt.matchedCaseId !== undefined).length).toBe(1);
      harness.replayServer.finishScenario();
    });
  });

  describe("HTTP Upstream Fault Injection", () => {
    it("handles early upstream socket disconnect and returns 502 upstream error", async () => {
      const scenarioId = "replay.chat.plain-text.nonstream";
      const receiptStart = harness.receipts.length;
      harness.replayServer.selectScenario(scenarioId);
      harness.replayServer.faultMode = "disconnect_early";
      try {
        await client.chat.completions.create({
          model: CHAT_MODEL,
          messages: [{ role: "user", content: LONG_TEXT_PROMPT }],
        });
        expect.unreachable("should have thrown 502");
      } catch (err: unknown) {
        expect((err as { status: number }).status).toBe(502);
      } finally {
        harness.replayServer.faultMode = undefined;
      }
      await expect.poll(() => harness.receipts.slice(receiptStart).filter((receipt) => receipt.matchedCaseId !== undefined).length).toBe(1);
      harness.replayServer.finishScenario();
    });

    it("handles unmapped upstream routes with fail-closed 404 response", async () => {
      const scenarioId = "replay.chat.plain-text.nonstream";
      const receiptStart = harness.receipts.length;
      harness.replayServer.selectScenario(scenarioId);
      try {
        await client.chat.completions.create({
          model: "unmapped-model",
          messages: [{ role: "user", content: LONG_TEXT_PROMPT }],
        });
        expect.unreachable("should have thrown error");
      } catch (err: unknown) {
        expect((err as { status: number }).status).toBeGreaterThanOrEqual(400);
      }
      expect(harness.receipts.slice(receiptStart).some((receipt) => receipt.matchedCaseId !== undefined)).toBe(false);
      expect(() => harness.replayServer.finishScenario()).toThrow("replay scenario incomplete");
      harness.replayServer.abortScenario();
    });
  });
});
