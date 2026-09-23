import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSdkClients, sdkToolCalls, type SdkClients, type SdkProtocol } from "./client.js";
import {
  CHAT_MODEL,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
  startReplaySdkHarness,
} from "./replay_harness.js";
import { executeMixedImageTool, executeParallelWeather } from "./scenario_requests.js";

interface MatrixCell {
  readonly title: string;
  readonly client: SdkProtocol;
  readonly upstream: SdkProtocol;
  readonly model: string;
}

const CELLS: readonly MatrixCell[] = [
  { title: "C -> C", client: "chat", upstream: "chat", model: CHAT_MODEL },
  { title: "C -> R", client: "chat", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "C -> M", client: "chat", upstream: "messages", model: MESSAGES_MODEL },
  { title: "M -> C", client: "messages", upstream: "chat", model: CHAT_MODEL },
  { title: "M -> R", client: "messages", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
  { title: "M -> M", client: "messages", upstream: "messages", model: MESSAGES_MODEL },
  { title: "R -> C", client: "responses", upstream: "chat", model: CHAT_MODEL },
  { title: "R -> M", client: "responses", upstream: "messages", model: MESSAGES_MODEL },
  { title: "R -> R", client: "responses", upstream: "responses", model: NATIVE_RESPONSES_MODEL },
];

describe("nine-cell matrix parallel tools & mixed image-tool execution via Mock Copilot Replay", () => {
  let harness: ReplaySdkHarness;
  let clients: SdkClients;
  let imgBase64: string;

  beforeAll(async () => {
    harness = await startReplaySdkHarness();
    clients = createSdkClients(harness);
    imgBase64 = (await readFile(path.resolve("tests/sdk/images/vergil.jpg"))).toString("base64");
  });

  afterAll(async () => {
    await harness.close();
  });
  afterEach(() => { harness.replayServer.abortScenario(); });

  describe("Parallel Tools Execution across Matrix Cells", () => {
    it.each(CELLS)("$title parallel tools", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "parallel-tools");
      const calls = sdkToolCalls(await executeParallelWeather(clients, cell.client, cell.model));
      expect(calls.length).toBe(2);
      expect(calls[0]?.id).not.toBe(calls[1]?.id);
      finish(harness, cell.upstream, "parallel-tools", receiptStart);
    });
  });

  describe("Mixed Image & Tool Execution across Matrix Cells", () => {
    it.each(CELLS)("$title mixed image and tool", async (cell) => {
      const receiptStart = select(harness, cell.upstream, "mixed-image-tool");
      const calls = sdkToolCalls(await executeMixedImageTool(clients, cell.client, cell.model, imgBase64));
      // Responses forces the named tool; Chat and Messages must choose exactly one call.
      if (cell.client === "responses") expect(calls.length).toBeGreaterThan(0);
      else expect(calls.length).toBe(1);
      finish(harness, cell.upstream, "mixed-image-tool", receiptStart);
    });
  });
});

type ScenarioFamily = "parallel-tools" | "mixed-image-tool";

function select(harness: ReplaySdkHarness, protocol: SdkProtocol, family: ScenarioFamily): number {
  const receiptStart = harness.receipts.length;
  harness.replayServer.selectScenario(`replay.${protocol}.${family}.nonstream`);
  return receiptStart;
}

function finish(
  harness: ReplaySdkHarness,
  protocol: SdkProtocol,
  family: ScenarioFamily,
  receiptStart: number,
): void {
  const scenarioId = `replay.${protocol}.${family}.nonstream`;
  harness.replayServer.finishScenario();
  expect(harness.receipts.slice(receiptStart)).toEqual([
    { scenarioId, scenarioStep: 1, matchedCaseId: scenarioId },
  ]);
}
