import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ReplaySdkHarness, startReplaySdkHarness } from "./replay_harness.js";
import { createSdkClients, REPLAY_TARGETS, SDK_MODES, SDK_PROTOCOLS, type SdkClients } from "./client.js";
import { expectScenarioResult, readExpectedResult } from "./replay_expectations.js";
import { executeTextScenario } from "./scenario_requests.js";
import { TEXT_SCENARIOS } from "./scenarios.js";

describe("long-text and image nine-cell matrix via production HTTP replay", () => {
  let harness: ReplaySdkHarness;
  let clients: SdkClients;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    clients = createSdkClients(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("lists models through both official SDKs and the HTTP Copilot model source", async () => {
    const expectedModels = REPLAY_TARGETS.map((target) => target.model);
    expect((await clients.openai.models.list()).data.map((model) => model.id)).toEqual(expectedModels);
    expect((await clients.anthropic.models.list()).data.map((model) => model.id)).toEqual(expectedModels);
    expect(harness.receipts).toEqual([]);
  });

  describe.each(TEXT_SCENARIOS)("$id", (scenario) => {
    let imageBase64: string | undefined;

    beforeAll(async () => {
      imageBase64 = scenario.imagePath === undefined
        ? undefined
        : (await readFile(scenario.imagePath)).toString("base64");
    });

    describe.each(SDK_PROTOCOLS)("%s downstream", (downstream) => {
      describe.each(REPLAY_TARGETS)("$protocol upstream", (target) => {
        it.each(SDK_MODES)("%s preserves complete text and a normal terminal outcome", async (mode) => {
          const expected = await readExpectedResult(harness.corpus.exchanges, target.protocol, scenario.id, mode);
          const scenarioId = `replay.${target.protocol}.${scenario.id}.${mode}`;
          const receiptStart = harness.receipts.length;
          harness.replayServer.selectScenario(scenarioId);
          try {
            const { result } = await executeTextScenario(clients, downstream, target, scenario, mode, imageBase64);
            expectScenarioResult(result, expected, scenario, downstream, mode);
            harness.replayServer.finishScenario();
            expect(harness.receipts.slice(receiptStart)).toEqual([
              { scenarioId, scenarioStep: 1, matchedCaseId: scenarioId },
            ]);
          } finally {
            harness.replayServer.abortScenario();
          }
        });
      });
    });
  });
});
