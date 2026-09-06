import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import {
  MAX_MODEL_CAPABILITY_OVERRIDES_PER_ACCOUNT,
  ModelCapabilityOverrideError,
  SqliteModelCapabilityOverrides,
} from "../../src/copilot/capability_overrides.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import {
  chooseOutputTokenBudget,
  parseLiveModelCapabilities,
  type BuiltinModelCapabilityLookup,
} from "../../src/copilot/model_capabilities.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { applyMigrations, embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as modelCapabilitiesMigration } from "../../src/persistence/migrations/040_model_capabilities.js";
import { SqliteDatabase } from "../../src/persistence/sqlite.js";

const signal = new AbortController().signal;

describe("model capability registry", () => {
  it("normalizes explicit HTTP aliases, excludes ws, and preserves missing, empty, and malformed", async () => {
    const harness = await createHarness({
      "github.com/1": [
        model("dual", { supported_endpoints: ["/chat/completions", "/v1/responses", "/responses"] }),
        model("non-gpt-responses", { supported_endpoints: ["/responses"] }),
        model("messages", { supported_endpoints: ["/v1/messages"] }),
        model("ws-only", { supported_endpoints: ["ws:/responses", "wss://example.test/responses"] }),
        model("empty", { supported_endpoints: [] }),
        model("missing", { mode: "chat" }),
        model("malformed", { supported_endpoints: ["/responses", 42] }),
      ],
    });
    const snapshot = await harness.registry.get(harness.account1, signal);
    expect(capability(snapshot, "dual").protocols.value).toEqual(["chat", "responses"]);
    expect(capability(snapshot, "non-gpt-responses").protocols.value).toEqual(["responses"]);
    expect(capability(snapshot, "messages").protocols.value).toEqual(["messages"]);
    expect(capability(snapshot, "ws-only").protocols.value).toEqual([]);
    expect(capability(snapshot, "empty").protocols).toMatchObject({ value: [], source: "live", liveState: "value" });
    expect(capability(snapshot, "missing").protocols).toMatchObject({ value: null, source: "unknown", liveState: "missing" });
    expect(capability(snapshot, "malformed").protocols).toMatchObject({ value: null, source: "unknown", liveState: "malformed" });
  });

  it("applies field precedence without unioning conflicts or replacing explicit empty values", async () => {
    const builtins: BuiltinModelCapabilityLookup = {
      get(modelId) {
        if (modelId !== "conflict" && modelId !== "missing") return null;
        return {
          revision: "builtin-test",
          capabilities: parseLiveModelCapabilities({
            model_info: {
              supported_endpoints: ["/v1/chat/completions"],
              max_output_tokens: 16_000,
              default_output_tokens: 8_000,
              chat_output_token_field: "max_tokens",
            },
          }),
        };
      },
    };
    const harness = await createHarness({
      "github.com/1": [
        model("conflict", { supported_endpoints: ["/v1/responses"], max_output_tokens: 12_000 }),
        model("missing", {}),
        model("empty", { supported_endpoints: [] }),
      ],
    }, builtins);
    harness.overrides.set("github.com/1", "conflict", {
      enabled: true,
      protocols: ["messages"],
      defaultOutputTokens: 6_000,
      chatOutputTokenField: "max_completion_tokens",
    }, 0);
    const snapshot = await harness.registry.get(harness.account1, signal);
    expect(capability(snapshot, "conflict")).toMatchObject({
      protocols: { value: ["messages"], source: "admin_override", conflict: true },
      maxOutputTokens: { value: 12_000, source: "live", conflict: true },
      defaultOutputTokens: {
        configuration: { value: 6_000, source: "admin_override", conflict: true },
        effective: 6_000,
        source: "admin_override",
      },
      profile: { chatOutputTokenField: { value: "max_completion_tokens", source: "admin_override", conflict: true } },
    });
    expect(capability(snapshot, "missing")).toMatchObject({
      protocols: { value: ["chat"], source: "builtin" },
      maxOutputTokens: { value: 16_000, source: "builtin" },
      defaultOutputTokens: { effective: 8_000, source: "builtin" },
    });
    expect(capability(snapshot, "empty").protocols).toMatchObject({ value: [], source: "live" });
  });

  it("isolates same model IDs by account and exposes configured-only models only when explicitly enabled", async () => {
    const harness = await createHarness({
      "github.com/1": [model("same", { supported_endpoints: ["/chat/completions"] })],
      "github.com/2": [model("same", { supported_endpoints: ["/responses"] })],
    });
    harness.overrides.set("github.com/1", "manual", {
      enabled: true,
      protocols: ["messages"],
      defaultOutputTokens: 2048,
    }, 0);
    harness.overrides.set("github.com/2", "manual", {
      enabled: false,
      protocols: ["chat"],
    }, 0);
    const [one, two] = await Promise.all([
      harness.registry.get(harness.account1, signal),
      harness.registry.get(harness.account2, signal),
    ]);
    expect(capability(one, "same").protocols.value).toEqual(["chat"]);
    expect(capability(two, "same").protocols.value).toEqual(["responses"]);
    expect(capability(one, "manual")).toMatchObject({
      discovered: false, configured: true, verified: false, visible: true,
      protocols: { value: ["messages"], source: "admin_override" },
    });
    expect(capability(two, "manual")).toMatchObject({
      discovered: false, configured: true, verified: false, visible: false,
    });
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(capability(one, "manual").protocols.value)).toBe(true);
  });

  it("does not cache stale refreshes and shares one generation without caller-abort poisoning", async () => {
    let releaseFirst = (): void => undefined;
    let fetches = 0;
    const catalog = new CopilotModelCatalog({
      async fetch() {
        fetches += 1;
        if (fetches === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { data: [model(`generation-${fetches}`, { supported_endpoints: ["/responses"] })] };
      },
    });
    const database = databaseWithCapabilities();
    const overrides = new SqliteModelCapabilityOverrides(database);
    const registry = new ModelCapabilityRegistry(catalog, overrides, { get: () => null });
    const account = await createAccount(database, "1");
    const firstAbort = new AbortController();
    const first = registry.get(account, firstAbort.signal);
    const companion = registry.get(account, signal);
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const laterWaiter = registry.get(account, signal);
    expect(fetches).toBe(1);
    releaseFirst();
    await expect(Promise.all([companion, laterWaiter])).resolves.toEqual([
      expect.objectContaining({ models: [expect.objectContaining({ modelId: "generation-1" })] }),
      expect.objectContaining({ models: [expect.objectContaining({ modelId: "generation-1" })] }),
    ]);
    expect(fetches).toBe(1);

    let releaseStale = (): void => undefined;
    const staleCatalog = new CopilotModelCatalog({
      async fetch() {
        await new Promise<void>((resolve) => { releaseStale = resolve; });
        return { data: [model("stale", { supported_endpoints: ["/chat/completions"] })] };
      },
    });
    const staleRegistry = new ModelCapabilityRegistry(staleCatalog, overrides, { get: () => null });
    const pending = staleRegistry.get(account, signal);
    staleRegistry.invalidate(account.accountId);
    releaseStale();
    await pending;
    const fresh = staleRegistry.get(account, signal);
    releaseStale();
    await fresh;
    expect(fetches).toBe(1);
  });

  it("persists monotonic override revisions, reset tombstones, validation, and bounded capacity", async () => {
    const database = databaseWithCapabilities();
    await createAccount(database, "1");
    const firstStore = new SqliteModelCapabilityOverrides(database, () => 100);
    const set = firstStore.set("github.com/1", "manual", {
      enabled: true,
      protocols: ["messages"],
      maxOutputTokens: 4096,
      defaultOutputTokens: 2048,
    }, 0);
    expect(set.revision).toBe(1);
    const restarted = new SqliteModelCapabilityOverrides(database, () => 200);
    expect(restarted.get("github.com/1", "manual")).toEqual(set);
    expect(() => restarted.set("github.com/1", "manual", { enabled: true }, 0))
      .toThrow(ModelCapabilityOverrideError);
    const reset = restarted.reset("github.com/1", "manual", 1);
    expect(reset).toMatchObject({ revision: 2, value: null });
    expect(restarted.set("github.com/1", "manual", { enabled: true, protocols: [] }, 2).revision).toBe(3);
    expect(() => restarted.set("github.com/1", "bad model", { enabled: true }, 0))
      .toThrow(ModelCapabilityOverrideError);
    expect(() => restarted.set("github.com/1", "bad-default", {
      enabled: true, maxOutputTokens: 10, defaultOutputTokens: 11,
    }, 0)).toThrow(ModelCapabilityOverrideError);

    restarted.reset("github.com/1", "manual", 3);
    for (let index = 0; index < MAX_MODEL_CAPABILITY_OVERRIDES_PER_ACCOUNT; index += 1) {
      restarted.set("github.com/1", `configured-${index}`, { enabled: true }, 0);
    }
    expect(() => restarted.set("github.com/1", "overflow", { enabled: true }, 0))
      .toThrow(ModelCapabilityOverrideError);
  });

  it("clears account-scoped overrides when account removal starts", async () => {
    const database = databaseWithCapabilities();
    const overrides = new SqliteModelCapabilityOverrides(database);
    const directory = new AccountDirectory(
      database,
      new MemoryCredentialStore(),
      () => 1_700_000_000_000,
      8,
      (accountId) => overrides.clearAccount(accountId),
    );
    const account = await directory.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "token" },
    });
    overrides.set(account.accountId, "manual", { enabled: true, protocols: ["messages"] }, 0);
    const revision = directory.list().find((item) => item.accountId === account.accountId)?.revision;
    if (revision === undefined) throw new Error("missing account revision");
    await directory.remove(account.accountId, revision);
    expect(overrides.list(account.accountId)).toEqual([]);
  });

  it("uses explicit valid output budgets, configured defaults, known ceilings, and unknown fallback", () => {
    const unknownConfiguration = {
      value: null, source: "unknown" as const, conflict: false, liveState: "missing" as const,
    };
    expect(chooseOutputTokenBudget(1234, {
      configuration: unknownConfiguration, effective: 4096, source: "unknown_fallback", valid: true,
    })).toBe(1234);
    expect(chooseOutputTokenBudget(undefined, {
      configuration: unknownConfiguration, effective: 8192, source: "known_ceiling", valid: true,
    })).toBe(8192);
    expect(chooseOutputTokenBudget(undefined, {
      configuration: unknownConfiguration, effective: 4096, source: "unknown_fallback", valid: true,
    })).toBe(4096);
    expect(() => chooseOutputTokenBudget(0, {
      configuration: unknownConfiguration, effective: 4096, source: "unknown_fallback", valid: true,
    })).toThrow(TypeError);
  });

  it("marks a persisted default invalid when a refreshed ceiling becomes smaller", async () => {
    let ceiling = 10_000;
    const database = databaseWithCapabilities();
    const account = await createAccount(database, "1");
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return {
          data: [model("changing", {
            supported_endpoints: ["/messages"],
            max_output_tokens: ceiling,
          })],
        };
      },
    });
    const overrides = new SqliteModelCapabilityOverrides(database);
    overrides.set(account.accountId, "changing", {
      enabled: true,
      defaultOutputTokens: 8_000,
    }, 0);
    const registry = new ModelCapabilityRegistry(catalog, overrides, { get: () => null });
    expect(capability(await registry.get(account, signal), "changing").defaultOutputTokens.valid).toBe(true);
    ceiling = 4_000;
    registry.invalidate(account.accountId);
    const refreshed = capability(await registry.get(account, signal), "changing").defaultOutputTokens;
    expect(refreshed).toMatchObject({ effective: 8_000, valid: false });
    expect(() => chooseOutputTokenBudget(undefined, refreshed)).toThrow(TypeError);
  });
});

