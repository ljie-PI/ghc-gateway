import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import type { BoundAccount } from "../../src/accounts/account_directory.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { outboundHeaders, ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { EndpointDiscovery, fallbackEndpoint, stripSecretsOnRedirect } from "../../src/copilot/endpoint_discovery.js";
import { copilotHeaders } from "../../src/copilot/identity.js";
import { HttpCopilotBackend } from "../../src/copilot/transport.js";
import { getValidToken, needsRefresh } from "../../src/copilot/token_refresh.js";

const execFileAsync = promisify(execFile);
const testEndpointDiscoveries = new Set<EndpointDiscovery>();

afterEach(async () => {
  await Promise.all([...testEndpointDiscoveries].map(async (discovery) => await discovery.close()));
  testEndpointDiscoveries.clear();
});

function account(kind: "github.com" | "ghes" = "github.com"): BoundAccount {
  const host = kind === "github.com" ? "github.com" : "ghe.example.com";
  return {
    accountId: `${host}/1`,
    environment: resolveGitHubEnvironment(host),
    userId: "1",
    login: "octo",
    displayName: "Octo",
    credentialGeneration: 1,
  };
}

describe("Copilot transport", () => {
  it("does not load Undici while composing and closing an idle production gateway", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-undici-idle-"));
    const source = [
      "import Module from 'node:module';",
      "import { parseStartupConfig } from './src/config/startup_config.ts';",
      "import { composeProductionDaemonGateway, createProductionApplicationContext } from './src/main.ts';",
      "const dataDir = process.argv[1];",
      "const startup = parseStartupConfig(['--data-dir', dataDir, '--port', '31400'], {});",
      "const application = await createProductionApplicationContext(startup, {});",
      "const gateway = await composeProductionDaemonGateway({",
      "  startup, env: {}, requestStop() {}, logger: { write() {} },",
      "  identity: { version: 1, managed: false, pid: process.pid, processStartIdentity: 'test', instanceNonce: 'test', controlToken: 'test', port: 31400, createdAt: '2026-09-03T00:00:00.000Z' },",
      "}, { application, uptimeMs: () => 0 });",
      "await gateway.close();",
      "const loaded = Object.keys(Module._cache).filter((file) => file.includes('node_modules') && file.includes('undici'));",
      "if (loaded.length > 0) throw new Error(`Undici loaded while idle: ${loaded.join(', ')}`);",
    ].join("\n");
    try {
      await execFileAsync(process.execPath, [
        "--import",
        "tsx/esm",
        "--input-type=module",
        "--eval",
        source,
        dataDir,
      ], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("uses fixed identity headers that inbound authorization cannot override", () => {
    const headers = outboundHeaders("real-token", new Headers({
      authorization: "Bearer attacker",
      "copilot-integration-id": "evil",
      "x-request-id": "ok",
    }));
    expect(headers.get("authorization")).toBe("Bearer real-token");
    expect(headers.get("copilot-integration-id")).toBe(copilotHeaders()["copilot-integration-id"] ?? null);
    expect(headers.get("editor-version")).toBe("vscode/1.110.1");
    expect(headers.get("x-request-id")).toBe("ok");
  });

  it("refreshes github.com tokens only when remaining time is under 60s", () => {
    const now = 1_000_000;
    expect(needsRefresh({ generation: 1, githubToken: "g" }, now, "ghes")).toBe(false);
    expect(needsRefresh({
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: now + 60_000,
    }, now, "github.com")).toBe(false);
    expect(needsRefresh({
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: now + 59_999,
    }, now, "github.com")).toBe(true);
  });

  it("returns GHES oauth token without copilot exchange", async () => {
    const store = new MemoryCredentialStore();
    const bound = account("ghes");
    await store.putGeneration(bound.accountId, 1, { generation: 1, githubToken: "ghes-oauth" });
    const token = await getValidToken(store, new AccountCoordinator(), bound, Date.now(), async () => {
      throw new Error("should not refresh");
    });
    expect(token).toBe("ghes-oauth");
  });

  it("deduplicates stale refreshes for one account generation", async () => {
    const store = new MemoryCredentialStore();
    const coordinator = new AccountCoordinator();
    const bound = account();
    await store.putGeneration(bound.accountId, 1, { generation: 1, githubToken: "github" });
    const started = deferred<void>();
    const release = deferred<void>();
    let refreshes = 0;
    const refresh = async (): Promise<{ token: string; expiresAtMs: number }> => {
      refreshes += 1;
      started.resolve();
      await release.promise;
      return { token: "copilot", expiresAtMs: Date.now() + 120_000 };
    };
    const first = getValidToken(store, coordinator, bound, Date.now(), refresh);
    await started.promise;
    const second = getValidToken(store, coordinator, bound, Date.now(), refresh);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["copilot", "copilot"]);
    expect(refreshes).toBe(1);
    expect(coordinator.inspect()).toMatchObject({ generationKeys: 0, generationPending: 0 });
  });

  it("refreshes different accounts and independent contexts concurrently", async () => {
    const store = new MemoryCredentialStore();
    const coordinator = new AccountCoordinator();
    const firstAccount = account();
    const secondAccount = { ...account(), accountId: "github.com/2", userId: "2" };
    await store.putGeneration(firstAccount.accountId, 1, { generation: 1, githubToken: "github-one" });
    await store.putGeneration(secondAccount.accountId, 1, { generation: 1, githubToken: "github-two" });
    const bothStarted = deferred<void>();
    const release = deferred<void>();
    let started = 0;
    const refresh = async (): Promise<{ token: string; expiresAtMs: number }> => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return { token: "copilot", expiresAtMs: Date.now() + 120_000 };
    };
    const first = getValidToken(store, coordinator, firstAccount, Date.now(), refresh);
    const second = getValidToken(store, coordinator, secondAccount, Date.now(), refresh);
    await bothStarted.promise;

    const independentStore = new MemoryCredentialStore();
    await independentStore.putGeneration(firstAccount.accountId, 1, { generation: 1, githubToken: "independent" });
    await expect(getValidToken(
      independentStore,
      new AccountCoordinator(),
      firstAccount,
      Date.now(),
      async () => ({ token: "independent-copilot", expiresAtMs: Date.now() + 120_000 }),
    )).resolves.toBe("independent-copilot");

    release.resolve();
    await Promise.all([first, second]);
  });

  it("cancels a queued refresh waiter without damaging active or successor refreshes", async () => {
    const store = new MemoryCredentialStore();
    const coordinator = new AccountCoordinator();
    const bound = account();
    await store.putGeneration(bound.accountId, 1, { generation: 1, githubToken: "github" });
    const started = deferred<void>();
    const release = deferred<void>();
    let refreshes = 0;
    const refresh = async (): Promise<{ token: string; expiresAtMs: number }> => {
      refreshes += 1;
      started.resolve();
      await release.promise;
      return { token: "copilot", expiresAtMs: Date.now() + 120_000 };
    };
    const active = getValidToken(store, coordinator, bound, Date.now(), refresh);
    await started.promise;
    const controller = new AbortController();
    const canceled = getValidToken(store, coordinator, bound, Date.now(), refresh, controller.signal);
    const successor = getValidToken(store, coordinator, bound, Date.now(), refresh);
    await Promise.resolve();
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await expect(active).resolves.toBe("copilot");
    await expect(successor).resolves.toBe("copilot");
    expect(refreshes).toBe(1);
    expect(coordinator.inspect()).toMatchObject({ generationKeys: 0, generationPending: 0 });
  });

  it("strips secrets on cross-host redirect and keeps them on same host", () => {
    const headers = new Headers({ authorization: "Bearer t", cookie: "a=b", cookie2: "c=d" });
    const stripped = stripSecretsOnRedirect("https://api.githubcopilot.com/x", "https://evil.example/x", headers);
    expect(stripped.get("authorization")).toBeNull();
    expect(stripped.get("cookie2")).toBeNull();
    const same = stripSecretsOnRedirect("https://api.githubcopilot.com/x", "https://api.githubcopilot.com/y", headers);
    expect(same.get("authorization")).toBe("Bearer t");
  });

  it("discovers once per account with fallback", async () => {
    const bound = account();
    let calls = 0;
    const discovery = new EndpointDiscovery(async () => {
      calls += 1;
      return null;
    });
    const first = await discovery.discover(bound);
    const second = await discovery.discover(bound);
    expect(first.endpoint).toBe("https://api.githubcopilot.com");
    expect(fallbackEndpoint(account("ghes"))).toBe("https://copilot-api.ghe.example.com");
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
    await discovery.close();
  });

  it("isolates endpoint cache hits by Bound Account credential generation", async () => {
    const generationOne = account();
    const generationTwo = { ...generationOne, credentialGeneration: 2 };
    let calls = 0;
    const discovery = new EndpointDiscovery(async (current) => {
      calls += 1;
      return `https://generation-${current.credentialGeneration}.test.invalid`;
    });
    try {
      await expect(discovery.discover(generationOne)).resolves.toEqual({
        endpoint: "https://generation-1.test.invalid",
        cached: false,
      });
      await expect(discovery.discover(generationOne)).resolves.toEqual({
        endpoint: "https://generation-1.test.invalid",
        cached: true,
      });
      await expect(discovery.discover(generationTwo)).resolves.toEqual({
        endpoint: "https://generation-2.test.invalid",
        cached: false,
      });
      await expect(discovery.discover(generationTwo)).resolves.toEqual({
        endpoint: "https://generation-2.test.invalid",
        cached: true,
      });
      expect(calls).toBe(2);
    } finally {
      await discovery.close();
    }
  });

  it("keeps an invalidated stale completion out of the newer generation cache", async () => {
    const generationOne = account();
    const generationTwo = { ...generationOne, credentialGeneration: 2 };
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    let calls = 0;
    const discovery = new EndpointDiscovery(async () => {
      calls += 1;
      return await (calls === 1 ? first.promise : second.promise);
    });
    try {
      const stale = discovery.discover(generationOne);
      discovery.invalidate(generationOne.accountId);
      const current = discovery.discover(generationTwo);
      second.resolve("https://generation-2.test.invalid");
      await expect(current).resolves.toEqual({
        endpoint: "https://generation-2.test.invalid",
        cached: false,
      });
      first.resolve("https://generation-1.test.invalid");
      await expect(stale).resolves.toEqual({
        endpoint: "https://generation-1.test.invalid",
        cached: false,
      });
      await expect(discovery.discover(generationTwo)).resolves.toEqual({
        endpoint: "https://generation-2.test.invalid",
        cached: true,
      });
      expect(calls).toBe(2);
    } finally {
      discovery.forceClose();
    }
  });

  it("deduplicates same-generation discovery while canceling one waiter independently", async () => {
    const source = deferred<string | null>();
    let calls = 0;
    const discovery = new EndpointDiscovery(async () => {
      calls += 1;
      return await source.promise;
    });
    const firstController = new AbortController();
    try {
      const first = discovery.discover(account(), firstController.signal);
      const second = discovery.discover(account());
      expect(calls).toBe(1);
      firstController.abort();
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      source.resolve("https://shared.test.invalid");
      await expect(second).resolves.toEqual({
        endpoint: "https://shared.test.invalid",
        cached: false,
      });
      await expect(discovery.discover(account())).resolves.toEqual({
        endpoint: "https://shared.test.invalid",
        cached: true,
      });
      expect(calls).toBe(1);
    } finally {
      discovery.forceClose();
    }
  });

  it("drops an orphaned discovery before the next request", async () => {
    const sources = [deferred<string | null>(), deferred<string | null>()];
    const sourceSignals: AbortSignal[] = [];
    let calls = 0;
    const discovery = new EndpointDiscovery(async (_current, sourceSignal) => {
      sourceSignals.push(sourceSignal!);
      return await sources[calls++]!.promise;
    });
    const waiterController = new AbortController();
    try {
      const orphan = discovery.discover(account(), waiterController.signal);
      waiterController.abort();
      await expect(orphan).rejects.toMatchObject({ name: "AbortError" });
      expect(sourceSignals[0]?.aborted).toBe(true);
      sources[0]!.resolve("https://orphan.test.invalid");
      await Promise.resolve();
      const retry = discovery.discover(account());
      expect(calls).toBe(2);
      sources[1]!.resolve("https://retry.test.invalid");
      await expect(retry).resolves.toEqual({
        endpoint: "https://retry.test.invalid",
        cached: false,
      });
    } finally {
      discovery.forceClose();
    }
  });

  it("does not retain a rejected discovery coordinator", async () => {
    let calls = 0;
    const discovery = new EndpointDiscovery(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("synthetic discovery failure");
      }
      return "https://retry.test.invalid";
    });
    try {
      await expect(discovery.discover(account())).rejects.toThrow("synthetic discovery failure");
      await expect(discovery.discover(account())).resolves.toEqual({
        endpoint: "https://retry.test.invalid",
        cached: false,
      });
      expect(calls).toBe(2);
    } finally {
      discovery.forceClose();
    }
  });

  it("closes endpoint discovery without retaining in-flight work", async () => {
    const source = deferred<string | null>();
    let sourceSignal: AbortSignal | undefined;
    const discovery = new EndpointDiscovery(async (_current, signal) => {
      sourceSignal = signal;
      return await source.promise;
    });
    const pending = discovery.discover(account());
    const pendingResult = pending.catch((error: unknown) => error);
    try {
      const closing = discovery.close();
      expect(sourceSignal?.aborted).toBe(true);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await closing;
      await expect(discovery.discover(account())).rejects.toMatchObject({ name: "AbortError" });
      discovery.forceClose();
      discovery.forceClose();
    } finally {
      source.resolve("https://late.test.invalid");
      await pendingResult;
      discovery.forceClose();
    }
  });

  it("binds a scripted backend to the provided account only", async () => {
    const backend = new ScriptedCopilotBackend({
      chat: {
        status: 200,
        headers: new Headers(),
        body: new TextEncoder().encode("{}"),
      },
    });
    const bound = await backend.bind(account(), new AbortController().signal);
    expect(bound.accountId).toBe("github.com/1");
    await bound.completeChat({
      model: "gpt",
      body: new Uint8Array(),
      stream: false,
      hasVisionInput: false,
      nonstreamBodyBytes: 1_000,
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(backend.captured).toEqual([{ accountId: "github.com/1", kind: "chat" }]);
  });

  it("sends JSON and vision headers only from typed Chat request state", async () => {
    const store = new MemoryCredentialStore();
    const bound = account();
    await store.putGeneration(bound.accountId, 1, {
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: Date.now() + 120_000,
    });
    let captured: { readonly input: RequestInfo | URL; readonly init: RequestInit | undefined } | undefined;
    const backend = new HttpCopilotBackend({
      credentials: store,
      accountCoordinator: new AccountCoordinator(),
      refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
      endpointDiscovery: testEndpointDiscovery(async () => null),
      fetchImpl: async (input, init) => {
        captured = { input, init };
        return new Response("{}", { status: 200 });
      },
    });
    const copilot = await backend.bind(bound, new AbortController().signal);
    await copilot.completeChat({
      model: "gpt",
      body: new TextEncoder().encode("{}"),
      stream: false,
      hasVisionInput: true,
      nonstreamBodyBytes: 1_000,
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    const headers = new Headers(captured?.init?.headers);
    expect(captured?.input).toBe("https://api.githubcopilot.com/chat/completions");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("copilot-vision-request")).toBe("true");
    expect(headers.has("authorization")).toBe(true);
  });

  it("completes the first outbound request through the lazy Undici transport", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/chat/completions");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    const store = new MemoryCredentialStore();
    const bound = { ...account(), accountId: "github.com/lazy-undici" };
    await store.putGeneration(bound.accountId, 1, {
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: Date.now() + 120_000,
    });
    const backend = new HttpCopilotBackend({
      credentials: store,
      accountCoordinator: new AccountCoordinator(),
      refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
      endpointDiscovery: testEndpointDiscovery(async () => `http://127.0.0.1:${address.port}`),
    });
    try {
      const copilot = await backend.bind(bound, new AbortController().signal);
      const response = await copilot.completeChat({
        model: "gpt",
        body: new TextEncoder().encode("{}"),
        stream: false,
        hasVisionInput: false,
        nonstreamBodyBytes: 1_000,
        connectTimeoutMs: 1_000,
        firstByteTimeoutMs: 1_000,
        signal: new AbortController().signal,
      });
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(response.body)).toBe("{\"ok\":true}");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces captured connect timeout on injected fetch transport", async () => {
    const store = new MemoryCredentialStore();
    const bound = account();
    await store.putGeneration(bound.accountId, 1, {
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: Date.now() + 120_000,
    });
    const backend = new HttpCopilotBackend({
      credentials: store,
      accountCoordinator: new AccountCoordinator(),
      refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
      endpointDiscovery: testEndpointDiscovery(async () => null),
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response("{}", { status: 200 });
      },
    });
    const copilot = await backend.bind(bound, new AbortController().signal);
    await expect(copilot.completeChat({
      model: "gpt",
      body: new TextEncoder().encode("{}"),
      stream: false,
      hasVisionInput: false,
      nonstreamBodyBytes: 1_000,
      connectTimeoutMs: 1,
      firstByteTimeoutMs: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow(/upstream timeout/u);
  });

  it("cancels non-2xx upstream bodies before returning safe errors", async () => {
    const store = new MemoryCredentialStore();
    const bound = account();
    await store.putGeneration(bound.accountId, 1, {
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: Date.now() + 120_000,
    });
    let canceled = false;
    const backend = new HttpCopilotBackend({
      credentials: store,
      accountCoordinator: new AccountCoordinator(),
      refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
      endpointDiscovery: testEndpointDiscovery(async () => null),
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          canceled = true;
        },
      }), { status: 429 }),
    });
    const copilot = await backend.bind(bound, new AbortController().signal);
    const response = await copilot.completeChat({
      model: "gpt",
      body: new TextEncoder().encode("{}"),
      stream: false,
      hasVisionInput: false,
      nonstreamBodyBytes: 1_000,
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 100,
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(429);
    expect(canceled).toBe(true);
  });

  it("times out when non-stream headers arrive but body bytes do not", async () => {
    const store = new MemoryCredentialStore();
    const bound = account();
    await store.putGeneration(bound.accountId, 1, {
      generation: 1,
      githubToken: "g",
      copilotToken: "c",
      copilotExpiresAtMs: Date.now() + 120_000,
    });
    const backend = new HttpCopilotBackend({
      credentials: store,
      accountCoordinator: new AccountCoordinator(),
      refreshCopilotToken: async () => ({ token: "unused", expiresAtMs: Date.now() + 120_000 }),
      endpointDiscovery: testEndpointDiscovery(async () => null),
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull(): void {
          // keep headers open without body bytes
        },
      }), { status: 200 }),
    });
    const copilot = await backend.bind(bound, new AbortController().signal);
    await expect(copilot.completeChat({
      model: "gpt",
      body: new TextEncoder().encode("{}"),
      stream: false,
      hasVisionInput: false,
      nonstreamBodyBytes: 1_000,
      connectTimeoutMs: 100,
      firstByteTimeoutMs: 1,
      signal: new AbortController().signal,
    })).rejects.toThrow(/upstream timeout/u);
  });
});

function testEndpointDiscovery(
  source: ConstructorParameters<typeof EndpointDiscovery>[0],
): EndpointDiscovery {
  const discovery = new EndpointDiscovery(source);
  testEndpointDiscoveries.add(discovery);
  return discovery;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
