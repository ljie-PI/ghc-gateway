import { expect, test } from "@playwright/test";
import { installAdminFixture } from "./fixtures/admin_fixture.js";
import type { AdminUsagePage } from "../../web/src/types.js";

test.use({ locale: "en-US" });


test("Overview shows three cumulative windows from totals and refreshes without hiding missing data", async ({ page }) => {
  await page.clock.install({ time: Date.parse("2040-01-01T00:00:00Z") });
  await installAdminFixture(page);
  const totals = {
    "24h": { requestCount: 42, errorCount: 2, inputTokens: 2000000, outputTokens: 300000, cacheTokens: 987654 },
    "7d": { requestCount: 99, errorCount: 4, inputTokens: 4000000, outputTokens: 500000, cacheTokens: 1987654 },
    "28d": { requestCount: 500, errorCount: 9, inputTokens: 9000000, outputTokens: 800000, cacheTokens: 2987654 },
  };
  const queries: URLSearchParams[] = [];
  let missingWeek = false;
  let empty = false;
  await page.route(/\/admin\/api\/v1\/usage(?:\?|$)/u, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const window = query.get("window") as keyof typeof totals;
    if (!(window in totals) || (missingWeek && window === "7d")) {
      await route.fulfill({ status: 503, json: { error: { code: "upstream_unavailable", requestId: "synthetic" } } });
      return;
    }
    const pageData = usage(3);
    await route.fulfill({ json: { data: { ...pageData, totals: { ...pageData.totals,
      ...(empty ? { requestCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 } : totals[window]),
    } } } });
  });
  await page.goto("/");
  const expectations = [
    ["Last 24 hours", ["42", "2", "2,000,000", "300,000", "987,654"]],
    ["Last 7 days", ["99", "4", "4,000,000", "500,000", "1,987,654"]],
    ["Last 28 days", ["500", "9", "9,000,000", "800,000", "2,987,654"]],
  ] as const;
  for (const [label, values] of expectations) {
    await expect(page.getByRole("region", { name: label, exact: true }).locator(".stat-row strong")).toHaveText([...values]);
  }
  expect(queries.map((query) => query.get("window")).sort()).toEqual(["24h", "28d", "7d"]);
  for (const query of queries) {
    expect(query.has("from") || query.has("to") || query.has("cursor")).toBe(false);
    expect(query.get("limit")).toBe("1");
  }
  await expect(page.getByText("Only retained hourly usage buckets are included.", { exact: true })).toBeVisible();
  missingWeek = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Overview unavailable");
  await expect(page.getByRole("region", { name: "Last 7 days", exact: true })).toHaveCount(0);
  missingWeek = false;
  empty = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  for (const [label] of expectations) {
    await expect(page.getByRole("region", { name: label, exact: true }).locator(".stat-row strong"))
      .toHaveText(["0", "0", "0", "0", "0"]);
  }
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(queries).toHaveLength(9);
});

for (const [exit, endpoint] of [
  ["failure", "/status"], ["failure", "/usage?limit=1&window=28d"],
  ["navigation", "/status"], ["navigation", "/usage?limit=1&window=28d"],
] as const) {
  test(`Overview cancels unfinished ${endpoint} on ${exit} without blocking later loads`, async ({ page }) => {
    const fixture = await installAdminFixture(page);
    await page.goto("/");
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await expect(refresh).toBeEnabled();
    let release!: () => void;
    let started!: () => void;
    let finished!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const requestFinished = new Promise<void>((resolve) => { finished = resolve; });
    let aborted = 0;
    page.on("requestfailed", (request) => {
      if (request.url().endsWith(endpoint)) aborted += 1;
    });
    await page.route((url) => url.pathname + url.search === `/admin/api/v1${endpoint}`, async (route) => {
      started();
      await pending;
      try {
        await route.fulfill({ json: { data: endpoint === "/status" ? fixture.state.status : usage(987654) } });
      } finally { finished(); }
    }, { times: 1 });
    if (exit === "failure") {
      await page.route(/\/usage\?limit=1&window=7d$/u, async (route) => {
        await requestStarted;
        await route.fulfill({ status: 503, json: { error: { code: "upstream_unavailable", requestId: "synthetic" } } });
      }, { times: 1 });
    }
    try {
      await refresh.click();
      await requestStarted;
      if (exit === "failure") {
        await expect(page.getByRole("alert")).toContainText("upstream unavailable");
      } else {
        await page.getByRole("navigation").getByRole("button", { name: "Accounts", exact: true }).click();
        await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
      }
      await expect.poll(() => aborted).toBe(1);
      if (exit === "failure") await refresh.click();
      else await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
      const stats = page.getByRole("region", { name: "Last 28 days", exact: true }).locator(".stat-row strong");
      await expect(stats).toHaveText(["42", "2", "12,000", "3,400", "800"]);
      release();
      await requestFinished;
      await expect(stats).toHaveText(["42", "2", "12,000", "3,400", "800"]);
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally { release(); }
  });
}

function usage(cacheTokens: number): AdminUsagePage {
  return {
    items: [{ utcHour: "2026-09-03T12:00:00.000Z", accountId: "github:1", protocol: "openai_chat",
      resolvedModel: "synthetic", outcome: "success", requestCount: 1, errorCount: 0,
      inputTokens: 7, outputTokens: 2, cacheTokens: cacheTokens === 0 ? 0 : 3, latencySumMs: 2, latencyMaxMs: 2 }],
    nextCursor: "synthetic-next-page",
    totals: { requestCount: 42, errorCount: 2, inputTokens: 2000000, outputTokens: 300000,
      cacheTokens, latencySumMs: 900, latencyMaxMs: 120 },
  };
}
