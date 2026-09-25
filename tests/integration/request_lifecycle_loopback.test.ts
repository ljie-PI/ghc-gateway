import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { withSetupCleanup, startHttpCopilot, closeAll, jsonStream, waitForHttp, assertTransportReleased } from "../../scripts/tooling/test_support/http_copilot.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type HostedGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createOpenaiResponsesRoute } from "../../src/protocols/openai_responses/endpoint.js";
import type { ResponsesHistory } from "../../src/protocols/openai_responses/history.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";
import { testModelCapabilityRegistry } from "../contract/model_capability_registry_harness.js";

describe("request lifecycle over loopback", () => {
  const closing: HostedGateway[] = [];

  afterEach(async () => {
    await closeAll(closing.splice(0).map((gateway) => () => gateway.close()));
  });

  it("writes an exact Content-Length for each loopback probe response", async () => {
    const port = await availablePort();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", String(port)], {}, { homedir: "Q:\\ghc-gateway-loopback" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, []);
    closing.push(gateway);
    await gateway.listen();

    for (const [route, expectedBody] of [
      ["/healthz", "{\"status\":\"ok\",\"version\":\"0.1.1\"}"],
      ["/readyz", "{\"status\":\"ready\"}"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expectedBody)));
      expect(await response.text()).toBe(expectedBody);
    }

    const notReadyPort = await availablePort();
    const notReadyGateway = await createGateway({
      startup: parseStartupConfig(["--port", String(notReadyPort)], {}, { homedir: "Q:\\ghc-gateway-loopback" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [], { isReady: () => false });
    closing.push(notReadyGateway);
    await notReadyGateway.listen();
    await (await fetch(`http://127.0.0.1:${notReadyPort}/healthz`)).text();
    const notReadyBody = "{\"status\":\"not_ready\"}";
    const notReady = await fetch(`http://127.0.0.1:${notReadyPort}/readyz`);
    expect(notReady.status).toBe(503);
    expect(notReady.headers.get("content-length")).toBe(String(Buffer.byteLength(notReadyBody)));
    expect(await notReady.text()).toBe(notReadyBody);
  });

  it("delivers a nonempty precommit 504 when an internal deadline cancels only upstream work", async () => {
    const usage: UsageUpdate[] = [];
    const opened = await responsesGateway({
      totalMs: 1_500,
      usage,
    });
    const { gateway } = opened;
    closing.push(gateway);
    const { port } = await gateway.listen();

    const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native", input: "hi", stream: true }),
    });

    await waitForHttp(() => opened.upstream.streams.length === 1);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.text()).toBe(
      "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
    );
    await waitForHttp(() => opened.upstream.streams[0]?.closed === true);
    assertTransportReleased(opened.backend);
    expect(opened.upstream.requests).toHaveLength(1);
    opened.upstream.assertSatisfied();
    expect(usage).toHaveLength(1);
    expect(usage).toMatchObject([{
      protocol: "openai_responses_native",
      outcome: "timeout",
    }]);
  });

  it("keeps a real client disconnect distinct and fabricates no timeout response", async () => {
    const usage: UsageUpdate[] = [];
    const opened = await responsesGateway({
      totalMs: 60_000,
      usage,
    });
    const { gateway } = opened;
    closing.push(gateway);
    const { port } = await gateway.listen();
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native", input: "hi", stream: true }),
      signal: controller.signal,
    });
    await waitForHttp(() => opened.upstream.streams.length === 1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitForHttp(() => {
      const state = opened.backend.inspect();
      return usage.length === 1 && opened.upstream.streams[0]?.closed === true
        && state.responseLeases === 0 && state.pools.active === 0 && state.pools.waiters === 0;
    });
    assertTransportReleased(opened.backend);
    expect(opened.upstream.requests).toHaveLength(1);
    opened.upstream.assertSatisfied();
    expect(usage).toMatchObject([{
      protocol: "openai_responses_native",
      outcome: "aborted",
    }]);
  });

  it("claims shutdown finalization before close hooks and keeps cleanup bounded", async () => {
    const usage: UsageUpdate[] = [];
    let finalizedBeforeClose = false;
    const opened = await responsesGateway({
      totalMs: 60_000,
      usage,
      onClose: () => {
        finalizedBeforeClose = usage.length === 1;
      },
    });
    const { gateway } = opened;
    closing.push(gateway);
    const pending = gateway.fetch(responsesRequest());
    await waitForHttp(() => opened.upstream.streams.length === 1);
    const started = Date.now();
    await gateway.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await pending).body).toBeNull();
    expect(finalizedBeforeClose).toBe(true);
    await waitForHttp(() => opened.upstream.streams[0]?.closed === true);
    assertTransportReleased(opened.backend);
    expect(opened.upstream.requests).toHaveLength(1);
    opened.upstream.assertSatisfied();
    expect(usage).toHaveLength(1);
    expect(usage).toMatchObject([{ outcome: "aborted" }]);
  });
});

async function responsesGateway(options: {
  readonly totalMs: number;
  readonly usage: UsageUpdate[];
  readonly onClose?: () => void;
}) {
  return await withSetupCleanup(async (own) => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    });
    own(() => closeDatabase(database));
    const credentials = new MemoryCredentialStore();
    const accountCoordinator = new AccountCoordinator();
    const accounts = new AccountDirectory(database, credentials, accountCoordinator);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return {
          data: [{
            id: "native",
            name: "Native",
            vendor: "github",
            model_picker_enabled: true,
            model_info: { supported_endpoints: ["/responses"] },
          }],
        };
      },
    });
    const http = await startHttpCopilot({ credentials, accountCoordinator, nowMs: Date.now, expectations: [{
      method: "POST", path: "/responses", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => { await exchange.waitForClose(); } },
    }] });
    own(() => http.close());
    const registry = testModelCapabilityRegistry(catalog);
    own(() => registry.close());
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.totalMs = options.totalMs;
    const port = await availablePort();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", String(port)], {}, { homedir: "Q:\\ghc-gateway-loopback" }),
      runtime,
    }, [createOpenaiResponsesRoute({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
      copilot: http.backend,
      history: EMPTY_HISTORY,
      usageRecorder: { recordUsage: (update) => options.usage.push(update) },
    })], {
      onClose: async () => {
        await closeAll([
          () => options.onClose?.(),
          () => assertTransportReleased(http.backend),
          () => registry.close(), () => http.close(), () => closeDatabase(database),
        ]);
      },
    });
    return { gateway, upstream: http.upstream, backend: http.backend };
  });
}

const EMPTY_HISTORY: ResponsesHistory = {
  async resolve() {
    return { kind: "none" };
  },
  async enrich(request) {
    return request;
  },
  async recordReceipt() {},
  async recordCheckpoint() {},
};

function responsesRequest(): Request {
  return new Request("http://127.0.0.1:31400/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "native", input: "hi", stream: true }),
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}
