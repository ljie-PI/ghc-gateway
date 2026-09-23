import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { expect } from "vitest";
import { TEXT_TERMINAL, type SdkMode, type SdkProtocol, type SdkResult } from "./client.js";
import { MIN_TEXT_SCENARIO_CHARACTERS, type TextScenario } from "./scenarios.js";
import type { ReplayExchangeRecord } from "../support/replay/types.js";

interface CapturedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly visualTokens: number | "not_reported";
}

export interface ExpectedResult {
  readonly text: string;
  readonly upstream: SdkProtocol;
  readonly usage: CapturedUsage;
  /** Fixed native fields retain the difference between an explicit zero and no report. */
  readonly nativeUsage: Readonly<Record<string, unknown>>;
  readonly mode: SdkMode;
  readonly reasoning: readonly unknown[];
  readonly toolCallIds: readonly string[];
}

export async function readExpectedResult(manifest: readonly ReplayExchangeRecord[], protocol: SdkProtocol, scenario: TextScenario["id"], mode: SdkMode): Promise<ExpectedResult> {
  const exchange = manifest.find((record) => record.caseId === `replay.${protocol}.${scenario}.${mode}`);
  if (exchange === undefined) throw new Error("Missing captured exchange expectation");
  return readExpectedExchangeResult(exchange);
}

/** Read immutable fixture fields, never a production converter or the downstream SDK result. */
export async function readExpectedExchangeResult(exchange: ReplayExchangeRecord): Promise<ExpectedResult> {
  const raw = await readFile(new URL(`./corpus/${exchange.response.bodyFile}`, import.meta.url), "utf8");
  const upstream = exchange.targetProtocol;
  const mode = exchange.response.stream ? "stream" : "nonstream";
  // These fixed SSE fixtures have one JSON data line per event; this is not a wire decoder.
  const fixtures: Record<string, unknown>[] = mode === "nonstream" ? [JSON.parse(raw)]
    : raw.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data));
  const last = fixtures.at(-1)!;
  const completed = mode === "nonstream" ? last : upstream === "responses" ? record(last.response) : undefined;
  // Current captures have complete final Chat/Responses usage; Messages has start + final delta usage.
  const nativeUsage = mode === "nonstream" ? record(last.usage)!
    : upstream === "chat" ? record(fixtures.findLast((event) => record(event.usage) !== undefined)?.usage)!
      : upstream === "responses" ? record(completed?.usage)!
        : { ...record(record(fixtures[0]?.message)?.usage), ...record(fixtures.findLast((event) => event.type === "message_delta")?.usage) };
  if (nativeUsage === undefined) throw new Error("Missing fixed fixture usage");
  const fields = usageFields(nativeUsage, upstream);
  const usage: CapturedUsage = {
    inputTokens: fields.input, outputTokens: fields.output,
    cacheReadTokens: fields.cacheRead ?? 0, cacheWriteTokens: fields.cacheWrite ?? 0,
    reasoningTokens: fields.reasoning ?? 0, visualTokens: "not_reported",
  };
  const reasoning = upstream === "messages"
    ? mode === "stream" ? streamedThinkingBlocks(fixtures)
      : (completed?.content as Anthropic.ContentBlock[] | undefined)?.filter((block) => block.type === "thinking" || block.type === "redacted_thinking") ?? []
    : upstream === "responses"
      ? (completed?.output as OpenAI.Responses.ResponseOutputItem[] | undefined)?.filter((item) => item.type === "reasoning") ?? []
      : fixtures.flatMap((fixture) => {
        const choice = record((fixture.choices as unknown[] | undefined)?.[0]);
        return chatReasoning(mode === "stream" ? choice?.delta : choice?.message);
      });
  return { text: fixedText(fixtures, upstream, mode), upstream, usage, nativeUsage, mode, reasoning,
    toolCallIds: fixedToolIds(fixtures, upstream, mode) };
}

/** Fixed Messages thinking blocks: start snapshots plus their ordered thinking/signature deltas. */
function streamedThinkingBlocks(fixtures: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const blocks = new Map<unknown, Record<string, unknown>>();
  for (const event of fixtures) {
    const block = event.type === "content_block_start" ? record(event.content_block) : undefined;
    if (block?.type === "thinking" || block?.type === "redacted_thinking") blocks.set(event.index, { ...block });
    const target = event.type === "content_block_delta" ? blocks.get(event.index) : undefined;
    const delta = record(event.delta);
    if (target === undefined || delta === undefined) continue;
    if (delta.type === "thinking_delta") target.thinking = `${String(target.thinking)}${String(delta.thinking)}`;
    if (delta.type === "signature_delta") target.signature = `${String(target.signature ?? "")}${String(delta.signature)}`;
  }
  return [...blocks.values()];
}

