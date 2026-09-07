import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type HostedGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import type { ResponsesHistory } from "../../src/protocols/responses/history.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

describe("request lifecycle over loopback", () => {
  const closing: HostedGateway[] = [];

  afterEach(async () => {
    await Promise.allSettled(closing.splice(0).map(async (gateway) => await gateway.close()));
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
      ["/healthz", "{\"status\":\"ok\",\"version\":\"0.1.0\"}"],
      ["/readyz", "{\"status\":\"ready\"}"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expectedBody)));
      expect(await response.text()).toBe(expectedBody);
    }
  });

  it("delivers a nonempty precommit 504 when an internal deadline cancels only upstream work", async () => {
    const usage: UsageUpdate[] = [];
    const gateway = await responsesGateway({
      totalMs: 20,
      usage,
      stream: (signal) => stalledBytes(signal),
    });
    closing.push(gateway);
    const { port } = await gateway.listen();

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native", input: "hi", stream: true }),
    });

    expect(response.status).toBe(504);
    expect(await response.text()).toBe(
      "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
    );
    expect(usage).toHaveLength(1);
    expect(usage).toMatchObject([{
      protocol: "openai_responses_native",
      outcome: "timeout",
    }]);
  });

  it("keeps a real client disconnect distinct and fabricates no timeout response", async () => {
    const usage: UsageUpdate[] = [];
    const gateway = await responsesGateway({
      totalMs: 60_000,
      usage,
      stream: (signal) => stalledBytes(signal),
    });
    closing.push(gateway);
    const { port } = await gateway.listen();
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native", input: "hi", stream: true }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => usage.length === 1);
    expect(usage).toMatchObject([{
      protocol: "openai_responses_native",
      outcome: "aborted",
    }]);
  });

  it("claims shutdown finalization before close hooks and keeps cleanup bounded", async () => {
    const usage: UsageUpdate[] = [];
    let finalizedBeforeClose = false;
    const gateway = await responsesGateway({
      totalMs: 60_000,
      usage,
      stream: (signal) => stalledBytes(signal),
      onClose: () => {
        finalizedBeforeClose = usage.length === 1;
      },
    });
    const pending = gateway.fetch(responsesRequest());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await gateway.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await pending).body).toBeNull();
    expect(finalizedBeforeClose).toBe(true);
    expect(usage).toHaveLength(1);
    expect(usage).toMatchObject([{ outcome: "aborted" }]);
  });
});

async function responsesGateway(options: {
  readonly totalMs: number;
  readonly usage: UsageUpdate[];
  readonly stream: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
  readonly onClose?: () => void;
}): Promise<HostedGateway> {
  const database = openDatabase({
    path: ":memory:",
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore());
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
  const backend = new ScriptedCopilotBackend({
    responsesStream: (request) => options.stream(request.signal),
  });
  const runtime = defaultRuntimeConfigSnapshot();
  runtime.timeouts.totalMs = options.totalMs;
  runtime.timeouts.firstByteMs = 1_000;
  const port = await availablePort();
  const gateway = await createGateway({
    startup: parseStartupConfig(["--port", String(port)], {}, { homedir: "Q:\\ghc-gateway-loopback" }),
    runtime,
  }, [createResponsesRoute({
    directory: accounts,
    catalog,
    preferences: accounts.preferences,
    copilot: backend,
    history: EMPTY_HISTORY,
    usageRecorder: { recordUsage: (update) => options.usage.push(update) },
  })], {
    ...(options.onClose === undefined
      ? { onClose: () => closeDatabase(database) }
      : {
        onClose: () => {
          options.onClose?.();
          closeDatabase(database);
        },
      }),
  });
  return gateway;
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

function stalledBytes(signal: AbortSignal): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: async () => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
          return { done: true, value: undefined };
        },
      };
    },
  };
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
