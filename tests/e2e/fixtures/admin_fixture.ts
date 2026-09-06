import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page, Request, Route } from "@playwright/test";
import type {
  AdminAccount,
  AdminAccounts,
  AdminHistorySummary,
  AdminModels,
  AdminOperationalEvent,
  AdminRuntimeConfig,
  AdminStatus,
} from "../../../web/src/types.js";

const NOW = "2026-09-03T12:00:00.000Z";

export interface AdminFixture {
  readonly requests: Request[];
  readonly streamRequests: Request[];
  readonly streamRequestHeaders: Array<Record<string, string | string[] | undefined>>;
  readonly state: {
    authenticated: boolean;
    accounts: AdminAccounts;
    models: AdminModels;
    config: AdminRuntimeConfig;
    history: AdminHistorySummary;
    status: AdminStatus;
    events: AdminOperationalEvent[];
    rejectSecurity: boolean;
    conflictAccount: boolean;
    conflictConfig: boolean;
    conflictHistory: boolean;
    conflictModel: boolean;
    failAccountRemoval: boolean;
    streamBodies: string[];
    streamDelaysMs: number[];
    streamHoldsMs: number[];
  };
}

export async function installAdminFixture(page: Page): Promise<AdminFixture> {
  const github = account("github:1", "github.com", "octo");
  const fixture: AdminFixture = {
    requests: [],
    streamRequests: [],
    streamRequestHeaders: [],
    state: {
      authenticated: false,
      accounts: { defaultRevision: 1, defaultAccountId: github.accountId, items: [github] },
      models: {
        accountId: github.accountId,
        credentialGeneration: 1,
        catalogGeneration: 1,
        fetchedAt: NOW,
        capabilityRevision: 0,
        preferredModel: { revision: 1, modelId: "gpt-alpha", validity: "valid" },
        items: [
          modelItem({
            id: "gpt-alpha",
            name: "Alpha",
            vendor: "OpenAI",
            maxInputTokens: 128000,
            maxOutputTokens: 16000,
          }),
          modelItem({
            id: "claude-beta",
            name: "Beta",
            vendor: "Anthropic",
            maxInputTokens: 200000,
            maxOutputTokens: 8192,
          }),
        ],
      },
      config: runtimeConfig(),
      history: {
        revision: 4,
        count: 12,
        oldestAt: "2026-09-01T09:00:00.000Z",
        newestAt: NOW,
        ttlDays: 7,
        maxResponses: 512,
      },
      status: status("healthy"),
      events: [operationalEvent(40, "gateway_started")],
      rejectSecurity: false,
      conflictAccount: false,
      conflictConfig: false,
      conflictHistory: false,
      conflictModel: false,
      failAccountRemoval: false,
      streamBodies: [sse("performance", { kind: "performance", status: status("healthy") })],
      streamDelaysMs: [],
      streamHoldsMs: [],
    },
  };
  const streamServer = createServer(async (request, response) => {
    const index = fixture.streamRequestHeaders.length;
    fixture.streamRequestHeaders.push(request.headers);
    const delay = fixture.state.streamDelaysMs[index] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const body = fixture.state.streamBodies[Math.min(index, fixture.state.streamBodies.length - 1)] ?? "";
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "http://127.0.0.1:4173",
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    response.write(body);
    const hold = fixture.state.streamHoldsMs[index] ?? 0;
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    streamServer.once("error", reject);
    streamServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = streamServer.address() as AddressInfo;
  page.once("close", () => streamServer.close());
  page.once("crash", () => streamServer.close());
  await page.route("**/admin/api/v1/**", (route) => handle(route, fixture));
  await page.route("**/admin/api/v1/events/stream", async (route) => {
    fixture.requests.push(route.request());
    fixture.streamRequests.push(route.request());
    await route.fulfill({
      status: 307,
      headers: { Location: `http://127.0.0.1:${port}/events/stream` },
    });
  });
  return fixture;
}

function modelItem(input: {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}, options: {
  readonly discovered?: boolean;
  readonly override?: NonNullable<AdminModels["items"][number]["override"]>;
  readonly overrideRevision?: number;
} = {}): AdminModels["items"][number] {
  const discovered = options.discovered ?? true;
  const override = options.override ?? null;
  return {
    ...input,
    discovered,
    configured: override !== null,
    verified: discovered,
    enabled: override?.enabled ?? true,
    visible: override?.enabled ?? true,
    protocols: override?.protocols ?? ["chat", "responses"],
    protocolsSource: override?.protocols === undefined ? "live" : "admin_override",
    protocolsConflict: false,
    protocolsLiveState: "value",
    maxInputTokensSource: "builtin",
    maxInputTokensConflict: false,
    maxInputTokensLiveState: "missing",
    maxOutputTokensSource: "builtin",
    maxOutputTokensConflict: false,
    maxOutputTokensLiveState: "missing",
    defaultOutputTokens: {
      configured: null,
      configuredSource: "unknown",
      conflict: false,
      liveState: "missing",
      effective: Math.min(8192, input.maxOutputTokens),
      source: "known_ceiling",
      valid: true,
    },
    chatOutputTokenField: "max_tokens",
    chatOutputTokenFieldSource: "builtin",
    chatOutputTokenFieldConflict: false,
    chatOutputTokenFieldLiveState: "missing",
    overrideRevision: options.overrideRevision ?? 0,
    builtinRevision: "test",
    override,
  };
}

async function handle(route: Route, fixture: AdminFixture): Promise<void> {
  const request = route.request();
  fixture.requests.push(request);
  const url = new URL(request.url());
  const path = url.pathname.slice("/admin/api/v1".length);

  if (path === "/auth/bootstrap") {
    fixture.state.authenticated = true;
    return json(route, 200, session());
  }
  if (!fixture.state.authenticated) return failure(route, 401, "unauthenticated");
  if (path === "/auth/session") return json(route, 200, session());
  if (
    request.method() !== "GET"
    && (fixture.state.rejectSecurity || request.headers()["x-ghcg-csrf"] !== "csrf-memory-only")
  ) {
    return failure(route, 403, "forbidden");
  }
  if (path === "/auth/logout") {
    fixture.state.authenticated = false;
    return route.fulfill({ status: 204 });
  }
  if (path === "/status") return json(route, 200, fixture.state.status);
  if (path === "/usage") {
    return json(route, 200, {
      items: [],
      nextCursor: null,
      totals: {
        requestCount: 42,
        errorCount: 2,
        inputTokens: 12000,
        outputTokens: 3400,
        cacheTokens: 800,
        latencySumMs: 900,
        latencyMaxMs: 120,
      },
    });
  }
  if (path === "/models/capabilities" && request.method() === "PUT") {
    const body = request.postDataJSON() as {
      modelId: string;
      capabilities: NonNullable<AdminModels["items"][number]["override"]>;
    };
    const existing = fixture.state.models.items.find((item) => item.id === body.modelId);
    const nextRevision = fixture.state.models.capabilityRevision + 1;
    const next = modelItem({
      id: body.modelId,
      name: existing?.name ?? body.modelId,
      vendor: existing?.vendor ?? "configured",
      maxInputTokens: body.capabilities.maxInputTokens ?? existing?.maxInputTokens ?? 0,
      maxOutputTokens: body.capabilities.maxOutputTokens ?? existing?.maxOutputTokens ?? 0,
    }, {
      discovered: existing?.discovered ?? false,
      override: body.capabilities,
      overrideRevision: nextRevision,
    });
    fixture.state.models = {
      ...fixture.state.models,
      capabilityRevision: nextRevision,
      items: existing === undefined
        ? [...fixture.state.models.items, next]
        : fixture.state.models.items.map((item) => item.id === body.modelId ? next : item),
    };
    return json(route, 200, fixture.state.models);
  }
  if (path === "/models/capabilities" && request.method() === "DELETE") {
    const body = request.postDataJSON() as { modelId: string };
    const existing = fixture.state.models.items.find((item) => item.id === body.modelId);
    const nextRevision = fixture.state.models.capabilityRevision + 1;
    fixture.state.models = {
      ...fixture.state.models,
      capabilityRevision: nextRevision,
      items: existing?.discovered === true
        ? fixture.state.models.items.map((item) => item.id === body.modelId
          ? modelItem({
            id: item.id,
            name: item.name,
            vendor: item.vendor,
            maxInputTokens: item.maxInputTokens ?? 0,
            maxOutputTokens: item.maxOutputTokens ?? 0,
          }, { overrideRevision: nextRevision })
          : item)
        : fixture.state.models.items.filter((item) => item.id !== body.modelId),
    };
    return json(route, 200, fixture.state.models);
  }
  if (path === "/accounts") return json(route, 200, fixture.state.accounts);
  if (path === "/device-flows" && request.method() === "POST") {
    return json(route, 201, {
      flowId: "flow-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.invalid/login/device",
      expiresAt: "2026-09-03T12:10:00.000Z",
      pollIntervalSeconds: 1,
    });
  }
  if (path === "/device-flows/flow-1") {
    const ghes = account("ghes:2", "github.example.test", "enterprise");
    if (!fixture.state.accounts.items.some((item) => item.accountId === ghes.accountId)) {
      fixture.state.accounts = {
        ...fixture.state.accounts,
        items: [...fixture.state.accounts.items, ghes],
      };
    }
    return json(route, 200, { state: "complete", account: ghes });
  }
  if (path === "/accounts/default") {
    if (fixture.state.conflictAccount) {
      fixture.state.conflictAccount = false;
      fixture.state.accounts = {
        ...fixture.state.accounts,
        defaultRevision: fixture.state.accounts.defaultRevision + 1,
      };
      return failure(route, 409, "revision_conflict");
    }
    const body = request.postDataJSON() as { accountId: string };
    fixture.state.accounts = {
      ...fixture.state.accounts,
      defaultAccountId: body.accountId,
      defaultRevision: fixture.state.accounts.defaultRevision + 1,
    };
    return json(route, 200, {
      defaultAccountId: body.accountId,
      defaultRevision: fixture.state.accounts.defaultRevision,
    });
  }
  if (path.startsWith("/accounts/") && request.method() === "DELETE") {
    const id = decodeURIComponent(path.slice("/accounts/".length));
    const found = fixture.state.accounts.items.find((item) => item.accountId === id)!;
    if (fixture.state.failAccountRemoval) {
      fixture.state.failAccountRemoval = false;
      const removing: AdminAccount = { ...found, state: "removing", revision: found.revision + 1 };
      fixture.state.accounts = {
        ...fixture.state.accounts,
        items: fixture.state.accounts.items.map((item) => item.accountId === id ? removing : item),
      };
      return failure(route, 500, "internal_error");
    }
    const removed: AdminAccount = { ...found, state: "removed", revision: found.revision + 1 };
    fixture.state.accounts = {
      ...fixture.state.accounts,
      items: fixture.state.accounts.items.map((item) => item.accountId === id ? removed : item),
    };
    return json(route, 200, removed);
  }
  if (path === "/models" && request.method() === "GET") return json(route, 200, fixture.state.models);
  if (path === "/models/refresh") {
    fixture.state.models = {
      ...fixture.state.models,
      catalogGeneration: 2,
      preferredModel: { revision: 2, modelId: "gpt-alpha", validity: "invalid" },
      items: fixture.state.models.items.slice(1),
    };
    return json(route, 200, fixture.state.models);
  }
  if (path === "/models/preferred") {
    if (fixture.state.conflictModel) {
      fixture.state.conflictModel = false;
      return failure(route, 409, "revision_conflict");
    }
    const body = request.postDataJSON() as { modelId: string };
    fixture.state.models = {
      ...fixture.state.models,
      preferredModel: { revision: 3, modelId: body.modelId, validity: "valid" },
    };
    return json(route, 200, {
      accountId: fixture.state.models.accountId,
      preferredModel: fixture.state.models.preferredModel,
    });
  }
  if (path === "/config" && request.method() === "GET") return json(route, 200, fixture.state.config);
  if (path === "/config" && fixture.state.conflictConfig) {
    fixture.state.conflictConfig = false;
    return failure(route, 409, "revision_conflict");
  }
  if (path === "/config") {
    const body = request.postDataJSON() as { config: AdminRuntimeConfig["config"] };
    fixture.state.config = {
      ...fixture.state.config,
      revision: fixture.state.config.revision + 1,
      config: body.config,
    };
    return json(route, 200, fixture.state.config);
  }
  if (path === "/history" && request.method() === "GET") return json(route, 200, fixture.state.history);
  if (path === "/history" && fixture.state.conflictHistory) {
    fixture.state.conflictHistory = false;
    fixture.state.history = { ...fixture.state.history, revision: fixture.state.history.revision + 1 };
    return failure(route, 409, "revision_conflict");
  }
  if (path === "/history") {
    fixture.state.history = {
      ...fixture.state.history,
      revision: fixture.state.history.revision + 1,
      count: 0,
      oldestAt: null,
      newestAt: null,
    };
    return json(route, 200, fixture.state.history);
  }
  if (path === "/events") {
    const cursor = url.searchParams.get("cursor");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const after = cursor === null ? -1 : Number(cursor);
    const remaining = fixture.state.events.filter((event) => Number(event.eventId) > after);
    const items = remaining.slice(0, limit);
    return json(route, 200, {
      items,
      nextCursor: remaining.length > limit ? items.at(-1)?.eventId ?? null : null,
    });
  }
  return failure(route, 404, "not_found");
}

function session() {
  return {
    csrfToken: "csrf-memory-only",
    idleExpiresAt: "2026-09-03T12:30:00.000Z",
    absoluteExpiresAt: "2026-09-04T00:00:00.000Z",
  };
}

function account(accountId: string, host: string, login: string): AdminAccount {
  return {
    accountId,
    host,
    numericUserId: accountId.split(":")[1]!,
    login,
    displayName: login === "octo" ? "Octo Admin" : "Enterprise Admin",
    state: "active",
    revision: 1,
    authenticatedAt: NOW,
    preferredModel: null,
  };
}

export function operationalEvent(
  eventId: number,
  kind: AdminOperationalEvent["kind"] = "gateway_started",
  severity: AdminOperationalEvent["severity"] = "info",
): AdminOperationalEvent {
  return {
    eventId: String(eventId),
    occurredAt: "2026-09-03T12:02:00.000Z",
    kind,
    severity,
    metadata: {},
  };
}

export function status(performance: "healthy" | "degraded"): AdminStatus {
  return {
    version: "0.1.0",
    uptimeMs: 600000,
    health: "ok",
    performance,
    ...(performance === "degraded" ? { degradedSince: NOW } : {}),
    performanceMetrics: [
      {
        metric: "buffered_p95_ms",
        state: performance === "degraded" ? "degraded" : "healthy",
        actual: performance === "degraded" ? 8 : 2,
        threshold: 5,
        samples: 40,
        startedAt: performance === "degraded" ? NOW : null,
      },
      { metric: "stream_event_p95_ms", state: "healthy", actual: 1, threshold: 2, samples: 40, startedAt: null },
      { metric: "checkpoint_p95_ms", state: "healthy", actual: 2, threshold: 5, samples: 40, startedAt: null },
      { metric: "event_loop_p95_ms", state: "healthy", actual: 3, threshold: 10, samples: 40, startedAt: null },
    ],
    admission: { activeRequests: 1, activeStreams: 1, queuedRequests: 0, activeMax: 4, queueMax: 16 },
    storage: { historyCount: 12, usageBucketCount: 3, eventCount: 1 },
    telemetry: { pendingMutations: 0, droppedUsageUpdates: 0, droppedOperationalEvents: 0 },
    daemon: { managed: true, pid: 1234, startedAt: NOW },
  };
}

function runtimeConfig(): AdminRuntimeConfig {
  const config = {
    limits: {
      requestBodyBytes: 33554432,
      sseEventBytes: 4194304,
      nonstreamBodyBytes: 33554432,
      accumulatorBytes: 33554432,
    },
    admission: { activeMax: 4, queueMax: 16 },
    timeouts: {
      queueMs: 30000,
      connectMs: 30000,
      firstByteMs: 120000,
      streamIdleMs: 120000,
      totalMs: 1800000,
    },
    accounts: { maxAuthenticated: 8 },
    history: { ttlDays: 7 },
    usage: { retentionDays: 90 },
    events: { retentionDays: 7 },
  };
  const ranges: Record<string, { min: number; max: number; unit: string }> = {};
  for (const [group, entries] of Object.entries(config)) {
    for (const key of Object.keys(entries)) {
      ranges[`${group}.${key}`] = { min: 0, max: 99999999, unit: key.endsWith("Ms") ? "ms" : "count" };
    }
  }
  return { revision: 7, config, ranges };
}

export function sse(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

async function json(route: Route, statusCode: number, data: unknown): Promise<void> {
  await route.fulfill({
    status: statusCode,
    contentType: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store", "x-request-id": "fixture-request" },
    body: JSON.stringify({ data }),
  });
}

async function failure(route: Route, statusCode: number, code: string): Promise<void> {
  await route.fulfill({
    status: statusCode,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      error: { code, message: code.replaceAll("_", " "), requestId: "fixture-request" },
    }),
  });
}
