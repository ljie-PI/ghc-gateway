import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_FIXTURE_NOW_MS,
  installAdminFixture,
  operationalEvent,
  sse,
  status,
} from "./fixtures/admin_fixture.js";

async function openAdmin(page: Page) {
  const fixture = await installAdminFixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  return fixture;
}

async function keyboardNavigate(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Overview" }).focus();
  await page.keyboard.press("Tab");
  if (name !== "Accounts") throw new Error("keyboardNavigate currently starts at Accounts");
  await expect(page.getByRole("button", { name })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name, exact: true })).toBeFocused();
}

async function recordAccessibilityEvidence(page: Page): Promise<void> {
  const evidence = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")];
    const accessibleName = (element: HTMLElement): string => {
      const explicitLabel = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
      const associatedLabel = element.id === "" ? "" : document.querySelector<HTMLLabelElement>(
        `label[for="${CSS.escape(element.id)}"]`,
      )?.textContent ?? "";
      return explicitLabel || associatedLabel || element.textContent?.trim() || "";
    };
    const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    return {
      standard: "WCAG-semantic-smoke",
      controls: controls.length,
      unnamedControls: controls.filter((element) => accessibleName(element) === "").map((element) => element.tagName),
      duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
      mainLandmarks: document.querySelectorAll("main").length,
      headingOneCount: document.querySelectorAll("h1").length,
    };
  });
  expect(evidence).toMatchObject({ unnamedControls: [], duplicateIds: [], mainLandmarks: 1, headingOneCount: 1 });
  const directory = path.resolve("artifacts", "ci");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "admin-accessibility.json"), `${JSON.stringify({
    ...evidence,
    passed: true,
    browser: "chromium",
    browserMemoryIncludedInDaemonRss: false,
  }, null, 2)}\n`, "utf8");
}

async function advanceDeviceClock(
  page: Page,
  fixture: Awaited<ReturnType<typeof installAdminFixture>>,
  milliseconds: number,
): Promise<void> {
  fixture.state.deviceNowMs += milliseconds;
  await page.clock.fastForward(milliseconds);
}

function devicePollRequests(fixture: Awaited<ReturnType<typeof installAdminFixture>>) {
  return fixture.requests.filter((request) => (
    request.method() === "GET" && request.url().endsWith("/device-flows/flow-1")
  ));
}

test("workspace starts directly at the listener root and opens its event stream", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  await page.goto("/");
  await expect(page).toHaveURL((url) => url.pathname === "/" && url.search === "" && url.hash === "");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect.poll(() => fixture.streamRequests.length).toBe(1);
  await recordAccessibilityEvidence(page);
});

