import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
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
import { SqliteDatabase } from "../../src/persistence/sqlite.js";

const signal = new AbortController().signal;
const databases: SqliteDatabase[] = [];
const registries: ModelCapabilityRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  for (const database of databases.splice(0)) database.close();
});

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
        {
          id: "production-shape",
          name: "Production",
          vendor: "test",
          model_picker_enabled: true,
          supported_endpoints: ["/responses", "/chat/completions"],
          supported_parameters: ["top_p", "temperature", "response_format"],
          supported_reasoning_efforts: ["high", "low"],
          capabilities: {
            limits: {
              max_prompt_tokens: 200_000,
              max_output_tokens: 32_000,
            },
          },
        },
        {
          id: "live-conflict",
          name: "Conflict",
          vendor: "test",
          model_picker_enabled: true,
          supported_endpoints: ["/responses"],
          model_info: { supported_endpoints: ["/chat/completions"] },
        },
        {
          id: "equivalent-order",
          name: "Equivalent",
          vendor: "test",
          model_picker_enabled: true,
          supported_endpoints: ["/responses", "/chat/completions"],
          model_info: { supported_endpoints: ["/v1/chat/completions", "/v1/responses"] },
        },
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
    expect(capability(snapshot, "production-shape")).toMatchObject({
      protocols: { value: ["chat", "responses"], source: "live" },
      maxInputTokens: { value: 200_000, source: "live" },
      maxOutputTokens: { value: 32_000, source: "live" },
      profile: {
        supportedParameters: {
          value: ["response_format", "temperature", "top_p"],
          source: "live",
        },
        reasoningEfforts: {
          value: ["high", "low"],
          source: "live",
        },
      },
    });
    expect(capability(snapshot, "live-conflict").protocols).toMatchObject({
      value: null,
      source: "unknown",
      liveState: "malformed",
    });
    expect(capability(snapshot, "equivalent-order").protocols.value).toEqual(["chat", "responses"]);
  });

  it("applies field precedence without unioning conflicts or replacing explicit empty values", async () => {
    const builtins: BuiltinModelCapabilityLookup = {
      get() {
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
        model("malformed", { supported_endpoints: null, max_output_tokens: null }),
      ],
    }, builtins);
    const snapshot = await harness.registry.get(harness.account1, signal);
    expect(capability(snapshot, "conflict")).toMatchObject({
      protocols: { value: ["responses"], source: "live", conflict: true },
      maxOutputTokens: { value: 12_000, source: "live", conflict: true },
      defaultOutputTokens: {
        configuration: { value: 8_000, source: "builtin", conflict: false },
        effective: 8_000,
        source: "builtin",
      },
      profile: { chatOutputTokenField: { value: "max_tokens", source: "builtin", conflict: false } },
    });
    expect(capability(snapshot, "missing")).toMatchObject({
      protocols: { value: ["chat"], source: "builtin" },
      maxOutputTokens: { value: 16_000, source: "builtin" },
      defaultOutputTokens: { effective: 8_000, source: "builtin" },
    });
    expect(capability(snapshot, "empty").protocols).toMatchObject({ value: [], source: "live", conflict: true });
    expect(capability(snapshot, "malformed")).toMatchObject({
      protocols: { value: null, source: "unknown", liveState: "malformed" },
      maxOutputTokens: { value: null, source: "unknown", liveState: "malformed" },
    });
    expect(snapshot.models.map((item) => item.modelId)).toEqual(["conflict", "missing", "empty", "malformed"]);
  });

  it("preserves input precedence, malformed declarations, and account-scoped catalogs independently of output", async () => {
    const builtins: BuiltinModelCapabilityLookup = {
      get: () => ({
        revision: "input-limits-test",
        capabilities: parseLiveModelCapabilities({
          max_input_tokens: 64_000,
          max_output_tokens: 4096,
          default_output_tokens: 2048,
          supported_endpoints: ["/chat/completions"],
        }),
      }),
    };
    const inputModel = (id: string, limits: Readonly<Record<string, unknown>>) => ({
      ...model(id, {
        supported_endpoints: ["/responses"],
        max_output_tokens: 16_000,
        default_output_tokens: 8000,
      }),
      capabilities: { limits },
    });
    const harness = await createHarness({
      "github.com/1": [
        inputModel("explicit", { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 }),
        inputModel("context-only", { max_context_window_tokens: 144_000 }),
        inputModel("missing", {}),
        inputModel("malformed", { max_prompt_tokens: null, max_context_window_tokens: 144_000 }),
        inputModel("malformed-context", { max_context_window_tokens: null }),
        { ...inputModel("conflicting", { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 }), max_input_tokens: 32_000 },
      ],
      "github.com/2": [inputModel("explicit", { max_prompt_tokens: 32_000, max_context_window_tokens: 144_000 })],
    }, builtins);
    const initial = await harness.registry.get(harness.account1, signal);
    expect(initial.models.map(({ modelId, maxInputTokens }) => ({ modelId, ...maxInputTokens }))).toEqual([
      { modelId: "explicit", value: 128_000, source: "live", conflict: true, liveState: "value" },
      { modelId: "context-only", value: 144_000, source: "live", conflict: true, liveState: "value" },
      { modelId: "missing", value: 64_000, source: "builtin", conflict: false, liveState: "missing" },
      { modelId: "malformed", value: null, source: "unknown", conflict: false, liveState: "malformed" },
      { modelId: "malformed-context", value: null, source: "unknown", conflict: false, liveState: "malformed" },
      { modelId: "conflicting", value: null, source: "unknown", conflict: false, liveState: "malformed" },
    ]);
    for (const item of initial.models) {
      expect(item).toMatchObject({
        protocols: { value: ["responses"], source: "live", conflict: true },
        maxOutputTokens: { value: 16_000, source: "live", conflict: true },
        defaultOutputTokens: { effective: 8000, source: "live", valid: true },
      });
    }
    expect(capability(initial, "explicit").maxInputTokens.value).toBe(128_000);
    expect(Object.isFrozen(capability(initial, "explicit").maxInputTokens)).toBe(true);
    const otherAccount = await harness.registry.get(harness.account2, signal);
    expect(capability(otherAccount, "explicit").maxInputTokens).toEqual({
      value: 32_000, source: "live", conflict: true, liveState: "value",
    });

  });

  it("isolates same model IDs by account and keeps snapshots immutable", async () => {
    const harness = await createHarness({
      "github.com/1": [model("same", { supported_endpoints: ["/chat/completions"] })],
      "github.com/2": [model("same", { supported_endpoints: ["/responses"] })],
    });
    const [one, two] = await Promise.all([
      harness.registry.get(harness.account1, signal),
      harness.registry.get(harness.account2, signal),
    ]);
    expect(capability(one, "same").protocols.value).toEqual(["chat"]);
    expect(capability(two, "same").protocols.value).toEqual(["responses"]);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(capability(one, "same").protocols.value)).toBe(true);
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
    const database = databaseWithAccounts();
    const registry = new ModelCapabilityRegistry(catalog, { get: () => null });
    registries.push(registry);
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
    const staleRegistry = new ModelCapabilityRegistry(staleCatalog, { get: () => null });
    registries.push(staleRegistry);
    const pending = staleRegistry.get(account, signal);
    staleRegistry.invalidate(account.accountId);
    releaseStale();
    await pending;
    const fresh = staleRegistry.get(account, signal);
    releaseStale();
    await fresh;
    expect(fetches).toBe(1);
  });

  it("uses explicit valid output budgets, known ceilings, and unknown fallback", () => {
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

  it("marks an upstream default invalid when a refreshed ceiling becomes smaller", async () => {
    let ceiling = 10_000;
    const database = databaseWithAccounts();
    const account = await createAccount(database, "1");
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return {
          data: [model("changing", {
            supported_endpoints: ["/messages"],
            max_output_tokens: ceiling,
            default_output_tokens: 8_000,
          })],
        };
      },
    });
    const registry = new ModelCapabilityRegistry(catalog, { get: () => null });
    registries.push(registry);
    expect(capability(await registry.get(account, signal), "changing").defaultOutputTokens.valid).toBe(true);
    ceiling = 4_000;
    registry.invalidate(account.accountId);
    const refreshed = capability(await registry.get(account, signal), "changing").defaultOutputTokens;
    expect(refreshed).toMatchObject({ effective: 8_000, valid: false });
    expect(() => chooseOutputTokenBudget(undefined, refreshed)).toThrow(TypeError);
  });

  it("supersedes catalog and credential generations without mutating captured snapshots", async () => {
    let endpoint = "/chat/completions";
    const database = databaseWithAccounts();
    const account = await createAccount(database, "1");
    const catalog = new CopilotModelCatalog({
      async fetch() { return { data: [model("same", { supported_endpoints: [endpoint] })] }; },
    });
    const registry = new ModelCapabilityRegistry(catalog, { get: () => null });
    registries.push(registry);
    const initial = await registry.get(account, signal);
    expect(registry.isCurrent(initial)).toBe(true);
    endpoint = "/responses";
    registry.invalidate(account.accountId);
    expect(registry.isCurrent(initial)).toBe(false);
    const refreshed = await registry.get(account, signal);
    expect(registry.isCurrent(refreshed)).toBe(true);
    expect(refreshed.catalogGeneration).toBeGreaterThan(initial.catalogGeneration);
    expect(capability(initial, "same").protocols.value).toEqual(["chat"]);
    expect(capability(refreshed, "same").protocols.value).toEqual(["responses"]);
    const reauthenticated = await registry.get({ ...account, credentialGeneration: account.credentialGeneration + 1 }, signal);
    expect(registry.isCurrent(refreshed)).toBe(false);
    expect(registry.isCurrent(reauthenticated)).toBe(true);
    expect(reauthenticated.credentialGeneration).toBe(account.credentialGeneration + 1);
    expect(Object.isFrozen(initial.models)).toBe(true);
    expect(Object.isFrozen(capability(initial, "same").revision)).toBe(true);
  });

  it("selects only models whose effective capabilities are usable for agent mapping", async () => {
    const harness = await createHarness({
      "github.com/1": [
        model("responses", { supported_endpoints: ["/responses"], max_output_tokens: 8000 }),
        model("chat", {
          supported_endpoints: ["/chat/completions"],
          max_output_tokens: 8000,
          chat_output_token_field: "max_tokens",
        }),
        model("mixed", { supported_endpoints: ["/chat/completions", "/responses"], max_output_tokens: 8000 }),
        model("chat-without-token-field", { supported_endpoints: ["/chat/completions"], max_output_tokens: 8000 }),
        model("empty-protocols", { supported_endpoints: [], max_output_tokens: 8000 }),
        model("missing-protocols", { max_output_tokens: 8000 }),
        model("invalid-output-default", {
          supported_endpoints: ["/responses"],
          max_output_tokens: 8000,
          default_output_tokens: 9000,
        }),
      ],
    });
    const snapshot = await harness.registry.get(harness.account1, signal);

    expect(harness.registry.modelsUsableForAgentMapping(snapshot).map((item) => item.modelId)).toEqual([
      "responses",
      "chat",
      "mixed",
    ]);
  });

  it("derives bounded output defaults from declarations and ceilings", async () => {
    const harness = await createHarness({
      "github.com/1": [
        model("small", { max_output_tokens: 2000 }),
        model("large", { max_output_tokens: 16000 }),
        model("unknown", {}),
        model("declared", { default_output_tokens: 1000, max_output_tokens: 2000 }),
      ],
    });
    const snapshot = await harness.registry.get(harness.account1, signal);
    expect(snapshot.models.map((item) => ({
      id: item.modelId, value: chooseOutputTokenBudget(undefined, item.defaultOutputTokens), source: item.defaultOutputTokens.source,
    }))).toEqual([
      { id: "small", value: 2000, source: "known_ceiling" },
      { id: "large", value: 8192, source: "known_ceiling" },
      { id: "unknown", value: 4096, source: "unknown_fallback" },
      { id: "declared", value: 1000, source: "live" },
    ]);
    expect(chooseOutputTokenBudget(1500, capability(snapshot, "declared").defaultOutputTokens)).toBe(1500);
  });
});

async function createHarness(
  data: Readonly<Record<string, readonly unknown[]>>,
  builtins: BuiltinModelCapabilityLookup = { get: () => null },
) {
  const database = databaseWithAccounts();
  const account1 = await createAccount(database, "1");
  const account2 = await createAccount(database, "2");
  const catalog = new CopilotModelCatalog({
    async fetch(accountId) {
      return { data: data[accountId] ?? [] };
    },
  });
  const registry = new ModelCapabilityRegistry(catalog, builtins);
  registries.push(registry);
  return {
    database,
    account1,
    account2,
    registry,
  };
}

async function createAccount(database: SqliteDatabase, userId: string) {
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), () => 1_700_000_000_000);
  return await directory.upsertAuthenticated({
    host: "github.com",
    userId,
    secret: { generation: 0, githubToken: `token-${userId}` },
  });
}

function databaseWithAccounts(): SqliteDatabase {
  const database = new SqliteDatabase(":memory:");
  databases.push(database);
  applyMigrations(database, [
    embedMigration(runtimeConfigMigration),
    embedMigration(accountsMigration),
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
