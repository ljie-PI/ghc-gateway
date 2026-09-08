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

describe("nine-cell matrix protocol execution via Mock Copilot Replay", () => {
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

  it("serves model listing for OpenAI and Anthropic shapes through production HTTP model catalog", async () => {
    const openAiModels = await openai.models.list();
    expect(openAiModels.data.map((m) => m.id)).toEqual([
      CHAT_MODEL,
      NATIVE_RESPONSES_MODEL,
      MESSAGES_MODEL,
    ]);

    const anthropicModels = await anthropic.models.list();
    expect(anthropicModels.data.map((m) => m.id)).toEqual([
      CHAT_MODEL,
      NATIVE_RESPONSES_MODEL,
      MESSAGES_MODEL,
    ]);

    // Verify receipt on replay server for /models
    const catalogReceipt = harness.receipts.find((r) => r.path === "/models");
    expect(catalogReceipt).toBeDefined();
    expect(catalogReceipt?.method).toBe("GET");
  });

  describe("C -> C (Chat -> Chat)", () => {
    it("nonstream", async () => {
      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "sdk-chat-nonstream" }],
      });
      expect(resp.choices[0]?.message.content).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.plain-text.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "sdk-chat-stream" }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
      }
      expect(text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.plain-text.stream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.stream).toBe(true);
    });
  });

  describe("C -> R (Chat -> Responses conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{ role: "user", content: "sdk-responses-nonstream" }],
      });
      expect(resp.choices[0]?.message.content).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.plain-text.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{ role: "user", content: "sdk-responses-stream" }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
      }
      expect(text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.plain-text.stream");
      expect(r?.path).toBe("/responses");
      expect(r?.stream).toBe(true);
    });
  });

  describe("C -> M (Chat -> Messages conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{ role: "user", content: "sdk-messages-nonstream" }],
      });
      expect(resp.choices[0]?.message.content).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.plain-text.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{ role: "user", content: "sdk-messages-stream" }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
      }
      expect(text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.plain-text.stream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.stream).toBe(true);
    });
  });

  describe("M -> C (Messages -> Chat conversion)", () => {
    it("nonstream", async () => {
      const resp = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "sdk-chat-nonstream" }],
      });
      expect(resp.content[0]?.type).toBe("text");
      if (resp.content[0]?.type === "text") {
        expect(resp.content[0].text).toBe("pong");
      }
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.plain-text.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("stream", async () => {
      const stream = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "sdk-chat-stream" }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      expect(text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.plain-text.stream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.stream).toBe(true);
    });
  });

  describe("M -> M (Messages -> Messages native)", () => {
    it("nonstream", async () => {
      const resp = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "sdk-messages-nonstream" }],
      });
      expect(resp.content[0]?.type).toBe("text");
      if (resp.content[0]?.type === "text") {
        expect(resp.content[0].text).toBe("pong");
      }
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.plain-text.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });

    it("stream", async () => {
      const stream = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "sdk-messages-stream" }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      expect(text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.plain-text.stream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.stream).toBe(true);
    });
  });

  describe("M -> R (Messages -> Responses conversion)", () => {
    it("nonstream", async () => {
      const resp = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "sdk-responses-nonstream" }],
      });
      expect(resp.content[0]?.type).toBe("text");
      if (resp.content[0]?.type === "text") {
        expect(resp.content[0].text).toBe("pong");
      }
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.plain-text.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("stream", async () => {
      const stream = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 32,
        messages: [{ role: "user", content: "sdk-responses-stream" }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      expect(text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.plain-text.stream");
      expect(r?.path).toBe("/responses");
      expect(r?.stream).toBe(true);
    });
  });

  describe("R -> C (Responses -> Chat conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.responses.create({
        model: CHAT_MODEL,
        input: "sdk-chat-nonstream",
      });
      expect(resp.output_text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.plain-text.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.responses.create({
        model: CHAT_MODEL,
        input: "sdk-chat-stream",
        stream: true,
      });
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      expect(types.some((t) => t === "response.completed" || t === "response.incomplete")).toBe(true);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.plain-text.stream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.stream).toBe(true);
    });
  });

  describe("R -> M (Responses -> Messages conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: "sdk-messages-nonstream",
      });
      expect(resp.output_text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.plain-text.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: "sdk-messages-stream",
        stream: true,
      });
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      expect(types).toContain("response.completed");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.plain-text.stream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.stream).toBe(true);
    });
  });

  describe("R -> R (Responses -> Responses native)", () => {
    it("nonstream", async () => {
      const resp = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: "sdk-responses-nonstream",
      });
      expect(resp.output_text).toBe("pong");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.plain-text.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: "sdk-responses-stream",
        stream: true,
      });
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      expect(types).toContain("response.completed");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.plain-text.stream");
      expect(r?.path).toBe("/responses");
      expect(r?.stream).toBe(true);
    });
  });
});
