import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";

const WEATHER_TOOL_OPENAI = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    strict: true,
  },
} as const;

const WEATHER_TOOL_RESPONSES = {
  type: "function",
  name: "get_weather",
  description: "Get weather for city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const WEATHER_TOOL_ANTHROPIC = {
  name: "get_weather",
  description: "Get weather for city",
  input_schema: {
    type: "object" as const,
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

describe("nine-cell matrix parallel tools & mixed image-tool execution via Mock Copilot Replay", () => {
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
  afterEach(() => { harness.replayServer.abortScenario(); });

  describe("Parallel Tools Execution across Matrix Cells", () => {
    it("C -> C parallel tools", async () => {
      const receiptStart = select("chat", "parallel-tools");
      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(2);
      expect(calls![0]?.id).not.toBe(calls![1]?.id);
      finish("chat", "parallel-tools", receiptStart);
    });

    it("C -> R parallel tools", async () => {
      const receiptStart = select("responses", "parallel-tools");
      const resp = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(2);
      expect(calls![0]?.id).not.toBe(calls![1]?.id);
      finish("responses", "parallel-tools", receiptStart);
    });

    it("C -> M parallel tools", async () => {
      const receiptStart = select("messages", "parallel-tools");
      const resp = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(2);
      expect(calls![0]?.id).not.toBe(calls![1]?.id);
      finish("messages", "parallel-tools", receiptStart);
    });

    it("M -> C parallel tools", async () => {
      const receiptStart = select("chat", "parallel-tools");
      const resp = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(2);
      expect(calls[0]?.id).not.toBe(calls[1]?.id);
      finish("chat", "parallel-tools", receiptStart);
    });

    it("M -> R parallel tools", async () => {
      const receiptStart = select("responses", "parallel-tools");
      const resp = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(2);
      expect(calls[0]?.id).not.toBe(calls[1]?.id);
      finish("responses", "parallel-tools", receiptStart);
    });

    it("M -> M parallel tools", async () => {
      const receiptStart = select("messages", "parallel-tools");
      const resp = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(2);
      expect(calls[0]?.id).not.toBe(calls[1]?.id);
      finish("messages", "parallel-tools", receiptStart);
    });

    it("R -> C parallel tools", async () => {
      const receiptStart = select("chat", "parallel-tools");
      const resp = await openai.responses.create({
        model: CHAT_MODEL,
        input: "Get weather for Tokyo and Paris simultaneously using get_weather twice.",
        tools: [WEATHER_TOOL_RESPONSES],
      });
      const calls = resp.output.filter((i) => i.type === "function_call");
      expect(calls.length).toBe(2);
      expect(calls[0]?.call_id).not.toBe(calls[1]?.call_id);
      finish("chat", "parallel-tools", receiptStart);
    });

    it("R -> M parallel tools", async () => {
      const receiptStart = select("messages", "parallel-tools");
      const resp = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: "Get weather for Tokyo and Paris simultaneously using get_weather twice.",
        tools: [WEATHER_TOOL_RESPONSES],
      });
      const calls = resp.output.filter((i) => i.type === "function_call");
      expect(calls.length).toBe(2);
      expect(calls[0]?.call_id).not.toBe(calls[1]?.call_id);
      finish("messages", "parallel-tools", receiptStart);
    });

    it("R -> R parallel tools", async () => {
      const receiptStart = select("responses", "parallel-tools");
      const resp = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: "Get weather for Tokyo and Paris simultaneously using get_weather twice.",
        tools: [WEATHER_TOOL_RESPONSES],
      });
      const calls = resp.output.filter((i) => i.type === "function_call");
      expect(calls.length).toBe(2);
      expect(calls[0]?.call_id).not.toBe(calls[1]?.call_id);
      finish("responses", "parallel-tools", receiptStart);
    });
  });

  describe("Mixed Image & Tool Execution across Matrix Cells", () => {
    it("C -> C mixed image and tool", async () => {
      const receiptStart = select("chat", "mixed-image-tool");
      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the weather in the city where this character resides? Call get_weather." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(1);
      finish("chat", "mixed-image-tool", receiptStart);
    });

    it("C -> R mixed image and tool", async () => {
      const receiptStart = select("responses", "mixed-image-tool");
      const resp = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the weather in the city where this character resides? Call get_weather." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(1);
      finish("responses", "mixed-image-tool", receiptStart);
    });

    it("C -> M mixed image and tool", async () => {
      const receiptStart = select("messages", "mixed-image-tool");
      const resp = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the weather in the city where this character resides? Call get_weather." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(1);
      finish("messages", "mixed-image-tool", receiptStart);
    });

    it("M -> C mixed image and tool", async () => {
      const receiptStart = select("chat", "mixed-image-tool");
      const resp = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the weather in the city where this character resides? Call get_weather." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(1);
      finish("chat", "mixed-image-tool", receiptStart);
    });

    it("M -> R mixed image and tool", async () => {
      const receiptStart = select("responses", "mixed-image-tool");
      const resp = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the weather in the city where this character resides? Call get_weather." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(1);
      finish("responses", "mixed-image-tool", receiptStart);
    });

    it("M -> M mixed image and tool", async () => {
      const receiptStart = select("messages", "mixed-image-tool");
      const resp = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the weather in the city where this character resides? Call get_weather." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(1);
      finish("messages", "mixed-image-tool", receiptStart);
    });

    it("R -> C mixed image and tool", async () => {
      const receiptStart = select("chat", "mixed-image-tool");
      const resp = await openai.responses.create({
        model: CHAT_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is the weather in the city where this character resides? Call get_weather." },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        tools: [WEATHER_TOOL_RESPONSES],
        tool_choice: { type: "function", name: "get_weather" },
      });
      const call = resp.output.find((i) => i.type === "function_call");
      expect(call).toBeDefined();
      finish("chat", "mixed-image-tool", receiptStart);
    });

    it("R -> M mixed image and tool", async () => {
      const receiptStart = select("messages", "mixed-image-tool");
      const resp = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is the weather in the city where this character resides? Call get_weather." },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        tools: [WEATHER_TOOL_RESPONSES],
        tool_choice: { type: "function", name: "get_weather" },
      });
      const call = resp.output.find((i) => i.type === "function_call");
      expect(call).toBeDefined();
      finish("messages", "mixed-image-tool", receiptStart);
    });

    it("R -> R mixed image and tool", async () => {
      const receiptStart = select("responses", "mixed-image-tool");
      const resp = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is the weather in the city where this character resides? Call get_weather." },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        tools: [WEATHER_TOOL_RESPONSES],
        tool_choice: { type: "function", name: "get_weather" },
      });
      const call = resp.output.find((i) => i.type === "function_call");
      expect(call).toBeDefined();
      finish("responses", "mixed-image-tool", receiptStart);
    });
  });

  function select(protocol: "chat" | "messages" | "responses", family: "parallel-tools" | "mixed-image-tool"): number {
    const receiptStart = harness.receipts.length;
    harness.replayServer.selectScenario(`replay.${protocol}.${family}.nonstream`);
    return receiptStart;
  }

  function finish(protocol: "chat" | "messages" | "responses", family: "parallel-tools" | "mixed-image-tool", receiptStart: number): void {
    const scenarioId = `replay.${protocol}.${family}.nonstream`;
    harness.replayServer.finishScenario();
    expect(harness.receipts.slice(receiptStart)).toEqual([
      { scenarioId, scenarioStep: 1, matchedCaseId: scenarioId },
    ]);
  }

});
