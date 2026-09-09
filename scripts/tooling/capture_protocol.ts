import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { convertBufferedResponse } from "../../src/protocols/conversion/buffered.js";
import { decodeProtocolStream } from "../../src/protocols/conversion/stream_decoders.js";
import { decodeSseRecords } from "../../src/protocols/conversion/sse.js";
import type { InferenceProtocol, SemanticUsage } from "../../src/protocols/conversion/types.js";
import {
  expectedForecastArguments, FORECAST_TOOL_ANTHROPIC, FORECAST_TOOL_OPENAI, FORECAST_TOOL_RESPONSES,
  PARIS_RESULT, TOKYO_RESULT, type ScenarioTurn,
} from "./capture_scenarios.js";

export const CAPTURE_MODELS = {
  "gemini-3.5-flash": { protocol: "chat", route: "/chat/completions", maxOutputTokens: 8_192 },
  "gpt-5.5": { protocol: "responses", route: "/responses", maxOutputTokens: 16_384 },
  "claude-sonnet-4": { protocol: "messages", route: "/v1/messages", maxOutputTokens: 8_192 },
} as const;
export type CaptureModel = keyof typeof CAPTURE_MODELS;
export interface CaptureToolCall { id: string; name: string; arguments: string }
export interface CaptureAssistant { text: string; calls: CaptureToolCall[] }
export type CaptureHistoryItem =
  | { role: "user"; text: string; image?: string }
  | ({ role: "assistant" } & CaptureAssistant)
  | { role: "tool"; callId: string; text: string };