async function createHarness(
  data: Readonly<Record<string, readonly unknown[]>>,
  builtins: BuiltinModelCapabilityLookup = { get: () => null },
) {
  const database = databaseWithCapabilities();
  const account1 = await createAccount(database, "1");
  const account2 = await createAccount(database, "2");
  const catalog = new CopilotModelCatalog({
    async fetch(accountId) {
      return { data: data[accountId] ?? [] };
    },
  });
  const overrides = new SqliteModelCapabilityOverrides(database);
  return {
    database,
    account1,
    account2,
    overrides,
    registry: new ModelCapabilityRegistry(catalog, overrides, builtins),
  };
}

async function createAccount(database: SqliteDatabase, userId: string) {
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), () => 1_700_000_000_000);
  return await directory.upsertAuthenticated({
    host: "github.com",
    userId,
    secret: { generation: 0, githubToken: `token-${userId}` },
  });
}

function databaseWithCapabilities(): SqliteDatabase {
  const database = new SqliteDatabase(":memory:");
  applyMigrations(database, [
    embedMigration(runtimeConfigMigration),
    embedMigration(accountsMigration),
    embedMigration(modelCapabilitiesMigration),
  ], () => 1_700_000_000_000);
  return database;
}

function model(id: string, modelInfo: Readonly<Record<string, unknown>>) {
  return {
    id,
    name: id,
    vendor: "test",
    model_picker_enabled: true,
    model_info: modelInfo,
  };
}

function capability(
  snapshot: Awaited<ReturnType<ModelCapabilityRegistry["get"]>>,
  modelId: string,
) {
  const result = snapshot.models.find((item) => item.modelId === modelId);
  if (result === undefined) throw new Error(`missing capability ${modelId}`);
  return result;
}
