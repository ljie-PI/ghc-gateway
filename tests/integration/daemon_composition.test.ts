import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory, type AccountDirectoryError } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { discoverEndpoint, invalidateEndpoint } from "../../src/copilot/endpoint_discovery.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { SqliteModelCapabilityOverrides } from "../../src/copilot/capability_overrides.js";
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
import { migration as modelCapabilitiesMigration } from "../../src/persistence/migrations/040_model_capabilities.js";
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
    const closeCatalog = application.catalog.close.bind(application.catalog);
    const telemetryRuntime = application.telemetryRuntime;
    const database = application.database;
    if (telemetryRuntime === undefined || database === undefined) {
      throw new Error("expected production close owners");
    }
    const closeTelemetry = telemetryRuntime.close.bind(telemetryRuntime);
    const closeSqlite = database.close.bind(database);
    application.copilot.close = async () => {
      order.push("copilot");
      await closeCopilot();
    };
    application.catalog.close = async () => {
      order.push("catalog");
      await closeCatalog();
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
      expect(order).toEqual(["copilot", "catalog", "telemetry", "sqlite"]);
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
    application.catalog.close = async () => {
      order.push("catalog");
      throw new Error("catalog close failed");
    };
    const telemetryRuntime = application.telemetryRuntime;
    if (telemetryRuntime === undefined || application.database === undefined) {
      throw new Error("expected production close owners");
    }
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
          expect.objectContaining({ message: "catalog close failed" }),
          expect.objectContaining({ message: "telemetry close failed" }),
          expect.objectContaining({ message: "sqlite close failed" }),
        ],
      });
      expect(order).toEqual(["copilot", "catalog", "telemetry", "sqlite"]);
      expect(application.database.prepare("SELECT 1").get()).toEqual({ "1": 1 });
    } finally {
      application.database.close = closeSqlite;
      application.forceClose?.();
      expect(() => application.database?.prepare("SELECT 1").get()).toThrow();
      await rm(dataDir, { recursive: true, force: true });
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
      await harness.catalog.get(account.accountId, signal());
      expect(harness.catalogFetchCount()).toBe(1);
      let endpointFetches = 0;
      const endpointSource = async () => {
        endpointFetches += 1;
        return "https://copilot.test.invalid";
      };
      await discoverEndpoint(account, endpointSource);
      expect(endpointFetches).toBe(1);

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
      await harness.catalog.get(account.accountId, signal());
      expect(harness.catalogFetchCount()).toBe(3);
      await discoverEndpoint(account, endpointSource);
      expect(endpointFetches).toBe(2);
      invalidateEndpoint(account.accountId);
    } finally {
      invalidateEndpoint("github.com/91919");
      await gateway.close();
    }
  });
});

interface CompositionHarness {
  readonly startup: ReturnType<typeof parseStartupConfig>;
  readonly application: ApplicationContext;
  readonly database: ReturnType<typeof openDatabase>;
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly history: SqliteResponsesHistory;
  readonly telemetry: TelemetryRecorder;
  readonly runtime: RuntimeConfigStore;
  readonly catalogFetchCount: () => number;
}

function compositionHarness(): CompositionHarness {
  const database = openDatabase({
    path: ":memory:",
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(historyMigration),
      embedMigration(modelCapabilitiesMigration),
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
  const registry = new ModelCapabilityRegistry(catalog, new SqliteModelCapabilityOverrides(database), {
    get: () => null,
  });
  const application: ApplicationContext = {
    database,
    credentials,
    directory,
    catalog,
    registry,
    copilot: new ScriptedCopilotBackend({}),
    history,
    telemetry,
    runtime,
    async close() {
      await telemetry.flush();
      await catalog.close();
      closeDatabase(database);
    },
  };
  return {
    startup: parseStartupConfig(["--data-dir", "daemon-composition", "--port", String(PORT)], {}),
    application,
    database,
    directory,
    catalog,
    history,
    telemetry,
    runtime,
    catalogFetchCount: () => catalogFetches,
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
