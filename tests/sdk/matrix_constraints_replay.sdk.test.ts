import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";

describe("nine-cell matrix constraints, reasoning & usage execution via Mock Copilot Replay", () => {
  let harness: ReplaySdkHarness;
  let openai: OpenAI;
  let anthropic: Anthropic;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    openai = new OpenAI({
      apiKey: "local-gateway",
      baseURL: harness.openAiBaseUrl,
      fetch: harness.fetch,
      maxRetries: 0,
    });
    anthropic = new Anthropic({
      apiKey: "local-gateway",
      baseURL: harness.baseUrl,
      fetch: harness.fetch,
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("Chat Downstream Constraints & Usage", () => {
    it("C -> C with reasoning_effort and usage observation", async () => {
      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }],
        reasoning_effort: "low",
      });
      expect(resp.choices[0]?.message.content?.length).toBeGreaterThan(0);
      expect(resp.usage).toBeDefined();
      expect(resp.usage?.prompt_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.reasoning-effort.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("C -> R with reasoning_effort and usage observation", async () => {
      const resp = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }],
        reasoning_effort: "low",
      });
      expect(resp.choices[0]?.message.content?.length).toBeGreaterThan(0);
      expect(resp.usage).toBeDefined();
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.reasoning-effort.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("C -> M with reasoning_effort and usage observation", async () => {
      const resp = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }],
        reasoning_effort: "low",
      });
      expect(resp.choices[0]?.message.content?.length).toBeGreaterThan(0);
      expect(resp.usage).toBeDefined();
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.reasoning-effort.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });
  });

  describe("Messages Downstream Constraints & Usage", () => {
    it("M -> C with output_config effort and usage observation", async () => {
      const resp = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }],
        output_config: { effort: "low" },
      });
      expect(resp.content[0]?.type).toBe("text");
      expect(resp.usage.input_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.reasoning-effort.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("M -> R with output_config effort and usage observation", async () => {
      const resp = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }],
        output_config: { effort: "low" },
      });
      expect(resp.content[0]?.type).toBe("text");
      expect(resp.usage.input_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.reasoning-effort.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("M -> M with output_config effort and usage observation", async () => {
      const resp = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "Explain quantum entanglement in 20 words." }],
        output_config: { effort: "low" },
      });
      expect(resp.content.length).toBeGreaterThan(0);
      expect(resp.usage.input_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.reasoning-effort.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });
  });

  describe("Responses Downstream Constraints & Usage", () => {
    it("R -> C with reasoning.effort and usage observation", async () => {
      const resp = await openai.responses.create({
        model: CHAT_MODEL,
        input: "Explain quantum entanglement in 20 words.",
        reasoning: { effort: "low" },
        max_output_tokens: 64,
      });
      expect(resp.output_text?.length).toBeGreaterThan(0);
      expect(resp.usage?.input_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.reasoning-effort.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("R -> R with reasoning.effort and usage observation", async () => {
      const resp = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: "Explain quantum entanglement in 20 words.",
        reasoning: { effort: "low" },
        max_output_tokens: 64,
      });
      expect(resp.output_text?.length).toBeGreaterThan(0);
      expect(resp.usage?.input_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.reasoning-effort.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("R -> M with reasoning.effort and usage observation", async () => {
      const resp = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: "Explain quantum entanglement in 20 words.",
        reasoning: { effort: "low" },
        max_output_tokens: 64,
      });
      expect(resp.output_text?.length).toBeGreaterThan(0);
      expect(resp.usage?.input_tokens).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.reasoning-effort.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });
  });
});
