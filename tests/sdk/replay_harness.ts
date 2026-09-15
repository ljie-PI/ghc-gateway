import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { EndpointDiscovery } from "../../src/copilot/endpoint_discovery.js";
import { HttpCopilotBackend } from "../../src/copilot/transport.js";
import { HttpCopilotModelsSource } from "../../src/copilot/models_source.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { bootstrapGateway } from "../../src/main.js";
import { MockCopilotReplayServer, parseReplayManifestText, type ReplayReceipt } from "../support/replay/server.js";
import type { SdkProtocol } from "./client.js";
import type { ReplayScenarioManifest } from "../support/replay/types.js";
import { createReplayScenarios } from "./replay_scenarios.js";
import { startCopilotHttpMock, type CopilotHttpMock, type HttpRequestObservation } from "../../scripts/tooling/test_support/copilot_http.js";
import { syntheticSdkFixtureCatalog } from "./synthetic_scenarios.js";
export { CHAT_MODEL, NATIVE_RESPONSES_MODEL, MESSAGES_MODEL } from "./replay_models.js";

export const SDK_TEST_GUARD = "GHC_GATEWAY_SDK_TESTS";
export const REPLAY_SERVER_PORT = 31488;

const nativeFetch = globalThis.fetch;
const nowMs = (): number => 1_700_000_000_000;

export interface ReplaySdkHarness {
  readonly baseUrl: string;
  readonly openAiBaseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly replayServer: MockCopilotReplayServer;
  /** Immutable response corpus; scenario ownership lives only in replay_scenarios.ts. */
  readonly corpus: ReplayScenarioManifest;
  readonly receipts: readonly ReplayReceipt[];
  close(): Promise<void>;
}

export function assertOfflineSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[SDK_TEST_GUARD] !== "1") {
    throw new Error(`${SDK_TEST_GUARD}=1 is required for manual offline SDK tests`);
  }
}

export async function startReplaySdkHarness(options: {
  readonly manifestPath?: string;
  readonly reasoningDownstream?: SdkProtocol;
  readonly toolDownstream?: SdkProtocol;
} = {}): Promise<ReplaySdkHarness> {
  assertOfflineSdkTestsEnabled();

  const manifestPath = options.manifestPath ?? path.resolve("tests/sdk/corpus/manifest.json");
  const corpusDir = path.dirname(manifestPath);
  const manifestRaw = await readFile(manifestPath, "utf8");
  const corpus = parseReplayManifestText(manifestRaw);
  const scenarios = await createReplayScenarios(corpus, options);

  const replayServer = new MockCopilotReplayServer({
    port: REPLAY_SERVER_PORT,
    corpusDir,
    exchanges: corpus.exchanges,
    scenarios,
  });
  await replayServer.start();

  try {
    const gateway = await startHttpSdkGateway(`http://127.0.0.1:${REPLAY_SERVER_PORT}`, "req_sdk_replay");
    return {
      ...gateway, replayServer, corpus,
      get receipts() { return replayServer.recordedReceipts; },
      async close() {
        try { await gateway.close(); } finally { await replayServer.stop(); }
      },
    };
  } catch (error: unknown) {
    await replayServer.stop();
    throw error;
  }
}

export interface SyntheticSdkHarness extends HttpSdkGateway {
  readonly upstream: CopilotHttpMock;
  requests(path: string): readonly HttpRequestObservation[];
}

export async function startSyntheticSdkHarness(): Promise<SyntheticSdkHarness> {
  assertOfflineSdkTestsEnabled();
  const upstream = await startCopilotHttpMock({ expectations: syntheticSdkFixtureCatalog() });
  try {
    const gateway = await startHttpSdkGateway(upstream.origin, "req_sdk_loopback");
    return {
      ...gateway, upstream,
      requests: (path) => upstream.requests.filter((request) => request.path === path),
      async close() {
        try { await gateway.close(); }
        finally { await upstream.stop(); }
        upstream.assertHealthy();
        if (upstream.requests.filter((request) => request.method === "GET" && request.path === "/models").length !== 1) {
          throw new Error("synthetic SDK expected exactly one catalog discovery");
        }
      },
    };
  } catch (error: unknown) {
    await upstream.stop();
    throw error;
  }
}