export function encodeCaptureRequest(model: CaptureModel, system: string, history: readonly CaptureHistoryItem[], stream: boolean, tools: boolean): Uint8Array {
  const config = CAPTURE_MODELS[model];
  const common = { model, stream };
  let body: object;
  if (config.protocol === "chat") {
    body = {
      ...common, max_tokens: config.maxOutputTokens,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(tools ? { tools: [FORECAST_TOOL_OPENAI], tool_choice: "required", parallel_tool_calls: true } : {}),
      messages: [{ role: "system", content: system }, ...history.map((item) => {
        if (item.role === "tool") return { role: "tool", tool_call_id: item.callId, content: item.text };
        if (item.role === "assistant") return {
          role: "assistant", content: item.text || null,
          ...(item.calls.length ? { tool_calls: item.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
        };
        return { role: "user", content: item.image === undefined ? item.text : [
          { type: "text", text: item.text }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${item.image}`, detail: "auto" } },
        ] };
      })],
    };
  } else if (config.protocol === "responses") {
    body = {
      ...common, instructions: system, max_output_tokens: config.maxOutputTokens, reasoning: { effort: "low" }, store: false,
      ...(tools ? { tools: [FORECAST_TOOL_RESPONSES], tool_choice: "required", parallel_tool_calls: true } : {}),
      input: history.flatMap((item): object[] => {
        if (item.role === "tool") return [{ type: "function_call_output", call_id: item.callId, output: item.text }];
        if (item.role === "assistant") return [
          ...(item.text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] }] : []),
          ...item.calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments })),
        ];
        return [{ role: "user", content: [
          { type: "input_text", text: item.text },
          ...(item.image === undefined ? [] : [{ type: "input_image", image_url: `data:image/jpeg;base64,${item.image}`, detail: "auto" }]),
        ] }];
      }),
    };
  } else {
    const messages: Array<{ role: string; content: object[] }> = [];
    for (const item of history) {
      const role = item.role === "assistant" ? "assistant" : "user";
      const content: object[] = item.role === "tool"
        ? [{ type: "tool_result", tool_use_id: item.callId, content: item.text }]
        : item.role === "assistant"
          ? [...(item.text ? [{ type: "text", text: item.text }] : []), ...item.calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments) as unknown }))]
          : [...(item.image === undefined ? [] : [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: item.image } }]), { type: "text", text: item.text }];
      // Adjacent tool results and the following user prompt belong to one user turn.
      const previous = messages.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else messages.push({ role, content });
    }
    body = {
      ...common, system, max_tokens: config.maxOutputTokens, messages,
      ...(tools ? { tools: [FORECAST_TOOL_ANTHROPIC], tool_choice: { type: "any", disable_parallel_tool_use: false } } : {}),
    };
  }
  return Buffer.from(JSON.stringify(body));
}

export interface ValidatedCapture {
  readonly assistant: CaptureAssistant;
  readonly usage: SemanticUsage;
  readonly terminal: "completed";
  readonly textCharacters: number;
  readonly textSha256: string;
  readonly semanticDeltas: number;
}

export async function validateCaptureResponse(protocol: InferenceProtocol, bytes: Uint8Array, stream: boolean, turn: ScenarioTurn, maxBodyBytes: number): Promise<ValidatedCapture> {
  let assistant: CaptureAssistant;
  let usage: SemanticUsage | undefined;
  let semanticDeltas = 0;
  if (!stream) {
    validateNativeEnvelope(protocol, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    const converted = convertBufferedResponse(bytes, {
      source: protocol, target: "chat", model: "capture", maxBytes: maxBodyBytes,
      createUuid: () => "00000000-0000-4000-8000-000000000001", nowUnixSeconds: () => 0,
    });
    if (converted.observations.terminal !== "completed") invalid();
    const value = JSON.parse(Buffer.from(converted.bytes).toString("utf8")) as {
      choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    const message = value.choices[0]!.message;
    assistant = { text: message.content ?? "", calls: (message.tool_calls ?? []).map((call) => ({ id: call.id, ...call.function })) };
    usage = converted.observations.usage;
  } else {
    // Consume the complete wire stream independently of semantic decoders, which
    // intentionally stop at their terminal. Reject trailing data/errors as well.
    await validateWireTerminal(protocol, bytes, maxBodyBytes);
    const texts = new Map<string, string>();
    const tools = new Map<string, CaptureToolCall & { done: boolean }>();
    let terminal = false;
    for await (const event of decodeProtocolStream(protocol, asBytes(bytes), Math.min(maxBodyBytes, 1_048_576), maxBodyBytes)) {
      if (event.kind === "text_delta") {
        texts.set(event.key, (texts.get(event.key) ?? "") + event.delta);
        semanticDeltas += 1;
      } else if (event.kind === "text_done") {
        const previous = texts.get(event.key);
        if (previous !== undefined && previous !== event.text) invalid();
        texts.set(event.key, event.text);
      } else if (event.kind === "refusal_delta" || event.kind === "refusal_done") invalid();
      else if (event.kind === "tool_start") {
        if (tools.has(event.key)) invalid();
        tools.set(event.key, { id: event.callId, name: event.name, arguments: "", done: false });
      } else if (event.kind === "tool_arguments_delta") {
        const tool = tools.get(event.key);
        if (tool === undefined || tool.done) invalid();
        tool.arguments += event.delta;
        semanticDeltas += 1;
      } else if (event.kind === "tool_done") {
        const tool = tools.get(event.key);
        if (tool === undefined || event.completed === false) invalid();
        if (event.argumentsJson !== undefined) {
          if (tool.arguments !== "" && tool.arguments !== event.argumentsJson) invalid();
          tool.arguments = event.argumentsJson;
        }
        tool.done = true;
      } else if (event.kind === "usage") usage = event.usage;
      else if (event.kind === "terminal") {
        if (terminal || event.status !== "completed" || (event.finishReason !== "stop" && event.finishReason !== "tool_calls")) invalid();
        terminal = true;
      }
    }
    if (!terminal || [...tools.values()].some((tool) => !tool.done)) invalid();
    assistant = { text: [...texts.values()].join(""), calls: [...tools.values()].map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) };
  }
  if (usage === undefined || usage.inputTokens + usage.cacheReadTokens <= 0 || usage.outputTokens <= 0) invalid();
  for (const value of Object.values(usage)) if (!Number.isSafeInteger(value) || value < 0) invalid();
  if (assistant.text.length < turn.minTextCharacters) invalid();
  if (turn.tools) validateForecastCalls(assistant.calls);
  else if (assistant.calls.length !== 0) invalid();
  return {
    assistant, usage, terminal: "completed", textCharacters: assistant.text.length,
    textSha256: createHash("sha256").update(assistant.text).digest("hex"), semanticDeltas,
  };
}

export function forecastResults(calls: readonly CaptureToolCall[]): CaptureHistoryItem[] {
  return calls.map((call) => {
    const args = JSON.parse(call.arguments) as { location: { city: string } };
    return { role: "tool", callId: call.id, text: args.location.city === "Tokyo" ? TOKYO_RESULT : PARIS_RESULT };
  });
}

function validateForecastCalls(calls: readonly CaptureToolCall[]): void {
  if (calls.length !== 2 || new Set(calls.map((call) => call.id)).size !== 2) invalid();
  const cities = new Set<string>();
  for (const call of calls) {
    if (!call.id || call.name !== "get_hourly_forecast") invalid();
    const args = JSON.parse(call.arguments) as ReturnType<typeof expectedForecastArguments>;
    const city = args?.location?.city;
    if (city !== "Tokyo" && city !== "Paris") invalid();
    if (!Array.isArray(args.fields)) invalid();
    const expected = expectedForecastArguments(city);
    if (!isDeepStrictEqual({ ...args, fields: [...args.fields].sort() }, { ...expected, fields: [...expected.fields].sort() })) invalid();
    cities.add(city);
  }
  if (cities.size !== 2) invalid();
}

async function validateWireTerminal(protocol: InferenceProtocol, bytes: Uint8Array, maxBodyBytes: number): Promise<void> {
  let terminal = false;
  let nativeFinish = false;
  for await (const record of decodeSseRecords(asBytes(bytes), Math.min(maxBodyBytes, 1_048_576))) {
    if (terminal) invalid();
    if (protocol === "chat" && record.data === "[DONE]") { terminal = true; continue; }
    const value = object(JSON.parse(record.data) as unknown);
    if ((value.error !== undefined && value.error !== null) || value.type === "error") invalid();
    if (protocol === "chat") {
      if (!Array.isArray(value.choices)) invalid();
      for (const choice of value.choices) {
        const finish = object(choice).finish_reason;
        if (finish !== undefined && finish !== null) {
          if (nativeFinish || (finish !== "stop" && finish !== "tool_calls")) invalid();
          nativeFinish = true;
        }
      }
    }
    if (protocol === "messages" && value.type === "message_delta") {
      const stop = object(value.delta).stop_reason;
      if (stop !== undefined && stop !== null) {
        if (nativeFinish || !["end_turn", "tool_use", "stop_sequence"].includes(String(stop))) invalid();
        nativeFinish = true;
      }
    }
    if (protocol === "messages" && value.type === "message_stop") terminal = true;
    if (protocol === "responses" && value.type === "response.completed") {
      validateNativeEnvelope(protocol, value.response);
      terminal = true;
      nativeFinish = true;
    }
    if (record.eventName !== undefined && protocol !== "chat" && record.eventName !== value.type) invalid();
  }
  if (!terminal || !nativeFinish) invalid();
}
function validateNativeEnvelope(protocol: InferenceProtocol, input: unknown): void {
  const value = object(input);
  if (value.error !== undefined && value.error !== null) invalid();
  if (protocol === "responses") {
    if (value.object !== "response" || value.status !== "completed") invalid();
  } else if (protocol === "messages") {
    if (value.type !== "message" || value.role !== "assistant" || !["end_turn", "tool_use", "stop_sequence"].includes(String(value.stop_reason))) invalid();
  } else {
    if ((value.object !== undefined && value.object !== "chat.completion") || !Array.isArray(value.choices) || value.choices.length !== 1) invalid();
    const choice = object(value.choices[0]);
    if (object(choice.message).role !== "assistant" || !["stop", "tool_calls"].includes(String(choice.finish_reason))) invalid();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
async function* asBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
function invalid(): never { throw new Error("capture_invalid_response"); }
