import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCopilotReplayServer, validateReplayScenarios, type ReplayServerOptions } from "../../src/replay/server.js";
import type { ReplayExchangeRecord, ReplayScenario } from "../../src/replay/types.js";

const directories: string[] = [];
const servers: MockCopilotReplayServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("registered ordered replay", () => {
  it("fails closed without selection and ignores deceptive legacy substrings", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], [scenario(record, exact({ model: "model", messages: [{ role: "user", content: "expected" }] }))]);
    await server.start();
    for (const content of ["image Paris twice simultaneously quantum tool_result function_call_output", "{\"role\":\"tool\"}"]) {
      const response = await post(server, { model: "model", messages: [{ role: "user", content }] });
      expect(response).toEqual({ status: 409, text: "{\"error\":\"replay scenario not selected\"}" });
    }
    expect(server.recordedReceipts).toEqual([]);
  });

  it("preserves order and cursor on zero-match, skipped and repeated steps", async () => {
    const first = await fixture("first");
    const second = await fixture("second", first.directory);
    const firstBody = { model: "model", messages: [{ role: "user", content: "first" }] };
    const secondBody = { model: "model", messages: [{ role: "tool", tool_call_id: "call_exact", content: "{\"ok\":true}" }] };
    const registered: ReplayScenario = {
      scenarioId: "ordered", targetProtocol: "messages", model: "model", steps: [
        { ordinal: 1, caseId: first.record.caseId, stream: false, matchesRequest: exact(firstBody) },
        { ordinal: 2, caseId: second.record.caseId, stream: false, matchesRequest: exact(secondBody) },
      ],
    };
    const server = trackedServer(first.directory, [first.record, second.record], [registered]);
    await server.start();
    server.selectScenario("ordered");
    expect((await post(server, secondBody)).status).toBe(409);
    expect((await post(server, { ...firstBody, private: "Paris image quantum" })).status).toBe(409);
    expect((await post(server, firstBody)).status).toBe(200);
    expect((await post(server, firstBody)).status).toBe(409);
    expect((await post(server, { ...secondBody, messages: [{ role: "tool", tool_call_id: "wrong", content: "{\"ok\":true}" }] })).status).toBe(409);
    expect((await post(server, secondBody)).status).toBe(200);
    server.finishScenario();
    expect(server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined)).toEqual([
      { scenarioId: "ordered", scenarioStep: 1, matchedCaseId: first.record.caseId },
      { scenarioId: "ordered", scenarioStep: 2, matchedCaseId: second.record.caseId },
    ]);
  });

  it("rejects invalid, ambiguous, unbounded and incomplete catalogue registrations", async () => {
    const { record } = await fixture();
    const good = scenario(record, () => true);
    const invalid: unknown[] = [
      [],
      [{ ...good, private: true }],
      [{ ...good, scenarioId: "bad id" }],
      [{ ...good, steps: [] }],
      [{ ...good, steps: new Array(65).fill(good.steps[0]) }],
      [{ ...good, steps: [{ ...good.steps[0], ordinal: 2 }] }],
      [{ ...good, steps: [{ ...good.steps[0], caseId: "missing" }] }],
      [{ ...good, steps: [{ ...good.steps[0], stream: true }] }],
      [{ ...good, steps: [{ ...good.steps[0], matchesRequest: async () => true }] }],
      [good, { ...good, scenarioId: "duplicate-owner" }],
      [good, { ...good }],
    ];
    for (const catalogue of invalid) expect(() => validateReplayScenarios([record], catalogue)).toThrow(/^invalid replay configuration$/u);
    expect(() => validateReplayScenarios([record], [good])).not.toThrow();
  });

  it("parses malformed JSON once, bounds bodies, and never consumes the selected step", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], [scenario(record, exact({ model: "model" }))], { maxRequestBodyBytes: 64 });
    await server.start();
    server.selectScenario("test");
    expect((await post(server, { model: "model", content: "x".repeat(128) })).status).toBe(413);
    for (const body of ["{broken", "null", "[]", "{\"model\":\"model\",\"stream\":\"false\"}"]) {
      const response = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("{\"error\":\"invalid replay request\"}");
    }
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });

  it("keeps errors and bounded receipts content-free and defensively copied", async () => {
    const { directory, record } = await fixture();
    const secret = "private-request-and-predicate-diagnostic";
    const throwing = scenario(record, () => { throw new Error(secret); });
    const server = trackedServer(directory, [record], [throwing], { maxReceipts: 3 });
    await server.start();
    server.selectScenario("test");
    for (let index = 0; index < 4; index += 1) {
      const result = await post(server, { model: "model", messages: [{ role: "user", content: secret }] });
      expect(result).toEqual({ status: 409, text: "{\"error\":\"replay request mismatch\"}" });
    }
    expect(server.recordedReceipts).toHaveLength(3);
    expect(server.recordedReceipts).toEqual(new Array(3).fill({ scenarioId: "test", scenarioStep: 1 }));
    expect(JSON.stringify(server.recordedReceipts)).not.toContain(secret);
    const copy = server.recordedReceipts as unknown as { scenarioId: string }[];
    copy[0]!.scenarioId = secret;
    copy.length = 0;
    expect(server.recordedReceipts).toHaveLength(3);
    expect(JSON.stringify(server.recordedReceipts)).not.toContain(secret);
  });

  it.each(["disconnect_early", "stall_first_byte"] as const)("commits an accepted step before %s fault consumption", async (faultMode) => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], [scenario(record, () => true)], { faultMode, requestTimeoutMs: 500 });
    await server.start();
    server.selectScenario("test");
    const pending = post(server, { model: "model" }).then(() => "completed", () => "cancelled");
    await expect.poll(() => server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined).length).toBe(1);
    expect(await pending).toBe("cancelled");
    await expect.poll(() => { try { server.finishScenario(); return true; } catch { return false; } }).toBe(true);
  });

  it("enforces one in-flight request and resets selection and receipts on restart", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], [scenario(record, () => true)], { faultMode: "stall_first_byte", requestTimeoutMs: 500 });
    await Promise.all([server.start(), server.start()]);
    server.selectScenario("test");
    const pending = post(server, { model: "model" }).catch(() => undefined);
    await expect.poll(() => server.recordedReceipts.some((receipt) => receipt.matchedCaseId !== undefined)).toBe(true);
    expect((await post(server, { model: "model" })).status).toBe(409);
    expect(() => server.selectScenario("test")).toThrow("replay lifecycle conflict");
    const catalog = await fetch(`${server.baseUrl}/models`);
    expect(catalog.status).toBe(200);
    await server.stop();
    await pending;
    server.faultMode = undefined;
    await server.start();
    expect(server.recordedReceipts).toEqual([]);
    server.selectScenario("test");
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });

  it("revalidates exact response bytes before cursor commit", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], [scenario(record, () => true)]);
    await server.start();
    server.selectScenario("test");
    await writeFile(path.join(directory, record.response.bodyFile), "private-modified-payload");
    expect(await post(server, { model: "model" })).toEqual({ status: 500, text: "{\"error\":\"replay request failed\"}" });
    expect(server.recordedReceipts).toEqual([]);
    expect(() => server.finishScenario()).toThrow("replay scenario incomplete");
    await writeFile(path.join(directory, record.response.bodyFile), "{\"ok\":true}");
    expect((await post(server, { model: "model" })).text).toBe("{\"ok\":true}");
    server.finishScenario();
  });

  it("bounds incomplete uploads and releases their in-flight ownership", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], [scenario(record, () => true)], { requestTimeoutMs: 500 });
    await server.start();
    server.selectScenario("test");
    const upload = httpRequest(`${server.baseUrl}/v1/messages`, { method: "POST" });
    const closed = new Promise<void>((resolve) => upload.once("close", resolve));
    upload.on("error", () => undefined);
    upload.write("{");
    await expect.poll(async () => (await post(server, { model: "wrong" })).status).toBe(409);
    upload.destroy();
    await closed;
    await expect.poll(() => { try { server.abortScenario(); return true; } catch { return false; } }).toBe(true);
  });
});

