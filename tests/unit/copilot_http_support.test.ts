import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { EndpointDiscovery } from "../../src/copilot/endpoint_discovery.js";
import { HttpCopilotBackend } from "../../src/copilot/transport.js";
import { boundedHttpWait, startCopilotHttpMock, type HttpExpectation, type HttpStreamControl } from "../../scripts/tooling/test_support/copilot_http.js";

const bytes = (value: string) => Buffer.from(value);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(async (close) => close()));
  expect(results.every((result) => result.status === "fulfilled"), "all HTTP resources close").toBe(true);
});
async function mock(options: Parameters<typeof startCopilotHttpMock>[0] = {}) {
  const server = await startCopilotHttpMock(options);
  cleanup.push(async () => server.stop());
  return server;
}
async function transport(origin: string) {
  const credentials = new MemoryCredentialStore();
  const accountCoordinator = new AccountCoordinator();
  const account = { accountId: "github.com/41", userId: "41", login: null, displayName: null, credentialGeneration: 3, environment: resolveGitHubEnvironment("github.com") };
  await credentials.putGeneration(account.accountId, 3, { generation: 3, githubToken: "synthetic-github" });
  const endpointDiscovery = new EndpointDiscovery(async () => origin);
  cleanup.push(async () => endpointDiscovery.close());
  const backend = new HttpCopilotBackend({
    credentials, accountCoordinator, endpointDiscovery, nowMs: () => 1_000,
    refreshCopilotToken: async () => ({ token: "synthetic-copilot", expiresAtMs: 100_000 }),
  });
  cleanup.push(async () => backend.close());
  return { backend, bound: await backend.bind(account, new AbortController().signal) };
}
const request = (body: Uint8Array, signal = new AbortController().signal) => ({
  body, signal, model: "synthetic", stream: false, hasVisionInput: false,
  nonstreamBodyBytes: 1024, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000,
});
function idle(backend: HttpCopilotBackend) {
  expect(backend.inspect()).toMatchObject({ closed: false, responseLeases: 0, pools: { active: 0, waiters: 0 } });
}
async function socket(origin: string): Promise<Socket> {
  const url = new URL(origin);
  const value = connect(Number(url.port), url.hostname);
  value.on("error", () => undefined);
  cleanup.push(async () => { value.destroy(); });
  await boundedHttpWait(new Promise<void>((resolve) => value.once("connect", resolve)));
  return value;
}
async function closed(value: Socket) {
  if (!value.closed) await boundedHttpWait(new Promise<void>((resolve) => value.once("close", () => resolve())));
}

async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("HTTP observation timeout");
}

const fixed: HttpExpectation = { method: "POST", path: "/chat/completions", body: bytes("{ \"model\":\"synthetic\" }"), reply: { status: 201, headers: { "content-type": "application/json", "x-synthetic": "fixed" }, body: bytes("{ \"fixed\":true }\n") } };

