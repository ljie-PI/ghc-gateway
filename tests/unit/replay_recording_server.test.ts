import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { EndpointDiscovery } from "../../src/copilot/endpoint_discovery.js";
import { HttpCopilotBackend } from "../../src/copilot/transport.js";
import { REPLAY_CATALOG } from "../support/replay/catalog.js";
import { RecordingCopilotServer, type RecordingFailure, type RecordingStep } from "../support/replay/recording_server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface Seen { readonly path: string; readonly headers: IncomingHttpHeaders; readonly body: string }

/** A controlled Copilot HTTP substitute reached through the production transport. */
async function recording(respond: (response: ServerResponse, seen: Seen) => void, options: { idleTimeoutMs?: number; maxResponseBodyBytes?: number } = {}) {
  const seen: Seen[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const entry = { path: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
    seen.push(entry);
    respond(response, entry);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("test listener unavailable");
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const accountId = `recording-test-${address.port}`;
  const credentials = new MemoryCredentialStore();
  await credentials.putGeneration(accountId, 1, {
    generation: 1, githubToken: "synthetic-github", copilotToken: "synthetic-copilot", copilotExpiresAtMs: Date.now() + 3_600_000,
  });
  const endpointDiscovery = new EndpointDiscovery(async () => `http://127.0.0.1:${address.port}`);
  const backend = new HttpCopilotBackend({
    credentials, accountCoordinator: new AccountCoordinator(), endpointDiscovery,
    refreshCopilotToken: async () => { throw new Error("unexpected token refresh"); },
  });
  cleanup.push(async () => { await backend.close(); await endpointDiscovery.close(); });
  const controller = new AbortController();
  const bound = await backend.bind({
    accountId, environment: resolveGitHubEnvironment("github.com"), userId: "1", login: "synthetic", displayName: "Synthetic", credentialGeneration: 1,
  }, controller.signal);
  const server = new RecordingCopilotServer({ bound, signal: controller.signal, now: () => new Date(1_700_000_000_000), ...options });
  await server.start();
  cleanup.push(async () => { controller.abort(); await server.stop(); });
  return { server, seen, backend };
}

async function post(origin: string, path: string, body: object, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const chatStep: RecordingStep = { caseId: "replay.chat.case.nonstream", path: "/chat/completions", model: "chat-model", stream: false };

describe("recording Copilot upstream", () => {
  it("serves the fixed replay catalog and rejects unselected inference without forwarding", async () => {
    const { server, seen } = await recording(() => { throw new Error("must not forward"); });
    const catalog = await fetch(`${server.origin}/models`);
    expect(await catalog.json()).toEqual(REPLAY_CATALOG);
    expect((await post(server.origin, "/chat/completions", { model: "chat-model" })).status).toBe(409);
    expect(seen).toEqual([]);
  });

  it("forwards a buffered step once and retains the exact upstream bytes", async () => {
    const bytes = "{\"id\":\"exact\",  \"choices\":[]}";
    const { server, seen, backend } = await recording((response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(bytes);
    });
    server.selectSteps([chatStep]);
    const request = { model: "chat-model", messages: [{ role: "user", content: "hello" }] };
    expect(await post(server.origin, "/chat/completions", request, { "copilot-vision-request": "true" })).toEqual({ status: 200, text: bytes });
    const [exchange] = await server.finishSteps();
    expect(exchange).toMatchObject({ caseId: chatStep.caseId, path: "/chat/completions", stream: false, status: 200,
      contentType: "application/json; charset=utf-8", capturedAt: "2023-11-14T22:13:20.000Z" });
    expect(Buffer.from(exchange!.body).toString("utf8")).toBe(bytes);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/chat/completions");
    expect(JSON.parse(seen[0]!.body)).toEqual(request);
    expect(seen[0]!.headers["copilot-vision-request"]).toBe("true");
    expect(backend.inspect().responseLeases).toBe(0);
  });

  it("relays an ordered stream unchanged with native Messages and Responses headers", async () => {
    const frames = ["event: message_start\ndata: {\"a\":1}\n\n", "event: message_stop\ndata: {}\n\n"];
    const { server, seen, backend } = await recording((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) response.write(frame);
      response.end();
    });
    server.selectSteps([
      { caseId: "replay.messages.case.stream", path: "/v1/messages", model: "messages-model", stream: true },
      { caseId: "replay.responses.case.stream", path: "/responses", model: "responses-model", stream: true },
    ]);
    const messages = await post(server.origin, "/v1/messages", { model: "messages-model", stream: true },
      { "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" });
    const responses = await post(server.origin, "/responses", { model: "responses-model", stream: true },
      { "x-initiator": "agent", "x-request-id": "request-1" });
    expect([messages, responses]).toEqual([{ status: 200, text: frames.join("") }, { status: 200, text: frames.join("") }]);
    const exchanges = await server.finishSteps();
    expect(exchanges.map((exchange) => [exchange.caseId, Buffer.from(exchange.body).toString("utf8")])).toEqual([
      ["replay.messages.case.stream", frames.join("")], ["replay.responses.case.stream", frames.join("")],
    ]);
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/messages", "/responses"]);
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(seen[1]!.headers["x-initiator"]).toBe("agent");
    expect(seen[1]!.headers["x-request-id"]).toBe("request-1");
    expect(backend.inspect().responseLeases).toBe(0);
  });

  it.each([
    ["model", "/chat/completions", { model: "other-model" }],
    ["route", "/responses", { model: "chat-model" }],
    ["stream mode", "/chat/completions", { model: "chat-model", stream: true }],
  ] as const)("fails closed on a changed %s without forwarding", async (_name, path, body) => {
    const { server, seen } = await recording(() => { throw new Error("must not forward"); });
    server.selectSteps([chatStep]);
    expect((await post(server.origin, path, body, { "x-initiator": "user", "x-request-id": "request-1" })).status).toBe(502);
    expect(seen).toEqual([]);
    await expect(server.finishSteps()).rejects.toThrow(expect.objectContaining({ code: "capture_request_mismatch", caseId: chatStep.caseId }));
  });

  it("reports rejected upstream status content-free and stops the selection", async () => {
    const { server, seen } = await recording((response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end("{\"error\":\"private upstream diagnostic\"}");
    });
    server.selectSteps([chatStep, { ...chatStep, caseId: "replay.chat.next.nonstream" }]);
    const first = await post(server.origin, "/chat/completions", { model: "chat-model" });
    expect(first.status).toBe(502);
    expect(first.text).not.toContain("private");
    expect((await post(server.origin, "/chat/completions", { model: "chat-model" })).status).toBe(409);
    expect(seen).toHaveLength(1);
    let failure: RecordingFailure | undefined;
    try { await server.finishSteps(); } catch (error: unknown) { failure = error as RecordingFailure; }
    expect(failure).toMatchObject({ code: "capture_http_status", status: 400, caseId: chatStep.caseId });
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  it("requires every selected step", async () => {
    const { server } = await recording((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    server.selectSteps([chatStep, { ...chatStep, caseId: "replay.chat.next.nonstream" }]);
    expect((await post(server.origin, "/chat/completions", { model: "chat-model" })).status).toBe(200);
    await expect(server.finishSteps()).rejects.toThrow(expect.objectContaining({ code: "capture_incomplete", caseId: "replay.chat.next.nonstream" }));
  });

  it("keeps reading upstream after the gateway stops reading and queues the next request", async () => {
    const frames = ["data: {\"n\":1}\n\n", "data: {\"n\":2}\n\n"];
    const { server, seen, backend } = await recording((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frames[0]);
      setTimeout(() => response.end(frames[1]), 100);
    });
    const step = { ...chatStep, stream: true };
    server.selectSteps([step, { ...step, caseId: "replay.chat.next.stream" }]);
    const early = new AbortController();
    const first = await fetch(`${server.origin}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chat-model", stream: true }), signal: early.signal,
    });
    const reader = first.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString("utf8")).toBe(frames[0]);
    const second = post(server.origin, "/chat/completions", { model: "chat-model", stream: true });
    early.abort();
    expect(await second).toEqual({ status: 200, text: frames.join("") });
    const exchanges = await server.finishSteps();
    expect(exchanges.map((exchange) => Buffer.from(exchange.body).toString("utf8"))).toEqual([frames.join(""), frames.join("")]);
    expect(seen).toHaveLength(2);
    await expect.poll(() => backend.inspect().responseLeases).toBe(0);
  });

  it("bounds retained stream bytes and idle gaps and releases the upstream lease", async () => {
    const limited = await recording((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${"x".repeat(64)}\n\n`);
    }, { maxResponseBodyBytes: 32 });
    limited.server.selectSteps([{ ...chatStep, stream: true }]);
    await post(limited.server.origin, "/chat/completions", { model: "chat-model", stream: true }).catch(() => undefined);
    await expect(limited.server.finishSteps()).rejects.toThrow(expect.objectContaining({ code: "capture_body_limit" }));
    expect(limited.backend.inspect().responseLeases).toBe(0);

    const idle = await recording((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {}\n\n");
    }, { idleTimeoutMs: 50 });
    idle.server.selectSteps([{ ...chatStep, stream: true }]);
    await post(idle.server.origin, "/chat/completions", { model: "chat-model", stream: true }).catch(() => undefined);
    await expect(idle.server.finishSteps()).rejects.toThrow(expect.objectContaining({ code: "capture_timeout" }));
    await expect.poll(() => idle.backend.inspect().responseLeases).toBe(0);
  });
});
