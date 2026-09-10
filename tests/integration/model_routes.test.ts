import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { capabilitySnapshotFromCatalog } from "../../src/copilot/capability_registry.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { parseLiveModelCapabilities } from "../../src/copilot/model_capabilities.js";
import { TokenRefreshError } from "../../src/copilot/token_refresh.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { PreferredModelManager } from "../../src/protocols/model_catalog/preferred.js";
import { createModelCatalogRoutes } from "../../src/protocols/model_catalog/routes.js";

const nowMs = (): number => 1_700_000_000_000;

describe("model routes errors and preferences", () => {
  it("returns 401 without an account and invalidates missing preferences", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return { data: [{ id: "visible", name: "V", vendor: "x", model_picker_enabled: true }] };
      },
    });
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      catalog,
      preferences: accounts.preferences,
    }));
    try {
      const missing = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(missing.status).toBe(401);
      const account = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "t" },
      });
      const ok = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(ok.status).toBe(200);
      const snapshot = await catalog.get("github.com/1", new AbortController().signal);
      const manager = new PreferredModelManager(accounts.preferences);
      manager.setPreferred("github.com/1", "visible", 0, capabilitySnapshotFromCatalog(account, snapshot));
      catalog.invalidate("github.com/1");
      const empty = new CopilotModelCatalog({
        async fetch() {
          return { data: [] };
        },
      });
      await empty.get("github.com/1", new AbortController().signal);
      accounts.preferences.markInvalidIfMissing("github.com/1", new Set(), 2);
      expect(accounts.preferences.get("github.com/1")?.validity).toBe("invalid");
    } finally {
      await gw.close();
      closeDatabase(database);
    }
  });

  it("exposes Retry-After only for valid final CAPI 429 values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    let retryAfter: string | undefined = "120";
    const catalog = new CopilotModelCatalog({
      async fetch() {
        throw new CapiFetchError(429, retryAfter);
      },
    });
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      catalog,
      preferences: accounts.preferences,
    }));
    try {
      const valid = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(valid.status).toBe(429);
      expect(valid.headers.get("retry-after")).toBe("120");

      retryAfter = undefined;
      catalog.invalidate("github.com/1");
      const invalid = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(invalid.status).toBe(429);
      expect(invalid.headers.get("retry-after")).toBeNull();
    } finally {
      await gw.close();
      closeDatabase(database);
    }
  });

  it("lists only discovered models without importing builtin names", async () => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [
        embedMigration(runtimeConfigMigration),
        embedMigration(accountsMigration),
      ],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    const account = await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return { data: [{
          id: "discovered",
          name: "Discovered",
          vendor: "test",
          model_picker_enabled: true,
          model_info: { supported_endpoints: ["/chat/completions"] },
        }] };
      },
    });
    const registry = new ModelCapabilityRegistry(catalog, {
      get(modelId) {
        return modelId === "builtin-only"
          ? {
            revision: "test",
            capabilities: parseLiveModelCapabilities({
              model_info: { supported_endpoints: ["/chat/completions"] },
            }),
          }
          : null;
      },
    });
    const gateway = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:/discovered-models" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
    }));
    try {
      const response = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      const body = await response.json() as {
        data: Array<{ id: string }>;
      };
      expect(body.data.map((item) => item.id)).toEqual(["discovered"]);
      const anthropic = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/models", {
        headers: { "anthropic-version": "2023-06-01" },
      }));
      expect((await anthropic.json() as { data: Array<{ id: string }> }).data.map((item) => item.id))
        .toEqual(["discovered"]);
      const snapshot = await registry.get(account, new AbortController().signal);
      const preferences = new PreferredModelManager(accounts.preferences);
      expect(() => preferences.setPreferred(account.accountId, "builtin-only", 0, snapshot))
        .toThrow("model not in catalog");
      preferences.setPreferred(account.accountId, "discovered", 0, snapshot);
      expect(accounts.preferences.get(account.accountId)?.validity).toBe("valid");
    } finally {
      await gateway.close();
      closeDatabase(database);
    }
  });

  it("does not let a stale public listing invalidate a newer preferred model", async () => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [
        embedMigration(runtimeConfigMigration),
        embedMigration(accountsMigration),
      ],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    const account = await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    let release = (): void => undefined;
    let started = (): void => undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return { data: [{
          id: "old",
          name: "Old",
          vendor: "test",
          model_picker_enabled: true,
          model_info: { supported_endpoints: ["/chat/completions"] },
        }] };
      },
    });
    const registry = new ModelCapabilityRegistry(catalog, { get: () => null });
    const gateway = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:/stale-models" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
    }));
    try {
      const listing = gateway.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      await startedPromise;
      accounts.preferences.set(account.accountId, { modelId: "new", catalogGeneration: 1 }, 0);
      release();
      expect((await listing).status).toBe(200);
      expect(accounts.preferences.get(account.accountId)).toMatchObject({
        modelId: "new",
        validity: "valid",
      });
    } finally {
      await gateway.close();
      closeDatabase(database);
    }
  });

  it("does not reconcile preference validity from a superseded catalog generation", async () => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [
        embedMigration(runtimeConfigMigration),
        embedMigration(accountsMigration),
      ],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    const account = await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    accounts.preferences.set(account.accountId, { modelId: "keep", catalogGeneration: 0 }, 0);
    let fetches = 0;
    let releaseOld = (): void => undefined;
    let oldStarted = (): void => undefined;
    const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        fetches += 1;
        if (fetches === 1) {
          oldStarted();
          await new Promise<void>((resolve) => { releaseOld = resolve; });
          return { data: [] };
        }
        return { data: [{
          id: "keep",
          name: "Keep",
          vendor: "test",
          model_picker_enabled: true,
          model_info: { supported_endpoints: ["/chat/completions"] },
        }] };
      },
    });
    const registry = new ModelCapabilityRegistry(
      catalog,
      { get: () => null },
    );
    const gateway = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:/superseded-models" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
    }));
    try {
      const staleListing = gateway.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      await oldStartedPromise;
      registry.invalidate(account.accountId);
      await registry.get(account, new AbortController().signal);
      releaseOld();
      expect((await staleListing).status).toBe(200);
      expect(accounts.preferences.get(account.accountId)?.validity).toBe("valid");
    } finally {
      await gateway.close();
      closeDatabase(database);
    }
  });

  it("normalizes model-list credential and timeout failures in both protocol shapes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    let error: unknown = new CapiFetchError(502, undefined, "upstream_timeout");
    const catalog = new CopilotModelCatalog({
      async fetch() {
        throw error;
      },
    });
    const gateway = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      catalog,
      preferences: accounts.preferences,
    }), { createRequestId: () => "req_models" });
    try {
      const openai = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(openai.status).toBe(504);
      expect(openai.headers.get("x-request-id")).toBe("req_models");
      expect(JSON.parse(await openai.text())).toMatchObject({
        error: { type: "api_error", code: "504" },
      });

      catalog.invalidate("github.com/1");
      const anthropic = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/models", {
        headers: { "anthropic-version": "2023-06-01" },
      }));
      expect(anthropic.status).toBe(504);
      expect(anthropic.headers.get("request-id")).toBe("req_models");
      expect(JSON.parse(await anthropic.text())).toMatchObject({
        type: "error",
        error: { type: "timeout_error", message: "upstream timeout" },
        request_id: "req_models",
      });

      error = new TokenRefreshError("missing", "secret-token https://unsafe.example/private");
      catalog.invalidate("github.com/1");
      const authentication = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(authentication.status).toBe(401);
      expect(await authentication.text()).not.toContain("secret-token");
    } finally {
      await gateway.close();
      closeDatabase(database);
    }
  });
});