describe("bounded synthetic Copilot HTTP seam", () => {
  it("uses caller credentials and real Undici wire metadata without normalizing either body", async () => {
    const server = await mock({ expectations: [
      { ...fixed, times: 2 },
      { ...fixed, path: "/responses" },
      { ...fixed, path: "/v1/messages" },
    ] });
    const { backend, bound } = await transport(server.origin);
    const body = fixed.body as Uint8Array;
    const first = await bound.completeChat({ ...request(body), hasVisionInput: true });
    expect(first.status).toBe(201);
    expect(first.headers.get("x-synthetic")).toBe("fixed");
    expect(Buffer.from(first.body).equals(fixed.reply.body!), "raw response bytes unchanged").toBe(true);
    await bound.completeChat(request(body));
    await bound.completeResponses({ ...request(body), hasVisionInput: true, initiator: "agent", requestId: "req_synthetic" });
    await bound.completeMessages({ ...request(body), version: "2023-06-01", betaFeatures: ["prompt-caching-2024-07-31"] });
    expect(server.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/chat/completions" }, { method: "POST", path: "/chat/completions" },
      { method: "POST", path: "/responses" }, { method: "POST", path: "/v1/messages" },
    ]);
    for (const observation of server.requests) {
      expect(Buffer.from(observation.body).equals(body), "raw request bytes unchanged").toBe(true);
      // Compare boolean evidence so a failure cannot dump an authorization value.
      expect(observation.headers.get("authorization") === "Bearer synthetic-copilot", "caller credential was used").toBe(true);
      expect(observation.headers.get("copilot-integration-id")).toBe("vscode-chat");
      expect(observation.headers.get("editor-version")).toBe("vscode/1.110.1");
    }
    expect(server.requests.map((item) => item.headers.get("copilot-vision-request"))).toEqual(["true", null, "true", null]);
    expect(server.requests[2]!.headers.get("x-initiator")).toBe("agent");
    expect(server.requests[2]!.headers.get("x-request-id")).toBe("req_synthetic");
    expect(server.requests[2]!.headers.get("openai-intent")).toBe("conversation-panel");
    expect(server.requests[3]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(server.requests[3]!.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
    server.assertSatisfied();
    idle(backend);
  });

  it.each(["method", "path", "headers", "body"] as const)("fails closed on a %s mismatch with a content-free error", async (mutation) => {
    const server = await mock({ expectations: [{ ...fixed, headers: { "x-synthetic": "expected", "x-absent": null } }] });
    const response = await fetch(server.origin + (mutation === "path" ? "/wrong" : fixed.path), {
      method: mutation === "method" ? "PUT" : "POST",
      headers: { "x-synthetic": mutation === "headers" ? "wrong" : "expected", authorization: "synthetic-secret" },
      body: mutation === "body" ? bytes("{\"model\":\"synthetic\"}") : Buffer.from(fixed.body as Uint8Array),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("{\"error\":\"synthetic HTTP mismatch\"}");
    expect(() => server.assertHealthy()).toThrow("synthetic HTTP request mismatch");
    expect(() => server.assertSatisfied()).toThrow();
  });

  it("sanitizes predicate exceptions and does not consume a rejected expectation", async () => {
    const server = await mock({ expectations: [{ ...fixed, body: () => { throw new Error("synthetic-private"); } }] });
    const response = await fetch(server.origin + fixed.path, { method: "POST", body: "{}" });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("{\"error\":\"synthetic HTTP mismatch\"}");
    expect(() => server.assertHealthy()).toThrow("synthetic HTTP predicate failed");
  });

  it("bounds request count and aggregate retained bytes", async () => {
    const expectation = { ...fixed, body: bytes("1234"), times: 2 };
    const server = await mock({ limits: { retainedBodyBytes: 6 }, expectations: [expectation] });
    const send = async () => fetch(server.origin + fixed.path, { method: "POST", body: "1234" });
    await (await send()).arrayBuffer();
    const rejected = await send();
    expect(rejected.status).toBe(413);
    await rejected.arrayBuffer();
    expect(server.requests).toHaveLength(1);
    expect(server.retainedBodyBytes).toBe(4);
    expect(() => server.assertHealthy()).toThrow("retained body limit");

    const limited = await mock({ limits: { requests: 1 }, expectations: [fixed] });
    await (await fetch(limited.origin + fixed.path, { method: "POST", body: Buffer.from(fixed.body as Uint8Array) })).arrayBuffer();
    const excess = await fetch(limited.origin + fixed.path, { method: "POST", body: "{}" });
    expect(excess.status).toBe(429);
    await excess.arrayBuffer();
    expect(limited.requests).toHaveLength(1);
    expect(() => limited.assertHealthy()).toThrow("request limit");
  });

  it("bounds a chunked request body without retaining its partial content", async () => {
    const server = await mock({ limits: { bodyBytes: 4 } });
    const peer = await socket(server.origin);
    peer.resume();
    peer.write("POST /chat/completions HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n12345\r\n0\r\n\r\n");
    await closed(peer);
    expect(server.requests).toHaveLength(0);
    expect(server.retainedBodyBytes).toBe(0);
    expect(() => server.assertHealthy()).toThrow("request body limit");
  });

  it("bounds sockets and times out incomplete requests", async () => {
    const server = await mock({ limits: { sockets: 1, waitMs: 200 } });
    const first = await socket(server.origin);
    first.write("POST /chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\n1");
    const second = await socket(server.origin);
    await closed(second);
    await closed(first);
    await waitUntil(() => server.socketCount === 0);
    expect(server.requests).toHaveLength(0);
    expect(server.socketCount).toBe(0);
    expect(() => server.assertHealthy()).toThrow("socket limit");
  });

  it("bounds HTTP headers and total unfinished-stream duration", async () => {
    const invalid = await mock();
    const peer = await socket(invalid.origin);
    peer.resume();
    peer.write(`GET / HTTP/1.1\r\nHost: localhost\r\nX-Oversized: ${"x".repeat(17 * 1024)}\r\n\r\n`);
    await closed(peer);
    expect(invalid.requests).toHaveLength(0);
    expect(() => invalid.assertHealthy()).toThrow("invalid HTTP request");

    const timed = await mock({ limits: { waitMs: 100 }, expectations: [{ ...fixed, reply: { stream: async () => undefined } }] });
    await fetch(timed.origin + fixed.path, { method: "POST", body: Buffer.from(fixed.body as Uint8Array) })
      .then(async (response) => response.arrayBuffer()).catch(() => undefined);
    await timed.streams[0]!.waitForClose();
    expect(timed.streams[0]).toMatchObject({ ended: false, closed: true });
    expect(() => timed.assertHealthy()).toThrow(/timeout/u);
  });

  it("supports explicit SSE write/end barriers while preserving event bytes", async () => {
    const server = await mock({ expectations: [{ ...fixed, reply: { headers: { "content-type": "text/event-stream" }, stream: async () => undefined } }] });
    const { backend, bound } = await transport(server.origin);
    const result = await bound.openChatStream({ ...request(fixed.body as Uint8Array), stream: true });
    const exchange = server.streams[0]!;
    const iterator = result.bytes[Symbol.asyncIterator]();
    expect(exchange).toMatchObject({ closed: false, ended: false });
    const first = bytes("data: {\"synthetic\":1}\n\n");
    const last = bytes("data: [DONE]\n\n");
    await exchange.write(first);
    expect(Buffer.from((await iterator.next()).value!).equals(first)).toBe(true);
    await exchange.end(last);
    const remaining: Uint8Array[] = [];
    for (;;) { const next = await iterator.next(); if (next.done) break; remaining.push(next.value); }
    expect(Buffer.concat(remaining).equals(last)).toBe(true);
    await exchange.waitForClose();
    server.assertSatisfied();
    idle(backend);
  });

  it.each(["signal", "iterator", "disconnect"] as const)("releases an unfinished HTTP stream on %s before teardown", async (mode) => {
    const server = await mock({ expectations: [{ ...fixed, reply: { headers: { "content-type": "text/event-stream" }, async stream(exchange) {
      await exchange.write(bytes("data: waiting\n\n"));
      await exchange.waitForClose();
    } } }] });
    const { backend, bound } = await transport(server.origin);
    const controller = new AbortController();
    const result = await bound.openChatStream({ ...request(fixed.body as Uint8Array, controller.signal), stream: true });
    const iterator = result.bytes[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    const exchange = server.streams[0]!;
    expect(exchange).toMatchObject({ closed: false, ended: false });
    expect(backend.inspect()).toMatchObject({ responseLeases: 1, pools: { active: 1 } });
    if (mode === "iterator") await iterator.return?.();
    else {
      if (mode === "signal") controller.abort(); else exchange.disconnect();
      await expect(iterator.next()).rejects.toThrow();
    }
    await exchange.waitForClose();
    expect(exchange.ended).toBe(false);
    server.assertSatisfied();
    idle(backend);
  });

  it("bounds active exchanges and force-closes unfinished work idempotently", async () => {
    const server = await mock({ limits: { activeExchanges: 1 }, expectations: [{ ...fixed, reply: { stream: async (exchange) => exchange.waitForClose() } }] });
    const response = await fetch(server.origin + fixed.path, { method: "POST", body: Buffer.from(fixed.body as Uint8Array) });
    const rejected = await fetch(server.origin + fixed.path, { method: "POST", body: "{}" });
    expect(rejected.status).toBe(503);
    await rejected.arrayBuffer();
    const body = response.arrayBuffer().catch(() => undefined);
    await Promise.all([server.stop(), server.stop(), body]);
    expect(server.activeExchanges).toBe(0);
    expect(server.socketCount).toBe(0);
    expect(server.streams[0]).toMatchObject({ closed: true, ended: false });
    expect(() => server.assertHealthy()).toThrow("active exchange limit");
  });

  it("bounds response writes and backpressure waits on a non-reading peer", async () => {
    let exchange: HttpStreamControl | undefined;
    const server = await mock({ expectations: [{ method: "GET", path: "/sse", body: bytes(""), reply: { async stream(control) {
      exchange = control;
      await control.write(new Uint8Array(8 * 1024 * 1024));
      await control.waitForClose();
    } } }] });
    const peer = await socket(server.origin);
    peer.pause();
    peer.write("GET /sse HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await waitUntil(() => exchange !== undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // TCP send-buffer capacity varies by OS; prove Node signaled backpressure, not
    // that any particular number of bytes must remain blocked in the kernel.
    expect(exchange!.backpressureWrites).toBe(1);
    expect(exchange!.ended).toBe(false);
    await server.stop();
    await exchange!.waitForClose();
    expect(exchange!.ended).toBe(false);
    expect(server.socketCount).toBe(0);

    const limited = await mock({ limits: { responseBytes: 4 }, expectations: [{ ...fixed, reply: { async stream(control) { await control.write(bytes("12345")); } } }] });
    await fetch(limited.origin + fixed.path, { method: "POST", body: Buffer.from(fixed.body as Uint8Array) }).then(async (response) => response.arrayBuffer()).catch(() => undefined);
    expect(() => limited.assertHealthy()).toThrow("response body limit");
  });

  it("rejects invalid setup and times out barriers without leaking unbounded waits", async () => {
    await expect(startCopilotHttpMock({ limits: { requests: 0 } })).rejects.toThrow("invalid synthetic HTTP limit");
    await expect(startCopilotHttpMock({ expectations: [{ ...fixed, times: 129 }] })).rejects.toThrow("invalid synthetic HTTP expectation");
    await expect(boundedHttpWait(new Promise<void>(() => undefined), 10)).rejects.toThrow("synthetic HTTP wait timeout");
  });
});
