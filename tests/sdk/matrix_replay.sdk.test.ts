import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ReplaySdkHarness, startReplaySdkHarness } from "./replay_harness.js";
import {
  createSdkClients,
  executeChat,
  executeMessages,
  executeResponses,
  REPLAY_TARGETS,
  SDK_MODES,
  SDK_PROTOCOLS,
  type SdkClients,
  type SdkMode,
  type SdkProtocol,
} from "./client.js";
import { expectScenarioResult, readExpectedResult } from "./replay_expectations.js";
import { TEXT_SCENARIOS, type TextScenario } from "./scenarios.js";

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
            const result = await executeScenario(downstream, target, scenario, mode, imageBase64);
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

  // Keep native request shapes explicit; the SDK helper owns invocation, not conversation history.
  function executeScenario(
    downstream: SdkProtocol,
    target: typeof REPLAY_TARGETS[number],
    scenario: TextScenario,
    mode: SdkMode,
    imageBase64: string | undefined,
  ) {
    const { model } = target;
    const dataUrl = `data:image/jpeg;base64,${imageBase64}`;
    // Preserve the native SDK request options formerly exercised by the duplicate suites.
    const nativeLongText = scenario.id === "plain-text" && downstream === target.protocol;
    switch (downstream) {
    case "chat":
      return executeChat(clients.openai, {
        model,
        max_tokens: 2_000,
        ...(nativeLongText ? { reasoning_effort: "low" as const } : {}),
        messages: [
          ...(scenario.system === undefined ? [] : [{ role: "system" as const, content: scenario.system }]),
          {
            role: "user",
            content: imageBase64 === undefined ? scenario.prompt : [
              { type: "text", text: scenario.prompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
            ],
          },
        ],
      }, mode);
    case "messages":
      return executeMessages(clients.anthropic, {
        model,
        max_tokens: nativeLongText ? 700 : 2_000,
        ...(nativeLongText ? { thinking: { type: "disabled" as const } } : {}),
        ...(scenario.system === undefined ? {} : { system: scenario.system }),
        messages: [{
          role: "user",
          content: imageBase64 === undefined ? scenario.prompt : [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            { type: "text", text: scenario.prompt },
          ],
        }],
      }, mode);
    case "responses":
      return executeResponses(clients.openai, {
        model,
        max_output_tokens: 2_000,
        ...(nativeLongText ? { reasoning: { effort: "low" as const } } : {}),
        ...(scenario.system === undefined ? {} : { instructions: scenario.system }),
        input: imageBase64 === undefined ? scenario.prompt : [{
          role: "user",
          content: [
            { type: "input_text", text: scenario.prompt },
            { type: "input_image", image_url: dataUrl, detail: "auto" },
          ],
        }],
      }, mode);
    }
  }
});
