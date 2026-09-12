import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { ReplayExchangeRecord, ReplayScenario, ReplayScenarioManifest } from "../../src/replay/types.js";
import type { SdkProtocol, SdkToolCall } from "./client.js";
import { matchesTextRequest } from "./replay_expectations.js";
import { matchesSessionRequest } from "./session_expectations.js";
import {
  FORECAST_COMPARE_PROMPT, FORECAST_PARAMETERS, MIXED_WEATHER_PROMPT, PARALLEL_WEATHER_PROMPT,
  REASONING_PROMPT, SESSION_ASSISTANT_TEXT_SHA256, TEXT_SCENARIOS, WEATHER_PARAMETERS, WEATHER_PROMPT,
  WEATHER_RESPONSES_PROMPT, WEATHER_RESULT,
} from "./scenarios.js";
import { SESSION_TURNS } from "./session_inputs.js";

const MAX_COLLECTION = 64;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MODELS: Record<SdkProtocol, string> = {
  chat: "gemini-3.5-flash", responses: "gpt-5.5", messages: "claude-sonnet-4",
};

export function replayScenarioId(caseId: string): string {
  const weather = /^replay\.(chat|messages|responses)\.tool-(?:call|result)\.nonstream$/u.exec(caseId);
  if (weather !== null) return `replay.${weather[1]}.weather-roundtrip`;
  const session = /^replay\.(chat|messages|responses)\.coherent-session\.turn-[1-5]$/u.exec(caseId);
  if (session !== null) return `replay.${session[1]}.coherent-session`;
  return caseId;
}

/** Build the one harness-owned scenario catalogue from authored inputs and fixed identity fields. */
export async function createReplayScenarios(manifest: ReplayScenarioManifest): Promise<readonly ReplayScenario[]> {
  const imageBase64 = (await readFile(new URL("./images/vergil.jpg", import.meta.url))).toString("base64");
  const scenarios: ReplayScenario[] = [];
  for (const protocol of ["chat", "responses", "messages"] as const) {
    for (const scenario of TEXT_SCENARIOS) {
      for (const mode of ["nonstream", "stream"] as const) {
        const caseId = `replay.${protocol}.${scenario.id}.${mode}`;
        scenarios.push(single(caseId, protocol, mode === "stream", (body) =>
          matchesTextRequest(body, protocol, scenario, scenario.id === "image" ? imageBase64 : undefined)));
      }
    }
    const reasoningCase = `replay.${protocol}.reasoning-effort.nonstream`;
    scenarios.push(single(reasoningCase, protocol, false, (body) =>
      matchesTextRequest(body, protocol, { prompt: REASONING_PROMPT }, undefined) && matchesReasoning(body, protocol)));

    const toolCallId = await fixedToolCallId(manifest, `replay.${protocol}.tool-call.nonstream`, protocol);
    const previousResponseId = protocol === "responses"
      ? await fixedResponseId(manifest, `replay.${protocol}.tool-call.nonstream`) : undefined;
    scenarios.push({
      scenarioId: `replay.${protocol}.weather-roundtrip`, targetProtocol: protocol, model: MODELS[protocol],
      steps: [
        step(1, `replay.${protocol}.tool-call.nonstream`, false, (body) => matchesWeatherCall(body, protocol)),
        step(2, `replay.${protocol}.tool-result.nonstream`, false,
          (body) => matchesWeatherResult(body, protocol, toolCallId, previousResponseId)),
      ],
    });
    for (const stream of [false, true]) {
      const caseId = `replay.${protocol}.parallel-tools.${stream ? "stream" : "nonstream"}`;
      scenarios.push(single(caseId, protocol, stream, (body) => stream
        ? matchesForecastCall(body, protocol)
        : matchesSimpleToolCall(body, protocol, PARALLEL_WEATHER_PROMPT, undefined)));
    }
    const mixedCase = `replay.${protocol}.mixed-image-tool.nonstream`;
    scenarios.push(single(mixedCase, protocol, false, (body) =>
      matchesSimpleToolCall(body, protocol, MIXED_WEATHER_PROMPT, imageBase64)));

    const sessionIds = SESSION_TURNS.map((turn) => `replay.${protocol}.coherent-session.turn-${turn}`);
    const toolCallIds = await readFixedSessionToolCallIds(manifest, sessionIds[1]!, protocol);
    const calls: readonly SdkToolCall[] = toolCallIds.map((id, index) => ({
      id, name: "get_hourly_forecast", arguments: expectedSessionArguments(index),
    }));
    scenarios.push({
      scenarioId: `replay.${protocol}.coherent-session`, targetProtocol: protocol, model: MODELS[protocol],
      steps: sessionIds.map((caseId, index) => step(index + 1, caseId, index > 0, (body) => matchesSessionRequest(body, {
        protocol, turn: SESSION_TURNS[index]!, imageBase64,
        assistantTextSha256: SESSION_ASSISTANT_TEXT_SHA256[protocol], calls,
      }))),
    });
  }
  return scenarios;
}

