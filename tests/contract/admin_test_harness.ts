import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import type { AdminModuleDependencies } from "../../src/admin/routes.js";
import type { AdminMonitorEvent, AdminTelemetry } from "../../src/telemetry/admin.js";
import type { AdminModule, Gateway } from "../../src/gateway/create_gateway.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";

const ORIGIN = "http://127.0.0.1:31400";

export interface TestAdminDependencies extends AdminModuleDependencies {
  readonly now: { value: number };
  readonly emitted: { publish(event: AdminMonitorEvent): void };
  readonly calls: string[];
}

export function adminDependencies(now = { value: 1_800_000_000_000 }): TestAdminDependencies {
  const calls: string[] = [];
  const listeners = new Set<(event: Readonly<AdminMonitorEvent>) => void>();
  let config = defaultRuntimeConfigSnapshot();
  let configRevision = 1;
  const historyRevision = 0;
  const account = {
    accountId: "github.com/42",
    revision: 3,
    host: "github.com",
    userId: "42",
    login: "octocat",
    displayName: "Octocat",
    state: "active" as const,
    authenticatedAtMs: now.value - 1_000,
  };
  let defaultRevision = 2;
  let defaultAccountId: string | null = account.accountId;
  let preference: {
    readonly accountId: string;
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
    readonly catalogGeneration: number;
  } | null = null;
  const capabilitySnapshot = (
    bound: Awaited<ReturnType<NonNullable<AdminModuleDependencies["accounts"]["bindAccount"]>>>,
  ) => ({
    accountId: bound.accountId,
    credentialGeneration: bound.credentialGeneration,
    catalogGeneration: 7,
    fetchedAt: "2027-01-15T08:00:00.000Z",
    models: [capabilityModel("gpt-test")],
  });
  const telemetry: AdminTelemetry = {
    async queryUsage(query, signal) {
      calls.push(`usage:${query.limit}`);
      signal.throwIfAborted();
      return {
        items: [], nextCursor: null,
        totals: { requestCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, latencySumMs: 0, latencyMaxMs: 0 },
      };
    },
    async queryEvents(query, signal) {
      calls.push(`events:${query.limit}`);
      signal.throwIfAborted();
      return { items: [], nextCursor: null };
    },
    async replayEvents(afterEventId, signal) {
      signal.throwIfAborted();
      return afterEventId === "1"
        ? { found: true, latestEventId: "2", items: [operationalEvent("2")] }
        : { found: false, latestEventId: "2", items: [] };
    },
    snapshot() {
      return {
        storage: { usageBucketCount: 2, eventCount: 3 },
        pendingMutations: 1,
        droppedUsageUpdates: 4,
        droppedOperationalEvents: 5,
        performance: {
          status: "healthy", startedAtMs: null,
          metrics: {
            bufferedMs: { p95: null, status: "insufficient_data", samples: 0 },
            eventMs: { p95: null, status: "insufficient_data", samples: 0 },
            checkpointMs: { p95: null, status: "insufficient_data", samples: 0 },
            eventLoopMs: { p95: null, status: "insufficient_data", samples: 0 },
          },
        },
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    now,
    calls,
    emitted: { publish: (event) => { for (const listener of listeners) listener(event); } },
    accounts: {
      list: () => [account],
      defaultState: () => ({ defaultRevision, defaultAccountId }),
      use: async (accountId, expectedRevision, signal) => {
        signal?.throwIfAborted();
        if (expectedRevision !== defaultRevision) throw coded("revision_conflict");
        if (accountId !== account.accountId) throw coded("not_found");
        defaultRevision += 1;
        defaultAccountId = accountId;
        return defaultRevision;
      },
      remove: async (accountId, expectedRevision, signal, onRemoving) => {
        signal?.throwIfAborted();
        if (accountId !== account.accountId) throw coded("not_found");
        if (expectedRevision !== account.revision) throw coded("revision_conflict");
        onRemoving?.();
        return { ...account, revision: 5, state: "removed" };
      },
      bindAccount: async (accountId, signal) => {
        signal?.throwIfAborted();
        if (accountId !== account.accountId) throw coded("not_found");
        return {
          accountId,
          environment: resolveGitHubEnvironment("github.com"),
          userId: "42",
          login: "octocat",
          displayName: "Octocat",
          credentialGeneration: 4,
        };
      },
    },
    deviceFlows: {
      async start(host, signal) {
        signal?.throwIfAborted();
        calls.push(`device-start:${host}`);
        return {
          flowId: "flow-1",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresAtMs: now.value + 900_000,
          pollIntervalSeconds: 5,
          nextPollAtMs: now.value + 5_000,
        };
      },
      async poll(flowId, signal) {
        signal?.throwIfAborted();
        calls.push(`device-poll:${flowId}`);
        return { status: "pending", pollIntervalSeconds: 5, nextPollAtMs: now.value + 5_000 };
      },
      async cancel(flowId) {
        calls.push(`device-cancel:${flowId}`);
        return { status: "canceled" };
      },
      has: () => true,
    },
    registry: {
      async get(bound, signal) {
        signal.throwIfAborted();
        calls.push(`catalog:${bound.accountId}`);
        return capabilitySnapshot(bound);
      },
      invalidate: (accountId) => calls.push(`invalidate:${accountId}`),
      isCurrent: (snapshot) => snapshot.catalogGeneration === 7
        && snapshot.credentialGeneration === 4,
      modelsUsableForAgentMapping: (snapshot) => {
        calls.push("agent-models");
        return snapshot.models;
      },
    },
    preferences: {
      get: () => preference,
    },
    preferredModels: {
      setPreferred: (accountId, modelId, expectedRevision, catalog) => {
        if (expectedRevision !== (preference?.revision ?? 0)) throw coded("revision_conflict");
        if (!catalog.models.some((model) => model.modelId === modelId)) throw new Error("model not in catalog");
        preference = { accountId, revision: expectedRevision + 1, modelId, validity: "valid", catalogGeneration: catalog.catalogGeneration };
        return preference;
      },
      markInvalidIfMissing: (_accountId, catalog) => {
        calls.push("preference-invalidated");
        if (preference !== null
          && !catalog.models.some((model) => model.modelId === preference?.modelId)) {
          preference = { ...preference, revision: preference.revision + 1, validity: "invalid" };
        }
        return preference;
      },
    },
    runtimeConfig: {
      read: () => ({ revision: configRevision, config }),
      updateAndApply: (candidate, expectedRevision, signal) => {
        signal.throwIfAborted();
        if (expectedRevision !== configRevision) throw coded("revision_conflict");
        config = structuredClone(candidate);
        configRevision += 1;
        calls.push(`config-applied:${configRevision}`);
        return { revision: configRevision, config };
      },
    },
    history: {
      inspect: () => ({
        revision: historyRevision,
        count: 0,
        receiptCount: 0,
        legacyCount: 0,
        untrackedContinuationBlocked: false,
        oldestAt: null,
        newestAt: null,
        ttlDays: 7,
        maxResponses: 512,
        maxReceipts: 2048,
      }),
      clear: (expectedRevision) => {
        if (expectedRevision !== historyRevision) throw coded("revision_conflict");
      },
    },
    telemetry,
    runtimeStatus: {
      snapshot: () => ({ version: "test", uptimeMs: 1234, daemon: { managed: true, pid: 123, startedAt: "2027-01-15T07:00:00.000Z" } }),
    },
    accountCaches: {
      invalidate: (accountId) => calls.push(`invalidate-account:${accountId}`),
    },
    nowMs: () => now.value,
  };
}

function capabilityModel(modelId: string) {
  return {
    accountId: "github.com/42",
    modelId,
    name: "GPT Test",
    vendor: "OpenAI",
    protocols: { value: ["chat", "responses"] as const, source: "live" as const, conflict: false, liveState: "value" as const },
    maxInputTokens: { value: 200_000, source: "builtin" as const, conflict: false, liveState: "missing" as const },
    maxOutputTokens: { value: 8_192, source: "builtin" as const, conflict: false, liveState: "missing" as const },
    defaultOutputTokens: {
      configuration: { value: null, source: "unknown" as const, conflict: false, liveState: "missing" as const },
      effective: 8_192,
      source: "known_ceiling" as const,
      valid: true,
    },
    profile: {
      chatOutputTokenField: {
        value: "max_tokens" as const,
        source: "builtin" as const,
        conflict: false,
        liveState: "missing" as const,
      },
      supportedParameters: {
        value: null,
        source: "unknown" as const,
        conflict: false,
        liveState: "missing" as const,
      },
      reasoningEfforts: {
        value: null,
        source: "unknown" as const,
        conflict: false,
        liveState: "missing" as const,
      },
    },
    revision: {
      credentialGeneration: 4,
      catalogGeneration: 7,
      builtinRevision: "test",
    },
  };
}

export function operationalEvent(eventId: string) {
  return { eventId, occurredAt: "2027-01-15T08:00:00.000Z", kind: "gateway_started" as const, severity: "info" as const, metadata: { status: "ready" } };
}

export async function login(gateway: Gateway, admin: AdminModule): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const minted = admin.mintBootstrap();
  if (minted.kind !== "issued") throw new Error("bootstrap was not issued");
  const response = await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ token: minted.token }),
  }));
  if (response.status !== 200) throw new Error("bootstrap exchange failed");
  const body = await response.json() as { data: { csrfToken: string } };
  return { cookie: response.headers.get("set-cookie") ?? "", csrf: body.data.csrfToken };
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
