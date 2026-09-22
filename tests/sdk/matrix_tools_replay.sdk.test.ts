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

type ToolMatrixCell =
  | { readonly title: string; readonly upstream: "chat"; readonly model: typeof CHAT_MODEL }
  | { readonly title: string; readonly upstream: "messages"; readonly model: typeof MESSAGES_MODEL }
  | { readonly title: string; readonly upstream: "responses"; readonly model: typeof NATIVE_RESPONSES_MODEL };

const CHAT_TOOL_CELLS = [
  { title: "C -> C (Chat -> Chat tools roundtrip)", upstream: "chat", model: CHAT_MODEL },
  { title: "C -> R (Chat -> Responses tools roundtrip)", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "C -> M (Chat -> Messages tools roundtrip)", upstream: "messages", model: MESSAGES_MODEL },
] as const satisfies readonly ToolMatrixCell[];

const MESSAGES_TOOL_CELLS = [
  { title: "M -> C (Messages -> Chat tools roundtrip)", upstream: "chat", model: CHAT_MODEL },
  { title: "M -> M (Messages -> Messages tools roundtrip)", upstream: "messages", model: MESSAGES_MODEL },
  { title: "M -> R (Messages -> Responses tools roundtrip)", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
] as const satisfies readonly ToolMatrixCell[];

const RESPONSES_TOOL_CELLS = [
  { title: "R -> C (Responses -> Chat tools & continuation)", upstream: "chat", model: CHAT_MODEL },
  { title: "R -> M (Responses -> Messages tools & continuation)", upstream: "messages", model: MESSAGES_MODEL },
  { title: "R -> R (Responses -> Responses native tools & continuation)", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
] as const satisfies readonly ToolMatrixCell[];

interface ToolCellContext {
  readonly harness: ReplaySdkHarness;
  readonly clients: SdkClients;
}

describe("nine-cell matrix tools & continuation execution via Mock Copilot Replay", () => {
  describeToolCells("chat", CHAT_TOOL_CELLS, executeChatRoundtrip);
  describeToolCells("messages", MESSAGES_TOOL_CELLS, executeMessagesRoundtrip);
  describeToolCells("responses", RESPONSES_TOOL_CELLS, executeResponsesRoundtrip);
});

function describeToolCells<Cell extends ToolMatrixCell>(
  clientProtocol: SdkProtocol,
  cells: readonly Cell[],
  execute: (cell: Cell, context: ToolCellContext) => Promise<void>,
): void {
  describe.each(cells)("$title", (cell) => {
    let harness: ReplaySdkHarness;
    let clients: SdkClients;

    beforeAll(async () => {
      harness = await startReplaySdkHarness({ toolDownstream: clientProtocol });
      clients = createSdkClients(harness);
    });

    afterAll(async () => {
      await harness.close();
    });
    afterEach(() => { harness.replayServer.abortScenario(); });

    it("executes tool call and second request tool result", async () => {
      await execute(cell, { harness, clients });
    });
  });
}

async function executeChatRoundtrip(cell: ToolMatrixCell, { harness, clients }: ToolCellContext): Promise<void> {
  const receiptStart = select(harness, cell.upstream);
  const first = await clients.openai.chat.completions.create({
    model: cell.model,
    messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
    tools: [WEATHER_TOOL_OPENAI],
  });
  const toolCall = first.choices[0]?.message.tool_calls?.[0];
  expect(toolCall).toBeDefined();
  expect(toolCall?.type).toBe("function");
  if (toolCall?.type === "function") {
    expect(toolCall.function.name).toBe("get_weather");
  }

  const second = await clients.openai.chat.completions.create({
    model: cell.model,
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" },
      first.choices[0]!.message,
      { role: "tool", tool_call_id: toolCall!.id, content: "{\"temperature\":22,\"condition\":\"sunny\"}" },
    ],
  });
  expect(second.choices[0]?.message.content?.length).toBeGreaterThan(0);
  finish(harness, cell.upstream, receiptStart);
}

async function executeMessagesRoundtrip(cell: ToolMatrixCell, { harness, clients }: ToolCellContext): Promise<void> {
  const receiptStart = select(harness, cell.upstream);
  const first = await clients.anthropic.messages.create({
    model: cell.model,
    max_tokens: 64,
    messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
    tools: [WEATHER_TOOL_ANTHROPIC],
  });
  const toolUse = first.content.find((block) => block.type === "tool_use");
  expect(toolUse).toBeDefined();

  const second = await clients.anthropic.messages.create({
    model: cell.model,
    max_tokens: 64,
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" },
      { role: "assistant", content: [toolUse!] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse!.id,
          content: "{\"temperature\":22,\"condition\":\"sunny\"}",
        }],
      },
    ],
  });
  expect(second.content[0]?.type).toBe("text");
  finish(harness, cell.upstream, receiptStart);
}

async function executeResponsesRoundtrip(cell: ToolMatrixCell, { harness, clients }: ToolCellContext): Promise<void> {
  const receiptStart = select(harness, cell.upstream);
  const first = cell.upstream === "responses"
    ? await clients.openai.responses.create({
      model: cell.model,
      input: "What is the weather in Tokyo?",
      tools: [WEATHER_TOOL_RESPONSES],
    })
    : await clients.openai.responses.create({
      model: cell.model,
      input: "Call get_weather once with city Tokyo.",
      tools: [WEATHER_TOOL_RESPONSES],
      tool_choice: { type: "function", name: "get_weather" },
    });
  const funcCall = first.output.find((item) => item.type === "function_call");
  expect(funcCall).toBeDefined();

  const toolOutput = {
    type: "function_call_output" as const,
    call_id: funcCall!.call_id,
    output: "{\"temperature\":22,\"condition\":\"sunny\"}",
  };
  const second = cell.upstream === "messages"
    ? await clients.openai.responses.create({
      model: cell.model,
      previous_response_id: first.id,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Use the tool result for the original task." }],
        },
        toolOutput,
      ],
    })
    : await clients.openai.responses.create({
      model: cell.model,
      previous_response_id: first.id,
      input: [toolOutput],
    });
  expect(second.output_text?.length).toBeGreaterThan(0);
  finish(harness, cell.upstream, receiptStart);
}

function select(harness: ReplaySdkHarness, protocol: SdkProtocol): number {
  const receiptStart = harness.receipts.length;
  harness.replayServer.selectScenario(`replay.${protocol}.weather-roundtrip`);
  return receiptStart;
}

function finish(harness: ReplaySdkHarness, protocol: SdkProtocol, receiptStart: number): void {
  const scenarioId = `replay.${protocol}.weather-roundtrip`;
  harness.replayServer.finishScenario();
  expect(harness.receipts.slice(receiptStart)).toEqual([
    { scenarioId, scenarioStep: 1, matchedCaseId: `replay.${protocol}.tool-call.nonstream` },
    { scenarioId, scenarioStep: 2, matchedCaseId: `replay.${protocol}.tool-result.nonstream` },
  ]);
}