export function matchesTextRequest(body: unknown, protocol: SdkProtocol, scenario: Pick<TextScenario, "prompt" | "system">, imageBase64: string | undefined): boolean {
  const request = record(body);
  if (request === undefined || request.tools !== undefined) return false;
  let content: unknown;
  let system: unknown;
  if (protocol === "responses") {
    system = request.instructions;
    if (typeof request.input === "string") content = request.input;
    else {
      if (!boundedArray(request.input)) return false;
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
    if (!boundedArray(request.messages)) return false;
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
  if (!boundedArray(content) || content.length !== (imageBase64 === undefined ? 1 : 2)) return false;
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
        const detail = protocol === "chat" ? record(part.image_url)?.detail : part.detail;
        if (part.type !== (protocol === "chat" ? "image_url" : "input_image") || image !== `data:image/jpeg;base64,${imageBase64}`
          || (detail !== undefined && detail !== "auto")) return false;
      }
      images += 1;
    }
  }
  return texts === 1 && images === (imageBase64 === undefined ? 0 : 1);
}

function boundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= 64;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fixedToolIds(fixtures: readonly Record<string, unknown>[], protocol: SdkProtocol, mode: SdkMode): string[] {
  // Read identity-bearing fixture entries only; SDKs, not this helper, assemble arguments.
  return fixtures.flatMap((fixture) => {
    if (protocol === "chat") {
      const calls = mode === "stream" ? (fixture as unknown as OpenAI.ChatCompletionChunk).choices[0]?.delta.tool_calls
        : (fixture as unknown as OpenAI.ChatCompletion).choices[0]?.message.tool_calls;
      return calls?.flatMap((call) => call.id === undefined ? [] : [call.id]) ?? [];
    }
    if (protocol === "messages") {
      const blocks = mode === "nonstream" ? (fixture as unknown as Anthropic.Message).content
        : fixture.type === "content_block_start" ? [(fixture as unknown as Anthropic.ContentBlockStartEvent).content_block] : [];
      return blocks.flatMap((block) => block.type === "tool_use" ? [block.id] : []);
    }
    const items = mode === "nonstream" ? (fixture as unknown as OpenAI.Responses.Response).output
      : fixture.type === "response.output_item.added" ? [(fixture as unknown as OpenAI.Responses.ResponseOutputItemAddedEvent).item] : [];
    return items.flatMap((item) => item.type === "function_call" ? [item.call_id] : []);
  });
}