function single(caseId: string, protocol: SdkProtocol, stream: boolean, matchesRequest: (body: unknown) => boolean): ReplayScenario {
  return { scenarioId: caseId, targetProtocol: protocol, model: MODELS[protocol], steps: [step(1, caseId, stream, matchesRequest)] };
}

function step(ordinal: number, caseId: string, stream: boolean, matchesRequest: (body: unknown) => boolean) {
  return { ordinal, caseId, stream, matchesRequest };
}

function exchange(manifest: ReplayScenarioManifest, caseId: string): ReplayExchangeRecord {
  const found = manifest.exchanges.find((candidate) => candidate.caseId === caseId);
  if (found === undefined) throw new Error("invalid replay configuration");
  return found;
}

function matchesReasoning(body: unknown, protocol: SdkProtocol): boolean {
  const request = record(body);
  if (request === undefined) return false;
  if (protocol === "chat") return request.reasoning_effort === "low";
  if (protocol === "responses") return record(request.reasoning)?.effort === "low";
  return record(request.output_config)?.effort === "low";
}

function matchesWeatherCall(body: unknown, protocol: SdkProtocol): boolean {
  const prompt = userProjection(body, protocol);
  return prompt !== undefined && prompt.image === undefined
    && [WEATHER_PROMPT, WEATHER_RESPONSES_PROMPT].includes(prompt.text)
    && matchesTool(body, protocol, "get_weather", WEATHER_PARAMETERS);
}

function matchesSimpleToolCall(body: unknown, protocol: SdkProtocol, text: string, image: string | undefined): boolean {
  const prompt = userProjection(body, protocol);
  return prompt?.text === text && prompt.image === image
    && matchesTool(body, protocol, "get_weather", WEATHER_PARAMETERS);
}

function matchesForecastCall(body: unknown, protocol: SdkProtocol): boolean {
  const prompt = userProjection(body, protocol);
  if (prompt?.text !== FORECAST_COMPARE_PROMPT || prompt.image !== undefined
    || !matchesTool(body, protocol, "get_hourly_forecast", FORECAST_PARAMETERS)) return false;
  const request = record(body)!;
  if (protocol === "messages") {
    const choice = record(request.tool_choice);
    return choice?.type === "auto" && choice.disable_parallel_tool_use !== true;
  }
  return request.tool_choice === "auto" && request.parallel_tool_calls === true;
}

function matchesTool(body: unknown, protocol: SdkProtocol, name: string, schema: unknown): boolean {
  const request = record(body);
  if (request === undefined || !boundedArray(request.tools, 1)) return false;
  const wrapper = record(request.tools[0]);
  const tool = protocol === "chat" ? record(wrapper?.function) : wrapper;
  if (tool === undefined || tool.name !== name || (protocol !== "messages" && wrapper?.type !== "function")) return false;
  const actualSchema = protocol === "messages" ? tool.input_schema : tool.parameters;
  return schemaMatches(actualSchema, schema);
}

function schemaMatches(actual: unknown, authored: unknown): boolean {
  if (isDeepStrictEqual(actual, authored)) return true;
  const withClosedObject = structuredClone(authored) as Record<string, unknown>;
  withClosedObject.additionalProperties = false;
  return isDeepStrictEqual(actual, withClosedObject);
}

