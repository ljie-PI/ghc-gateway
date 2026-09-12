import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory, type AccountDirectoryError } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { EndpointDiscovery } from "../../src/copilot/endpoint_discovery.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { RuntimeConfigStore } from "../../src/config/runtime_config.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import {
  composeProductionDaemonGateway,
  createProductionApplicationContext,
  type ApplicationContext,
} from "../../src/main.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import { migration as historyMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as continuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { TelemetryRecorder } from "../../src/telemetry/recorder.js";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const PORT = 31_419;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const IDENTITY = {
  version: 1 as const,
  managed: true,
  pid: 4242,
  processStartIdentity: "windows:production-composition",
  instanceNonce: "daemon-nonce",
  controlToken: "daemon-control-token",
  port: PORT,
  createdAt: "2026-09-03T11:00:00.000Z",
};

describe("production composition", () => {
  it("closes inference responses and dispatchers before telemetry and SQLite", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-close-order-"));
    const application = await createProductionApplicationContext(
      parseStartupConfig(["--data-dir", dataDir, "--port", String(PORT)], {}),
      {},
    );
    const order: string[] = [];
    const closeCopilot = application.copilot.close.bind(application.copilot);
    const closeRegistry = application.registry.close.bind(application.registry);
    const telemetryRuntime = application.telemetryRuntime;
    const endpointDiscovery = application.endpointDiscovery;
    const database = application.database;
    if (telemetryRuntime === undefined || endpointDiscovery === undefined || database === undefined) {
      throw new Error("expected production close owners");
    }
    const closeEndpointDiscovery = endpointDiscovery.close.bind(endpointDiscovery);
    const closeTelemetry = telemetryRuntime.close.bind(telemetryRuntime);
    const closeSqlite = database.close.bind(database);
    application.copilot.close = async () => {
      order.push("copilot");
      await closeCopilot();
    };
    application.registry.close = async () => {
      order.push("registry");
      await closeRegistry();
    };
    endpointDiscovery.close = async () => {
      order.push("endpoint-discovery");
      await closeEndpointDiscovery();
    };
    telemetryRuntime.close = async () => {
      order.push("telemetry");
      await closeTelemetry();
    };
    database.close = () => {
      order.push("sqlite");
      return closeSqlite();
    };
    try {
      await application.close?.();
      expect(order).toEqual(["copilot", "registry", "endpoint-discovery", "telemetry", "sqlite"]);
    } finally {
      application.forceClose?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("continues the ordered close chain and aggregates owner failures", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-close-errors-"));
    const application = await createProductionApplicationContext(
      parseStartupConfig(["--data-dir", dataDir, "--port", String(PORT)], {}),
      {},
    );
    const order: string[] = [];
    application.copilot.close = async () => {
      order.push("copilot");
      throw new Error("copilot close failed");
    };
    application.registry.close = async () => {
      order.push("registry");
      throw new Error("registry close failed");
    };
    const telemetryRuntime = application.telemetryRuntime;
    const endpointDiscovery = application.endpointDiscovery;
    if (telemetryRuntime === undefined || endpointDiscovery === undefined || application.database === undefined) {
      throw new Error("expected production close owners");
    }
    endpointDiscovery.close = async () => {
      order.push("endpoint-discovery");
      throw new Error("endpoint discovery close failed");
    };
    const closeSqlite = application.database.close.bind(application.database);
    telemetryRuntime.close = async () => {
      order.push("telemetry");
      throw new Error("telemetry close failed");
    };
    application.database.close = () => {
      order.push("sqlite");
      throw new Error("sqlite close failed");
    };
    try {
      await expect(application.close?.()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [
          expect.objectContaining({ message: "copilot close failed" }),
          expect.objectContaining({ message: "registry close failed" }),
          expect.objectContaining({ message: "endpoint discovery close failed" }),
          expect.objectContaining({ message: "telemetry close failed" }),
          expect.objectContaining({ message: "sqlite close failed" }),
        ],
      });
      expect(order).toEqual(["copilot", "registry", "endpoint-discovery", "telemetry", "sqlite"]);
      expect(application.database.prepare("SELECT 1").get()).toEqual({ "1": 1 });
    } finally {
      application.database.close = closeSqlite;
      application.forceClose?.();
      expect(() => application.database?.prepare("SELECT 1").get()).toThrow();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("owns endpoint discovery per application and shares it across catalog and backend", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-discovery-owners-"));
    const server = createServer((request, response) => {
      modelRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{
        id: "gpt-test",
        name: "GPT Test",
        vendor: "openai",
        model_picker_enabled: true,
        model_info: { supported_endpoints: ["/chat/completions"] },
      }] }));
    });
    const modelRequests: string[] = [];
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected model source listener");
    }
    const nativeFetch = globalThis.fetch;
    const discoveryRequests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const suffix = authorization.includes("context-a") ? "a" : "b";
      if (url.endsWith("/copilot_internal/v2/token")) {
        return new Response(JSON.stringify({ token: `copilot-${suffix}`, expires_at: 2_000_000_000 }), { status: 200 });
      }
      if (url.endsWith("/copilot_internal/user")) {
        discoveryRequests.push(suffix);
        return new Response(JSON.stringify({
          copilot_plan: "individual",
          quota_reset_date: "2026-10-01",
          quota_snapshots: {
            chat: quotaDetail(),
            completions: quotaDetail(),
            premium_interactions: quotaDetail(),
          },
          endpoints: { api: `http://127.0.0.1:${address.port}/${suffix}` },
        }), { status: 200 });
      }
      throw new Error("unexpected scripted fetch");
    }) as typeof fetch;
    let contextA: ApplicationContext | undefined;
    let contextB: ApplicationContext | undefined;
    try {
      contextA = await createProductionApplicationContext(
        parseStartupConfig(["--data-dir", path.join(root, "a"), "--port", String(PORT)], {}),
        {},
      );
      contextB = await createProductionApplicationContext(
        parseStartupConfig(["--data-dir", path.join(root, "b"), "--port", String(PORT + 1)], {}),
        {},
      );
      const accountA = await contextA.directory.upsertAuthenticated({
        host: "github.com",
        userId: "177",
        secret: { generation: 0, githubToken: "context-a" },
      });
      const accountB = await contextB.directory.upsertAuthenticated({
        host: "github.com",
        userId: "177",
        secret: { generation: 0, githubToken: "context-b" },
      });
      await contextA.registry.get(accountA, signal());
      await contextA.copilot.bind(accountA, signal());
      expect(discoveryRequests).toEqual(["a"]);
      await contextB.copilot.bind(accountB, signal());
      expect(discoveryRequests).toEqual(["a", "b"]);
      expect(modelRequests).toEqual(["/a/models"]);
    } finally {
      globalThis.fetch = nativeFetch;
      await contextA?.close?.();
      await contextB?.close?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares management state and applies runtime settings to every live owner", async () => {
    const harness = compositionHarness();
    const gateway = await composeProductionDaemonGateway({
      startup: harness.startup,
      env: {},
      identity: IDENTITY,
      logger: { write() {} },
      requestStop() {},
    }, { application: harness.application, uptimeMs: () => 1234 });
    try {
      const account = await harness.directory.upsertAuthenticated({
        host: "github.com",
        userId: "91919",
        login: "composition",
        secret: { generation: 0, githubToken: "test-token" },
      });
      await harness.registry.get(account, signal());
      expect(harness.catalogFetchCount()).toBe(1);
      await harness.endpointDiscovery.discover(account);
      expect(harness.endpointFetchCount()).toBe(1);

      const bootstrap = await control(gateway, "POST", "/admin-bootstrap");
      expect(bootstrap.status).toBe(200);
      const bootstrapBody = await bootstrap.json() as { data: { token: string } };
      const exchange = await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token: bootstrapBody.data.token }),
      }));
      expect(exchange.status).toBe(200);
      const session = await exchange.json() as { data: { csrfToken: string } };
      const cookie = exchange.headers.get("set-cookie") ?? "";

      const status = await adminJson(gateway, "/admin/api/v1/status", cookie);
      expect(status.data).toMatchObject({
        version: "0.1.0",
        uptimeMs: 1234,
        daemon: { managed: true, pid: 4242, startedAt: IDENTITY.createdAt },
      });
      const models = await adminJson(gateway, "/admin/api/v1/models", cookie);
      expect(models.data).toMatchObject({
        items: [{ id: "gpt-test", maxInputTokens: 200_000, maxOutputTokens: 16_384 }],
      });
      const cliModels = await control(gateway, "POST", "/command", {
        operation: "models.list",
        arguments: {},
      });
      expect(await cliModels.json()).toMatchObject({
        data: { items: [{ id: "gpt-test", maxInputTokens: 200_000, maxOutputTokens: 16_384 }] },
      });

      const config = defaultRuntimeConfigSnapshot();
      config.limits.requestBodyBytes = 1_048_576;
      config.accounts.maxAuthenticated = 1;
      config.history.ttlDays = 2;
      config.usage.retentionDays = 1;
      config.events.retentionDays = 1;
      const updated = await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/config`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: ORIGIN,
          "x-ghcg-csrf": session.data.csrfToken,
        },
        body: JSON.stringify({ expectedRevision: harness.runtime.readRevision(), config }),
      }));
      expect(updated.status).toBe(200);
      expect(harness.history.inspect().ttlDays).toBe(2);
      await expect(harness.directory.upsertAuthenticated({
        host: "github.com",
        userId: "91920",
        secret: { generation: 0, githubToken: "second-test-token" },
      })).rejects.toMatchObject({ code: "capacity" } satisfies Partial<AccountDirectoryError>);

      harness.telemetry.recordUsage({
        occurredAtMs: NOW - 2 * 86_400_000,
        accountId: account.accountId,
        protocol: "openai_chat",
        resolvedModel: "old-model",
        outcome: "success",
        requestCount: 1,
        errorCount: 0,
        inputTokens: 1,
        outputTokens: 1,
        cacheTokens: 0,
        latencyMs: 1,
      });
      harness.telemetry.recordEvent({
        occurredAtMs: NOW - 2 * 86_400_000,
        kind: "gateway_started",
        severity: "info",
      });
      await harness.telemetry.flush();
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM usage_buckets").get()).toEqual({ count: 0 });
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operational_events").get()).toEqual({ count: 0 });

      const events = await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/events/stream`, {
        headers: { cookie },
      }));
      expect(events.status).toBe(200);
      const reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: performance");
      harness.telemetry.recordEvent({ occurredAtMs: NOW, kind: "gateway_started", severity: "info" });
      await harness.telemetry.flush();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: operational");
      await reader.cancel();

      const cliUpdate = await control(gateway, "POST", "/command", {
        operation: "config.set",
        arguments: { key: "history.ttlDays", value: "3" },
      });
      expect(cliUpdate.status).toBe(200);
      expect(harness.history.inspect().ttlDays).toBe(3);

      const oversized = await gateway.fetch(new Request(`${ORIGIN}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"padding":"${"x".repeat(1_048_576)}"}`,
      }));
      expect(oversized.status).toBe(413);

      const removed = await control(gateway, "POST", "/command", {
        operation: "accounts.remove",
        arguments: { accountId: account.accountId },
      });
      expect(removed.status).toBe(200);
      await harness.registry.get(account, signal());
      expect(harness.catalogFetchCount()).toBe(2);
      await harness.endpointDiscovery.discover(account);
      expect(harness.endpointFetchCount()).toBe(2);
    } finally {
      await gateway.close();
    }
  });

  it("fences in-flight discovery across account logout and relogin", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    let fetches = 0;
    const harness = compositionHarness(async () => {
      fetches += 1;
      return await (fetches === 1 ? first.promise : second.promise);
    });
    const gateway = await composeProductionDaemonGateway({
      startup: harness.startup,
      env: {},
      identity: IDENTITY,
      logger: { write() {} },
      requestStop() {},
    }, { application: harness.application });
    try {
      const generationOne = await harness.directory.upsertAuthenticated({
        host: "github.com",
        userId: "177",
        secret: { generation: 0, githubToken: "generation-one" },
      });
      const stale = harness.endpointDiscovery.discover(generationOne);
      const logout = await control(gateway, "POST", "/command", {
        operation: "auth.logout",
        arguments: { accountId: generationOne.accountId },
      });
      expect(logout.status).toBe(200);
      const generationTwo = await harness.directory.upsertAuthenticated({
        host: "github.com",
        userId: "177",
        secret: { generation: 0, githubToken: "generation-two" },
      });
      expect(generationTwo.credentialGeneration).toBeGreaterThan(generationOne.credentialGeneration);
      const current = harness.endpointDiscovery.discover(generationTwo);
      second.resolve("https://generation-two.test.invalid");
      await expect(current).resolves.toMatchObject({ endpoint: "https://generation-two.test.invalid" });
      first.resolve("https://generation-one.test.invalid");
      await expect(stale).resolves.toMatchObject({ endpoint: "https://generation-one.test.invalid" });
      await expect(harness.endpointDiscovery.discover(generationTwo)).resolves.toEqual({
        endpoint: "https://generation-two.test.invalid",
        cached: true,
      });
      expect(fetches).toBe(2);
    } finally {
      await gateway.close();
    }
  });
});

