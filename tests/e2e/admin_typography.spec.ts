import { expect, test, type Page } from "@playwright/test";
import { ADMIN_FIXTURE_NOW_MS, installAdminFixture, operationalEvent } from "./fixtures/admin_fixture.js";

test.use({ locale: "en-US" });

async function expectReadableText(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const failures: { element: string; size: string; kind: string }[] = [];
    const inspect = (element: Element, style: CSSStyleDeclaration, kind: string): void => {
      if (Number.parseFloat(style.fontSize) < 12) failures.push({ element: element.tagName, size: style.fontSize, kind });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const element = node.parentElement;
      if (!node.textContent?.trim() || element === null || element.closest("script, style, svg") || !element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "visible") inspect(element, style, "text");
    }
    for (const element of document.querySelectorAll("*")) {
      if (!element.getClientRects().length || getComputedStyle(element).visibility !== "visible") continue;
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (!["none", "normal", "\"\""].includes(style.content)) inspect(element, style, pseudo);
      }
      if (element.matches("input, select, textarea, button")) inspect(element, getComputedStyle(element), "control");
      if (element.hasAttribute("placeholder")) inspect(element, getComputedStyle(element, "::placeholder"), "placeholder");
    }
    return failures;
  });
  expect(failures, "all rendered text, generated labels and placeholders meet the 12px floor").toEqual([]);
}

async function expectContainedControls(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    window.scrollTo({ left: 10000 });
    const rootScrollX = window.scrollX;
    window.scrollTo({ left: 0 });
    const clipped = [...document.querySelectorAll<HTMLElement>("button, .button, .brand, .device-code code, h1")]
      .filter((element) => element.getClientRects().length > 0 && element.clientWidth > 0
        && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1))
      .map((element) => ({ tag: element.tagName, classes: element.className }));
    return { rootScrollX, clipped };
  });
  expect(overflow).toEqual({ rootScrollX: 0, clipped: [] });
}

