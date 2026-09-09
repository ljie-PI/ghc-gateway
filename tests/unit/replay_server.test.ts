import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCopilotReplayServer, validateReplayCorpus, type ReplayServerOptions } from "../../src/replay/server.js";
import type { ReplayExchangeRecord, ReplayScenario } from "../../src/replay/types.js";

const directories: string[] = [];
const servers: MockCopilotReplayServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("explicit ordered replay", () => {
  it("rejects obsolete marker-only session configuration before listening", async () => {
    const { directory, record } = await fixture();
    const legacy = { ...record, session: { id: "unsafe", marker: "image", step: 1, totalSteps: 1 } };
    const server = trackedServer(directory, [legacy]);
    await expect(server.start()).rejects.toThrow("invalid replay configuration");
  });

  it("never escapes a selected scope to a marker-free independent tool-result case", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record]);
    await server.start();
    const expected = { model: "model", messages: [{ role: "tool", tool_call_id: "call_exact", content: "{\"temperature\":20}" }] };
    server.selectScenario({ id: "test", steps: [{ exchangeId: record.caseId, matchesRequest: (body) => JSON.stringify(body) === JSON.stringify(expected) }] });
    const wrong = { model: "model", messages: [{ role: "tool", tool_call_id: "call_wrong", content: "{\"temperature\":20}" }] };
    expect((await post(server, wrong)).status).toBe(409);
    expect(() => server.finishScenario()).toThrow("replay scenario incomplete");
    expect((await post(server, expected)).status).toBe(200);
    expect((await post(server, wrong)).status).toBe(409);
    expect((await post(server, expected)).status).toBe(409);
    server.finishScenario();
    expect((await post(server, wrong)).status).toBe(200);
    expect(server.recordedReceipts.filter((receipt) => receipt.scenarioId === "test" && receipt.matchedCaseId !== undefined)).toHaveLength(1);
  });

  it.each(["chat", "messages", "responses"] as const)("checks independently specified %s history, image, calls, result binding/content and JSON format", async (protocol) => {
    const { directory, record } = await fixture();
    const pathname = { chat: "/chat/completions", messages: "/v1/messages", responses: "/responses" }[protocol];
    const configured = { ...record, sourceProtocol: protocol, targetProtocol: protocol, selection: "explicit" as const, request: { method: "POST", path: pathname } };
    const server = trackedServer(directory, [configured]);
    await server.start();
    const history = {
      chat: [
        { role: "user", content: [{ type: "text", text: "start" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] },
        { role: "assistant", tool_calls: [{ id: "call_exact", type: "function", function: { name: "lookup", arguments: "{\"city\":\"Tokyo\"}" } }] },
        { role: "tool", tool_call_id: "call_exact", content: "{\"temperature\":20}" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "start" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_exact", name: "lookup", input: { city: "Tokyo" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_exact", content: "{\"temperature\":20}" }] },
      ],
      responses: [
        { role: "user", content: [{ type: "input_text", text: "start" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }] },
        { type: "function_call", call_id: "call_exact", name: "lookup", arguments: "{\"city\":\"Tokyo\"}" },
        { type: "function_call_output", call_id: "call_exact", output: "{\"temperature\":20}" },
      ],
    }[protocol];
    const historyKey = protocol === "responses" ? "input" : "messages";
    const format = protocol === "responses" ? { text: { format: { type: "json_object" } } }
      : protocol === "chat" ? { response_format: { type: "json_object" } } : {};
    const tools = protocol === "chat" ? [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]
      : protocol === "messages" ? [{ name: "lookup", input_schema: { type: "object" } }]
        : [{ type: "function", name: "lookup", parameters: { type: "object" } }];
    const expected = { [historyKey]: history, tools, ...format };
    // Authored from the scenario contract, never from the request under test or its hash.
    const matchesRequest = (body: unknown): boolean => {
      if (body === null || typeof body !== "object") return false;
      const value = body as Record<string, unknown>;
      return Object.entries(expected).every(([key, member]) => isDeepStrictEqual(value[key], member));
    };
    const first = { model: "model", [historyKey]: [history[0]] };
    expect((await post(server, first, pathname)).status).toBe(404); // explicit-only, never inferred
    server.selectScenario({ id: `semantic.${protocol}`, steps: [
      { exchangeId: configured.caseId, matchesRequest: (body) => isDeepStrictEqual(body, first) },
      { exchangeId: configured.caseId, matchesRequest },
    ] });
    const valid = { model: "model", ...expected };
    expect((await post(server, valid, pathname)).status).toBe(409); // skipped step
    expect((await post(server, first, pathname)).status).toBe(200);
    expect((await post(server, first, pathname)).status).toBe(409); // repeated step
    const serialized = JSON.stringify(valid);
    const resultBindingOffset = serialized.lastIndexOf("call_exact");
    const mutations = [
      JSON.parse(`${serialized.slice(0, resultBindingOffset)}call_wrong${serialized.slice(resultBindingOffset + "call_exact".length)}`),
      { ...valid, tools: [] },
      JSON.parse(serialized.replace("start", "modified history")),
      { ...valid, [historyKey]: [history[1], history[0], history[2]] },
      { ...valid, [historyKey]: history.slice(0, 2) },
      { ...valid, [historyKey]: [{ role: "user", content: "start" }, ...history.slice(1)] },
      { ...valid, model: "wrong-model" },
      { ...valid, stream: true },
      JSON.parse(serialized.replace("call_exact", "call_wrong")),
      JSON.parse(serialized.replaceAll("call_exact", "call_wrong")),
      JSON.parse(serialized.replace("lookup", "wrong_tool")),
      JSON.parse(serialized.replace("Tokyo", "Paris")),
      ...(protocol === "messages" ? [] : [JSON.parse(serialized.replace("{\\\"city\\\":\\\"Tokyo\\\"}", "invalid-json"))]),
      JSON.parse(serialized.replace("AQID", "AQIE")),
      JSON.parse(serialized.replace("temperature\\\":20", "temperature\\\":21")),
      JSON.parse(serialized.replace("{\\\"temperature\\\":20}", "not-json")),
      { ...valid, [historyKey]: [...history, history[2]] },
      ...(protocol === "messages" ? [] : [{ ...valid, ...JSON.parse(JSON.stringify(format).replace("json_object", "text")) }]),
    ];
    for (const mutation of mutations) {
      expect(isDeepStrictEqual(mutation, valid)).toBe(false);
      expect((await post(server, mutation, pathname)).status).toBe(409);
    }
    // Incidental envelope fields are deliberately not pinned by the semantic validator.
    expect((await post(server, { ...valid, max_tokens: 8192 }, pathname)).status).toBe(200);
    server.finishScenario();
    expect(server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined).map((receipt) => receipt.scenarioStep)).toEqual([1, 2]);
  });

  it("requires complete synchronous match specifications and unambiguous selection", async () => {
    const { directory, record } = await fixture();
    const duplicateCategory = { ...record, caseId: `${record.caseId}.duplicate` };
    const server = trackedServer(directory, [record, duplicateCategory]);
    expect(() => server.selectScenario({ id: "test", steps: [] })).toThrow("replay lifecycle conflict");
    await server.start();
    const step = { exchangeId: record.caseId, matchesRequest: () => true };
    for (const invalid of [
      {}, { id: "test" }, { id: "test", steps: [] }, { id: "test", steps: new Array(1) }, { id: "test", steps: new Array(65).fill(step) },
      { id: "test", steps: [{ exchangeId: "missing", matchesRequest: () => true }] },
      { id: "test", steps: [{ exchangeId: record.caseId }] },
      { id: "test", steps: [{ ...step, matchesRequest: true }] },
      { id: "test", steps: [{ ...step, matchesRequest: async () => true }] },
    ]) expect(() => server.selectScenario(invalid as ReplayScenario)).toThrow("invalid replay configuration");
    const request = { model: "model", messages: [{ role: "tool", content: "result" }] };
    expect((await post(server, request)).status).toBe(409);
    const selection = { id: "test", steps: [step] };
    server.selectScenario(selection);
    expect(() => server.selectScenario(selection)).toThrow("replay scenario already selected");
    expect(() => server.finishScenario()).toThrow("replay scenario incomplete");
    selection.steps.length = 0; // Caller mutation cannot alter the captured scope.
    expect((await post(server, request)).status).toBe(200);
    server.finishScenario();
    server.selectScenario({ id: "next", steps: [step] });
    server.abortScenario();
    expect(() => server.finishScenario()).toThrow("replay scenario incomplete");
  });

  it("fails closed on throwing/nonboolean predicates and emits only bounded content-free receipts/errors", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], { maxReceipts: 3 });
    await server.start();
    const secret = "private-request-and-diagnostic";
    const request = { model: "model", messages: [{ role: "tool", content: secret }] };
    for (const matchesRequest of [
      () => { throw new Error(secret); }, () => "true", () => 1, () => undefined,
      () => Promise.reject(new Error(secret)),
    ]) {
      server.selectScenario({ id: "private-test", steps: [{ exchangeId: record.caseId, matchesRequest: matchesRequest as unknown as (body: unknown) => boolean }] });
      const response = await post(server, request);
      expect(response).toEqual({ status: 409, text: "{\"error\":\"replay request mismatch\"}" });
      expect(() => server.finishScenario()).toThrow("replay scenario incomplete");
      server.abortScenario();
    }
    const miss = await post(server, { model: secret, messages: [{ role: "user", content: secret }] }, `/${secret}`);
    expect(miss.status).toBe(404);
    expect(miss.text).not.toContain(secret);
    expect(server.recordedReceipts).toHaveLength(3);
    expect(JSON.stringify(server.recordedReceipts)).not.toContain(secret);
    for (const receipt of server.recordedReceipts) {
      expect(Object.keys(receipt).every((key) => ["method", "path", "model", "stream", "matchedCaseId", "scenarioId", "scenarioStep"].includes(key))).toBe(true);
    }
    const copied = server.recordedReceipts as unknown as { path: string }[];
    copied[0]!.path = secret;
    copied.length = 0;
    expect(server.recordedReceipts).toHaveLength(3);
    expect(JSON.stringify(server.recordedReceipts)).not.toContain(secret);
    server.clearReceipts();
    expect(server.recordedReceipts).toEqual([]);
  });

  it("owns the scope during stalled requests, rejects concurrency, and stop/restart cancels and resets it", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], { faultMode: "stall_first_byte" });
    await Promise.all([server.start(), server.start()]);
    const selection = { id: "lifecycle", steps: [{ exchangeId: record.caseId, matchesRequest: () => true }] };
    server.selectScenario(selection);
    const pending = post(server, { model: "model" }).then(() => "completed", () => "cancelled");
    await expect.poll(() => server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined).length).toBe(1);
    expect(() => server.finishScenario()).toThrow("replay lifecycle conflict");
    expect(() => server.abortScenario()).toThrow("replay lifecycle conflict");
    expect(() => server.selectScenario(selection)).toThrow("replay lifecycle conflict");
    expect((await post(server, { model: "model" })).status).toBe(409);
    const catalog = await fetch(`${server.baseUrl}/models`);
    expect(catalog.status).toBe(200);
    await catalog.json();
    expect(server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined)).toHaveLength(1);
    await Promise.all([server.stop(), server.stop()]);
    expect(await pending).toBe("cancelled");
    expect(() => server.baseUrl).toThrow("replay server is not running");
    server.faultMode = undefined;
    await server.start();
    expect(server.recordedReceipts).toEqual([]);
    server.selectScenario(selection);
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });

  it("bounds request bytes and rejects malformed JSON without consuming the next step", async () => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], { maxRequestBodyBytes: 64 });
    await server.start();
    server.selectScenario({ id: "bounded", steps: [{ exchangeId: record.caseId, matchesRequest: () => true }] });
    expect((await post(server, { model: "model", content: "x".repeat(128) })).status).toBe(413);
    for (const body of ["{broken", "null", "[]", "{\"model\":\"model\",\"stream\":\"false\"}"]) {
      const response = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("{\"error\":\"invalid replay request\"}");
    }
    expect((await post(server, { model: "model" }, "/responses")).status).toBe(409);
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });

  it("rejects unsafe paths, symlink escapes and stale response bytes before listening or advancing", async () => {
    const { directory, record } = await fixture();
    const outside = await fixture();
    await symlink(outside.directory, path.join(directory, "escape"), "junction");
    for (const bodyFile of ["../response.json", path.join(outside.directory, "response.json"), "C:\\private\\response.json", "escape/response.json", "response.json:private", "."]) {
      const invalid = { ...record, response: { ...record.response, bodyFile } };
      await expect(validateReplayCorpus(directory, [invalid])).rejects.toThrow(/^invalid replay corpus$/u);
    }
    const stale = { ...record, response: { ...record.response, bodySha256: "0".repeat(64) } };
    const invalidServer = trackedServer(directory, [stale]);
    await expect(invalidServer.start()).rejects.toThrow(/^invalid replay corpus$/u);
    expect(() => invalidServer.baseUrl).toThrow("replay server is not running");
    const server = trackedServer(directory, [record]);
    await server.start();
    server.selectScenario({ id: "integrity", steps: [{ exchangeId: record.caseId, matchesRequest: () => true }] });
    await writeFile(path.join(directory, "response.json"), "private-modified-payload");
    const failed = await post(server, { model: "model" });
    expect(failed).toEqual({ status: 500, text: "{\"error\":\"replay request failed\"}" });
    expect(() => server.finishScenario()).toThrow("replay scenario incomplete");
    await writeFile(path.join(directory, "response.json"), "{\"ok\":true}");
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });

  it.each(["abort", "timeout", "disconnect"] as const)("releases transport resources after %s without replaying an accepted step", async (mode) => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], {
      faultMode: mode === "disconnect" ? "disconnect_early" : "stall_first_byte", requestTimeoutMs: 1000,
    });
    await server.start();
    server.selectScenario({ id: "fault", steps: [{ exchangeId: record.caseId, matchesRequest: () => true }] });
    const controller = new AbortController();
    const pending = fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST", body: JSON.stringify({ model: "model" }), signal: controller.signal,
    }).then(async (response) => { await response.text(); return "completed"; }).catch(() => "cancelled");
    await expect.poll(() => server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined).length).toBe(1);
    if (mode === "abort") controller.abort();
    expect(await pending).toBe("cancelled");
    await expect.poll(() => {
      try { server.finishScenario(); return true; } catch { return false; }
    }).toBe(true);
    server.faultMode = undefined;
    server.selectScenario({ id: "fresh", steps: [{ exchangeId: record.caseId, matchesRequest: () => true }] });
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });

  it.each(["abort", "timeout"] as const)("bounds incomplete uploads and releases their scope on %s", async (mode) => {
    const { directory, record } = await fixture();
    const server = trackedServer(directory, [record], { requestTimeoutMs: 1000 });
    await server.start();
    const selection = { id: "upload", steps: [{ exchangeId: record.caseId, matchesRequest: () => true }] };
    server.selectScenario(selection);
    const upload = httpRequest(`${server.baseUrl}/v1/messages`, { method: "POST" });
    const closed = new Promise<void>((resolve) => upload.once("close", resolve));
    upload.on("error", () => undefined);
    upload.write("{");
    await expect.poll(async () => (await post(server, { model: "wrong-model" })).text).toBe("{\"error\":\"replay request in flight\"}");
    if (mode === "abort") upload.destroy();
    await closed;
    await expect.poll(() => {
      try { server.abortScenario(); return true; } catch { return false; }
    }).toBe(true);
    expect(server.recordedReceipts.filter((receipt) => receipt.matchedCaseId !== undefined)).toEqual([]);
    server.selectScenario(selection);
    expect((await post(server, { model: "model" })).status).toBe(200);
    server.finishScenario();
  });
});

async function post(server: MockCopilotReplayServer, body: unknown, pathname = "/v1/messages"): Promise<{ status: number; text: string }> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function fixture(): Promise<{ directory: string; record: ReplayExchangeRecord }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ghcg-replay-"));
  directories.push(directory);
  const response = Buffer.from("{\"ok\":true}");
  await writeFile(path.join(directory, "response.json"), response);
  return {
    directory,
    record: {
      version: 1, caseId: "replay.messages.tool-result.nonstream", family: "replay",
      sourceProtocol: "messages", targetProtocol: "messages", logicalModel: "model", upstreamModel: "model",
      request: { method: "POST", path: "/v1/messages" },
      response: { status: 200, headers: {}, bodyFile: "response.json", bodySha256: createHash("sha256").update(response).digest("hex"), stream: false },
    },
  };
}

function trackedServer(directory: string, exchanges: readonly ReplayExchangeRecord[], options: Partial<ReplayServerOptions> = {}): MockCopilotReplayServer {
  const server = new MockCopilotReplayServer({ port: 0, corpusDir: directory, exchanges, ...options });
  servers.push(server);
  return server;
}
