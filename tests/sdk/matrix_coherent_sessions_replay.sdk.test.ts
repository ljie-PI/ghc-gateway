import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSdkClients, REPLAY_TARGETS, SDK_PROTOCOLS, type SdkProtocol, type SdkToolCall as ForecastCall } from "./client.js";
import { readExpectedExchangeResult, type ExpectedResult } from "./replay_expectations.js";
import { startReplaySdkHarness, type ReplaySdkHarness } from "./replay_harness.js";
import { expectSessionTurn } from "./session_expectations.js";
import { createSessionDriver, SESSION_TURNS, type SessionTurn } from "./session_inputs.js";
import { TOKYO_RESULT } from "./scenarios.js";

const MUTATIONS = ["image", "history", "history-order", "result-value", "result-binding", "result-format", "call-arguments", "tool-schema"] as const;
type Mutation = typeof MUTATIONS[number];

describe("coherent five-turn image/tool continuity through official SDKs and production HTTP replay", () => {
  let harness: ReplaySdkHarness;
  let imageBase64: string;
  const expected = new Map<SdkProtocol, ExpectedResult[]>();

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    imageBase64 = (await readFile(new URL("./images/vergil.jpg", import.meta.url))).toString("base64");
    for (const target of REPLAY_TARGETS) {
      expected.set(target.protocol, await Promise.all(sessionIds(target.protocol).map((id) => {
        const exchange = harness.corpus.exchanges.find((entry) => entry.caseId === id);
        if (exchange === undefined) throw new Error("Missing session exchange");
        return readExpectedExchangeResult(exchange);
      })));
    }
  });

  afterAll(async () => { await harness.close(); });

  describe.each(SDK_PROTOCOLS)("%s downstream", (downstream) => {
    it.each(REPLAY_TARGETS)("five ordered turns against $protocol upstream", async (target) => {
      let calls: readonly ForecastCall[] = [];
      const scenarioId = `replay.${target.protocol}.coherent-session`;
      const receiptStart = harness.receipts.length;
      select(scenarioId);
      const execute = createSessionDriver(createSdkClients(harness), downstream, target.model, imageBase64);
      try {
        for (const turn of SESSION_TURNS) {
          const result = await execute(turn, calls);
          const actual = expectSessionTurn(result, expected.get(target.protocol)![turn - 1]!, turn);
          if (turn === 2) calls = actual;
        }
        harness.replayServer.finishScenario();
        const receipts = harness.receipts.slice(receiptStart);
        expect(receipts.map((receipt) => receipt.scenarioStep)).toEqual(SESSION_TURNS);
        expect(receipts.map((receipt) => receipt.matchedCaseId)).toEqual(sessionIds(target.protocol));
      } finally {
        harness.replayServer.abortScenario();
      }
    });
  });

  // Mutate requests before gateway ingress, not expectations or frozen responses. Each native
  // route must reach the real replay predicate and fail without consuming its selected step.
  describe.each(REPLAY_TARGETS)("$protocol request semantics fail closed", (target) => {
    it.each(MUTATIONS)("rejects changed %s", async (mutation) => {
      let calls: readonly ForecastCall[] = [];
      let changed = false;
      const failTurn: SessionTurn = mutation === "tool-schema" ? 2 : 3;
      const scenarioId = `replay.${target.protocol}.coherent-session`;
      const receiptStart = harness.receipts.length;
      select(scenarioId);
      let requests = 0;
      const clients = createSdkClients({ ...harness, fetch: async (url, init) => {
        requests += 1;
        if (requests === failTurn) {
          if (typeof init?.body !== "string") throw new Error("Expected SDK JSON body");
          const body = JSON.parse(init.body) as Record<string, unknown>;
          changed = mutateRequest(body, target.protocol, mutation, expected.get(target.protocol)![0]!.text);
          return harness.fetch(url, { ...init, body: JSON.stringify(body) });
        }
        return harness.fetch(url, init);
      } });
      const execute = createSessionDriver(clients, target.protocol, target.model, imageBase64);
      try {
        for (const turn of SESSION_TURNS.filter((turn) => turn < failTurn)) {
          const actual = expectSessionTurn(await execute(turn, calls), expected.get(target.protocol)![turn - 1]!, turn);
          if (turn === 2) calls = actual;
        }
        const status = await execute(failTurn, calls).then(() => 200, (error: unknown) =>
          (error as { status?: number }).status);
        expect(changed, "the significant request field was actually mutated").toBe(true);
        expect(status, "gateway propagates replay rejection").toBe(409);
        const receipts = harness.receipts.slice(receiptStart);
        expect(receipts.map((receipt) => receipt.scenarioStep)).toEqual(SESSION_TURNS.slice(0, failTurn));
        expect(receipts.at(-1)?.matchedCaseId, "mutant reached replay but did not match").toBeUndefined();
        expect(() => harness.replayServer.finishScenario()).toThrow("replay scenario incomplete");
      } finally {
        harness.replayServer.abortScenario();
      }
    });
  });

  function sessionIds(protocol: SdkProtocol): string[] {
    return SESSION_TURNS.map((turn) => `replay.${protocol}.coherent-session.turn-${turn}`);
  }

  function select(id: string): void {
    harness.replayServer.selectScenario(id);
  }
});

