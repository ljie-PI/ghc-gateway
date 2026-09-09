import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createAdminModule } from "../../src/admin/routes.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import { SqliteAdminTelemetry, type AdminUsagePage } from "../../src/telemetry/admin.js";
import { TelemetryRecorder, type UsageUpdate } from "../../src/telemetry/recorder.js";
import { adminDependencies, login } from "./admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";
const NOW = Date.parse("2027-01-29T12:00:00.000Z");
const ZERO_TOTALS = {
  requestCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0,
  cacheTokens: 0, latencySumMs: 0, latencyMaxMs: 0,
};

function usage(at: string, requestCount: number, overrides: Partial<UsageUpdate> = {}): UsageUpdate {
  return {
    occurredAtMs: Date.parse(at), accountId: "github.com/42", protocol: "openai_chat",
    resolvedModel: "gpt-test", outcome: "upstream_error", requestCount, errorCount: 1,
    inputTokens: 10, outputTokens: 5, cacheTokens: 7, latencyMs: 4,
    ...overrides,
  };
}

const BOUNDARY_USAGE = [
  usage("2027-01-01T11:59:59.999Z", 64),
  usage("2027-01-01T12:00:00.000Z", 32),
  usage("2027-01-22T11:59:59.999Z", 16),
  usage("2027-01-22T12:00:00.000Z", 8),
  usage("2027-01-28T11:59:59.999Z", 4),
  usage("2027-01-28T12:00:00.000Z", 2),
  usage("2027-01-29T11:59:59.999Z", 1),
  usage("2027-01-29T12:00:00.000Z", 128),
  usage("2027-01-29T13:00:00.000Z", 256),
];

async function createHarness(updates: readonly UsageUpdate[] = [], now = NOW) {
  const directory = await mkdtemp(path.join(tmpdir(), "ghcg-admin-usage-"));
  const db = openDatabase({
    path: path.join(directory, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(telemetryMigration)],
    nowMs: () => now,
  });
  const recorder = new TelemetryRecorder(db, () => now);
  for (const update of updates) recorder.recordUsage(update);
  await recorder.flush();
  let token = 0;
  const admin = createAdminModule({
    ...adminDependencies({ value: now }),
    telemetry: new SqliteAdminTelemetry(db, { recorder }),
    createToken: () => `usage-token-${++token}`,
  });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: directory }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_usage" });
  onTestFinished(async () => {
    await gateway.close();
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
  });
  const session = await login(gateway, admin);
  const get = (query: string, cookie = session.cookie) => gateway.fetch(new Request(
    `${ORIGIN}/admin/api/v1/usage?${query}`, { headers: { cookie } },
  ));
  return {
    get,
    async read(query: string): Promise<AdminUsagePage> {
      const response = await get(query);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = await response.json() as { data: AdminUsagePage };
      expect(Object.keys(body)).toEqual(["data"]);
      expect(Object.keys(body.data).sort()).toEqual(["items", "nextCursor", "totals"]);
      return body.data;
    },
  };
}

