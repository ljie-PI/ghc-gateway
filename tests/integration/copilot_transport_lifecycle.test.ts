import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { Pool } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundAccount } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { EndpointDiscovery } from "../../src/copilot/endpoint_discovery.js";
import {
  HttpCopilotBackend,
  InvalidUpstreamResponseError,
  UpstreamTimeoutError,
} from "../../src/copilot/transport.js";
import { MESSAGES_VERSION } from "../../src/copilot/upstream_types.js";
import type { ChatRequest } from "../../src/protocols/chat_completions/types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let accountSequence = 0;
const endpointDiscoveries = new Set<EndpointDiscovery>();

afterEach(async () => {
  await Promise.all([...endpointDiscoveries].map(async (discovery) => await discovery.close()));
  endpointDiscoveries.clear();
});

describe("Copilot transport lifecycle", () => {
  it("reuses real loopback connections within the per-origin bound and closes them", async () => {
    let connectionCount = 0;
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{\"ok\":true}");
      });
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const { backend, bound } = await backendAt(origin);
    try {
      for (let index = 0; index < 8; index += 1) {
        const response = await bound.completeChat(chatRequest());
        expect(decoder.decode(response.body)).toBe("{\"ok\":true}");
      }
      expect(connectionCount).toBeLessThan(8);
      expect(connectionCount).toBeLessThanOrEqual(4);
      expect(backend.inspect().pools).toMatchObject({ entries: 1, active: 0, waiters: 0 });
    } finally {
      await backend.close();
      await waitUntil(() => sockets.size === 0);
      await closeServer(server, sockets);
    }
    expect(sockets.size).toBe(0);
  });

  it("isolates cancellation of one streamed response from another response in the same pool", async () => {
    const sockets = new Set<Socket>();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`first-${requests}\n`);
      setTimeout(() => {
        if (!response.destroyed) {
          response.end(`last-${requests}\n`);
        }
      }, 20);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const { backend, bound } = await backendAt(origin);
    try {
      const first = await bound.openChatStream(chatRequest({ stream: true }));
      const second = await bound.openChatStream(chatRequest({ stream: true }));
      const firstIterator = first.bytes[Symbol.asyncIterator]();
      const secondIterator = second.bytes[Symbol.asyncIterator]();
      expect(decoder.decode((await firstIterator.next()).value)).toContain("first-");
      expect(decoder.decode((await secondIterator.next()).value)).toContain("first-");
      await first.cancel();
      const remaining: string[] = [];
      for (;;) {
        const next = await secondIterator.next();
        if (next.done) {
          break;
        }
        remaining.push(decoder.decode(next.value));
      }
      expect(remaining.join("")).toContain("last-");
      expect(backend.inspect()).toMatchObject({
        responseLeases: 0,
        pools: { entries: 1, active: 0 },
      });
    } finally {
      await backend.close();
      await closeServer(server, sockets);
    }
  });

  it("keeps connect and first-byte deadlines distinct on the Undici path", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }, 50);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const { backend, bound } = await backendAt(origin);
    try {
      await expect(bound.completeChat(chatRequest({
        connectTimeoutMs: 20,
        firstByteTimeoutMs: 200,
      }))).resolves.toMatchObject({ status: 200 });
    } finally {
      await backend.close();
      await closeServer(server, sockets);
    }
  });

  it("releases partial and never-consumed response leases during iteration and shutdown", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("held\n");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const { backend, bound } = await backendAt(origin);
    const unconsumed = await bound.openChatStream(chatRequest({ stream: true }));
    const partial = await bound.openChatStream(chatRequest({ stream: true }));
    expect(backend.inspect().responseLeases).toBe(2);
    for await (const chunk of partial.bytes) {
      expect(decoder.decode(chunk)).toContain("held");
      break;
    }
    expect(backend.inspect()).toMatchObject({
      responseLeases: 1,
      pools: { active: 1 },
    });
    await backend.close();
    expect(backend.inspect()).toMatchObject({
      closed: true,
      responseLeases: 0,
      pools: { entries: 0, active: 0 },
    });
    await unconsumed.cancel();
    await waitUntil(() => sockets.size === 0);
    await closeServer(server, sockets);
  });

  it("bounds graceful shutdown when an injected response refuses cancellation", async () => {
    vi.useFakeTimers();
    try {
      const { backend, bound } = await backendAt("https://stuck-cancel.test", {
        fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
          async cancel(): Promise<void> {
            await new Promise<void>(() => undefined);
          },
        }), { status: 200 }),
      });
      await bound.openChatStream(chatRequest({ stream: true }));
      const closing = backend.close();
      const rejected = expect(closing).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(999);
      expect(backend.inspect().responseLeases).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(backend.inspect().responseLeases).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels each injected Fetch redirect before following it or classifying it", async () => {
    const { backend, bound } = await backendAt("https://redirect.test", {
      fetchImpl: redirectingFetch(),
    });
    try {
      const response = await bound.completeChat(chatRequest());
      expect(response.status).toBe(200);
      expect(decoder.decode(response.body)).toBe("{}");
    } finally {
      await backend.close();
    }

    let invalidCanceled = false;
    const invalid = await backendAt("https://invalid-redirect.test", {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          invalidCanceled = true;
        },
      }), { status: 302, headers: { location: "http://[" } }),
    });
    await expect(invalid.bound.completeChat(chatRequest())).rejects.toBeInstanceOf(InvalidUpstreamResponseError);
    expect(invalidCanceled).toBe(true);
    await invalid.backend.close();

    let exhaustionCancellations = 0;
    const exhausted = await backendAt("https://exhausted-redirect.test", {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          exhaustionCancellations += 1;
        },
      }), { status: 302, headers: { location: "/again" } }),
    });
    await expect(exhausted.bound.completeChat(chatRequest())).rejects.toBeInstanceOf(InvalidUpstreamResponseError);
    expect(exhaustionCancellations).toBe(11);
    await exhausted.backend.close();

    let missingLocationCanceled = false;
    const missing = await backendAt("https://missing-location.test", {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          missingLocationCanceled = true;
        },
      }), { status: 302 }),
    });
    await expect(missing.bound.completeChat(chatRequest())).resolves.toMatchObject({ status: 302 });
    expect(missingLocationCanceled).toBe(true);
    await missing.backend.close();
  });

  it("disposes a late Fetch response after the response-start timeout wins", async () => {
    let canceled = false;
    const { backend, bound } = await backendAt("https://late-response.test", {
      fetchImpl: async () => {
        await delay(20);
        return new Response(new ReadableStream<Uint8Array>({
          cancel(): void {
            canceled = true;
          },
        }), { status: 200 });
      },
    });
    await expect(bound.completeChat(chatRequest({
      connectTimeoutMs: 1,
      firstByteTimeoutMs: 100,
    }))).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await waitUntil(() => canceled);
    await backend.close();
  });

  it("releases a non-ending real redirect body before completing the next hop", async () => {
    const sockets = new Set<Socket>();
    let redirectClosed = false;
    const server = createServer((request, response) => {
      if (request.url === "/chat/completions") {
        response.on("close", () => {
          redirectClosed = true;
        });
        response.writeHead(302, { location: "/final" });
        response.write("held");
        return;
      }
      void waitUntil(() => redirectClosed).then(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const { backend, bound } = await backendAt(origin);
    try {
      const response = await bound.completeChat(chatRequest());
      expect(response.status).toBe(200);
      expect(redirectClosed).toBe(true);
    } finally {
      await backend.close();
      await closeServer(server, sockets);
    }
  });

  it("safely classifies invalid and exhausted Undici redirects without retained leases", async () => {
    for (const scenario of ["invalid", "exhausted"] as const) {
      const sockets = new Set<Socket>();
      let requests = 0;
      const server = createServer((_request, response) => {
        requests += 1;
        response.writeHead(302, {
          location: scenario === "invalid" ? "http://[" : "/chat/completions",
        });
        response.end("discarded");
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      const origin = await listen(server);
      const { backend, bound } = await backendAt(origin);
      try {
        await expect(bound.completeChat(chatRequest())).rejects.toBeInstanceOf(InvalidUpstreamResponseError);
        expect(requests).toBe(scenario === "invalid" ? 1 : 11);
        expect(backend.inspect()).toMatchObject({
          responseLeases: 0,
          pools: { active: 0, waiters: 0 },
        });
      } finally {
        await backend.close();
        await closeServer(server, sockets);
      }
    }
  });

  it("owns the native Messages origin, path, version, beta, identity, and authorization headers", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    const { backend, bound } = await backendAt("https://messages.test/untrusted/base?query=ignored", {
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        return new Response("{}", { status: 200 });
      },
    });
    try {
      await bound.completeMessages({
        body: encoder.encode("{}"),
        version: MESSAGES_VERSION,
        betaFeatures: ["prompt-caching-2024-07-31", "interleaved-thinking-2025-05-14"],
        nonstreamBodyBytes: 1_024,
        connectTimeoutMs: 1_000,
        firstByteTimeoutMs: 1_000,
        signal: new AbortController().signal,
      });
      expect(capturedUrl).toBe("https://messages.test/v1/messages");
      expect(capturedHeaders.get("anthropic-version")).toBe("2023-06-01");
      expect(capturedHeaders.get("anthropic-beta")).toBe(
        "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14",
      );
      expect(capturedHeaders.get("authorization")?.startsWith("Bearer ")).toBe(true);
      expect(capturedHeaders.get("copilot-integration-id")).toBe("vscode-chat");
      expect(capturedHeaders.get("content-type")).toBe("application/json");
    } finally {
      await backend.close();
    }
  });

  it("bounds per-origin acquisition waiters and resumes one after cancellation", async () => {
    const sockets = new Set<Socket>();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("held\n");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const { backend, bound } = await backendAt(origin, {
      poolLimits: {
        maxEntries: 2,
        connectionsPerEntry: 1,
        maxWaitersPerEntry: 1,
        idleTimeoutMs: 1_000,
        maxAcquisitionMs: 1_000,
        shutdownGraceMs: 500,
      },
    });
    try {
      const first = await bound.openChatStream(chatRequest({ stream: true }));
      const waiting = bound.openChatStream(chatRequest({ stream: true }));
      await waitUntil(() => backend.inspect().pools.waiters === 1);
      await expect(bound.openChatStream(chatRequest({ stream: true }))).rejects.toThrow(/saturated/u);
      await first.cancel();
      const second = await waiting;
      expect(requests).toBe(2);
      await second.cancel();
      expect(backend.inspect().pools).toMatchObject({ active: 0, waiters: 0 });
    } finally {
      await backend.close();
      await closeServer(server, sockets);
    }
  });

  it("bounds timeout-profile and origin churn", async () => {
    const sockets = new Set<Socket>();
    let clientConnections = 0;
    let peakClientConnections = 0;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    const shared = await backendAt(origin, {
      createDispatcher: (profile, limits) => {
        const dispatcher = new Pool(profile.origin, {
          connectTimeout: profile.connectTimeoutMs,
          connections: limits.connectionsPerEntry,
          pipelining: 1,
          keepAliveTimeout: limits.idleTimeoutMs,
          keepAliveMaxTimeout: limits.idleTimeoutMs,
        });
        dispatcher.on("connect", () => {
          clientConnections += 1;
          peakClientConnections = Math.max(peakClientConnections, clientConnections);
        });
        dispatcher.on("disconnect", () => {
          clientConnections -= 1;
        });
        return dispatcher;
      },
    });
    try {
      for (let connectTimeoutMs = 1_000; connectTimeoutMs < 1_020; connectTimeoutMs += 1) {
        await shared.bound.completeChat(chatRequest({ connectTimeoutMs }));
        expect(shared.backend.inspect().pools.entries).toBeLessThanOrEqual(16);
      }
      expect(shared.backend.inspect().pools.entries).toBe(16);
      expect(peakClientConnections).toBeLessThanOrEqual(16);
    } finally {
      await shared.backend.close();
      await waitUntil(() => clientConnections === 0);
      await closeServer(server, sockets);
    }

    const store = new MemoryCredentialStore();
    const backend = new HttpCopilotBackend({
      credentials: store,
      accountCoordinator: new AccountCoordinator(),
      refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
      endpointDiscovery: testEndpointDiscovery(async (current) => `http://127.0.0.1:${61_000 + Number(current.userId)}`),
    });
    for (let index = 0; index < 20; index += 1) {
      const current = syntheticAccount(String(index), `pool-${index}`);
      await store.putGeneration(current.accountId, 1, {
        generation: 1,
        githubToken: "github-token",
        copilotToken: "copilot-token",
        copilotExpiresAtMs: Date.now() + 120_000,
      });
      const bound = await backend.bind(current, new AbortController().signal);
      await expect(bound.completeChat(chatRequest({
        connectTimeoutMs: 10,
        firstByteTimeoutMs: 10,
      }))).rejects.toBeDefined();
      expect(backend.inspect().pools.entries).toBeLessThanOrEqual(16);
    }
    expect(backend.inspect().pools).toMatchObject({
      entries: 16,
      active: 0,
      waiters: 0,
      limits: { maxEntries: 16, connectionsPerEntry: 4 },
    });
    await backend.close();
  });

  it("applies acquisition deadlines and cancellation while one dispatcher factory remains pending", async () => {
    let resolveFactory: (pool: Pool) => void = () => undefined;
    const factory = new Promise<Pool>((resolve) => {
      resolveFactory = resolve;
    });
    const { backend, bound } = await backendAt("https://pending-factory.test", {
      createDispatcher: async () => await factory,
    });
    const timedOut = bound.completeChat(chatRequest({
      connectTimeoutMs: 10,
      firstByteTimeoutMs: 10,
    }));
    await expect(timedOut).rejects.toBeInstanceOf(UpstreamTimeoutError);

    const controller = new AbortController();
    const aborted = bound.completeChat(chatRequest({
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
      signal: controller.signal,
    }));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    backend.forceClose();
    resolveFactory(new Pool("https://pending-factory.test"));
    await waitUntil(() => backend.inspect().pools.entries === 0);
  });

  it("force-closes a pending dispatcher already claimed by graceful shutdown", async () => {
    let resolveFactory: (pool: Pool) => void = () => undefined;
    const factory = new Promise<Pool>((resolve) => {
      resolveFactory = resolve;
    });
    const dispatcher = new Pool("https://close-race.test");
    const destroy = vi.spyOn(dispatcher, "destroy");
    const { backend, bound } = await backendAt("https://close-race.test", {
      createDispatcher: async () => await factory,
    });
    const request = bound.completeChat(chatRequest({
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
    }));
    await waitUntil(() => backend.inspect().pools.initializing === 1);
    const closing = backend.close();
    backend.forceClose();
    resolveFactory(dispatcher);
    await closing;
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it("force-closes a dispatcher when idle eviction does not finish in its grace period", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    let destroy: ReturnType<typeof vi.spyOn> | undefined;
    const { backend, bound } = await backendAt(origin, {
      poolLimits: {
        maxEntries: 1,
        connectionsPerEntry: 1,
        maxWaitersPerEntry: 1,
        idleTimeoutMs: 1,
        maxAcquisitionMs: 100,
        shutdownGraceMs: 5,
      },
      createDispatcher: (profile) => {
        const dispatcher = new Pool(profile.origin, {
          connectTimeout: profile.connectTimeoutMs,
          connections: 1,
        });
        vi.spyOn(dispatcher, "close").mockImplementation(async () => await new Promise<void>(() => undefined));
        destroy = vi.spyOn(dispatcher, "destroy");
        return dispatcher;
      },
    });
    try {
      await bound.completeChat(chatRequest());
      await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
      await waitUntil(() => backend.inspect().pools.entries === 0);
    } finally {
      backend.forceClose();
      await closeServer(server, sockets);
    }
  });

  it("clears draining ownership when graceful backend shutdown force-closes a dispatcher", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    let destroy: ReturnType<typeof vi.spyOn> | undefined;
    const { backend, bound } = await backendAt(origin, {
      poolLimits: {
        maxEntries: 1,
        connectionsPerEntry: 1,
        maxWaitersPerEntry: 1,
        idleTimeoutMs: 1_000,
        maxAcquisitionMs: 100,
        shutdownGraceMs: 5,
      },
      createDispatcher: (profile) => {
        const dispatcher = new Pool(profile.origin, {
          connectTimeout: profile.connectTimeoutMs,
          connections: 1,
        });
        vi.spyOn(dispatcher, "close").mockImplementation(async () => await new Promise<void>(() => undefined));
        destroy = vi.spyOn(dispatcher, "destroy");
        return dispatcher;
      },
    });
    try {
      await bound.completeChat(chatRequest());
      await backend.close();
      expect(backend.inspect().pools).toMatchObject({
        entries: 0,
        draining: 0,
        active: 0,
        waiters: 0,
      });
      await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
    } finally {
      backend.forceClose();
      await closeServer(server, sockets);
    }
  });

  it("retains a dispatcher rejected by graceful close until force-close destroys it", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const origin = await listen(server);
    let destroy: ReturnType<typeof vi.spyOn> | undefined;
    const { backend, bound } = await backendAt(origin, {
      createDispatcher: (profile) => {
        const dispatcher = new Pool(profile.origin, {
          connectTimeout: profile.connectTimeoutMs,
          connections: 1,
        });
        vi.spyOn(dispatcher, "close").mockRejectedValue(new Error("dispatcher close failed"));
        destroy = vi.spyOn(dispatcher, "destroy");
        return dispatcher;
      },
    });
    try {
      await bound.completeChat(chatRequest());
      await expect(backend.close()).rejects.toBeInstanceOf(AggregateError);
      expect(destroy).not.toHaveBeenCalled();
      backend.forceClose();
      await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
      expect(backend.inspect().pools).toMatchObject({ entries: 0, draining: 0 });
    } finally {
      backend.forceClose();
      await closeServer(server, sockets);
    }
  });
});

