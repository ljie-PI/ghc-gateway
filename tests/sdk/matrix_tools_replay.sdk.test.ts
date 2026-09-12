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
    },
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
  },
};

describe("nine-cell matrix tools & continuation execution via Mock Copilot Replay", () => {
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
  afterEach(() => { harness.replayServer.abortScenario(); });

  describe("C -> C (Chat -> Chat tools roundtrip)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("chat");
      const first = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const toolCall = first.choices[0]?.message.tool_calls?.[0];
      expect(toolCall).toBeDefined();
      expect(toolCall?.type).toBe("function");
      if (toolCall?.type === "function") {
        expect(toolCall.function.name).toBe("get_weather");
      }

      const second = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "user", content: "What is the weather in Tokyo?" },
          first.choices[0]!.message,
          { role: "tool", tool_call_id: toolCall!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" },
        ],
      });
      expect(second.choices[0]?.message.content?.length).toBeGreaterThan(0);
      finish("chat", receiptStart);
    });
  });

  describe("C -> R (Chat -> Responses tools roundtrip)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("responses");
      const first = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const toolCall = first.choices[0]?.message.tool_calls?.[0];
      expect(toolCall).toBeDefined();
      expect(toolCall?.type).toBe("function");
      if (toolCall?.type === "function") {
        expect(toolCall.function.name).toBe("get_weather");
      }

      const second = await openai.chat.completions.create({
        model: NATIVE_RESPONSES_MODEL,
        messages: [
          { role: "user", content: "What is the weather in Tokyo?" },
          first.choices[0]!.message,
          { role: "tool", tool_call_id: toolCall!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" },
        ],
      });
      expect(second.choices[0]?.message.content?.length).toBeGreaterThan(0);
      finish("responses", receiptStart);
    });
  });

  describe("C -> M (Chat -> Messages tools roundtrip)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("messages");
      const first = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const toolCall = first.choices[0]?.message.tool_calls?.[0];
      expect(toolCall).toBeDefined();
      expect(toolCall?.type).toBe("function");
      if (toolCall?.type === "function") {
        expect(toolCall.function.name).toBe("get_weather");
      }

      const second = await openai.chat.completions.create({
        model: MESSAGES_MODEL,
        messages: [
          { role: "user", content: "What is the weather in Tokyo?" },
          first.choices[0]!.message,
          { role: "tool", tool_call_id: toolCall!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" },
        ],
      });
      expect(second.choices[0]?.message.content?.length).toBeGreaterThan(0);
      finish("messages", receiptStart);
    });
  });

  describe("M -> C (Messages -> Chat tools roundtrip)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("chat");
      const first = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const toolUse = first.content.find((b) => b.type === "tool_use");
      expect(toolUse).toBeDefined();

      const second = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 64,
        messages: [
          { role: "user", content: "What is the weather in Tokyo?" },
          { role: "assistant", content: [toolUse!] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" }] },
        ],
      });
      expect(second.content[0]?.type).toBe("text");
      finish("chat", receiptStart);
    });
  });

  describe("M -> M (Messages -> Messages tools roundtrip)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("messages");
      const first = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const toolUse = first.content.find((b) => b.type === "tool_use");
      expect(toolUse).toBeDefined();

      const second = await anthropic.messages.create({
        model: MESSAGES_MODEL,
        max_tokens: 64,
        messages: [
          { role: "user", content: "What is the weather in Tokyo?" },
          { role: "assistant", content: [toolUse!] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" }] },
        ],
      });
      expect(second.content[0]?.type).toBe("text");
      finish("messages", receiptStart);
    });
  });

  describe("M -> R (Messages -> Responses tools roundtrip)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("responses");
      const first = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const toolUse = first.content.find((b) => b.type === "tool_use");
      expect(toolUse).toBeDefined();

      const second = await anthropic.messages.create({
        model: NATIVE_RESPONSES_MODEL,
        max_tokens: 64,
        messages: [
          { role: "user", content: "What is the weather in Tokyo?" },
          { role: "assistant", content: [toolUse!] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" }] },
        ],
      });
      expect(second.content[0]?.type).toBe("text");
      finish("responses", receiptStart);
    });
  });

  describe("R -> C (Responses -> Chat tools & continuation)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("chat");
      const first = await openai.responses.create({
        model: CHAT_MODEL,
        input: "Call get_weather once with city Tokyo.",
        tools: [WEATHER_TOOL_RESPONSES],
        tool_choice: { type: "function", name: "get_weather" },
      });
      const funcCall = first.output.find((i) => i.type === "function_call");
      expect(funcCall).toBeDefined();

      const second = await openai.responses.create({
        model: CHAT_MODEL,
        previous_response_id: first.id,
        input: [
          {
            type: "function_call_output",
            call_id: funcCall!.call_id,
            output: "{\"temperature\":22,\"condition\":\"sunny\"}",
          },
        ],
      });
      expect(second.output_text?.length).toBeGreaterThan(0);
      finish("chat", receiptStart);
    });
  });

  describe("R -> M (Responses -> Messages tools & continuation)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("messages");
      const first = await openai.responses.create({
        model: MESSAGES_MODEL,
        input: "Call get_weather once with city Tokyo.",
        tools: [WEATHER_TOOL_RESPONSES],
        tool_choice: { type: "function", name: "get_weather" },
      });
      const funcCall = first.output.find((i) => i.type === "function_call");
      expect(funcCall).toBeDefined();

      const second = await openai.responses.create({
        model: MESSAGES_MODEL,
        previous_response_id: first.id,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Use the tool result for the original task." }],
          },
          {
            type: "function_call_output",
            call_id: funcCall!.call_id,
            output: "{\"temperature\":22,\"condition\":\"sunny\"}",
          },
        ],
      });
      expect(second.output_text?.length).toBeGreaterThan(0);
      finish("messages", receiptStart);
    });
  });

  describe("R -> R (Responses -> Responses native tools & continuation)", () => {
    it("executes tool call and second request tool result", async () => {
      const receiptStart = select("responses");
      const first = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        input: "What is the weather in Tokyo?",
        tools: [WEATHER_TOOL_RESPONSES],
      });
      const funcCall = first.output.find((i) => i.type === "function_call");
      expect(funcCall).toBeDefined();

      const second = await openai.responses.create({
        model: NATIVE_RESPONSES_MODEL,
        previous_response_id: first.id,
        input: [
          {
            type: "function_call_output",
            call_id: funcCall!.call_id,
            output: "{\"temperature\":22,\"condition\":\"sunny\"}",
          },
        ],
      });
      expect(second.output_text?.length).toBeGreaterThan(0);
      finish("responses", receiptStart);
    });
  });

  function select(protocol: "chat" | "messages" | "responses"): number {
    const receiptStart = harness.receipts.length;
    harness.replayServer.selectScenario(`replay.${protocol}.weather-roundtrip`);
    return receiptStart;
  }

  function finish(protocol: "chat" | "messages" | "responses", receiptStart: number): void {
    const scenarioId = `replay.${protocol}.weather-roundtrip`;
    harness.replayServer.finishScenario();
    expect(harness.receipts.slice(receiptStart)).toEqual([
      { scenarioId, scenarioStep: 1, matchedCaseId: `replay.${protocol}.tool-call.nonstream` },
      { scenarioId, scenarioStep: 2, matchedCaseId: `replay.${protocol}.tool-result.nonstream` },
    ]);
  }

});
