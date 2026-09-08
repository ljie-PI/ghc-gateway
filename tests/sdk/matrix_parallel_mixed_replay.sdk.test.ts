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

  describe("Parallel Tools Execution", () => {
    it("C -> C parallel tools", async () => {
      const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(2);
    });

    it("C -> M parallel tools", async () => {
      const resp = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = resp.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(2);
    });

    it("M -> C parallel tools", async () => {
      const resp = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(2);
    });

    it("M -> M parallel tools", async () => {
      const resp = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "Get weather for Tokyo and Paris simultaneously using get_weather twice." }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = resp.content.filter((b) => b.type === "tool_use");
      expect(calls.length).toBe(2);
    });
  });

  describe("Mixed Image & Tool Execution", () => {
    it("C -> C mixed image and tool", async () => {
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
    });

    it("C -> R mixed image and tool", async () => {
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
    });

    it("C -> M mixed image and tool", async () => {
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
    });

    it("M -> C mixed image and tool", async () => {
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
    });

    it("M -> R mixed image and tool", async () => {
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
    });

    it("M -> M mixed image and tool", async () => {
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
    });

    it("R -> C mixed image and tool", async () => {
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
    });

    it("R -> R mixed image and tool", async () => {
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
    });
  });
});
