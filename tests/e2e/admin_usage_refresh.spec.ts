import { expect, test, type Page } from "@playwright/test";
import { ADMIN_FIXTURE_NOW_MS, installAdminFixture, sse, status, type AdminFixture } from "./fixtures/admin_fixture.js";
import type { AdminUsagePage } from "../../web/src/types.js";

test.use({ locale: "en-US" });

async function openAccounts(page: Page): Promise<AdminFixture> {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=refresh-fixture");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  return fixture;
}

test("Overview, Accounts and Models use the same black Refresh control", async ({ page }) => {
  await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=refresh-controls");
  for (const view of ["Overview", "Accounts", "Models"]) {
    await page.getByRole("navigation").getByRole("button", { name: view, exact: true }).click();
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveCSS("background-color", "rgb(32, 29, 29)");
    await expect(refresh).toHaveCSS("color", "rgb(253, 252, 252)");
    await expect(page.getByRole("button", { name: "Refresh catalog", exact: true })).toHaveCount(0);
  }
});

test("manual Accounts refresh dismisses a success notice without erasing the original action result", async ({ page }) => {
  const fixture = await openAccounts(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Account removed.");
  await page.clock.fastForward(60_000);
  await expect(page.getByRole("status")).toHaveText("Account removed.");
  fixture.state.accountsDelayMs = 300;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  expect(fixture.state.accounts.items[0]?.state).toBe("removed");
});

test("manual refresh dismisses old action failures but reports a new refresh failure", async ({ page }) => {
  const fixture = await openAccounts(page);
  fixture.state.failAccountRemoval = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("internal error");
  await expect(page.getByText("removing", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.route("**/admin/api/v1/accounts", (route) => route.fulfill({
    status: 503, json: { error: { code: "upstream_unavailable", requestId: "synthetic" } },
  }), { times: 1 });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("upstream unavailable");
});

test("refresh clears copied feedback without canceling device authorization", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => undefined } });
  });
  const fixture = await openAccounts(page);
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  await page.getByRole("button", { name: "Copy device code", exact: true }).click();
  await expect(page.getByText("Code copied.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Code copied.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
  fixture.state.deviceNowMs += 5000;
  await page.clock.fastForward(5000);
  await expect.poll(() => fixture.requests.filter((request) => request.method() === "GET"
    && request.url().endsWith("/device-flows/flow-1")).length).toBe(1);
  expect(fixture.requests.some((request) => request.method() === "DELETE"
    && request.url().includes("/device-flows/"))).toBe(false);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`pre-refresh clipboard ${outcome} cannot restore dismissed feedback`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: {
        writeText: () => new Promise<void>((resolve, reject) => {
          window.addEventListener("finish-copy", (event) => {
            if ((event as CustomEvent<string>).detail === "resolve") resolve();
            else reject(new Error("synthetic clipboard failure"));
          }, { once: true });
        }),
      } });
    });
    await openAccounts(page);
    await page.getByRole("button", { name: "Start login", exact: true }).click();
    const copy = page.getByRole("button", { name: "Copy device code", exact: true });
    await copy.click();
    await expect(copy).toBeDisabled();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent("finish-copy", { detail: value })), outcome);
    await expect(copy).toBeEnabled();
    await expect(page.getByText("Code copied.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Could not copy. Select and copy the code manually.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
  });
}

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
  await page.goto("/admin/#bootstrap_token=usage-windows");
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

test("Overview waits for every usage window before enabling another refresh", async ({ page }) => {
  await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=usage-pending");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toBeEnabled();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/usage\?limit=1&window=28d$/u, async (route) => {
    await pending;
    await route.fulfill({ json: { data: usage(3) } });
  }, { times: 1 });
  try {
    await refresh.click();
    await expect(page.getByLabel("Loading overview", { exact: true })).toBeVisible();
    await expect(refresh).toBeDisabled();
    await expect(page.getByRole("region", { name: "Last 24 hours", exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("region", { name: "Last 28 days", exact: true }).locator(".stat-row strong"))
    .toHaveText(["42", "2", "2,000,000", "300,000", "3"]);
});

for (const [exit, endpoint] of [
  ["failure", "/status"], ["failure", "/usage?limit=1&window=28d"],
  ["navigation", "/status"], ["navigation", "/usage?limit=1&window=28d"],
] as const) {
  test(`Overview cancels unfinished ${endpoint} on ${exit} without blocking later loads`, async ({ page }) => {
    const fixture = await installAdminFixture(page);
    await page.goto("/admin/#bootstrap_token=usage-cancellation");
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

for (const width of [1440, 900, 390]) {
  for (const cacheTokens of [0, 987654]) {
    test(`Overview cache totals use all buckets at ${width}px with ${cacheTokens} cache tokens`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await installAdminFixture(page);
      await page.route(/\/admin\/api\/v1\/usage(?:\?|$)/u, (route) => route.fulfill({ json: { data: usage(cacheTokens) } }));
      await page.goto("/admin/#bootstrap_token=usage-fixture");
      const stats = page.getByRole("region", { name: "Last 24 hours", exact: true }).locator(".stat-row");
      await expect(stats.locator(":scope > div")).toHaveCount(5);
      const cache = stats.locator("div").filter({ has: page.getByText("Cache tokens", { exact: true }) });
      await expect(cache.locator("strong")).toHaveText(cacheTokens.toLocaleString("en-US"));
      await expect(cache.locator("span")).toHaveAttribute("title", /read.*write.*included in input/iu);
      await expect(stats.locator("div").filter({ has: page.getByText("Input tokens", { exact: true }) }).locator("strong")).toHaveText("2,000,000");
      await expect(stats.locator("div").filter({ has: page.getByText("Output tokens", { exact: true }) }).locator("strong")).toHaveText("300,000");
      await expect(page.getByText("Last 24 hours", { exact: true })).toBeVisible();
      await expect(page.getByText("Content-free totals for the last 24 hours.", { exact: true })).toHaveCount(0);
      await expect(page.locator(".chip").filter({ hasText: /buckets/u })).toHaveCount(0);
      const boxes = await stats.locator(":scope > div").evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, left: box.left, right: box.right, width: box.width };
      }));
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
        const row = boxes.filter((candidate) => Math.abs(candidate.top - box.top) <= 1);
        expect(Math.abs(box.width - row[0]!.width)).toBeLessThanOrEqual(1);
        if (width > 1100) expect(Math.abs(box.top - boxes[0]!.top)).toBeLessThanOrEqual(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(fixture.requests.filter((request) => request.url().includes("cursor="))).toHaveLength(0);
      if (cacheTokens > 0) await page.screenshot({ path: testInfo.outputPath(`overview-${width}.png`), fullPage: true });
    });
  }
}

test("Overview refresh clears a previous failure while retaining genuine state warnings", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.failStatus = true;
  fixture.state.status = status("degraded");
  fixture.state.streamBodies = [sse("performance", { kind: "performance", status: fixture.state.status })];
  await page.goto("/admin/#bootstrap_token=overview-refresh");
  await expect(page.getByRole("alert")).toContainText("Overview unavailable");
  fixture.state.failStatus = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Usage ledger", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toBeVisible();
});