function userProjection(body: unknown, protocol: SdkProtocol): { text: string; image?: string } | undefined {
  const request = record(body);
  if (request === undefined) return undefined;
  let content: unknown;
  if (protocol === "responses") {
    if (typeof request.input === "string") content = request.input;
    else {
      if (!boundedArray(request.input, 1)) return undefined;
      const user = record(request.input[0]);
      if (user?.role !== "user") return undefined;
      content = user.content;
    }
  } else {
    if (!boundedArray(request.messages, 1)) return undefined;
    const user = record(request.messages[0]);
    if (user?.role !== "user") return undefined;
    content = user.content;
  }
  if (typeof content === "string") return { text: content };
  if (!boundedArray(content, undefined, 2)) return undefined;
  let text: string | undefined;
  let image: string | undefined;
  for (const member of content) {
    const part = record(member);
    if (part === undefined) return undefined;
    if (part.type === "text" || part.type === "input_text") {
      if (typeof part.text !== "string" || text !== undefined) return undefined;
      text = part.text;
    } else if (protocol === "messages") {
      const source = record(part.source);
      if (part.type !== "image" || source?.type !== "base64" || source.media_type !== "image/jpeg" || typeof source.data !== "string" || image !== undefined) return undefined;
      image = source.data;
    } else {
      const url = protocol === "chat" ? record(part.image_url)?.url : part.image_url;
      const detail = protocol === "chat" ? record(part.image_url)?.detail : part.detail;
      if (part.type !== (protocol === "chat" ? "image_url" : "input_image") || typeof url !== "string"
        || !url.startsWith("data:image/jpeg;base64,") || (detail !== undefined && detail !== "auto") || image !== undefined) return undefined;
      image = url.slice("data:image/jpeg;base64,".length);
    }
  }
  return text === undefined ? undefined : { text, ...(image === undefined ? {} : { image }) };
}

function matchesWeatherResult(body: unknown, protocol: SdkProtocol, callId: string, previousResponseId: string | undefined): boolean {
  const request = record(body);
  if (request === undefined || request.tools !== undefined) return false;
  const items = protocol === "responses" ? request.input : request.messages;
  if (!boundedArray(items, undefined, 8)) return false;
  const projected: unknown[][] = [];
  for (const raw of items) {
    const item = record(raw);
    if (item === undefined) return false;
    if (protocol === "responses" && item.type === "function_call") {
      const args = parseBoundedJson(item.arguments);
      if (args === undefined) return false;
      projected.push(["call", item.call_id, item.name, args]);
    } else if (protocol === "responses" && item.type === "function_call_output") {
      projected.push(["result", item.call_id, item.output]);
    } else if (protocol === "chat" && item.role === "assistant") {
      if (!boundedArray(item.tool_calls, 1)) return false;
      const call = record(item.tool_calls[0]);
      const fn = record(call?.function);
      const args = parseBoundedJson(fn?.arguments);
      if (call?.type !== "function" || args === undefined) return false;
      projected.push(["call", call.id, fn?.name, args]);
    } else if (protocol === "chat" && item.role === "tool") {
      projected.push(["result", item.tool_call_id, item.content]);
    } else if (protocol === "messages" && item.role === "assistant") {
      if (!boundedArray(item.content, 1)) return false;
      const call = record(item.content[0]);
      if (call?.type !== "tool_use") return false;
      projected.push(["call", call.id, call.name, call.input]);
    } else if (protocol === "messages" && item.role === "user" && Array.isArray(item.content)) {
      if (!boundedArray(item.content, 1)) return false;
      const result = record(item.content[0]);
      if (result?.type !== "tool_result") return false;
      projected.push(["result", result.tool_use_id, result.content]);
    } else if (item.role === "user" && typeof item.content === "string") {
      if (![WEATHER_PROMPT, WEATHER_RESPONSES_PROMPT, "Use the tool result for the original task."].includes(item.content)) return false;
      projected.push(["user", item.content]);
    } else if (protocol === "responses" && item.role === "user" && boundedArray(item.content, 1)) {
      const text = record(item.content[0]);
      if (text?.type !== "input_text" || typeof text.text !== "string"
        || ![WEATHER_PROMPT, WEATHER_RESPONSES_PROMPT, "Use the tool result for the original task."].includes(text.text)) return false;
      projected.push(["user", text.text]);
    } else return false;
  }
  const result = projected.at(-1);
  if (!isDeepStrictEqual(result, ["result", callId, WEATHER_RESULT])) return false;
  if (request.previous_response_id !== undefined) {
    return protocol === "responses" && request.previous_response_id === previousResponseId && projected.length <= 2
      && projected.every((entry) => entry[0] !== "call");
  }
  const callIndex = projected.findIndex((entry) => entry[0] === "call");
  if (callIndex < 1 || callIndex !== projected.length - 2) return false;
  return isDeepStrictEqual(projected[callIndex], ["call", callId, "get_weather", { city: "Tokyo" }]);
}