export function decodeCapturedBody(request: HttpRequestObservation): unknown {
  return JSON.parse(new TextDecoder().decode(request.body)) as unknown;
}

export async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for SDK HTTP cleanup");
}

type HttpSdkGateway = Awaited<ReturnType<typeof startHttpSdkGateway>>;

/** One production application composer for both immutable recordings and synthetic HTTP cases. */
async function startHttpSdkGateway(origin: string, requestId: string) {
  const port = await reserveLoopbackPort();
  const artifactRoot = path.resolve("artifacts", "test-data");
  await mkdir(artifactRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(artifactRoot, "ghc-gateway-replay-sdk-"));
  const disposers: (() => Promise<unknown>)[] = [];
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      // Continue cleanup after a failing disposer; never retain the SQLite handle or directory.
      let failed = false;
      for (const close of disposers.reverse()) {
        try { await close(); } catch { failed = true; }
      }
      if (failed) throw new Error("SDK application cleanup failed");
    })();
    return disposePromise;
  };
  let gateway: Awaited<ReturnType<typeof bootstrapGateway>> | undefined;
  try {
    const database = openDatabase({
      path: path.join(dataDir, "state.db"),
      migrations: [
        embedMigration(runtimeConfigMigration), embedMigration(accountsMigration),
        embedMigration(responsesHistoryMigration), embedMigration(responsesContinuationMigration),
      ], nowMs,
    });
    let databaseClosed = false;
    const closeState = (): void => {
      if (!databaseClosed) { databaseClosed = true; closeDatabase(database); }
    };
    disposers.push(async () => closeState());
    const credentials = new MemoryCredentialStore();
    const accountCoordinator = new AccountCoordinator();
    const directory = new AccountDirectory(database, credentials, accountCoordinator, nowMs);
    await directory.upsertAuthenticated({
      host: "github.com", userId: "1", secret: { generation: 0, githubToken: "sdk-replay-token" },
    });
    const endpointDiscovery = new EndpointDiscovery(async () => origin);
    disposers.push(async () => endpointDiscovery.close());
    const modelsSource = new HttpCopilotModelsSource(async () => ({ token: "dummy-token", endpoint: origin }));
    disposers.push(async () => modelsSource.close());
    const copilot = new HttpCopilotBackend({
      credentials, accountCoordinator, nowMs, endpointDiscovery,
      refreshCopilotToken: async () => ({ token: "dummy-token", expiresAtMs: nowMs() + 3_600_000 }),
    });
    disposers.push(async () => copilot.close());
    const catalog = new CopilotModelCatalog(modelsSource, () => new Date(nowMs()));
    const registry = new ModelCapabilityRegistry(catalog, { get: () => null });
    disposers.push(async () => registry.close());
    const history = new SqliteResponsesHistory(database, { nowMs });
    gateway = await bootstrapGateway({
      startup: { host: "127.0.0.1", port, dataDir, logLevel: "error" },
      application: {
        database, credentials, accountCoordinator, directory, registry, copilot, history, modelsSource,
        close: dispose,
        forceClose: () => {
          copilot.forceClose(); modelsSource.forceClose(); endpointDiscovery.forceClose(); closeState();
        },
      },
      dependencies: { createRequestId: () => requestId },
    });
    await gateway.listen();
    const runningGateway = gateway;
    const baseUrl = `http://127.0.0.1:${port}`;
    return {
      baseUrl, openAiBaseUrl: `${baseUrl}/v1`, fetch: loopbackOnlyFetch(baseUrl), transport: copilot,
      async close() {
        try { await runningGateway.close(); }
        finally { try { await dispose(); } finally { await rm(dataDir, { recursive: true, force: true }); } }
      },
    };
  } catch (error: unknown) {
    try { await gateway?.close(); }
    finally { try { await dispose(); } finally { await rm(dataDir, { recursive: true, force: true }); } }
    throw error;
  }
}

function loopbackOnlyFetch(origin: string): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin || url.hostname !== "127.0.0.1") {
      throw new Error("offline SDK tests blocked a non-loopback request");
    }
    return await nativeFetch(input, init);
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve SDK loopback port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}
