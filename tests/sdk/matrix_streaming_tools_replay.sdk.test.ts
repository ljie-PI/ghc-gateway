import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSdkClients, executeChat, executeMessages, executeResponses, REPLAY_TARGETS, SDK_PROTOCOLS, sdkToolCalls,
  type SdkClients, type SdkProtocol, type SdkProtocolResult,
} from "./client.js";
import { expectUsage, readExpectedExchangeResult } from "./replay_expectations.js";
import { type ReplaySdkHarness, startReplaySdkHarness } from "./replay_harness.js";
import {
  FORECAST_COMPARE_PROMPT, FORECAST_TOOL_ANTHROPIC, FORECAST_TOOL_OPENAI, FORECAST_TOOL_RESPONSES,
  expectedForecastArguments,
} from "./scenarios.js";

describe("nine-cell parallel streaming tools with official SDK accumulation", () => {
  let harness: ReplaySdkHarness;
  let clients: SdkClients;
  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    clients = createSdkClients(harness);
  });
  afterAll(async () => { await harness.close(); });

  describe.each(SDK_PROTOCOLS)("%s downstream", (downstream) => {
    it.each(REPLAY_TARGETS)("$protocol upstream preserves complete arguments, call binding and terminal usage", async (target) => {
      const exchangeId = `replay.${target.protocol}.parallel-tools.stream`;
      const exchange = harness.corpus.exchanges.find((candidate) => candidate.caseId === exchangeId)!;
      const expected = await readExpectedExchangeResult(exchange);
      const receiptStart = harness.receipts.length;
      const value = await executeTools(downstream, target.model);
      const { result } = value;
      const calls = sdkToolCalls(value);
      expect(calls.length).toBe(2);
      expect(expected.toolCallIds.length).toBe(2);
      expect(new Set(calls.map((call) => call.id)).size).toBe(2);
      // Fixed native IDs bind the ordered complete arguments, not merely two plausible cities.
      for (const [index, city] of (["Tokyo", "Paris"] as const).entries()) {
        const call = calls[index]!;
        expect(call.id.length).toBeGreaterThan(0);
        expect(call.id === expected.toolCallIds[index], "SDK call ID retains its upstream argument binding").toBe(true);
        expect(call.name === "get_hourly_forecast", "forecast tool name is preserved").toBe(true);
        expect(isDeepStrictEqual(call.arguments, expectedForecastArguments(city)), "complete nested forecast arguments are preserved").toBe(true);
      }
      expectUsage(result.response.usage, downstream, expected);
      expect(result.text === expected.text, "complete ancillary tool text").toBe(true);
      expect(result.stream?.text === expected.text, "no duplicated or truncated streamed text").toBe(true);
      expect(result.stream?.terminalCount).toBe(1);
      expect(result.terminal === { chat: "tool_calls", messages: "tool_use", responses: "completed" }[downstream], "normal tool terminal outcome").toBe(true);
      expect(harness.receipts.slice(receiptStart).filter((receipt) => receipt.matchedCaseId !== undefined))
        .toMatchObject([{ matchedCaseId: exchangeId, model: target.model, stream: true }]);
      // Chat/Responses raw argument frames are coarse. Interleaving and byte fragmentation remain
      // independently covered by protocol_conversion_response.test.ts, not fabricated capture frames.
    });
  });

  async function executeTools(downstream: SdkProtocol, model: string): Promise<SdkProtocolResult> {
    switch (downstream) {
    case "chat": {
      const result = await executeChat(clients.openai, {
        model, messages: [{ role: "user", content: FORECAST_COMPARE_PROMPT }],
        tools: [FORECAST_TOOL_OPENAI], tool_choice: "auto", parallel_tool_calls: true, max_tokens: 700,
      }, "stream");
      return { protocol: downstream, result };
    }
    case "messages": {
      const result = await executeMessages(clients.anthropic, {
        model, max_tokens: 700, messages: [{ role: "user", content: FORECAST_COMPARE_PROMPT }],
        tools: [FORECAST_TOOL_ANTHROPIC], tool_choice: { type: "auto", disable_parallel_tool_use: false },
      }, "stream");
      return { protocol: downstream, result };
    }
    case "responses": {
      const result = await executeResponses(clients.openai, {
        model, input: FORECAST_COMPARE_PROMPT, tools: [FORECAST_TOOL_RESPONSES],
        tool_choice: "auto", parallel_tool_calls: true, max_output_tokens: 700,
      }, "stream");
      return { protocol: downstream, result };
    }
    }
  }
});