function expectedSessionArguments(index: number): unknown {
  const city = index === 0 ? "Tokyo" : "Paris";
  const country_code = index === 0 ? "JP" : "FR";
  return { location: { city, country_code }, date: "2026-10-18", start_hour: 15, end_hour: 18,
    units: "metric", fields: ["temperature_c", "precipitation_probability", "cloud_cover_percent", "wind_speed_kph"] };
}

async function readFixedSessionToolCallIds(
  manifest: ReplayScenarioManifest,
  caseId: string,
  protocol: SdkProtocol,
): Promise<readonly string[]> {
  const raw = await readFile(new URL(`./corpus/${exchange(manifest, caseId).response.bodyFile}`, import.meta.url), "utf8");
  const values = raw.trimStart().startsWith("{")
    ? [JSON.parse(raw) as Record<string, unknown>]
    : raw.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).filter((data) => data !== "[DONE]")
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  const toolCallIds: string[] = [];
  for (const value of values) {
    if (protocol === "chat") {
      const choice = record((value.choices as unknown[] | undefined)?.[0]);
      const message = record(choice?.message) ?? record(choice?.delta);
      if (Array.isArray(message?.tool_calls)) for (const rawCall of message.tool_calls) {
        const id = record(rawCall)?.id;
        if (typeof id === "string" && !toolCallIds.includes(id)) toolCallIds.push(id);
      }
    } else if (protocol === "messages") {
      const content = Array.isArray(value.content) ? value.content
        : value.type === "content_block_start" ? [value.content_block] : [];
      for (const rawPart of content) {
        const part = record(rawPart);
        if (part?.type === "tool_use" && typeof part.id === "string") toolCallIds.push(part.id);
      }
    } else {
      const output = Array.isArray(value.output) ? value.output
        : value.type === "response.output_item.added" ? [value.item] : [];
      for (const rawItem of output) {
        const item = record(rawItem);
        if (item?.type === "function_call" && typeof item.call_id === "string") toolCallIds.push(item.call_id);
      }
    }
  }
  return [...new Set(toolCallIds)];
}

async function fixedToolCallId(manifest: ReplayScenarioManifest, caseId: string, protocol: SdkProtocol): Promise<string> {
  const raw = await readFile(new URL(`./corpus/${exchange(manifest, caseId).response.bodyFile}`, import.meta.url), "utf8");
  const value = JSON.parse(raw) as Record<string, unknown>;
  let id: unknown;
  if (protocol === "chat") id = record(record((value.choices as unknown[])[0])?.message)?.tool_calls;
  if (protocol === "chat") id = record((id as unknown[])[0])?.id;
  else if (protocol === "messages") id = record((value.content as unknown[]).find((item) => record(item)?.type === "tool_use"))?.id;
  else id = record((value.output as unknown[]).find((item) => record(item)?.type === "function_call"))?.call_id;
  if (typeof id !== "string" || id.length === 0) throw new Error("invalid replay configuration");
  return id;
}

async function fixedResponseId(manifest: ReplayScenarioManifest, caseId: string): Promise<string> {
  const raw = await readFile(new URL(`./corpus/${exchange(manifest, caseId).response.bodyFile}`, import.meta.url), "utf8");
  const id = record(JSON.parse(raw))?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("invalid replay configuration");
  return id;
}

function parseBoundedJson(value: unknown): unknown | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_ARGUMENT_BYTES) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function boundedArray(value: unknown, exact?: number, max = MAX_COLLECTION): value is unknown[] {
  return Array.isArray(value) && value.length <= max && (exact === undefined || value.length === exact);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
