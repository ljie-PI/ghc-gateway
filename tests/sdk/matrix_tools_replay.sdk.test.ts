import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSdkClients, sdkToolCalls, type SdkClients, type SdkProtocol } from "./client.js";
import {
  CHAT_MODEL,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";
import { executeWeatherRoundtrip } from "./scenario_requests.js";

interface ToolCell {
  readonly title: string;
  readonly client: SdkProtocol;
  readonly upstream: SdkProtocol;
  readonly model: string;
}

const TOOL_CELLS: readonly ToolCell[] = [
  { title: "C -> C (Chat -> Chat tools roundtrip)", client: "chat", upstream: "chat", model: CHAT_MODEL },
  { title: "C -> R (Chat -> Responses tools roundtrip)", client: "chat", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "C -> M (Chat -> Messages tools roundtrip)", client: "chat", upstream: "messages", model: MESSAGES_MODEL },
  { title: "M -> C (Messages -> Chat tools roundtrip)", client: "messages", upstream: "chat", model: CHAT_MODEL },
  { title: "M -> M (Messages -> Messages tools roundtrip)", client: "messages", upstream: "messages", model: MESSAGES_MODEL },
  { title: "M -> R (Messages -> Responses tools roundtrip)", client: "messages", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "R -> C (Responses -> Chat tools & continuation)", client: "responses", upstream: "chat", model: CHAT_MODEL },
  { title: "R -> M (Responses -> Messages tools & continuation)", client: "responses", upstream: "messages", model: MESSAGES_MODEL },
  { title: "R -> R (Responses -> Responses native tools & explicit history)", client: "responses", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
];

describe("nine-cell matrix tools & continuation execution via Mock Copilot Replay", () => {
  describe.each(TOOL_CELLS)("$title", (cell) => {
    let harness: ReplaySdkHarness;
    let clients: SdkClients;

    beforeAll(async () => {
      harness = await startReplaySdkHarness({ toolDownstream: cell.client });
      clients = createSdkClients(harness);
    });

    afterAll(async () => {
      await harness.close();
    });
    afterEach(() => { harness.replayServer.abortScenario(); });

    it("executes tool call and second request tool result", async () => {
      const receiptStart = select(harness, cell.upstream);
      const { first, second } = await executeWeatherRoundtrip(clients, cell.client, cell.upstream, cell.model);
      expect(sdkToolCalls(first)[0]?.name).toBe("get_weather");
      expect(second.result.text.length).toBeGreaterThan(0);
      if (second.protocol === "messages") expect(second.result.response.content.some((block) => block.type === "text")).toBe(true);
      finish(harness, cell.upstream, receiptStart);
    });
  });
});

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
