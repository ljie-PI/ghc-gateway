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
import { MockCopilotReplayServer, parseReplayManifestText, type ReplayReceipt } from "../../src/replay/server.js";
import type { ReplayScenarioManifest } from "../../src/replay/types.js";
import { createReplayScenarios } from "./replay_scenarios.js";

export const SDK_TEST_GUARD = "GHC_GATEWAY_SDK_TESTS";
export const REPLAY_SERVER_PORT = 31488;
export const CHAT_MODEL = "gemini-3.5-flash";
export const NATIVE_RESPONSES_MODEL = "gpt-5.5";
export const MESSAGES_MODEL = "claude-sonnet-4";

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
} = {}): Promise<ReplaySdkHarness> {
  assertOfflineSdkTestsEnabled();

  const manifestPath = options.manifestPath ?? path.resolve("tests/sdk/corpus/manifest.json");
  const corpusDir = path.dirname(manifestPath);
  const manifestRaw = await readFile(manifestPath, "utf8");
  const corpus = parseReplayManifestText(manifestRaw);
  const scenarios = await createReplayScenarios(corpus);

  const replayServer = new MockCopilotReplayServer({
    port: REPLAY_SERVER_PORT,
    corpusDir,
    exchanges: corpus.exchanges,
    scenarios,
  });
  await replayServer.start();

  const artifactRoot = path.resolve("artifacts", "test-data");
  await mkdir(artifactRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(artifactRoot, "ghc-gateway-replay-sdk-"));
  const port = await reserveLoopbackPort();

  const database = openDatabase({
    path: path.join(dataDir, "state.db"),
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(responsesHistoryMigration),
      embedMigration(responsesContinuationMigration),
    ],
    nowMs,
  });

  const credentials = new MemoryCredentialStore();
  const accountCoordinator = new AccountCoordinator();
  const directory = new AccountDirectory(database, credentials, accountCoordinator, nowMs);
  await directory.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "sdk-replay-token" },
  });

  const replayEndpoint = `http://127.0.0.1:${REPLAY_SERVER_PORT}`;
  const modelsSource = new HttpCopilotModelsSource(
    async () => ({ token: "dummy-token", endpoint: replayEndpoint }),
    fetch,
  );
  const catalog = new CopilotModelCatalog(modelsSource, () => new Date(nowMs()));
  const history = new SqliteResponsesHistory(database, { nowMs });
  const registry = new ModelCapabilityRegistry(catalog, { get: () => null });

  const endpointDiscovery = new EndpointDiscovery(async () => replayEndpoint);
  const copilot = new HttpCopilotBackend({
    credentials,
    accountCoordinator,
    refreshCopilotToken: async () => ({ token: "dummy-token", expiresAtMs: nowMs() + 3_600_000 }),
    endpointDiscovery,
    fetchImpl: fetch,
  });

  let databaseClosed = false;
  const closeState = (): void => {
    if (!databaseClosed) {
      databaseClosed = true;
      closeDatabase(database);
    }
  };

  const gateway = await bootstrapGateway({
    startup: { host: "127.0.0.1", port, dataDir, logLevel: "error" },
    application: {
      database,
      credentials,
      accountCoordinator,
      directory,
      registry,
      copilot,
      history,
      modelsSource,
      async close() {
        await registry.close();
        await copilot.close();
        await modelsSource.close();
        await endpointDiscovery.close();
        closeState();
      },
      forceClose: () => {
        copilot.forceClose();
        modelsSource.forceClose();
        endpointDiscovery.forceClose();
        closeState();
      },
    },
    dependencies: { createRequestId: () => "req_sdk_replay" },
  });

  try {
    await gateway.listen();
  } catch (error: unknown) {
    await gateway.close().catch(() => undefined);
    await replayServer.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    openAiBaseUrl: `${baseUrl}/v1`,
    fetch: loopbackOnlyFetch(baseUrl),
    replayServer,
    corpus,
    get receipts() {
      return replayServer.recordedReceipts;
    },
    async close() {
      await gateway.close();
      await replayServer.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
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
