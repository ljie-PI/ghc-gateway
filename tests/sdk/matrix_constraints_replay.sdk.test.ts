import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSdkClients, executeChat, executeMessages, executeResponses, REPLAY_TARGETS, SDK_PROTOCOLS,
  type SdkClients, type SdkProtocol,
} from "./client.js";
import { expectReasoningResult, expectUsage, readExpectedExchangeResult } from "./replay_expectations.js";
import { type ReplaySdkHarness, startReplaySdkHarness } from "./replay_harness.js";

const prompt = "Explain quantum entanglement in 20 words.";

describe("nine-cell SDK-parsed reasoning and usage via production HTTP replay", () => {
  let harness: ReplaySdkHarness;
  let clients: SdkClients;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    clients = createSdkClients(harness);
  });
  afterAll(async () => { await harness.close(); });

  describe.each(SDK_PROTOCOLS)("%s downstream", (downstream) => {
    it.each(REPLAY_TARGETS)("$protocol upstream preserves native reasoning or approved converted omission", async (target) => {
      const exchangeId = `replay.${target.protocol}.reasoning-effort.nonstream`;
      const exchange = harness.corpus.exchanges.find((candidate) => candidate.caseId === exchangeId)!;
      const expected = await readExpectedExchangeResult(exchange);
      const receiptStart = harness.receipts.length;
      harness.replayServer.selectScenario(exchangeId);
      try {
        const result = await executeReasoning(downstream, target.model);
        expect(expected.text.length).toBeGreaterThan(0);
        expect(result.text === expected.text, "all captured answer text remains separate from reasoning").toBe(true);
        // The immutable legacy Chat fixture is truncated. Preserve that fact, never call it completed.
        const terminal = (target.protocol === "chat"
          ? { chat: "length", messages: "max_tokens", responses: "incomplete" }
          : { chat: "stop", messages: "end_turn", responses: "completed" })[downstream];
        expect(result.terminal === terminal, "native or converted fixture terminal outcome").toBe(true);
        if (target.protocol === "chat" && downstream === "responses") {
          expect((result.response as OpenAI.Responses.Response).incomplete_details?.reason === "max_output_tokens", "truncation reason is preserved").toBe(true);
        }
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

  function executeReasoning(downstream: SdkProtocol, model: string) {
    switch (downstream) {
    case "chat": return executeChat(clients.openai, {
      model, messages: [{ role: "user", content: prompt }], reasoning_effort: "low",
    }, "nonstream");
    case "messages": return executeMessages(clients.anthropic, {
      model, max_tokens: 64, messages: [{ role: "user", content: prompt }], output_config: { effort: "low" },
    }, "nonstream");
    case "responses": return executeResponses(clients.openai, {
      model, input: prompt, reasoning: { effort: "low" }, max_output_tokens: 64,
    }, "nonstream");
    }
  }
});
