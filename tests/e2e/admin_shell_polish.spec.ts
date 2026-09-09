import { expect, test } from "@playwright/test";
import { installAdminFixture, operationalEvent } from "./fixtures/admin_fixture.js";

test("global header and footer are removed without losing session logout", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=shell-fixture");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  await expect(page.getByText("ADMIN / OVERVIEW", { exact: true })).toHaveCount(0);
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  await sidebar.getByRole("button", { name: "End session" }).click();
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
  expect(fixture.requests.filter((request) => request.url().endsWith("/auth/logout"))).toHaveLength(1);
});

test("desktop sidebar stays anchored during page scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installAdminFixture(page);
  fixture.state.events = Array.from({ length: 80 }, (_, index) => operationalEvent(index + 1));
  await page.goto("/admin/#bootstrap_token=scroll-fixture");
  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.getByRole("list", { name: "Operational events" }).getByRole("listitem")).toHaveCount(80);
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  const before = await sidebar.boundingBox();
  expect(before).not.toBeNull();
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  const after = await sidebar.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
  await expect(sidebar.getByRole("button", { name: "End session" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("desktop-scrolled.png") });
});

test("short desktop and mobile navigation keep all actions reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 320 });
  await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=short-fixture");
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  const logout = sidebar.getByRole("button", { name: "End session" });
  await logout.scrollIntoViewIfNeeded();
  await expect(logout).toBeInViewport();
  const overview = sidebar.getByRole("button", { name: "Overview" });
  await overview.scrollIntoViewIfNeeded();
  await expect(overview).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 720 });
  const menu = page.getByRole("button", { name: "Open navigation" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(overview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(page.locator("#admin-navigation")).toHaveAttribute("inert", "");
  await menu.click();
  await logout.click();
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
});
