import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
import { sdkToolCalls as sessionCalls, type SdkProtocol, type SdkProtocolResult as SessionResult, type SdkToolCall as ForecastCall } from "./client.js";
import { expectUsage, type ExpectedResult } from "./replay_expectations.js";
import {
  expectedForecastArguments, FORECAST_PARAMETERS, PARIS_RESULT, SESSION_SYSTEM, TEXT_SCENARIOS, TOKYO_RESULT,
} from "./scenarios.js";
import { SESSION_PROMPTS, type SessionTurn } from "./session_inputs.js";

export function expectSessionTurn(value: SessionResult, expected: ExpectedResult, turn: SessionTurn): ForecastCall[] {
  const { result, protocol } = value;
  const calls = sessionCalls(value);
  expect(calls.length, "actual parsed call count on every turn").toBe(turn === 2 ? 2 : 0);
  expect(isDeepStrictEqual(calls.map((call) => call.id), expected.toolCallIds), "fixture call identities and order are preserved").toBe(true);
  if (turn === 2) {
    expect(calls.every((call) => call.id.length > 0), "nonempty returned call identities").toBe(true);
    expect(new Set(calls.map((call) => call.id)).size, "unique returned call identities").toBe(2);
    for (const [index, city] of (["Tokyo", "Paris"] as const).entries()) {
      expect(calls[index]?.name === "get_hourly_forecast", "forecast tool name").toBe(true);
      expect(isDeepStrictEqual(calls[index]?.arguments, expectedForecastArguments(city)), "nested multi-parameter forecast arguments").toBe(true);
    }
  } else {
    expect(result.text.length, "substantive textual response").toBeGreaterThan(600);
    const patterns = turn === 1 ? TEXT_SCENARIOS.find((scenario) => scenario.id === "image")!.facts.map((fact) => fact.pattern)
      : [ /Tokyo/iu, /silver|white/iu, /coat/iu, /sword|katana/iu, /30%/u, /13\s*(?:kph|km\/h)/iu,
        ...(turn === 4 ? [/15:00/u, /18:00/u, /contingency|rain|shelter|covered/iu] : [
          /Paris/iu, /blue/iu, /20\s*°?\s*C/u, /14\s*°?\s*C/u, /70%/u, /21\s*(?:kph|km\/h)/iu,
        ]),
        ...(turn === 5 ? [/Image-derived claims/iu, /Tool-derived claims/iu, /Unsupported claims/iu, /handoff/iu] : []),
      ];
    for (const pattern of patterns) expect(pattern.test(result.text), `session fact ${pattern.source}`).toBe(true);
    if (turn === 4) expect([...result.text.matchAll(/^[* \t]*(?:15|16|17|18):[0-5]\d/gmu)].length, "six scheduled shots").toBe(6);
  }
  expect(result.text === expected.text, "complete parsed text matches independent fixture text").toBe(true);
  const terminal = protocol === "responses" ? "completed"
    : protocol === "messages" ? (turn === 2 ? "tool_use" : "end_turn") : (turn === 2 ? "tool_calls" : "stop");
  expect(result.terminal === terminal, "expected session terminal outcome").toBe(true);
  if (turn === 1) expect(result.stream === undefined, "buffered turn contains no stream observations").toBe(true);
  else {
    expect(result.stream?.terminalCount, "exactly one normal stream terminal").toBe(1);
    expect(result.stream?.text === expected.text, "streamed text has no loss or duplication").toBe(true);
  }
  expectUsage(result.response.usage, protocol, expected);
  return calls;
}

export interface SessionRequestExpectation {
  readonly protocol: SdkProtocol;
  readonly turn: SessionTurn;
  readonly imageBase64: string;
  readonly turns: readonly ExpectedResult[];
  readonly calls: readonly ForecastCall[];
}

export function matchesSessionRequest(body: unknown, expected: SessionRequestExpectation): boolean {
  try {
    return matchesSessionBody(body, expected);
  } catch {
    return false;
  }
}