interface CompositionHarness {
  readonly startup: ReturnType<typeof parseStartupConfig>;
  readonly application: ApplicationContext;
  readonly database: ReturnType<typeof openDatabase>;
  readonly directory: AccountDirectory;
  readonly registry: ModelCapabilityRegistry;
  readonly history: SqliteResponsesHistory;
  readonly telemetry: TelemetryRecorder;
  readonly runtime: RuntimeConfigStore;
  readonly endpointDiscovery: EndpointDiscovery;
  readonly catalogFetchCount: () => number;
  readonly endpointFetchCount: () => number;
}

function compositionHarness(
  endpointSource: ConstructorParameters<typeof EndpointDiscovery>[0] = async () => "https://copilot.test.invalid",
): CompositionHarness {
  const database = openDatabase({
    path: ":memory:",
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(historyMigration),
      embedMigration(continuationMigration),
    ],
    nowMs: () => NOW,
  });
  const credentials = new MemoryCredentialStore();
  const runtime = new RuntimeConfigStore(database, () => NOW);
  const snapshot = runtime.seedIfEmpty({});
  const directory = new AccountDirectory(database, credentials, () => NOW, snapshot.accounts.maxAuthenticated);
  let catalogFetches = 0;
  const catalog = new CopilotModelCatalog({
    async fetch() {
      catalogFetches += 1;
      return { data: [{
        id: "gpt-test",
        name: "GPT Test",
        vendor: "openai",
        model_picker_enabled: true,
        model_info: {
          supported_endpoints: ["/chat/completions"],
          max_input_tokens: 200_000,
          max_output_tokens: 16_384,
          chat_output_token_field: "max_tokens",
        },
      }] };
    },
  }, () => new Date(NOW));
  const history = new SqliteResponsesHistory(database, { nowMs: () => NOW, ttlDays: snapshot.history.ttlDays });
  const telemetry = new TelemetryRecorder(database, () => NOW);
  const registry = new ModelCapabilityRegistry(catalog, {
    get: () => null,
  });
  let endpointFetches = 0;
  const endpointDiscovery = new EndpointDiscovery(async (account, signal) => {
    endpointFetches += 1;
    return await endpointSource(account, signal);
  });
  const application: ApplicationContext = {
    database,
    credentials,
    directory,
    registry,
    copilot: new ScriptedCopilotBackend({}),
    history,
    telemetry,
    endpointDiscovery,
    runtime,
    async close() {
      await telemetry.flush();
      await registry.close();
      await endpointDiscovery.close();
      closeDatabase(database);
    },
  };
  return {
    startup: parseStartupConfig(["--data-dir", "daemon-composition", "--port", String(PORT)], {}),
    application,
    database,
    directory,
    registry,
    history,
    telemetry,
    runtime,
    endpointDiscovery,
    catalogFetchCount: () => catalogFetches,
    endpointFetchCount: () => endpointFetches,
  };
}

async function control(
  gateway: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await gateway.fetch(new Request(`${ORIGIN}/__ghcg/control/v1${path}`, {
    method,
    headers: {
      "x-ghcg-control-token": IDENTITY.controlToken,
      "x-ghcg-instance-nonce": IDENTITY.instanceNonce,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function adminJson(
  gateway: { fetch(request: Request): Promise<Response> },
  path: string,
  cookie: string,
): Promise<{ data: unknown }> {
  const response = await gateway.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
  expect(response.status).toBe(200);
  return await response.json() as { data: unknown };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function quotaDetail(): Record<string, unknown> {
  return { entitlement: 100, remaining: 100, percent_remaining: 100, unlimited: false };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