function redirectingFetch(): typeof fetch {
  let calls = 0;
  let firstCanceled = false;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          firstCanceled = true;
        },
      }), { status: 302, headers: { location: "/final" } });
    }
    expect(firstCanceled).toBe(true);
    return new Response("{}", { status: 200 });
  };
}

async function backendAt(
  endpoint: string,
  options: Readonly<{
    fetchImpl?: typeof fetch;
    poolLimits?: ConstructorParameters<typeof HttpCopilotBackend>[0]["poolLimits"];
    createDispatcher?: ConstructorParameters<typeof HttpCopilotBackend>[0]["createDispatcher"];
  }> = {},
): Promise<{
  readonly backend: HttpCopilotBackend;
  readonly bound: Awaited<ReturnType<HttpCopilotBackend["bind"]>>;
}> {
  const store = new MemoryCredentialStore();
  const current = syntheticAccount(String(++accountSequence), `transport-${accountSequence}`);
  await store.putGeneration(current.accountId, 1, {
    generation: 1,
    githubToken: "github-token",
    copilotToken: "copilot-token",
    copilotExpiresAtMs: Date.now() + 120_000,
  });
  const backend = new HttpCopilotBackend({
    credentials: store,
    accountCoordinator: new AccountCoordinator(),
    refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
    endpointDiscovery: testEndpointDiscovery(async () => endpoint),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.poolLimits === undefined ? {} : { poolLimits: options.poolLimits }),
    ...(options.createDispatcher === undefined ? {} : { createDispatcher: options.createDispatcher }),
  });
  return {
    backend,
    bound: await backend.bind(current, new AbortController().signal),
  };
}

function testEndpointDiscovery(
  source: ConstructorParameters<typeof EndpointDiscovery>[0],
): EndpointDiscovery {
  const discovery = new EndpointDiscovery(source);
  endpointDiscoveries.add(discovery);
  return discovery;
}

function syntheticAccount(userId: string, suffix: string): BoundAccount {
  return {
    accountId: `github.com/${suffix}`,
    environment: resolveGitHubEnvironment("github.com"),
    userId,
    login: suffix,
    displayName: suffix,
    credentialGeneration: 1,
  };
}

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gpt-test",
    body: encoder.encode("{}"),
    stream: false,
    hasVisionInput: false,
    nonstreamBodyBytes: 1_024,
    connectTimeoutMs: 1_000,
    firstByteTimeoutMs: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition not reached before timeout");
    }
    await delay(1);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