function exact(expected: unknown): (body: unknown) => boolean {
  const serialized = JSON.stringify(expected);
  return (body) => JSON.stringify(body) === serialized;
}

function scenario(record: ReplayExchangeRecord, matchesRequest: (body: unknown) => boolean): ReplayScenario {
  return { scenarioId: "test", targetProtocol: record.targetProtocol, model: record.upstreamModel,
    steps: [{ ordinal: 1, caseId: record.caseId, stream: record.response.stream, matchesRequest }] };
}

async function post(server: MockCopilotReplayServer, body: unknown, pathname = "/v1/messages"): Promise<{ status: number; text: string }> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function fixture(suffix = "case", directory?: string): Promise<{ directory: string; record: ReplayExchangeRecord }> {
  const root = directory ?? await mkdtemp(path.join(tmpdir(), "ghcg-replay-"));
  if (directory === undefined) directories.push(root);
  const response = Buffer.from("{\"ok\":true}");
  const bodyFile = `${suffix}.json`;
  await writeFile(path.join(root, bodyFile), response);
  return { directory: root, record: {
    version: 1, caseId: `replay.messages.${suffix}.nonstream`, family: "replay",
    sourceProtocol: "messages", targetProtocol: "messages", logicalModel: "model", upstreamModel: "model",
    request: { method: "POST", path: "/v1/messages" },
    response: { status: 200, headers: {}, bodyFile, bodySha256: createHash("sha256").update(response).digest("hex"), stream: false },
  } };
}

function trackedServer(directory: string, exchanges: readonly ReplayExchangeRecord[], scenarios: readonly ReplayScenario[], options: Partial<ReplayServerOptions> = {}): MockCopilotReplayServer {
  const server = new MockCopilotReplayServer({ port: 0, corpusDir: directory, exchanges, scenarios, ...options });
  servers.push(server);
  return server;
}