// A small, fixed-scenario projection of significant upstream fields, not a protocol codec.
// Incidental envelopes and message grouping differ across native SDKs; ordered content must not.
function matchesSessionBody(body: unknown, expected: SessionRequestExpectation): boolean {
  const request = record(body);
  if (request === undefined || request.previous_response_id !== undefined) return false;
  const { protocol, turn } = expected;
  const actual: unknown[][] = [];
  let system = protocol === "messages" ? request.system : request.instructions;
  const items = protocol === "responses" ? request.input : request.messages;
  if (!Array.isArray(items)) return false;
  for (const value of items) {
    const item = record(value);
    if (item === undefined) return false;
    if (item.role === "system" || item.role === "developer") {
      if (system !== undefined || actual.length !== 0) return false;
      system = item.content;
      continue;
    }
    if (protocol === "responses" && item.type === "function_call") {
      actual.push(["call", item.call_id, item.name, parseArguments(item.arguments)]);
    } else if (protocol === "responses" && item.type === "function_call_output") {
      actual.push(["result", item.call_id, textContent(item.output, "input_text")]);
    } else if (protocol === "chat" && item.role === "tool") {
      actual.push(["result", item.tool_call_id, textContent(item.content, "text")]);
    } else {
      if (item.role !== "user" && item.role !== "assistant") return false;
      if (!appendContent(actual, item.role, item.content, protocol, expected.imageBase64)) return false;
      if (item.tool_calls !== undefined) {
        if (protocol !== "chat" || item.role !== "assistant" || !Array.isArray(item.tool_calls)) return false;
        for (const call of item.tool_calls) {
          const tool = record(call);
          const fn = record(tool?.function);
          if (tool?.type !== "function" || fn === undefined) return false;
          actual.push(["call", tool.id, fn.name, parseArguments(fn.arguments)]);
        }
      }
    }
  }
  if (textContent(system, protocol === "responses" ? "input_text" : "text") !== SESSION_SYSTEM) return false;
  if (turn === 1) {
    if (request.tools !== undefined) return false;
  } else {
    if (!Array.isArray(request.tools) || request.tools.length !== 1) return false;
    const tool = record(request.tools[0]);
    const fn = protocol === "chat" ? record(tool?.function) : tool;
    if (fn?.name !== "get_hourly_forecast" || (protocol !== "messages" && tool?.type !== "function")) return false;
    if (!isDeepStrictEqual(protocol === "messages" ? fn.input_schema : fn.parameters, FORECAST_PARAMETERS)) return false;
    if (turn === 2) {
      if (protocol === "messages") {
        const choice = record(request.tool_choice);
        if (choice?.type !== "auto" || choice.disable_parallel_tool_use === true) return false;
      } else if (request.tool_choice !== "auto" || request.parallel_tool_calls === false) return false;
    }
  }

  const wanted: unknown[][] = [];
  for (let index = 0; index < turn; index += 1) {
    if (index === 2) {
      if (expected.calls.length !== 2) return false;
      wanted.push(["result", expected.calls[0]!.id, TOKYO_RESULT], ["result", expected.calls[1]!.id, PARIS_RESULT]);
    }
    wanted.push(["user", "text", SESSION_PROMPTS[index]]);
    if (index === 0) wanted.push(["user", "image", expected.imageBase64]);
    if (index < turn - 1) {
      const text = expected.turns[index]!.text;
      if (text !== "") wanted.push(["assistant", "text", text]);
      if (index === 1) for (const call of expected.calls) wanted.push(["call", call.id, call.name, call.arguments]);
    }
  }
  return isDeepStrictEqual(actual, wanted);
}

function appendContent(target: unknown[][], role: string, content: unknown, protocol: SdkProtocol, imageBase64: string): boolean {
  if (content === null || content === undefined || content === "") return role === "assistant";
  if (typeof content === "string") { target.push([role, "text", content]); return true; }
  if (!Array.isArray(content)) return false;
  for (const value of content) {
    const part = record(value);
    if (part === undefined) return false;
    const textType = protocol === "responses" ? (role === "assistant" ? "output_text" : "input_text") : "text";
    if (part.type === textType && typeof part.text === "string") {
      if (part.text !== "") target.push([role, "text", part.text]);
    } else if (protocol === "messages" && part.type === "tool_use" && role === "assistant") {
      target.push(["call", part.id, part.name, part.input]);
    } else if (protocol === "messages" && part.type === "tool_result" && role === "user") {
      if (part.is_error !== undefined && part.is_error !== false) return false;
      target.push(["result", part.tool_use_id, textContent(part.content, "text")]);
    } else {
      if (role !== "user") return false;
      if (protocol === "messages") {
        const source = record(part.source);
        if (part.type !== "image" || source?.type !== "base64" || source.media_type !== "image/jpeg" || source.data !== imageBase64) return false;
      } else {
        const image = protocol === "chat" ? record(part.image_url)?.url : part.image_url;
        const detail = protocol === "chat" ? record(part.image_url)?.detail : part.detail;
        if (part.type !== (protocol === "chat" ? "image_url" : "input_image") || image !== `data:image/jpeg;base64,${imageBase64}`
          || (detail !== undefined && detail !== "auto")) return false;
      }
      target.push([role, "image", imageBase64]);
    }
  }
  return true;
}

function textContent(value: unknown, type: string): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const part = record(value[0]);
  return part?.type === type && typeof part.text === "string" ? part.text : undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected JSON tool arguments");
  return JSON.parse(value) as unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
