import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { expect } from "vitest";
import type { SdkMode, SdkProtocol, SdkResult } from "./client.js";
import type { TextScenario } from "./scenarios.js";
import type { ReplayExchangeRecord } from "../../src/replay/types.js";

type CapturedUsage = NonNullable<NonNullable<ReplayExchangeRecord["downstreamExpectation"]>["usage"]>;

export interface ExpectedResult {
  readonly text: string;
  readonly upstream: SdkProtocol;
  readonly usage: CapturedUsage;
}

export async function readExpectedResult(manifest: readonly ReplayExchangeRecord[], protocol: SdkProtocol, scenario: TextScenario["id"], mode: SdkMode): Promise<ExpectedResult> {
  const usage = manifest.find((record) => record.caseId === `replay.${protocol}.${scenario}.${mode}`)?.downstreamExpectation?.usage;
  if (usage === undefined) throw new Error("Missing captured usage expectation");
  return { text: await readExpectedText(protocol, scenario, mode), upstream: protocol, usage };
}

export function matchesTextRequest(body: unknown, protocol: SdkProtocol, scenario: TextScenario, imageBase64: string | undefined): boolean {
  const request = record(body);
  if (request === undefined || request.tools !== undefined) return false;
  let content: unknown;
  let system: unknown;
  if (protocol === "responses") {
    system = request.instructions;
    if (typeof request.input === "string") content = request.input;
    else {
      if (!Array.isArray(request.input)) return false;
      const input = [...request.input];
      if (system === undefined && ["system", "developer"].includes(String(record(input[0])?.role))) {
        system = record(input.shift())?.content;
      }
      if (input.length !== 1) return false;
      const message = record(input[0]);
      if (message?.role !== "user") return false;
      content = message.content;
    }
  } else {
    if (!Array.isArray(request.messages)) return false;
    const messages = [...request.messages];
    if (protocol === "chat" && record(messages[0])?.role === "system") {
      system = record(messages.shift())?.content;
    } else if (protocol === "messages") system = request.system;
    if (messages.length !== 1 || record(messages[0])?.role !== "user") return false;
    content = record(messages[0])?.content;
  }
  if (Array.isArray(system)) {
    if (system.length !== 1 || !["text", "input_text"].includes(String(record(system[0])?.type))) return false;
    system = record(system[0])?.text;
  }
  if (system !== scenario.system) return false;
  if (typeof content === "string") return imageBase64 === undefined && content === scenario.prompt;
  if (!Array.isArray(content) || content.length !== (imageBase64 === undefined ? 1 : 2)) return false;
  let texts = 0;
  let images = 0;
  for (const value of content) {
    const part = record(value);
    if (part === undefined) return false;
    if (part.type === (protocol === "responses" ? "input_text" : "text")) {
      if (part.text !== scenario.prompt) return false;
      texts += 1;
    } else {
      if (imageBase64 === undefined) return false;
      if (protocol === "messages") {
        const source = record(part.source);
        if (part.type !== "image" || source?.type !== "base64" || source.media_type !== "image/jpeg" || source.data !== imageBase64) return false;
      } else {
        const image = protocol === "chat" ? record(part.image_url)?.url : part.image_url;
        if (part.type !== (protocol === "chat" ? "image_url" : "input_image") || image !== `data:image/jpeg;base64,${imageBase64}`) return false;
      }
      images += 1;
    }
  }
  return texts === 1 && images === (imageBase64 === undefined ? 0 : 1);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read only fixed upstream fixture fields, independently of SDK result extraction and production converters. */
async function readExpectedText(protocol: SdkProtocol, scenario: TextScenario["id"], mode: SdkMode): Promise<string> {
  const extension = mode === "stream" ? "txt" : "json";
  const raw = await readFile(new URL(`./corpus/${protocol}/${scenario}.${mode}.${extension}`, import.meta.url), "utf8");
  if (mode === "nonstream") {
    switch (protocol) {
    case "chat": {
      const fixture = JSON.parse(raw) as OpenAI.ChatCompletion;
      return fixture.choices[0]?.message.content ?? "";
    }
    case "messages": {
      const fixture = JSON.parse(raw) as Anthropic.Message;
      return fixture.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    case "responses": {
      const fixture = JSON.parse(raw) as OpenAI.Responses.Response;
      return fixture.output.flatMap((item) => item.type === "message"
        ? item.content.flatMap((part) => part.type === "output_text" ? [part.text] : [])
        : []).join("");
    }
    }
  }

  // These immutable SSE fixtures have one JSON data line per event; this is not a wire decoder.
  const events = raw.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).filter((data) => data !== "[DONE]");
  return events.map((data) => {
    switch (protocol) {
    case "chat": {
      const event = JSON.parse(data) as OpenAI.ChatCompletionChunk;
      return event.choices[0]?.delta.content ?? "";
    }
    case "messages": {
      const event = JSON.parse(data) as Anthropic.MessageStreamEvent;
      return event.type === "content_block_delta" && event.delta.type === "text_delta" ? event.delta.text : "";
    }
    case "responses": {
      const event = JSON.parse(data) as OpenAI.Responses.ResponseStreamEvent;
      return event.type === "response.output_text.delta" ? event.delta : "";
    }
    }
  }).join("");
}

export function expectScenarioResult(
  result: SdkResult<OpenAI.ChatCompletion | Anthropic.Message | OpenAI.Responses.Response>,
  expected: ExpectedResult,
  scenario: TextScenario,
  downstream: SdkProtocol,
  mode: SdkMode,
): void {
  const expectedText = expected.text;
  expect(expectedText.length).toBeGreaterThan(1_000);
  // Compare complete strings without dumping captured content in a failed assertion.
  expect(result.text === expectedText, "complete parsed text matches the upstream fixture").toBe(true);
  for (const fact of scenario.facts) {
    expect(fact.pattern.test(result.text), fact.name).toBe(true);
  }
  expectUsage(result.response.usage, downstream, expected);
  expect(result.response.usage).not.toHaveProperty("visual_tokens");
  if (scenario.id === "image") {
    // These captures aggregate vision cost in input totals, without a separate visual-token breakdown.
    for (const field of ["image_tokens", "prompt_tokens_details.image_tokens", "input_tokens_details.image_tokens"]) {
      expect(result.response.usage).not.toHaveProperty(field);
    }
  }
  expect(result.terminal).toBe({ chat: "stop", messages: "end_turn", responses: "completed" }[downstream]);
  if (mode === "stream") {
    expect(result.stream?.terminalCount, "exactly one normal terminal outcome").toBe(1);
    expect(result.stream?.text === expectedText, "streamed text is neither truncated nor duplicated").toBe(true);
  } else {
    expect(result.stream).toBeUndefined();
  }
}

function expectUsage(usage: unknown, downstream: SdkProtocol, expected: ExpectedResult): void {
  const captured = expected.usage;
  // Capture metadata records native counters. Messages cache inputs and this Chat provider's
  // top-level reasoning output are separate; Responses counters already include them.
  const input = captured.inputTokens + (expected.upstream === "messages" ? captured.cacheReadTokens + captured.cacheWriteTokens : 0);
  const output = captured.outputTokens + (expected.upstream === "chat" ? captured.reasoningTokens : 0);
  switch (downstream) {
  case "chat": {
    const actual = usage as OpenAI.CompletionUsage & { reasoning_tokens?: number };
    expect(actual).toMatchObject({
      prompt_tokens: input,
      completion_tokens: expected.upstream === "chat" ? captured.outputTokens : output,
      total_tokens: input + output,
    });
    expect(actual.prompt_tokens_details?.cached_tokens ?? 0).toBe(captured.cacheReadTokens);
    const reasoning = expected.upstream === "chat" ? actual.reasoning_tokens : actual.completion_tokens_details?.reasoning_tokens;
    expect(reasoning ?? 0).toBe(captured.reasoningTokens);
    break;
  }
  case "messages": {
    const actual = usage as Anthropic.Usage;
    expect(actual).toMatchObject({ input_tokens: input - captured.cacheReadTokens - captured.cacheWriteTokens, output_tokens: output });
    expect(actual.cache_read_input_tokens ?? 0).toBe(captured.cacheReadTokens);
    expect(actual.cache_creation_input_tokens ?? 0).toBe(captured.cacheWriteTokens);
    break;
  }
  case "responses": {
    const actual = usage as OpenAI.Responses.ResponseUsage;
    expect(actual).toMatchObject({ input_tokens: input, output_tokens: output, total_tokens: input + output });
    expect(actual.input_tokens_details?.cached_tokens ?? 0).toBe(captured.cacheReadTokens);
    expect(actual.output_tokens_details?.reasoning_tokens ?? 0).toBe(captured.reasoningTokens);
    break;
  }
  }
}
