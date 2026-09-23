import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSdkClients, REPLAY_TARGETS, SDK_PROTOCOLS, TEXT_TERMINAL, type SdkClients } from "./client.js";
import { expectReasoningResult, expectUsage, readExpectedExchangeResult } from "./replay_expectations.js";
import { type ReplaySdkHarness, startReplaySdkHarness } from "./replay_harness.js";
import { executeReasoning } from "./scenario_requests.js";

describe("nine-cell SDK-parsed reasoning and usage via production HTTP replay", () => {
  let harness: ReplaySdkHarness;
  let clients: SdkClients;

  describe.each(SDK_PROTOCOLS)("%s downstream", (downstream) => {
    beforeAll(async () => {
      harness = await startReplaySdkHarness({ reasoningDownstream: downstream });
      clients = createSdkClients(harness);
    });
    afterAll(async () => { await harness.close(); });

    it.each(REPLAY_TARGETS)("$protocol upstream preserves native reasoning or portable converted presentation", async (target) => {
      const exchangeId = `replay.${target.protocol}.reasoning-effort.nonstream`;
      const exchange = harness.corpus.exchanges.find((candidate) => candidate.caseId === exchangeId)!;
      const expected = await readExpectedExchangeResult(exchange);
      const receiptStart = harness.receipts.length;
      harness.replayServer.selectScenario(exchangeId);
      try {
        const { result } = await executeReasoning(clients, downstream, target.model);
        expect(expected.text.length).toBeGreaterThan(0);
        expect(result.text === expected.text, "all captured answer text remains separate from reasoning").toBe(true);
        expect(result.terminal === TEXT_TERMINAL[downstream], "native or converted fixture terminal outcome").toBe(true);
        expectUsage(result.response.usage, downstream, expected);
        expectReasoningResult(result, expected, downstream);

        // Inspect official parsed objects, not just request options or reasoning-token counters.
        if (downstream === target.protocol) {
          if (downstream === "messages") {
            const thinking = (result.response as Anthropic.Message).content.find((block) => block.type === "thinking");
            expect(thinking?.thinking.length, "fixture supplies actual public thinking").toBeGreaterThan(0);
          } else if (downstream === "responses") {
            // This fixture supplies opaque state, not a portable public summary. Do not fabricate one.
            const reasoning = (result.response as OpenAI.Responses.Response).output.filter((item) => item.type === "reasoning");
            expect(reasoning.length).toBe(1);
            expect(reasoning[0]?.summary.length).toBe(0);
            expect(reasoning[0]?.content?.length).toBe(0);
            expect(typeof reasoning[0]?.encrypted_content).toBe("string");
            expect(reasoning[0]?.encrypted_content?.length).toBeGreaterThan(0);
          } else {
            const message = (result.response as OpenAI.ChatCompletion).choices[0]!.message as unknown as { reasoning_text?: string; reasoning_opaque?: string };
            expect(message.reasoning_text?.length, "Chat fixture supplies public reasoning").toBeGreaterThan(0);
            expect(message.reasoning_opaque?.length, "Chat fixture also supplies native opaque state").toBeGreaterThan(0);
          }
        }
        harness.replayServer.finishScenario();
        expect(harness.receipts.slice(receiptStart)).toEqual([
          { scenarioId: exchangeId, scenarioStep: 1, matchedCaseId: exchangeId },
        ]);
      } finally { harness.replayServer.abortScenario(); }
    });
  });
});