async function expectNavigationSettled(page: Page): Promise<void> {
  if (!(await page.getByRole("button", { name: "Open navigation" }).isVisible())) return;
  await expect.poll(() => page.locator("#admin-navigation").evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
}

for (const width of [1440, 1100, 900, 851, 850, 601, 600, 390, 320]) {
  test(`Admin typography remains readable and unclipped at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
    const fixture = await installAdminFixture(page);
    const first = fixture.state.accounts.items[0]!;
    fixture.state.accounts = { ...fixture.state.accounts, items: [first, {
      ...first, accountId: "ghes:2", host: "github.example.test", login: "enterprise", displayName: "Enterprise Admin",
    }] };
    fixture.state.events = [{ ...operationalEvent(1), metadata: { source: "synthetic ".repeat(30) } }];
    await page.goto("/admin/#bootstrap_token=typography-fixture");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("font-size", "16px");
    await expect(page.locator(".brand strong")).toHaveCSS("font-size", "20px");
    for (const item of await page.locator(".nav-item").all()) await expect(item).toHaveCSS("font-size", "18px");

    for (const view of ["Overview", "Accounts", "Models", "Configuration", "Events"]) {
      const menu = page.getByRole("button", { name: "Open navigation" });
      if (await menu.isVisible()) await menu.click();
      const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
      expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.getByRole("navigation").getByRole("button", { name: view, exact: true }).click();
      const title = page.getByRole("heading", { name: view, exact: true });
      await expect(title).toBeFocused();
      expect(await title.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(32);
      if (view === "Overview") {
        await expect(page.locator(".stat-row")).toHaveCount(3);
        for (const row of await page.locator(".stat-row").all()) await expect(row).toBeVisible();
        await expect(page.locator(".hero-metrics article > strong").first()).toHaveCSS("font-size", "32px");
        await expect(page.locator(".stat-row strong").first()).toHaveCSS("font-size", "20px");
      }
      if (view === "Configuration") await expect(page.locator(".config-form")).toBeVisible();
      if (view === "Accounts") {
        await page.getByRole("button", { name: "Start login", exact: true }).click();
        await expect(page.locator(".device-code code")).toHaveCSS("font-size", "28px");
        const chosen = await page.getByRole("button", { name: "In use", exact: true }).boundingBox();
        const other = await page.getByRole("button", { name: "Use this account", exact: true }).boundingBox();
        expect(chosen).not.toBeNull();
        expect(other).not.toBeNull();
        expect(chosen!.width).toBeCloseTo(other!.width, 0);
        expect(chosen!.height).toBeCloseTo(other!.height, 0);
        expect(chosen!.height).toBeGreaterThanOrEqual(44);
        const verification = await page.getByRole("link", { name: "Open verification page" }).boundingBox();
        expect(verification).not.toBeNull();
        expect(verification!.height).toBeGreaterThanOrEqual(44);
      }
      if (view === "Models") {
        await page.getByText("About sources and token limits", { exact: true }).click();
        await page.getByText("Capability details", { exact: true }).first().click();
        await expect(page.locator("td").first()).toHaveCSS("font-size", "14px");
        const details = page.locator(".model-details[open]").first();
        await expect(details.locator("input, select, textarea")).toHaveCount(0);
        const budget = details.locator("dl > div")
          .filter({ has: page.getByText("Chat budget field", { exact: true }) }).locator("dd");
        await expect(budget).toBeVisible();
        await expect(budget).toContainText("max_tokens");
        const budgetTextFits = await budget.evaluate((element) => (
          element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1
        ));
        expect(budgetTextFits, "read-only Chat budget metadata remains readable without clipping").toBe(true);
      }
      if (view === "Events") await page.getByRole("list", { name: "Operational events" }).locator("summary").first().click();
      if (await page.locator("h2").count()) await expect(page.locator("h2").first()).toHaveCSS("font-size", "20px");
      await expectReadableText(page);
      await expectContainedControls(page);
      await expectNavigationSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`${view.toLowerCase()}-${width}.png`), fullPage: true });
      if (view === "Accounts") await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });
}

for (const width of [851, 601]) {
  test(`Configuration labels do not overlap inputs at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installAdminFixture(page);
    await page.goto("/admin/#bootstrap_token=config-typography");
    const menu = page.getByRole("button", { name: "Open navigation" });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole("navigation").getByRole("button", { name: "Configuration", exact: true }).click();
    await expect(page.locator(".config-form")).toBeVisible();
    const collisions = await page.locator(".config-grid label").evaluateAll((labels) => labels.flatMap((label, index) => {
      const input = label.querySelector("input")!.getBoundingClientRect();
      const walker = document.createTreeWalker(label.querySelector("span")!, NodeFilter.SHOW_TEXT);
      const collisions: { index: number; width: number }[] = [];
      let text: Node | null;
      while ((text = walker.nextNode()) !== null) {
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          const width = Math.min(rect.right, input.right) - Math.max(rect.left, input.left);
          const height = Math.min(rect.bottom, input.bottom) - Math.max(rect.top, input.top);
          if (width > 1 && height > 1) collisions.push({ index, width });
        }
      }
      return collisions;
    }));
    await expectNavigationSettled(page);
    await page.screenshot({ path: testInfo.outputPath(`configuration-boundary-${width}.png`), fullPage: true });
    expect(collisions, "larger labels and descriptions do not intersect input controls").toEqual([]);
  });
}

test("loading, signed-out, empty and error states preserve the font minimum", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeVisible();
  await expectReadableText(page);
  await expectContainedControls(page);

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/admin/api/v1/auth/bootstrap", async (route) => { await pending; await route.fallback(); }, { times: 1 });
  await page.evaluate(() => { location.hash = "bootstrap_token=loading-typography"; });
  const loading = page.getByRole("button", { name: "Try current session" }).click();
  try {
    await expect(page.getByRole("heading", { name: "Establishing a secure session" })).toBeVisible();
    await expectReadableText(page);
    await expectContainedControls(page);
  } finally { release(); }
  await loading;
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  fixture.state.accounts = { ...fixture.state.accounts, defaultAccountId: null, items: [] };
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();
  await expectReadableText(page);
  await expectContainedControls(page);
  fixture.state.failStatus = true;
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectReadableText(page);
  await expectContainedControls(page);
});
