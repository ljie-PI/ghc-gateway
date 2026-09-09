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

test("manual Accounts refresh dismisses a success notice without erasing the original action result", async ({ page }) => {
  const fixture = await openAccounts(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
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
      const stats = page.locator(".stat-row");
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