test("github-and-ghes-account-lifecycle", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await openAdmin(page);
  await keyboardNavigate(page, "Accounts");
  await page.getByLabel("GitHub host").fill("github.example.test");
  await page.getByRole("button", { name: "Start login" }).click();
  await expect(page.getByText("ABCD-1234")).toBeVisible();
  await expect(page.getByText("checking automatically")).toBeVisible();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect.poll(() => devicePollRequests(fixture).length).toBe(1);
  await advanceDeviceClock(page, fixture, 10_000);
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Octo Admin" }).getByRole("button", { name: "In use" })).toBeDisabled();
  await expect(page.locator(".notice").filter({ hasText: "Account in use" })).toHaveCount(0);
  expect(fixture.state.accounts.defaultAccountId).toBe("github:1");
  fixture.state.conflictAccount = true;
  await page.getByRole("button", { name: "Use this account" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await page.getByRole("button", { name: "Use this account" }).click();
  fixture.state.failAccountRemoval = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("row")
    .filter({ hasText: "Enterprise Admin" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("alert")).toContainText("internal error");
  await expect(page.getByRole("row").filter({ hasText: "Enterprise Admin" }).getByText("removing"))
    .toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("row")
    .filter({ hasText: "Enterprise Admin" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("row").filter({ hasText: "Enterprise Admin" })).toHaveCount(0);
  expect(fixture.state.accounts.items.find((account) => account.accountId === "ghes:2")?.state).toBe("removed");
});

test("device-flow disposal and terminal failures clean up polling", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Start login" }).click();
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
  expect(devicePollRequests(fixture)).toHaveLength(0);
  await page.getByRole("button", { name: "Replace login" }).click();
  await expect.poll(() => fixture.requests.filter((request) => request.url().endsWith("/device-flows")).length)
    .toBe(2);
  await advanceDeviceClock(page, fixture, 5_000);
  await expect.poll(() => devicePollRequests(fixture).length).toBe(1);
  await page.getByRole("button", { name: "Models" }).click();
  await advanceDeviceClock(page, fixture, 20_000);
  expect(devicePollRequests(fixture)).toHaveLength(1);

  fixture.state.devicePollStates = ["denied"];
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect(page.getByRole("alert")).toContainText("denied in GitHub");
  await expect(page.getByText("ABCD-1234")).toHaveCount(0);

  fixture.state.devicePollStates = ["expired"];
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect(page.getByRole("alert")).toContainText("Authorization expired");

});

test("model-refresh-invalidates-preference", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Models" }).click();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeFocused();
  await expect(page.getByText("gpt-alpha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("ghcg models set <model-id>");
  await expect(page.getByRole("button", { name: "Set preferred" })).toHaveCount(0);
  expect(fixture.requests.some((request) => request.url().endsWith("/models/preferred"))).toBe(false);
});

test("model-account switching ignores stale responses", async ({ page }) => {
  const fixture = await openAdmin(page);
  const current = fixture.state.accounts.items[0]!;
  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: [...fixture.state.accounts.items, {
      ...current,
      accountId: "ghes:2",
      host: "github.example.test",
      numericUserId: "2",
      login: "enterprise",
      displayName: "Enterprise Admin",
    }],
  };
  fixture.state.modelDelayByAccount[current.accountId] = 300;
  await page.getByRole("button", { name: "Models" }).click();
  await page.getByLabel("Account", { exact: true }).selectOption("ghes:2");
  await expect(page.getByText("enterprise-model", { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  await expect(page.getByLabel("Account", { exact: true })).toHaveValue("ghes:2");
  await expect(page.getByText("enterprise-model", { exact: true })).toBeVisible();
  await expect(page.getByText("gpt-alpha", { exact: true })).toHaveCount(0);
});

test("config-revision-conflict", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Configuration" }).click();
  await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeFocused();
  await expect(page.getByText("REVISION 7")).toBeVisible();
  await expect(page.getByRole("group")).toHaveCount(7);
  await expect(page.getByRole("spinbutton")).toHaveCount(15);
  fixture.state.conflictConfig = true;
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
});

test("events-and-degraded-recovery", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.events = Array.from({ length: 520 }, (_, index) => operationalEvent(index + 1));
  const degraded = {
    ...operationalEvent(521, "performance_degraded", "warning"),
    metadata: { metric: "buffered_p95_ms", actual: 8, threshold: 5 },
  };
  const replayed = operationalEvent(522, "gateway_started");
  const recovered = operationalEvent(523, "performance_recovered");
  fixture.state.streamDelaysMs = [250, 0, 750];
  fixture.state.streamHoldsMs = [500];
  fixture.state.streamBodies = [
    `retry: 250\n${sse("performance", { kind: "performance", status: status("degraded") })}`
      + `id: 521\n${sse("operational", { kind: "operational", event: degraded })}`,
    `retry: 250\nid: 521\n${sse("operational", { kind: "operational", event: degraded })}`
      + `id: 522\n${sse("operational", { kind: "operational", event: replayed })}`,
    `retry: 60000\n${sse("reset", { kind: "reset", reason: "history_unavailable", latestEventId: "522" })}`
      + sse("performance", { kind: "performance", status: status("healthy") })
      + `id: 523\n${sse("operational", { kind: "operational", event: recovered })}`,
  ];

  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Primary navigation" }).getByText("connecting", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Primary navigation" }).getByText("live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeFocused();
  await expect(page.getByText("No prompt or response bodies.", { exact: false })).toBeVisible();
  await expect(page.getByRole("main").getByText("reconnecting", { exact: true })).toBeVisible();
  await expect.poll(() => fixture.streamRequestHeaders.length).toBeGreaterThanOrEqual(2);
  expect(fixture.streamRequestHeaders[1]?.["last-event-id"]).toBe("521");
  await expect(page.getByText("EVENT 521", { exact: true })).toHaveCount(1);
  await expect(page.getByText("EVENT 522", { exact: true })).toHaveCount(1);
  await expect.poll(() => fixture.streamRequestHeaders.length).toBeGreaterThanOrEqual(3);
  expect(fixture.streamRequestHeaders[2]?.["last-event-id"]).toBe("522");
  await expect(page.getByText("EVENT 521", { exact: true })).toHaveCount(0);
  await expect(page.getByText("EVENT 522", { exact: true })).toHaveCount(0);
  await expect(page.getByText("EVENT 523", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Operational events" }).getByRole("listitem")).toHaveCount(501);
  await expect(page.getByText("EVENT 520", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load newer events" }).click();
  await expect(page.getByText("EVENT 520", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Operational events" }).getByRole("listitem")).toHaveCount(512);
  await page.getByRole("button", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toHaveCount(0);
});