function fixedText(fixtures: readonly Record<string, unknown>[], protocol: SdkProtocol, mode: SdkMode): string {
  if (mode === "nonstream") {
    switch (protocol) {
    case "chat": {
      const fixture = fixtures[0] as unknown as OpenAI.ChatCompletion;
      return fixture.choices[0]?.message.content ?? "";
    }
    case "messages": {
      const fixture = fixtures[0] as unknown as Anthropic.Message;
      return fixture.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    case "responses": {
      const fixture = fixtures[0] as unknown as OpenAI.Responses.Response;
      return fixture.output.flatMap((item) => item.type === "message"
        ? item.content.flatMap((part) => part.type === "output_text" ? [part.text] : [])
        : []).join("");
    }
    }
  }

  return fixtures.map((data) => {
    switch (protocol) {
    case "chat": {
      const event = data as unknown as OpenAI.ChatCompletionChunk;
      return event.choices[0]?.delta.content ?? "";
    }
    case "messages": {
      const event = data as unknown as Anthropic.MessageStreamEvent;
      return event.type === "content_block_delta" && event.delta.type === "text_delta" ? event.delta.text : "";
    }
    case "responses": {
      const event = data as unknown as OpenAI.Responses.ResponseStreamEvent;
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
  expect(expectedText.length).toBeGreaterThanOrEqual(MIN_TEXT_SCENARIO_CHARACTERS);
  // Compare complete strings without dumping captured content in a failed assertion.
  expect(result.text === expectedText, "complete parsed text matches the upstream fixture").toBe(true);
  for (const fact of scenario.facts) {
    expect(fact.pattern.test(result.text), fact.name).toBe(true);
  }
  expectUsage(result.response.usage, downstream, expected);
  expectReasoningResult(result, expected, downstream);
  expect(result.terminal === TEXT_TERMINAL[downstream], "normal terminal outcome").toBe(true);
  if (mode === "stream") {
    expect(result.stream?.terminalCount, "exactly one normal terminal outcome").toBe(1);
    expect(result.stream?.text === expectedText, "streamed text is neither truncated nor duplicated").toBe(true);
  } else {
    expect(result.stream === undefined, "buffered results contain no stream observations").toBe(true);
  }
}

export function expectReasoningResult(
  result: SdkResult<OpenAI.ChatCompletion | Anthropic.Message | OpenAI.Responses.Response>,
  expected: ExpectedResult,
  downstream: SdkProtocol,
): void {
  const native = downstream === expected.upstream;
  const expectedVisible = visibleReasoningText(expected.reasoning, expected.upstream);
  if (downstream === "chat" && expected.mode === "stream") {
    const nativeFragments = expected.reasoning.flatMap((value) => {
      const text = record(value)?.reasoning_text;
      return typeof text === "string" ? [text] : [];
    });
    const expectedText = native ? nativeFragments.join("") : expectedVisible;
    expect(result.stream?.reasoningText === (expectedText.length === 0 ? undefined : expectedText), "complete SDK-parsed visible reasoning deltas").toBe(true);
    if (native) expect(result.stream?.reasoningDeltaCount).toBe(nativeFragments.length);
    else expect((result.stream?.reasoningDeltaCount ?? 0) > 0).toBe(expectedVisible.length > 0);
    return;
  }
  const actual = downstream === "chat" ? chatReasoning((result.response as OpenAI.ChatCompletion).choices[0]?.message)
    : downstream === "messages" ? (result.response as Anthropic.Message).content.filter((block) => block.type === "thinking" || block.type === "redacted_thinking")
      : (result.response as OpenAI.Responses.Response).output.filter((item) => item.type === "reasoning");
  if (native) {
    expect(JSON.stringify(actual) === JSON.stringify(expected.reasoning), "SDK-parsed native reasoning and opaque state are preserved").toBe(true);
    return;
  }
  const actualVisible = downstream === "messages" ? "" : visibleReasoningText(actual, downstream);
  expect(actualVisible === (downstream === "messages" ? "" : expectedVisible), "converted visible reasoning is preserved only in protocol-valid targets").toBe(true);
}

function chatReasoning(value: unknown): Record<string, unknown>[] {
  const message = record(value);
  const fields = Object.fromEntries(["reasoning_text", "reasoning_opaque", "reasoning_content", "thinking_blocks", "reasoning_items"]
    .flatMap((key) => message?.[key] === undefined ? [] : [[key, message[key]]]));
  return Object.keys(fields).length === 0 ? [] : [fields];
}

export function expectUsage(usage: unknown, downstream: SdkProtocol, expected: ExpectedResult): void {
  const captured = expected.usage;
  const source = usageFields(expected.nativeUsage, expected.upstream);
  const actual = usageFields(usage, downstream);
  // Messages input excludes both cache categories. Only top-level Chat reasoning is additional output.
  const input = captured.inputTokens + (expected.upstream === "messages" ? captured.cacheReadTokens + captured.cacheWriteTokens : 0);
  const separateReasoning = expected.upstream === "chat" && record(expected.nativeUsage.completion_tokens_details)?.reasoning_tokens === undefined;
  const output = captured.outputTokens + (separateReasoning ? captured.reasoningTokens : 0);
  const native = downstream === expected.upstream;
  if (native) expect(isDeepStrictEqual(usage, expected.nativeUsage), "native usage preserves reported fields, including explicit zero").toBe(true);
  else expect(Object.hasOwn(record(usage)!, "reasoning_tokens"), "converted usage does not expose a separate reasoning counter").toBe(false);
  expect(actual.input).toBe(downstream === "messages" ? input - captured.cacheReadTokens - captured.cacheWriteTokens : input);
  expect(actual.output).toBe(native ? captured.outputTokens : output);
  if (downstream !== "messages") expect(record(usage)?.total_tokens === input + output, "inclusive total tokens match").toBe(true);

  // Native absence stays absent. Converted envelopes deliberately materialize only portable details.
  const messagesStream = downstream === "messages" && expected.mode === "stream";
  // The converted Messages message_start reports zero cache counters. SDK finalMessage retains
  // those zeros when message_delta omits them; buffered Messages has no such initial snapshot.
  expect(actual.cacheRead).toBe(native ? source.cacheRead : downstream === "messages" && !messagesStream ? nonzero(captured.cacheReadTokens) : captured.cacheReadTokens);
  expect(actual.cacheWrite).toBe(native ? source.cacheWrite : messagesStream ? captured.cacheWriteTokens : nonzero(captured.cacheWriteTokens));
  expect(actual.reasoning).toBe(native ? source.reasoning
    : downstream === "chat" && expected.mode === "nonstream" ? nonzero(captured.reasoningTokens)
      : downstream === "messages" ? nonzero(captured.reasoningTokens) : captured.reasoningTokens);

  if (source.cacheRead !== undefined) {
    const actualInput = actual.input + (downstream === "messages" ? (actual.cacheRead ?? 0) + (actual.cacheWrite ?? 0) : 0);
    // No hit-rate thresholds: preserve the fixed source ratio, including fully cached Messages input.
    expect(cacheFraction(actual.cacheRead ?? 0, actualInput)).toBe(cacheFraction(source.cacheRead, input));
  }
  expectNoVisualUsage(usage);
}

function nonzero(value: number): number | undefined { return value === 0 ? undefined : value; }
function cacheFraction(cached: number, inclusiveInput: number): number | undefined {
  return inclusiveInput === 0 ? undefined : cached / inclusiveInput;
}

/** These are documented source counters, not a production conversion oracle. */
function usageFields(value: unknown, protocol: SdkProtocol) {
  const usage = record(value);
  if (usage === undefined) throw new Error("Missing SDK-visible usage");
  const inputDetails = record(usage[protocol === "chat" ? "prompt_tokens_details" : "input_tokens_details"]);
  const outputDetails = record(usage[protocol === "chat" ? "completion_tokens_details" : "output_tokens_details"]);
  const fields = {
    input: usage[protocol === "chat" ? "prompt_tokens" : "input_tokens"] as number,
    output: usage[protocol === "chat" ? "completion_tokens" : "output_tokens"] as number,
    cacheRead: (protocol === "messages" ? usage.cache_read_input_tokens : inputDetails?.cached_tokens) as number | undefined,
    cacheWrite: (protocol === "messages" ? usage.cache_creation_input_tokens : inputDetails?.cache_write_tokens) as number | undefined,
    reasoning: (protocol === "messages"
      ? outputDetails?.thinking_tokens
      : outputDetails?.reasoning_tokens ?? (protocol === "chat" ? usage.reasoning_tokens : undefined)) as number | undefined,
  };
  if (fields.input === undefined || fields.output === undefined
    || Object.values(fields).some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new Error("Invalid SDK usage counter");
  }
  return fields;
}

function visibleReasoningText(values: readonly unknown[], protocol: SdkProtocol): string {
  return values.flatMap((value) => {
    const object = record(value);
    if (object === undefined) return [];
    if (protocol === "messages") {
      return object.type === "thinking" && typeof object.thinking === "string" ? [object.thinking] : [];
    }
    if (protocol === "responses") {
      return [object.summary, object.content].flatMap((parts) => Array.isArray(parts)
        ? parts.flatMap((part) => typeof record(part)?.text === "string" ? [record(part)?.text as string] : [])
        : []);
    }
    for (const key of ["reasoning_text", "reasoning_content"] as const) {
      if (typeof object[key] === "string") return [object[key] as string];
    }
    const blocks = Array.isArray(object.thinking_blocks) ? object.thinking_blocks : [];
    return blocks.flatMap((block) => typeof record(block)?.thinking === "string" ? [record(block)?.thinking as string] : []);
  }).join("");
}

export function expectNoVisualUsage(usage: unknown): void {
  // Image understanding is included in input totals; these providers report no separate image tokens.
  for (const field of ["visual_tokens", "image_tokens", "prompt_tokens_details.image_tokens", "input_tokens_details.image_tokens"]) {
    const keys = field.split(".");
    const key = keys.pop()!;
    const parent = record(keys.reduce<unknown>((value, member) => record(value)?.[member], usage));
    expect(parent !== undefined && Object.hasOwn(parent, key), `no inferred ${field} breakdown`).toBe(false);
  }
}
