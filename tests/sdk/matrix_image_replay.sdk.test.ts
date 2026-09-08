import { readFile } from "node:fs/promises";
import path from "node:path";
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

describe("nine-cell matrix image execution via Mock Copilot Replay", () => {
  let harness: ReplaySdkHarness;
  let openai: OpenAI;
  let anthropic: Anthropic;
  let imgBase64: string;
  let dataUrl: string;

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

    const imgBuf = await readFile(path.resolve("tests/sdk/images/vergil.jpg"));
    imgBase64 = imgBuf.toString("base64");
    dataUrl = `data:image/jpeg;base64,${imgBase64}`;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("C -> C (Chat -> Chat image)", () => {
    it("nonstream", async () => {
      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      });
      expect(resp.choices[0]?.message.content?.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.image.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
      }
      expect(text.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.image.stream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.stream).toBe(true);
    });
  });

  describe("C -> R (Chat -> Responses image conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      });
      expect(resp.choices[0]?.message.content?.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.image.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
      }
      expect(text.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.image.stream");
      expect(r?.path).toBe("/responses");
      expect(r?.stream).toBe(true);
    });
  });

  describe("C -> M (Chat -> Messages image conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      });
      expect(resp.choices[0]?.message.content).toBe("Vergil");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.image.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
      }
      expect(text).toBe("Vergil");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.image.stream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.stream).toBe(true);
    });
  });

  describe("M -> C (Messages -> Chat image conversion)", () => {
    it("nonstream", async () => {
      const resp = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
      });
      expect(resp.content[0]?.type).toBe("text");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.image.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("stream", async () => {
      const stream = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      expect(text.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.image.stream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.stream).toBe(true);
    });
  });

  describe("M -> M (Messages -> Messages image native)", () => {
    it("nonstream", async () => {
      const resp = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
      });
      expect(resp.content[0]?.type).toBe("text");
      if (resp.content[0]?.type === "text") {
        expect(resp.content[0].text).toBe("Vergil");
      }
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.image.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });

    it("stream", async () => {
      const stream = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      expect(text).toBe("Vergil");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.image.stream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.stream).toBe(true);
    });
  });

  describe("M -> R (Messages -> Responses image conversion)", () => {
    it("nonstream", async () => {
      const resp = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
      });
      expect(resp.content[0]?.type).toBe("text");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.image.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("stream", async () => {
      const stream = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Who is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      expect(text.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.image.stream");
      expect(r?.path).toBe("/responses");
      expect(r?.stream).toBe(true);
    });
  });

  describe("R -> C (Responses -> Chat image conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.responses.create({
        model: CHAT_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Who is this?" },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
      });
      expect(resp.output_text?.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.image.nonstream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.model).toBe(CHAT_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.responses.create({
        model: CHAT_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Who is this?" },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        stream: true,
      });
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      expect(types.some((t) => t === "response.completed" || t === "response.incomplete")).toBe(true);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.chat.image.stream");
      expect(r?.path).toBe("/chat/completions");
      expect(r?.stream).toBe(true);
    });
  });

  describe("R -> M (Responses -> Messages image conversion)", () => {
    it("nonstream", async () => {
      const resp = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Who is this?" },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
      });
      expect(resp.output_text).toBe("Vergil");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.image.nonstream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.model).toBe(MESSAGES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Who is this?" },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        stream: true,
      });
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      expect(types).toContain("response.completed");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.messages.image.stream");
      expect(r?.path).toBe("/v1/messages");
      expect(r?.stream).toBe(true);
    });
  });

  describe("R -> R (Responses -> Responses image native)", () => {
    it("nonstream", async () => {
      const resp = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Who is this?" },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
      });
      expect(resp.output_text?.length).toBeGreaterThan(0);
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.image.nonstream");
      expect(r?.path).toBe("/responses");
      expect(r?.model).toBe(NATIVE_RESPONSES_MODEL);
    });

    it("stream", async () => {
      const stream = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Who is this?" },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        stream: true,
      });
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      expect(types).toContain("response.completed");
      const r = harness.receipts.find((rec) => rec.matchedCaseId === "replay.responses.image.stream");
      expect(r?.path).toBe("/responses");
      expect(r?.stream).toBe(true);
    });
  });
});
