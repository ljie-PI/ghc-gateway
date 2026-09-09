import { expect, test, type Page } from "@playwright/test";
import {
  ADMIN_FIXTURE_NOW_MS,
  installAdminFixture,
  type AdminFixture,
} from "./fixtures/admin_fixture.js";

async function openAccounts(page: Page): Promise<AdminFixture> {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=synthetic-accounts-bootstrap");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  return fixture;
}

async function advance(page: Page, fixture: AdminFixture, milliseconds: number): Promise<void> {
  fixture.state.deviceNowMs += milliseconds;
  await page.clock.fastForward(milliseconds);
}

async function connectSecondAccount(page: Page, fixture: AdminFixture): Promise<void> {
  fixture.state.devicePollStates = ["complete"];
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
  await advance(page, fixture, 5_000);
  await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();
}

async function expectNoConnectionBanner(page: Page): Promise<void> {
  await expect(page.locator(".notice").filter({ hasText: /Connected @|Account in use|Account is now in use/ }))
    .toHaveCount(0);
}

for (const width of [1440, 1100, 390, 320]) {
  test(`Accounts row contents align before and after selection at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await openAccounts(page);
    await connectSecondAccount(page, fixture);
    const rows = page.locator(".account-table tbody > tr");
    await expect(rows).toHaveCount(2);
    const positions = () => rows.evaluateAll((elements) => elements.map((row) => {
      const left = row.getBoundingClientRect().left;
      const selectors = [".avatar", ".identity strong", ".identity small", "[data-label='Authorization'] .badge", ".account-choice", ".remove-account"];
      const coordinates = selectors.map((selector) => row.querySelector(selector)!.getBoundingClientRect().left - left);
      const range = document.createRange();
      range.selectNodeContents(row.querySelector("[data-label='Authenticated']")!);
      return [...coordinates, range.getBoundingClientRect().left - left];
    }));
    const before = await positions();
    for (const [index, x] of before[0]!.entries()) {
      expect(Math.abs(x - before[1]![index]!), `column content ${index} is aligned`).toBeLessThanOrEqual(1);
    }
    await expect(page.locator(".account-table tr:not(.current-row) > td:first-child"))
      .toHaveCSS("border-left-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".account-table tr.current-row > td:first-child"))
      .toHaveCSS("border-left-color", "rgb(38, 119, 72)");
    await page.getByRole("button", { name: "Use this account", exact: true }).click();
    await expect(rows.nth(1).getByRole("button", { name: "In use", exact: true })).toBeDisabled();
    const after = await positions();
    for (const [index, x] of after[0]!.entries()) {
      expect(Math.abs(x - after[1]![index]!), `column content ${index} remains aligned`).toBeLessThanOrEqual(1);
      expect(Math.abs(x - before[0]![index]!), `selection does not move column content ${index}`).toBeLessThanOrEqual(1);
    }
    await page.locator(".account-table").screenshot({ path: testInfo.outputPath(`account-row-alignment-${width}.png`) });
  });
}

for (const width of [1440, 390]) {
  test(`Accounts heading and equal-sized selection controls at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await openAccounts(page);
    await connectSecondAccount(page, fixture);
    const eyebrow = await page.getByText("DEVICE AUTHORIZATION", { exact: true }).boundingBox();
    const heading = await page.getByRole("heading", { name: "Connect an account" }).boundingBox();
    expect(eyebrow).not.toBeNull();
    expect(heading).not.toBeNull();
    expect(Math.abs(eyebrow!.x - heading!.x)).toBeLessThanOrEqual(1);
    expect(heading!.y).toBeGreaterThanOrEqual(eyebrow!.y + eyebrow!.height);
    const selected = page.getByRole("row").filter({ hasText: "Octo Admin" });
    const other = page.getByRole("row").filter({ hasText: "Enterprise Admin" });
    const inUse = selected.getByRole("button", { name: "In use", exact: true });
    const use = other.getByRole("button", { name: "Use this account", exact: true });
    await expect(inUse).toBeDisabled();
    const selectedBox = await inUse.boundingBox();
    const useBox = await use.boundingBox();
    expect(selectedBox).not.toBeNull();
    expect(useBox).not.toBeNull();
    expect(selectedBox!.width).toBeCloseTo(useBox!.width, 0);
    expect(selectedBox!.height).toBeCloseTo(useBox!.height, 0);
    await expect(inUse).toHaveCSS("background-color", "rgb(38, 119, 72)");
    expect(await selected.evaluate((row) => getComputedStyle(row).backgroundColor))
      .not.toBe(await other.evaluate((row) => getComputedStyle(row).backgroundColor));
    const remove = other.getByRole("button", { name: "Remove", exact: true });
    await expect(remove).toHaveCSS("background-color", "rgb(180, 41, 32)");
    await expect(remove).toHaveCSS("border-top-style", "solid");
    await expect(page.getByText("Requests already running keep their", { exact: false })).toHaveCount(0);
    await expectNoConnectionBanner(page);
    expect(fixture.state.accounts.defaultAccountId).toBe("github:1");
    expect(fixture.requests.filter((request) => request.url().endsWith("/accounts/default"))).toHaveLength(0);
    await use.click();
    await expect(other.getByRole("button", { name: "In use", exact: true })).toBeDisabled();
    await expect(selected.getByRole("button", { name: "Use this account", exact: true })).toBeEnabled();
    await expectNoConnectionBanner(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
    await page.getByRole("button", { name: "Start login", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy device code", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`accounts-${width}.png`), fullPage: true });
  });
}

test("removed tombstones stay hidden on refresh/reload and all-removed is empty", async ({ page }) => {
  const fixture = await openAccounts(page);
  await connectSecondAccount(page, fixture);
  const enterprise = page.getByRole("row").filter({ hasText: "Enterprise Admin" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await enterprise.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(enterprise).toBeVisible();
  expect(fixture.requests.filter((request) => request.method() === "DELETE"
    && request.url().includes("/accounts/"))).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await enterprise.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(enterprise).toHaveCount(0);
  expect(fixture.state.accounts.items.find((account) => account.accountId === "ghes:2")?.state).toBe("removed");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  await expect(enterprise).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  await expect(enterprise).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  expect(fixture.state.accounts.items.every((account) => account.state === "removed")).toBe(true);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("failed cleanup remains visible with error and retry using refreshed revision", async ({ page }) => {
  const fixture = await openAccounts(page);
  fixture.state.failAccountRemoval = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("internal error");
  const row = page.getByRole("row").filter({ hasText: "Octo Admin" });
  await expect(row.getByText("removing", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toHaveCount(0);
  const revision = fixture.state.accounts.items[0]!.revision;
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.requests.findLast((request) => request.method() === "DELETE"
    && request.url().includes("/accounts/"))?.postDataJSON()).toEqual({ expectedRevision: revision });
});

test("no explicit default remains a warning without automatically selecting a row", async ({ page }) => {
  const fixture = await openAccounts(page);
  fixture.state.accounts = { ...fixture.state.accounts, defaultAccountId: null };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("No account is explicitly selected.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "In use", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use this account", exact: true })).toBeEnabled();
  expect(fixture.requests.filter((request) => request.url().endsWith("/accounts/default"))).toHaveLength(0);
});

test("copy icon writes the exact synthetic code through the browser Clipboard with safe feedback", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await openAccounts(page);
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  const copy = page.getByRole("button", { name: "Copy device code", exact: true });
  await expect(copy.locator("svg")).toHaveAttribute("aria-hidden", "true");
  const code = page.getByText("ABCD-1234", { exact: true });
  const codeBox = await code.boundingBox();
  const copyBox = await copy.boundingBox();
  expect(codeBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(copyBox!.x).toBeGreaterThanOrEqual(codeBox!.x + codeBox!.width);
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Code copied." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("ABCD-1234");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
  expect(consoleMessages.some((message) => message.includes("ABCD-1234"))).toBe(false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await expect(page.getByText("Code copied.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Authorization canceled in this view");
  await page.evaluate(() => navigator.clipboard.writeText(""));
});

for (const mode of ["denied", "unavailable"] as const) {
  test(`clipboard ${mode} gives a safe manual-copy fallback without disturbing authorization`, async ({ page }) => {
    await page.addInitScript((clipboardMode) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboardMode === "unavailable" ? undefined : {
          writeText: () => Promise.reject(new Error("synthetic diagnostic must not be displayed")),
        },
      });
    }, mode);
    const fixture = await openAccounts(page);
    await page.getByRole("button", { name: "Start login", exact: true }).click();
    await page.getByRole("button", { name: "Copy device code", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Could not copy. Select and copy the code manually." }))
      .toBeVisible();
    await expect(page.getByText("synthetic diagnostic", { exact: false })).toHaveCount(0);
    await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy device code", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    await advance(page, fixture, 5_000);
    await expect(page.getByText("checking automatically", { exact: false })).toBeVisible();
  });
}

for (const transition of ["cancel", "replace", "dispose", "expiry", "complete"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`late clipboard ${outcome} cannot restore feedback after ${transition}`, async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: () => new Promise<void>((resolve, reject) => {
              window.addEventListener("test-clipboard-resolve", () => resolve(), { once: true });
              window.addEventListener("test-clipboard-reject", () => reject(new Error("synthetic clipboard failure")), { once: true });
            }),
          },
        });
      });
      const fixture = await openAccounts(page);
      fixture.state.devicePollStates = transition === "complete" ? ["complete"] : ["pending"];
      await page.getByRole("button", { name: "Start login", exact: true }).click();
      await page.getByRole("button", { name: "Copy device code", exact: true }).click();
      if (transition === "cancel") await page.getByRole("button", { name: "Cancel", exact: true }).click();
      if (transition === "replace") {
        await page.getByRole("button", { name: "Replace login", exact: true }).click();
        await expect(page.getByRole("button", { name: "Copy device code", exact: true })).toBeEnabled();
      }
      if (transition === "dispose") {
        await page.getByRole("button", { name: "Overview", exact: true }).click();
        await page.getByRole("button", { name: "Accounts", exact: true }).click();
        await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
      }
      if (transition === "expiry") {
        await advance(page, fixture, 600_000);
        await expect(page.getByRole("alert")).toContainText("Authorization expired");
      }
      if (transition === "complete") {
        await advance(page, fixture, 5_000);
        await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();
      }
      await page.evaluate(async (result) => {
        window.dispatchEvent(new Event(`test-clipboard-${result}`));
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }, outcome);
      await expect(page.getByText("Code copied.", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Could not copy. Select and copy the code manually.", { exact: true })).toHaveCount(0);
      await expectNoConnectionBanner(page);
      if (transition !== "replace") await expect(page.getByText("ABCD-1234", { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    });
  }
}

for (const completion of ["poll", "cancel", "replace", "expiry"] as const) {
  test(`${completion} completion retains account-refresh errors rather than success notices`, async ({ page }) => {
    const fixture = await openAccounts(page);
    fixture.state.devicePollStates = completion === "poll" ? ["complete"] : ["pending"];
    fixture.state.cancelCompletesDeviceFlow = completion !== "poll";
    await page.route("**/admin/api/v1/accounts", (route) => route.fulfill({
      status: 500,
      json: { error: { code: "internal_error", message: "synthetic private diagnostic", requestId: "synthetic" } },
    }));
    await page.getByRole("button", { name: "Start login", exact: true }).click();
    await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
    if (completion === "poll") await advance(page, fixture, 5_000);
    if (completion === "cancel") await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (completion === "replace") await page.getByRole("button", { name: "Replace login", exact: true }).click();
    if (completion === "expiry") await advance(page, fixture, 600_000);
    await expect(page.getByText("ABCD-1234", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("internal error");
    await expect(page.getByText("synthetic private diagnostic", { exact: false })).toHaveCount(0);
    await expectNoConnectionBanner(page);
    await page.unroute("**/admin/api/v1/accounts");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(fixture.state.accounts.defaultAccountId).toBe("github:1");
  });
}

test("successful deletion stays hidden even if the following account refresh fails", async ({ page }) => {
  await openAccounts(page);
  await page.route("**/admin/api/v1/accounts", (route) => route.fulfill({
    status: 500,
    json: { error: { code: "internal_error", message: "synthetic", requestId: "synthetic" } },
  }));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("internal error");
  await expect(page.getByText("Octo Admin", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
});