describe("Admin usage HTTP windows", () => {
  it.each([
    ["", [2, 1], { requestCount: 3, errorCount: 2, inputTokens: 20, outputTokens: 10, cacheTokens: 14, latencySumMs: 8, latencyMaxMs: 4 }],
    ["window=24h", [2, 1], { requestCount: 3, errorCount: 2, inputTokens: 20, outputTokens: 10, cacheTokens: 14, latencySumMs: 8, latencyMaxMs: 4 }],
    ["window=7d", [8, 4, 2, 1], { requestCount: 15, errorCount: 4, inputTokens: 40, outputTokens: 20, cacheTokens: 28, latencySumMs: 16, latencyMaxMs: 4 }],
    ["window=28d", [32, 16, 8, 4, 2, 1], { requestCount: 63, errorCount: 6, inputTokens: 60, outputTokens: 30, cacheTokens: 42, latencySumMs: 24, latencyMaxMs: 4 }],
  ] as const)("uses server time and inclusive/exclusive hourly boundaries for '%s'", async (query, counts, totals) => {
    const harness = await createHarness(BOUNDARY_USAGE);
    const page = await harness.read(query);
    expect(page.items.map((item) => item.requestCount)).toEqual(counts);
    expect(page.nextCursor).toBeNull();
    expect(page.totals).toEqual(totals);
  });

  it("preserves bucket-start comparisons when server time is between hours", async () => {
    const harness = await createHarness([
      usage("2027-01-28T12:45:00.000Z", 100),
      usage("2027-01-28T13:00:00.000Z", 2),
      usage("2027-01-29T12:15:00.000Z", 3),
      usage("2027-01-29T13:00:00.000Z", 100),
    ], Date.parse("2027-01-29T12:30:00.000Z"));
    for (const query of ["", "window=24h"]) {
      const page = await harness.read(query);
      expect(page.items.map((item) => item.utcHour)).toEqual([
        "2027-01-28T13:00:00.000Z", "2027-01-29T12:00:00.000Z",
      ]);
      expect(page.totals).toEqual({
        requestCount: 5, errorCount: 2, inputTokens: 20, outputTokens: 10,
        cacheTokens: 14, latencySumMs: 8, latencyMaxMs: 4,
      });
    }
  });

  it("returns zero totals for empty retained data in every window", async () => {
    const harness = await createHarness();
    for (const query of ["", "window=24h", "window=7d", "window=28d"]) {
      expect(await harness.read(query)).toEqual({ items: [], nextCursor: null, totals: ZERO_TOTALS });
    }
  });

  it("totals all filtered buckets independently of limit and cursor", async () => {
    const harness = await createHarness([
      usage("2027-01-28T12:00:00.000Z", 2),
      usage("2027-01-29T11:00:00.000Z", 3),
      usage("2027-01-28T12:00:00.000Z", 100, { accountId: "github.com/99" }),
      usage("2027-01-28T12:00:00.000Z", 100, { protocol: "anthropic" }),
      usage("2027-01-28T12:00:00.000Z", 100, { resolvedModel: "other-model" }),
      usage("2027-01-28T12:00:00.000Z", 100, { outcome: "success", errorCount: 0 }),
    ]);
    const query = "window=7d&limit=1&accountId=github.com%2F42&protocol=openai_chat&resolvedModel=gpt-test&outcome=upstream_error";
    const totals = {
      requestCount: 5, errorCount: 2, inputTokens: 20, outputTokens: 10,
      cacheTokens: 14, latencySumMs: 8, latencyMaxMs: 4,
    };
    const first = await harness.read(query);
    expect(first.items).toEqual([{
      utcHour: "2027-01-28T12:00:00.000Z", accountId: "github.com/42", protocol: "openai_chat",
      resolvedModel: "gpt-test", outcome: "upstream_error", requestCount: 2, errorCount: 1,
      inputTokens: 10, outputTokens: 5, cacheTokens: 7, latencySumMs: 4, latencyMaxMs: 4,
    }]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.totals).toEqual(totals);
    const second = await harness.read(`${query}&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ utcHour: "2027-01-29T11:00:00.000Z", requestCount: 3 });
    expect(second.nextCursor).toBeNull();
    expect(second.totals).toEqual(totals);
    expect(await harness.read("window=28d&accountId=github.com%2Fmissing")).toEqual({
      items: [], nextCursor: null, totals: ZERO_TOTALS,
    });
  });

  it("preserves explicit from/to defaults and the inclusive 90-day lower bound", async () => {
    const harness = await createHarness(BOUNDARY_USAGE);
    for (const [query, counts] of [
      ["from=2027-01-22T12:00:00.000Z", [8, 4, 2, 1]],
      ["to=2027-01-29T11:00:00.000Z", [2]],
      ["from=2027-01-22T12:00:00.000Z&to=2027-01-28T12:00:00.000Z", [8, 4]],
      ["from=2026-10-31T12:00:00.000Z", [64, 32, 16, 8, 4, 2, 1]],
    ] as const) {
      expect((await harness.read(query)).items.map((item) => item.requestCount)).toEqual(counts);
    }
  });

  it("rejects invalid, duplicate, conflicting, and out-of-bounds queries without echoing input", async () => {
    const harness = await createHarness();
    for (const query of [
      "window", "window=", "window=1d", "window=90d", "window=24H", "window=%2024h", "window=private-input",
      "window=24h&window=24h", "window=7d&window=28d", "window=24h&%77indow=7d",
      "window=24h&from=2027-01-28T12:00:00.000Z", "window=7d&to=2027-01-29T12:00:00.000Z",
      "window=28d&from=2027-01-01T12:00:00.000Z&to=2027-01-29T12:00:00.000Z",
      "window=24h&from=", "window=24h&to=", "window=24h&from=invalid",
      "from=2026-10-31T11:59:59.999Z", "to=2027-01-29T12:00:00.001Z",
      "from=2027-01-29T12:00:00.000Z", "from=2027-01-29T13:00:00.000Z",
      "window=24h&limit=0", "window=7d&limit=501", "window=28d&limit=1&limit=2",
      "window=24h&cursor=bad", "window=24h&protocol=invalid", "window=7d&outcome=invalid",
      "window=28d&accountId=", "window=28d&resolvedModel=", "window=7d&now=2027-01-01T00:00:00.000Z",
    ]) {
      const response = await harness.get(query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: { code: "validation_failed", message: "validation failed", requestId: "req_admin_usage" },
      });
    }
  });

  it("requires an Admin Session for every relative window", async () => {
    const harness = await createHarness(BOUNDARY_USAGE);
    for (const query of ["", "window=24h", "window=7d", "window=28d"]) {
      const response = await harness.get(query, "");
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: { code: "unauthenticated", message: "unauthenticated", requestId: "req_admin_usage" },
      });
    }
  });
});
