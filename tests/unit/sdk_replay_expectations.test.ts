import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ReplayScenarioManifest } from "../../src/replay/types.js";
import { expectReasoningResult, expectScenarioResult, expectUsage, readExpectedExchangeResult, type ExpectedResult } from "../sdk/replay_expectations.js";
import { expectSessionTurn } from "../sdk/session_expectations.js";
import type { SdkResult } from "../sdk/client.js";
import type OpenAI from "openai";

const messages: ExpectedResult = {
  text: "", upstream: "messages", mode: "stream", reasoning: [], toolCallIds: [],
  nativeUsage: { input_tokens: 23, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
  usage: { inputTokens: 23, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 5, reasoningTokens: 0, visualTokens: "not_reported" },
};
const responses = {
  input_tokens: 31, output_tokens: 22, total_tokens: 53,
  input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 0 },
};

describe("independent SDK replay expectations (no SDK execution)", () => {
  it.each(["buffered-text", "first-session-turn", "native-usage", "invalid-counter"] as const)("keeps %s assertion diagnostics content-free", (kind) => {
    const privateText = "synthetic-private-response-probe";
    const text = "Vergil blue silver coat sword reserved. ".repeat(35);
    const nativeUsage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    const expected: ExpectedResult = {
      ...messages, upstream: "chat", mode: "nonstream", text, nativeUsage,
      usage: { ...messages.usage, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const result: SdkResult<OpenAI.ChatCompletion> = {
      response: { choices: [{ message: { role: "assistant", content: text } }], usage: nativeUsage } as OpenAI.ChatCompletion,
      text, terminal: "stop", stream: { text: privateText, reasoningText: privateText, terminalCount: 1 },
    };
    let error: unknown;
    try {
      if (kind === "buffered-text") expectScenarioResult(result, expected, { id: "plain-text", prompt: "synthetic", facts: [] }, "chat", "nonstream");
      else if (kind === "first-session-turn") expectSessionTurn({ protocol: "chat", result }, expected, 1);
      else expectUsage({ ...nativeUsage, ...(kind === "native-usage" ? { private: privateText } : { prompt_tokens: privateText }) }, "chat", expected);
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error).includes(privateText), "assertion metadata does not retain response content").toBe(false);
  });

  it("uses the Messages inclusive cache denominator and retains positive cache writes", () => {
    expectUsage(messages.nativeUsage, "messages", messages);
    expectUsage(responses, "responses", messages);
    expectUsage({ prompt_tokens: 31, completion_tokens: 22, total_tokens: 53,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 0 } }, "chat", messages);
  });

  it.each([
    { ...responses, input_tokens: 23, total_tokens: 45 },
    { ...responses, output_tokens: 44, total_tokens: 75 },
    { ...responses, input_tokens_details: { cached_tokens: 3 } },
    { ...responses, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5 } },
    { ...responses, output_tokens_details: {} },
    { ...responses, output_tokens_details: { reasoning_tokens: 1 } },
    { ...responses, visual_tokens: 1 },
    { ...responses, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5, image_tokens: 7 } },
  ])("rejects changed counters, lost fields or invented vision details %#", (usage) => {
    expect(() => expectUsage(usage, "responses", messages)).toThrow();
  });

  it("distinguishes native missing cache fields from reported zero, and rejects both substitutions", () => {
    const absent: ExpectedResult = { ...messages,
      nativeUsage: { input_tokens: 23, output_tokens: 22 },
      usage: { ...messages.usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const zero: ExpectedResult = { ...absent,
      nativeUsage: { ...absent.nativeUsage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    expectUsage(absent.nativeUsage, "messages", absent);
    expectUsage(zero.nativeUsage, "messages", zero);
    expect(() => expectUsage(zero.nativeUsage, "messages", absent)).toThrow();
    expect(() => expectUsage(absent.nativeUsage, "messages", zero)).toThrow();
  });

  it("retains initial converted Messages stream cache zeros rather than pretending the provider reported them", () => {
    const chat: ExpectedResult = { ...messages, upstream: "chat",
      nativeUsage: { prompt_tokens: 31, completion_tokens: 22, total_tokens: 53 },
      usage: { ...messages.usage, inputTokens: 31, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const buffered = { input_tokens: 31, output_tokens: 22 };
    const streamed = { ...buffered, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    expectUsage(streamed, "messages", chat);
    expectUsage(buffered, "messages", { ...chat, mode: "nonstream" });
    expect(() => expectUsage(buffered, "messages", chat)).toThrow();
    expect(() => expectUsage(streamed, "messages", { ...chat, mode: "nonstream" })).toThrow();
  });

  it("rejects lost or duplicated SDK-parsed reasoning fragments and converted reasoning leakage", () => {
    const expected: ExpectedResult = { ...messages, upstream: "chat", reasoning: [{ reasoning_text: "first " }, { reasoning_text: "second" }] };
    const result: SdkResult<OpenAI.ChatCompletion> = {
      response: { choices: [{ message: { role: "assistant", content: "answer" } }] } as OpenAI.ChatCompletion,
      text: "answer", terminal: "stop", stream: { text: "answer", terminalCount: 1, reasoningText: "first second", reasoningDeltaCount: 2 },
    };
    expectReasoningResult(result, expected, "chat");
    for (const reasoningText of [undefined, "second", "first secondsecond"]) {
      expect(() => expectReasoningResult({ ...result, stream: { ...result.stream!, reasoningText } }, expected, "chat")).toThrow();
    }
    expect(() => expectReasoningResult(result, { ...expected, upstream: "messages" }, "chat")).toThrow();
  });

  it("does not add nested Chat reasoning subsets, even when separate reasoning is also present", () => {
    const expected: ExpectedResult = { ...messages, upstream: "chat",
      nativeUsage: { prompt_tokens: 31, completion_tokens: 22, total_tokens: 53,
        reasoning_tokens: 13, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } },
      usage: { ...messages.usage, inputTokens: 31 },
    };
    expectUsage(expected.nativeUsage, "chat", expected);
    expectUsage(responses, "responses", expected);
    expect(() => expectUsage({ ...responses, output_tokens: 35, total_tokens: 66 }, "responses", expected)).toThrow();
  });

  it("reads every shared exchange using its own bodyFile and source metadata, including five-turn steps", async () => {
    const manifest = JSON.parse(await readFile(new URL("../sdk/corpus/manifest.json", import.meta.url), "utf8")) as ReplayScenarioManifest;
    const shared = new Set(manifest.responseSets.flatMap((set) => set.exchangeIds));
    expect(shared.size).toBeGreaterThan(0);
    for (const exchange of manifest.exchanges.filter((candidate) => shared.has(candidate.caseId))) {
      const result = await readExpectedExchangeResult(exchange);
      expect(result.upstream).toBe(exchange.targetProtocol);
      expect(result.usage).toEqual(exchange.downstreamExpectation?.usage);
      expectUsage(result.nativeUsage, result.upstream, result);
    }
  });

  it.each([
    { id: "replay.messages.plain-text.stream", uncached: 0, cached: 94, total: 94 },
    { id: "replay.messages.image.stream", uncached: 82, cached: 629, total: 711 },
  ])("keeps historical $id cache fraction without requiring fresh capture hit rates", async ({ id, uncached, cached, total }) => {
    const manifest = JSON.parse(await readFile(new URL("../sdk/corpus/manifest.json", import.meta.url), "utf8")) as ReplayScenarioManifest;
    const result = await readExpectedExchangeResult(manifest.exchanges.find((exchange) => exchange.caseId === id)!);
    expect(result.nativeUsage.input_tokens).toBe(uncached);
    expect(result.nativeUsage.cache_read_input_tokens).toBe(cached);
    expect(result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens).toBe(total);
    expect(cached / total).toBeLessThanOrEqual(1);
    expectUsage({ input_tokens: total, output_tokens: result.usage.outputTokens, total_tokens: total + result.usage.outputTokens,
      input_tokens_details: { cached_tokens: cached }, output_tokens_details: { reasoning_tokens: 0 } }, "responses", result);
  });
});
