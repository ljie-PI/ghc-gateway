import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSdkClients,
  type SdkClients,
  type SdkProtocol,
} from "./client.js";
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

type MatrixCell =
  | { readonly title: string; readonly upstream: "chat"; readonly model: typeof CHAT_MODEL }
  | { readonly title: string; readonly upstream: "messages"; readonly model: typeof MESSAGES_MODEL }
  | { readonly title: string; readonly upstream: "responses"; readonly model: typeof NATIVE_RESPONSES_MODEL };

const CHAT_CELLS = [
  { title: "C -> C", upstream: "chat", model: CHAT_MODEL },
  { title: "C -> R", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "C -> M", upstream: "messages", model: MESSAGES_MODEL },
] as const satisfies readonly MatrixCell[];

const MESSAGES_CELLS = [
  { title: "M -> C", upstream: "chat", model: CHAT_MODEL },
  { title: "M -> R", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "M -> M", upstream: "messages", model: MESSAGES_MODEL },
] as const satisfies readonly MatrixCell[];

const RESPONSES_CELLS = [
  { title: "R -> C", upstream: "chat", model: CHAT_MODEL },
  { title: "R -> M", upstream: "messages", model: MESSAGES_MODEL },
  { title: "R -> R", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
] as const satisfies readonly MatrixCell[];

const PARALLEL_PROMPT = "Get weather for Tokyo and Paris simultaneously using get_weather twice.";
const MIXED_PROMPT = "What is the weather in the city where this character resides? Call get_weather.";

describe("nine-cell matrix parallel tools & mixed image-tool execution via Mock Copilot Replay", () => {
  let harness: ReplaySdkHarness;
  let clients: SdkClients;
  let imgBase64: string;
  let dataUrl: string;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    clients = createSdkClients(harness);

    const imgBuf = await readFile(path.resolve("tests/sdk/images/vergil.jpg"));
    imgBase64 = imgBuf.toString("base64");
    dataUrl = `data:image/jpeg;base64,${imgBase64}`;
  });

  afterAll(async () => {
    await harness.close();
  });
  afterEach(() => { harness.replayServer.abortScenario(); });

  describe("Parallel Tools Execution across Matrix Cells", () => {
    it.each(CHAT_CELLS)("$title parallel tools", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "parallel-tools");
      const response = await clients.openai.chat.completions.create({
        model: cell.model,
        messages: [{ role: "user", content: PARALLEL_PROMPT }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = response.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(2);
      expect(calls![0]?.id).not.toBe(calls![1]?.id);
      finish(harness, cell.upstream, "parallel-tools", receiptStart);
    });

    it.each(MESSAGES_CELLS)("$title parallel tools", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "parallel-tools");
      const response = await clients.anthropic.messages.create({
        model: cell.model,
        max_tokens: 256,
        messages: [{ role: "user", content: PARALLEL_PROMPT }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = response.content.filter((block) => block.type === "tool_use");
      expect(calls.length).toBe(2);
      expect(calls[0]?.id).not.toBe(calls[1]?.id);
      finish(harness, cell.upstream, "parallel-tools", receiptStart);
    });

    it.each(RESPONSES_CELLS)("$title parallel tools", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "parallel-tools");
      const response = await clients.openai.responses.create({
        model: cell.model,
        input: PARALLEL_PROMPT,
        tools: [WEATHER_TOOL_RESPONSES],
      });
      const calls = response.output.filter((item) => item.type === "function_call");
      expect(calls.length).toBe(2);
      expect(calls[0]?.call_id).not.toBe(calls[1]?.call_id);
      finish(harness, cell.upstream, "parallel-tools", receiptStart);
    });
  });

  describe("Mixed Image & Tool Execution across Matrix Cells", () => {
    it.each(CHAT_CELLS)("$title mixed image and tool", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "mixed-image-tool");
      const response = await clients.openai.chat.completions.create({
        model: cell.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: MIXED_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        tools: [WEATHER_TOOL_OPENAI],
      });
      const calls = response.choices[0]?.message.tool_calls;
      expect(calls?.length).toBe(1);
      finish(harness, cell.upstream, "mixed-image-tool", receiptStart);
    });

    it.each(MESSAGES_CELLS)("$title mixed image and tool", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "mixed-image-tool");
      const response = await clients.anthropic.messages.create({
        model: cell.model,
        max_tokens: 256,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: MIXED_PROMPT },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
          ],
        }],
        tools: [WEATHER_TOOL_ANTHROPIC],
      });
      const calls = response.content.filter((block) => block.type === "tool_use");
      expect(calls.length).toBe(1);
      finish(harness, cell.upstream, "mixed-image-tool", receiptStart);
    });

    it.each(RESPONSES_CELLS)("$title mixed image and tool", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "mixed-image-tool");
      const response = await clients.openai.responses.create({
        model: cell.model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: MIXED_PROMPT },
              { type: "input_image", image_url: dataUrl, detail: "auto" },
            ],
          },
        ],
        tools: [WEATHER_TOOL_RESPONSES],
        tool_choice: { type: "function", name: "get_weather" },
      });
      const call = response.output.find((item) => item.type === "function_call");
      expect(call).toBeDefined();
      finish(harness, cell.upstream, "mixed-image-tool", receiptStart);
    });
  });
});

type ScenarioFamily = "parallel-tools" | "mixed-image-tool";

function select(harness: ReplaySdkHarness, protocol: SdkProtocol, family: ScenarioFamily): number {
  const receiptStart = harness.receipts.length;
  harness.replayServer.selectScenario(`replay.${protocol}.${family}.nonstream`);
  return receiptStart;
}

function finish(
  harness: ReplaySdkHarness,
  protocol: SdkProtocol,
  family: ScenarioFamily,
  receiptStart: number,
): void {
  const scenarioId = `replay.${protocol}.${family}.nonstream`;
  harness.replayServer.finishScenario();
  expect(harness.receipts.slice(receiptStart)).toEqual([
    { scenarioId, scenarioStep: 1, matchedCaseId: scenarioId },
  ]);
}
