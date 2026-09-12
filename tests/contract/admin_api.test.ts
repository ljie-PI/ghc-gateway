import { describe, expect, it } from "vitest";
import { createAdminModule } from "../../src/admin/routes.js";
import type { AdminModule } from "../../src/gateway/create_gateway.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { adminDependencies } from "./admin_test_harness.js";
import { login } from "./admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";

describe("Admin API", () => {
  it("serves canonical status, account, model, config, history, usage, and event envelopes", async () => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      const status = await read(harness.gateway, "/admin/api/v1/status", session.cookie);
      expect(status.data).toMatchObject({
        version: "test", uptimeMs: 1234, health: "ok", performance: "healthy",
        admission: { activeRequests: 0, activeStreams: 0, queuedRequests: 0, activeMax: 4, queueMax: 16 },
        storage: { historyCount: 0, usageBucketCount: 2, eventCount: 3 },
        daemon: { managed: true, pid: 123 },
      });
      expect((await read(harness.gateway, "/admin/api/v1/accounts", session.cookie)).data).toMatchObject({
        defaultRevision: 2, defaultAccountId: "github.com/42", items: [{ numericUserId: "42", preferredModel: null }],
      });
      const started = await mutate(harness.gateway, "POST", "/admin/api/v1/device-flows", session, {
        host: "github.com",
      });
      expect(await started.json()).toEqual({
        data: {
          flowId: "flow-1",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2027-01-15T08:15:00.000Z",
          pollIntervalSeconds: 5,
          nextPollAt: "2027-01-15T08:00:05.000Z",
        },
      });
      expect((await read(harness.gateway, "/admin/api/v1/device-flows/flow-1", session.cookie)).data).toEqual({
        state: "pending",
        pollIntervalSeconds: 5,
        nextPollAt: "2027-01-15T08:00:05.000Z",
      });
      const canceled = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows/flow-1`, {
        method: "DELETE",
        headers: { cookie: session.cookie, origin: ORIGIN, "x-ghcg-csrf": session.csrf },
      }));
      expect(canceled.status).toBe(200);
      expect(await canceled.json()).toEqual({ data: { state: "canceled" } });
      expect(harness.dependencies.calls).toContain("device-cancel:flow-1");
      expect((await read(harness.gateway, "/admin/api/v1/models", session.cookie)).data).toMatchObject({
        accountId: "github.com/42", catalogGeneration: 7, items: [{ id: "gpt-test", maxInputTokens: 200_000, maxOutputTokens: 8_192 }],
      });
      expect(harness.dependencies.calls).not.toContain("preference-invalidated");
      expect((await read(harness.gateway, "/admin/api/v1/config", session.cookie)).data).toMatchObject({
        revision: 1, ranges: { "limits.requestBodyBytes": { min: 1_048_576, max: 67_108_864, unit: "bytes" } },
      });
      expect((await read(harness.gateway, "/admin/api/v1/history", session.cookie)).data).toEqual({
        revision: 0, count: 0, receiptCount: 0, legacyCount: 0,
        untrackedContinuationBlocked: false,
        oldestAt: null, newestAt: null, ttlDays: 7, maxResponses: 512, maxReceipts: 2048,
      });
      expect((await read(harness.gateway, "/admin/api/v1/usage?limit=1", session.cookie)).data).toMatchObject({ items: [], nextCursor: null });
      expect((await read(harness.gateway, "/admin/api/v1/events?severity=info", session.cookie)).data).toEqual({ items: [], nextCursor: null });
    } finally {
      await harness.close();
    }
  });

  it("serializes discovered prompt limits without conflating context windows or changing output metadata", async () => {
    const dependencies = adminDependencies();
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return { data: [
          { id: "explicit", limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } },
          { id: "context-only", limits: { max_context_window_tokens: 144_000 } },
          { id: "malformed", limits: { max_prompt_tokens: null, max_context_window_tokens: 144_000 } },
        ].map(({ id, limits }) => ({
          id, name: id, vendor: "test", model_picker_enabled: true,
          capabilities: {
            supported_endpoints: ["/responses"],
            limits: { ...limits, max_output_tokens: 16_000 },
            default_output_tokens: 8000,
            chat_output_token_field: "max_completion_tokens",
          },
        })) };
      },
    }, () => new Date("2027-01-15T08:00:00Z"));
    const registry = new ModelCapabilityRegistry(catalog, { get: () => null });
    dependencies.registry.get = registry.get.bind(registry);
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = (await read(harness.gateway, "/admin/api/v1/models", session.cookie)).data as {
        items: Array<Record<string, unknown>>;
      };
      expect(response).toMatchObject({ accountId: "github.com/42", credentialGeneration: 4, catalogGeneration: 0 });
      expect(response.items.map((item) => ({
        id: item.id,
        value: item.maxInputTokens,
        source: item.maxInputTokensSource,
        conflict: item.maxInputTokensConflict,
        liveState: item.maxInputTokensLiveState,
      }))).toEqual([
        { id: "explicit", value: 128_000, source: "live", conflict: false, liveState: "value" },
        { id: "context-only", value: 144_000, source: "live", conflict: false, liveState: "value" },
        { id: "malformed", value: null, source: "unknown", conflict: false, liveState: "malformed" },
      ]);
      for (const item of response.items) {
        expect(item).toMatchObject({
          protocols: ["responses"], protocolsSource: "live", protocolsLiveState: "value",
          maxOutputTokens: 16_000, maxOutputTokensSource: "live", maxOutputTokensConflict: false, maxOutputTokensLiveState: "value",
          defaultOutputTokens: { configured: 8000, effective: 8000, source: "live", valid: true },
          chatOutputTokenField: "max_completion_tokens", chatOutputTokenFieldSource: "live",
        });
      }
    } finally {
      await harness.close();
      await catalog.close();
    }
  });

  it("validates TypeBox DTOs without coercion and maps state failures", async () => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      const current = (await read(harness.gateway, "/admin/api/v1/config", session.cookie)).data as { revision: number; config: unknown };
      const coerced = await mutate(harness.gateway, "PUT", "/admin/api/v1/config", session, {
        expectedRevision: String(current.revision), config: current.config,
      });
      expect(coerced.status).toBe(400);
      expect(await coerced.json()).toEqual({ error: { code: "validation_failed", message: "validation failed", requestId: "req_admin_api" } });

      const extra = await mutate(harness.gateway, "DELETE", "/admin/api/v1/history", session, { expectedRevision: 0, extra: true });
      expect(extra.status).toBe(400);
      const conflict = await mutate(harness.gateway, "DELETE", "/admin/api/v1/history", session, { expectedRevision: 9 });
      expect(conflict.status).toBe(409);
      const cleared = await mutate(harness.gateway, "DELETE", "/admin/api/v1/history", session, { expectedRevision: 0 });
      expect(await cleared.json()).toEqual({ data: {
        revision: 0,
        count: 0,
        receiptCount: 0,
        legacyCount: 0,
        untrackedContinuationBlocked: false,
        oldestAt: null,
        newestAt: null,
        ttlDays: 7,
        maxResponses: 512,
        maxReceipts: 2048,
      } });

      const unknownModel = await mutate(harness.gateway, "PUT", "/admin/api/v1/models/preferred", session, {
        accountId: "github.com/42", modelId: "missing", expectedRevision: 0,
      });
      expect(unknownModel.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("owns strict media, bounded body, no-body, query, unknown route, and signal handling", async () => {
    const dependencies = adminDependencies();
    dependencies.runtimeConfig.read().config.limits.requestBodyBytes = 64;
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const unsupported = await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, "{}", "text/plain");
      expect(unsupported.status).toBe(400);
      expect((await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, "{}", "application/json; charset=latin1")).status).toBe(400);
      expect((await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, "{}", "application/json", "gzip")).status).toBe(400);
      expect((await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, "{", "application/json")).status).toBe(400);
      expect((await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, "[]", "application/json")).status).toBe(400);
      expect((await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, JSON.stringify({ host: "x".repeat(100) }), "application/json")).status).toBe(400);
      expect((await rawMutation(harness.gateway, "/admin/api/v1/auth/bootstrap", session, JSON.stringify({ token: "x".repeat(129) }), "application/json")).status).toBe(400);

      dependencies.runtimeConfig.read().config.limits.requestBodyBytes = 256;
      expect((await rawMutation(harness.gateway, "/admin/api/v1/device-flows", session, JSON.stringify({ host: "x".repeat(100) }), "application/json")).status).toBe(201);

      expect((await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/logout`, {
        method: "POST",
        headers: { cookie: session.cookie, origin: ORIGIN, "x-ghcg-csrf": session.csrf },
        body: "x",
      }))).status).toBe(400);
      expect((await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/status?x=1`, { headers: { cookie: session.cookie } }))).status).toBe(400);
      expect((await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/usage?limit=1&limit=2`, { headers: { cookie: session.cookie } }))).status).toBe(400);
      const missing = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/missing?bad=1`, {
        method: "POST", headers: { cookie: session.cookie }, body: "ignored",
      }));
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toBe("application/json; charset=utf-8");

      dependencies.telemetry.queryUsage = async () => { throw Object.assign(new Error(), { code: "validation_failed" }); };
      expect((await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/usage?cursor=bad`, { headers: { cookie: session.cookie } }))).status).toBe(400);

      const controller = new AbortController();
      controller.abort();
      const aborted = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/status`, { signal: controller.signal }));
      expect(await aborted.text()).toBe("");
    } finally {
      await harness.close();
    }
  });

  it("invalidates account caches before credential cleanup and before returning failures", async () => {
    const dependencies = adminDependencies();
    dependencies.accounts.remove = async (_accountId, _revision, _signal, onRemoving) => {
      onRemoving?.();
      dependencies.calls.push("remove-started");
      throw new Error("cleanup failed");
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await mutate(harness.gateway, "DELETE", "/admin/api/v1/accounts/github.com%2F42", session, {
        expectedRevision: 3,
      });
      expect(response.status).toBe(500);
      expect(dependencies.calls.slice(-2)).toEqual(["invalidate-account:github.com/42", "remove-started"]);
    } finally {
      await harness.close();
    }
  });

  it("serializes refresh and preferred-model mutations for one account", async () => {
    const dependencies = adminDependencies();
    let releaseCatalog = (): void => undefined;
    let calls = 0;
    const originalGet = dependencies.registry.get;
    dependencies.registry.get = async (account, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseCatalog = resolve; });
      }
      return await originalGet(account, signal);
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const refresh = mutate(harness.gateway, "POST", "/admin/api/v1/models/refresh", session, { accountId: "github.com/42" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const preferred = mutate(harness.gateway, "PUT", "/admin/api/v1/models/preferred", session, {
        accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0,
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
      releaseCatalog();
      expect((await refresh).status).toBe(200);
      expect((await preferred).status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it.each(["PUT", "DELETE"])("does not register %s capability metadata mutations", async (method) => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      const before = await read(harness.gateway, "/admin/api/v1/models", session.cookie);
      for (const headers of [{}, { cookie: session.cookie, origin: ORIGIN, "x-ghcg-csrf": session.csrf }]) {
        const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/models/capabilities`, {
          method, headers,
        }));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "not_found", message: "not found", requestId: "req_admin_api" },
        });
      }
      expect(await read(harness.gateway, "/admin/api/v1/models", session.cookie)).toEqual(before);
      expect(harness.dependencies.calls).not.toContain("preference-invalidated");
    } finally {
      await harness.close();
    }
  });

  it.each(["refresh", "preferred"])("rejects %s after account removal during discovery", async (operation) => {
    const dependencies = adminDependencies();
    const originalGet = dependencies.registry.get;
    dependencies.registry.get = async (...args) => {
      const snapshot = await originalGet(...args);
      const active = dependencies.accounts.list()[0]!;
      dependencies.accounts.list = () => [{ ...active, state: "removed" }];
      return snapshot;
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = operation === "refresh"
        ? await mutate(harness.gateway, "POST", "/admin/api/v1/models/refresh", session, { accountId: "github.com/42" })
        : await mutate(harness.gateway, "PUT", "/admin/api/v1/models/preferred", session, {
          accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0,
        });
      expect(response.status).toBe(404);
      expect(dependencies.preferences.get("github.com/42")).toBeNull();
      expect(dependencies.calls).not.toContain("preference-invalidated");
    } finally {
      await harness.close();
    }
  });

  it("rejects catalog-backed mutations when reauthentication changes credential generation", async () => {
    for (const operation of ["refresh", "preferred"] as const) {
      const dependencies = adminDependencies();
      const originalBind = dependencies.accounts.bindAccount;
      const originalGet = dependencies.registry.get;
      let release = (): void => undefined;
      let started = (): void => undefined;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      dependencies.registry.get = async (...args) => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return await originalGet(...args);
      };
      const harness = await createHarness(dependencies);
      try {
        const session = await login(harness.gateway, harness.admin);
        const responsePromise = operation === "refresh"
          ? mutate(harness.gateway, "POST", "/admin/api/v1/models/refresh", session, {
            accountId: "github.com/42",
          })
          : mutate(harness.gateway, "PUT", "/admin/api/v1/models/preferred", session, {
            accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0,
          });
        await startedPromise;
        dependencies.accounts.bindAccount = async (accountId, signal) => ({
          ...(await originalBind(accountId, signal)),
          credentialGeneration: 5,
        });
        release();
        expect((await responsePromise).status, operation).toBe(409);
      } finally {
        await harness.close();
      }
    }
  });

  it.each(["refresh", "preferred"] as const)(
    "rejects %s before preference writes when the registry snapshot becomes non-current during credential rebind",
    async (operation) => {
      const dependencies = adminDependencies();
      const originalBind = dependencies.accounts.bindAccount;
      const originalSetPreferred = dependencies.preferredModels.setPreferred;
      const originalMarkInvalidIfMissing = dependencies.preferredModels.markInvalidIfMissing;
      let bindCalls = 0;
      let current = true;
      let preferenceWrites = 0;
      dependencies.accounts.bindAccount = async (...args) => {
        const bound = await originalBind(...args);
        bindCalls += 1;
        if (bindCalls === 2) current = false;
        return bound;
      };
      dependencies.registry.isCurrent = () => current;
      dependencies.preferredModels.setPreferred = (...args) => {
        preferenceWrites += 1;
        return originalSetPreferred(...args);
      };
      dependencies.preferredModels.markInvalidIfMissing = (...args) => {
        preferenceWrites += 1;
        return originalMarkInvalidIfMissing(...args);
      };
      const harness = await createHarness(dependencies);
      try {
        const session = await login(harness.gateway, harness.admin);
        const response = operation === "refresh"
          ? await mutate(harness.gateway, "POST", "/admin/api/v1/models/refresh", session, {
            accountId: "github.com/42",
          })
          : await mutate(harness.gateway, "PUT", "/admin/api/v1/models/preferred", session, {
            accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0,
          });
        expect(response.status).toBe(409);
        expect(bindCalls).toBe(2);
        expect(preferenceWrites).toBe(0);
        expect(dependencies.preferences.get("github.com/42")).toBeNull();
      } finally {
        await harness.close();
      }
    },
  );

  it("keeps model mutations serialized when a queued request aborts", async () => {
    const dependencies = adminDependencies();
    let releaseCatalog = (): void => undefined;
    let calls = 0;
    const originalGet = dependencies.registry.get;
    dependencies.registry.get = async (account, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseCatalog = resolve; });
      }
      return await originalGet(account, signal);
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const first = mutate(harness.gateway, "POST", "/admin/api/v1/models/refresh", session, { accountId: "github.com/42" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const abort = new AbortController();
      const second = harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/models/refresh`, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", cookie: session.cookie, origin: ORIGIN, "x-ghcg-csrf": session.csrf },
        body: JSON.stringify({ accountId: "github.com/42" }),
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      abort.abort();
      await second;
      const third = mutate(harness.gateway, "PUT", "/admin/api/v1/models/preferred", session, {
        accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
      releaseCatalog();
      expect((await first).status).toBe(200);
      expect((await third).status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("cancels a flow when its start request aborts before ownership", async () => {
    const dependencies = adminDependencies();
    let started = (): void => undefined;
    let release = (): void => undefined;
    const startCalled = new Promise<void>((resolve) => { started = resolve; });
    const startRelease = new Promise<void>((resolve) => { release = resolve; });
    dependencies.deviceFlows.start = async (...args) => {
      started();
      await startRelease;
      dependencies.calls.push(`device-start:${args[0]}`);
      return {
        flowId: "flow-1",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAtMs: dependencies.now.value + 900_000,
        pollIntervalSeconds: 5,
        nextPollAtMs: dependencies.now.value + 5_000,
      };
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const controller = new AbortController();
      const request = harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: ORIGIN,
          "x-ghcg-csrf": session.csrf,
        },
        body: JSON.stringify({ host: "github.com" }),
      }));
      await startCalled;
      controller.abort();
      release();
      expect(await (await request).text()).toBe("");
      expect(dependencies.calls).toContain("device-cancel:flow-1");
    } finally {
      await harness.close();
    }
  });

  it("releases provisional ownership when a start aborts after registration", async () => {
    const dependencies = adminDependencies();
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      expect((await mutate(harness.gateway, "POST", "/admin/api/v1/device-flows", session, {
        host: "github.com",
      })).status).toBe(201);
      dependencies.deviceFlows.start = async () => ({
        flowId: "flow-2",
        userCode: "WXYZ-9999",
        verificationUri: "https://github.com/login/device",
        expiresAtMs: dependencies.now.value + 900_000,
        pollIntervalSeconds: 5,
        nextPollAtMs: dependencies.now.value + 5_000,
      });
      const controller = new AbortController();
      dependencies.deviceFlows.has = () => {
        controller.abort();
        return true;
      };
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: ORIGIN,
          "x-ghcg-csrf": session.csrf,
        },
        body: JSON.stringify({ host: "github.com" }),
      }));
      expect(await response.text()).toBe("");
      expect(dependencies.calls).toContain("device-cancel:flow-2");
    } finally {
      await harness.close();
    }
  });
});

async function createHarness(dependencies = adminDependencies()): Promise<{
  readonly gateway: Gateway;
  readonly admin: AdminModule;
  readonly dependencies: ReturnType<typeof adminDependencies>;
  readonly close: () => Promise<void>;
}> {
  let token = 0;
  const admin = createAdminModule({ ...dependencies, createToken: () => `api-token-${++token}` });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/admin-api" }), runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_api" });
  return { gateway, admin, dependencies, close: async () => gateway.close() };
}

async function read(gateway: Gateway, path: string, cookie: string): Promise<{ data: unknown }> {
  const response = await gateway.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as { data: unknown };
}

async function mutate(
  gateway: Gateway,
  method: string,
  path: string,
  session: { readonly cookie: string; readonly csrf: string },
  body: unknown,
): Promise<Response> {
  return await rawMutation(gateway, path, session, JSON.stringify(body), "application/json", undefined, method);
}

async function rawMutation(
  gateway: Gateway,
  path: string,
  session: { readonly cookie: string; readonly csrf: string },
  body: string,
  contentType: string,
  encoding?: string,
  method = "POST",
): Promise<Response> {
  const headers = new Headers({ "content-type": contentType, cookie: session.cookie, origin: ORIGIN, "x-ghcg-csrf": session.csrf });
  if (encoding !== undefined) headers.set("content-encoding", encoding);
  return await gateway.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }));
}