/** Only downstream native JSON is changed; no production codec or observed upstream body is reused. */
function mutateRequest(body: Record<string, unknown>, protocol: SdkProtocol, mutation: Mutation, firstText: string): boolean {
  if (mutation === "history-order") {
    const items = (protocol === "responses" ? body.input : body.messages) as unknown[];
    const index = protocol === "chat" ? 1 : 0;
    [items[index], items[index + 1]] = [items[index + 1], items[index]];
    return true;
  }
  const results: Record<string, unknown>[] = [];
  let changed = false;
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item.role === "tool" || item.type === "tool_result" || item.type === "function_call_output") results.push(item);
    if (mutation === "image") {
      if (item.type === "image") { (item.source as Record<string, unknown>).data = "d3Jvbmc="; changed = true; }
      if (item.type === "image_url") { (item.image_url as Record<string, unknown>).url = "data:image/jpeg;base64,d3Jvbmc="; changed = true; }
      if (item.type === "input_image") { item.image_url = "data:image/jpeg;base64,d3Jvbmc="; changed = true; }
    }
    if (mutation === "history") {
      for (const key of ["text", "content"]) if (item[key] === firstText) { item[key] = "Unrelated assistant history"; changed = true; }
    }
    if (mutation === "tool-schema" && item.country_code !== undefined) {
      (item.country_code as Record<string, unknown>).type = "integer";
      changed = true;
    }
    if (mutation === "call-arguments") {
      const key = item.name === "get_hourly_forecast" ? (item.type === "tool_use" ? "input" : "arguments") : undefined;
      if (key !== undefined && item[key] !== undefined) {
        const args = (typeof item[key] === "string" ? JSON.parse(item[key]) : item[key]) as { start_hour: number | string };
        args.start_hour = "15";
        item[key] = key === "input" ? args : JSON.stringify(args);
        changed = true;
      }
    }
    Object.values(item).forEach(visit);
  }
  visit(body);
  if (mutation === "result-binding" && results.length === 2) {
    const key = protocol === "chat" ? "tool_call_id" : protocol === "messages" ? "tool_use_id" : "call_id";
    [results[0]![key], results[1]![key]] = [results[1]![key], results[0]![key]];
    changed = true;
  }
  if (mutation === "result-value" || mutation === "result-format") {
    for (const result of results) {
      const key = protocol === "responses" ? "output" : "content";
      if (result[key] === TOKYO_RESULT) {
        const payload = JSON.parse(TOKYO_RESULT) as { hours: { temperature_c: number }[] };
        if (mutation === "result-value") payload.hours[0]!.temperature_c = 99;
        result[key] = mutation === "result-format" ? payload : JSON.stringify(payload);
        changed = true;
      }
    }
  }
  return changed;
}
