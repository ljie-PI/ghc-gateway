import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  await page.goto("/admin/#bootstrap_token=one-time-secret");
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

test("bootstrap-and-session-expiry", async ({ page }) => {
  const fixture = await openAdmin(page);
  await expect(page).toHaveURL(/\/admin\/$/);
  await recordAccessibilityEvidence(page);
  expect(await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    body: document.body.textContent,
  }))).toEqual(expect.objectContaining({ local: 0, session: 0 }));
  fixture.state.authenticated = false;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
  await expect(page.getByText("admin session ended")).toBeVisible();
  expect(fixture.requests.some((request) => request.url().endsWith("/auth/logout"))).toBe(false);
  expect(fixture.requests.filter((request) => request.url().endsWith("/status"))).toHaveLength(2);
  expect(fixture.requests.find((request) => request.url().endsWith("/auth/bootstrap"))?.postData())
    .toBe("{\"token\":\"one-time-secret\"}");
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
  expect(fixture.requests.find((request) => request.url().endsWith("/accounts/default"))?.headers()["x-ghcg-csrf"])
    .toBe("csrf-memory-only");
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
  await page.getByRole("button", { name: "Check now" }).click();
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

  fixture.state.devicePollStates = ["pending"];
  await page.getByRole("button", { name: "Start login" }).click();
  fixture.state.authenticated = false;
  await advanceDeviceClock(page, fixture, 5_000);
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
  await advanceDeviceClock(page, fixture, 20_000);
  expect(devicePollRequests(fixture)).toHaveLength(4);
});

test("device-flow retries network failures without accepting stale responses", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await openAdmin(page);
  fixture.state.devicePollStates = ["network", "complete"];
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect(page.getByRole("alert")).toContainText("gateway is unreachable");
  await expect(page.getByText("retrying automatically")).toBeVisible();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: fixture.state.accounts.items.filter((account) => account.login !== "enterprise"),
  };
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Enterprise Admin")).toHaveCount(0);
  fixture.state.devicePollStates = ["complete"];
  const heldPoll = fixture.holdNextDevicePoll();
  try {
    await page.getByRole("button", { name: "Start login" }).click();
    await advanceDeviceClock(page, fixture, 5_000);
    await heldPoll.started;
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => fixture.requests.filter((request) => (
      request.method() === "DELETE" && request.url().endsWith("/device-flows/flow-1")
    )).length).toBe(1);
  } finally {
    heldPoll.release();
  }
  await heldPoll.responseFinished;
  await expect.poll(() => fixture.state.accounts.items.some((account) => account.login === "enterprise")).toBe(true);
  await expect(page.getByText("ABCD-1234")).toHaveCount(0);
  await expect(page.getByText("Enterprise Admin")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Authorization canceled in this view");

  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: fixture.state.accounts.items.filter((account) => account.login !== "enterprise"),
  };
  fixture.state.accountsDelayMs = 1_000;
  const staleRefreshCount = fixture.requests.filter((request) => request.url().endsWith("/accounts")).length;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => fixture.requests.filter((request) => request.url().endsWith("/accounts")).length)
    .toBeGreaterThan(staleRefreshCount);
  fixture.state.accountsDelayMs = 0;
  fixture.state.devicePollStates = ["complete"];
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await page.waitForTimeout(1_100);
  await expect(page.getByText("Enterprise Admin")).toBeVisible();

  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: fixture.state.accounts.items.filter((account) => account.login !== "enterprise"),
  };
  fixture.state.accountsDelayMs = 0;
  const clearingRequestCount = fixture.requests.filter((request) => request.url().endsWith("/accounts")).length;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => fixture.requests.filter((request) => request.url().endsWith("/accounts")).length)
    .toBeGreaterThan(clearingRequestCount);
  await expect(page.getByText("Enterprise Admin")).toHaveCount(0);
  fixture.state.accountsDelayMs = 1_000;
  fixture.state.devicePollStates = ["complete"];
  const accountRequestsBefore = fixture.requests.filter((request) => request.url().endsWith("/accounts")).length;
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect.poll(() => fixture.requests.filter((request) => request.url().endsWith("/accounts")).length)
    .toBeGreaterThan(accountRequestsBefore);
  await page.getByRole("button", { name: "Start login" }).click();
  await page.waitForTimeout(1_100);
  await expect(page.getByText("ABCD-1234")).toBeVisible();
  await expect(page.getByText("Enterprise Admin")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Octo Admin")).toBeVisible();
  await expect(page.locator(".loading-line")).toHaveCount(0);
});

test("device-flow expiry aborts a hanging browser poll", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await openAdmin(page);
  fixture.state.devicePollStates = ["pending"];
  fixture.state.devicePollDelayMs = 1_000;
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect.poll(() => devicePollRequests(fixture).length).toBe(1);
  await advanceDeviceClock(page, fixture, 595_000);
  await expect(page.getByRole("alert")).toContainText("Authorization expired");
  await expect(page.getByText("ABCD-1234")).toHaveCount(0);
});

test("device-flow expiry reconciles a raced completion", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await openAdmin(page);
  fixture.state.devicePollStates = ["pending"];
  fixture.state.devicePollDelayMs = 1_000;
  fixture.state.cancelCompletesDeviceFlow = true;
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Start login" }).click();
  await advanceDeviceClock(page, fixture, 5_000);
  await expect.poll(() => devicePollRequests(fixture).length).toBe(1);
  await advanceDeviceClock(page, fixture, 595_000);
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await expect(page.locator(".notice").filter({ hasText: "Connected @enterprise" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Octo Admin" }).getByRole("button", { name: "In use" })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("model-refresh-invalidates-preference", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Models" }).click();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeFocused();
  await expect(page.getByText("gpt-alpha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh catalog" }).click();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  fixture.state.conflictModel = true;
  await page.getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "changed elsewhere" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByText("claude-beta is now preferred.")).toBeVisible();
});

test("model-capability-override-lifecycle", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Models" }).click();
  await page.getByLabel("Model ID").fill("manual-model");
  await page.getByRole("button", { name: "Add configured model" }).click();
  const card = page.locator('tbody[data-model-id="manual-model"]');
  await expect(card.getByText("Configured / unverified", { exact: true })).toBeVisible();
  await card.getByText("Capability details and override").click();
  await card.getByLabel("messages").check();
  await card.getByLabel("Default output tokens").fill("2048");
  await card.getByRole("button", { name: "Save capability override" }).click();
  await expect(page.getByText("manual-model capability override saved.")).toBeVisible();
  expect(fixture.requests.find((request) => request.url().endsWith("/models/capabilities")
    && request.method() === "PUT")?.headers()["x-ghcg-csrf"]).toBe("csrf-memory-only");
  await card.getByRole("button", { name: "Reset override" }).click();
  await expect(page.locator('tbody[data-model-id="manual-model"]')).toHaveCount(0);
  await page.getByLabel("Model ID").fill("manual-model");
  await page.getByRole("button", { name: "Add configured model" }).click();
  await expect(page.locator('tbody[data-model-id="manual-model"]')).toBeVisible();
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

test("model token override keeps protocol inheritance", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Models" }).click();
  const card = page.locator('tbody[data-model-id="gpt-alpha"]').first();
  await card.getByText("Capability details and override").click();
  await expect(card.getByLabel("Override native protocols")).not.toBeChecked();
  await card.getByLabel("Default output tokens").fill("2048");
  await card.getByRole("button", { name: "Save capability override" }).click();
  await expect(page.getByText("gpt-alpha capability override saved.")).toBeVisible();
  await expect(card.getByText("Configured override", { exact: true })).toBeVisible();
  const request = fixture.requests.findLast((candidate) => (
    candidate.url().endsWith("/models/capabilities")
    && candidate.method() === "PUT"
    && candidate.postData()?.includes("gpt-alpha") === true
  ));
  expect(request?.postDataJSON()).toMatchObject({
    capabilities: { enabled: true, defaultOutputTokens: 2048 },
  });
  expect((request?.postDataJSON() as { capabilities?: { protocols?: unknown } }).capabilities?.protocols)
    .toBeUndefined();

  const beforeClear = fixture.requests.filter((candidate) => (
    candidate.url().endsWith("/models/capabilities") && candidate.method() === "PUT"
  )).length;
  await card.getByLabel("Default output tokens").fill("");
  await expect(card.getByLabel("Default output tokens")).toHaveValue("");
  await card.getByRole("button", { name: "Save capability override" }).click();
  await expect.poll(() => fixture.requests.filter((candidate) => (
    candidate.url().endsWith("/models/capabilities") && candidate.method() === "PUT"
  )).length).toBe(beforeClear + 1);
  const cleared = fixture.requests.findLast((candidate) => (
    candidate.url().endsWith("/models/capabilities")
    && candidate.method() === "PUT"
    && candidate.postData()?.includes("gpt-alpha") === true
  ));
  expect((cleared?.postDataJSON() as {
    capabilities?: { defaultOutputTokens?: unknown; protocols?: unknown };
  }).capabilities).toEqual({ enabled: true });
});

test("models view renders duplicate catalog IDs without crashing", async ({ page }) => {
  const fixture = await openAdmin(page);
  const first = fixture.state.models.items[0]!;
  fixture.state.models = {
    ...fixture.state.models,
    items: [first, { ...first, name: "Duplicate Alpha" }],
  };
  await page.getByRole("button", { name: "Models" }).click();
  await expect(page.getByText("gpt-alpha", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Duplicate Alpha", { exact: true })).toBeVisible();
});

test("config-revision-and-security-rejection", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Configuration" }).click();
  await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeFocused();
  await expect(page.getByText("REVISION 7")).toBeVisible();
  await expect(page.getByRole("group")).toHaveCount(7);
  await expect(page.getByRole("spinbutton")).toHaveCount(15);
  fixture.state.conflictConfig = true;
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  fixture.state.rejectSecurity = true;
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("security check rejected");
});

test("responses-history-inspect-and-clear", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Responses History" }).click();
  await expect(page.getByRole("heading", { name: "Responses History", exact: true })).toBeFocused();
  await expect(page.getByText("12 / 512", { exact: true })).toBeVisible();
  await expect(page.getByText("not a list of replies", { exact: false })).toBeVisible();
  fixture.state.conflictHistory = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(page.getByText("12 / 512", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByRole("heading", { name: "Responses state is empty" })).toBeVisible();
  await expect(page.getByText("Responses history and route ownership state cleared.")).toBeVisible();
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

  await page.goto("/admin/#bootstrap_token=event-secret");
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

test("daemon-restart-invalidates-session", async ({ page }) => {
  const fixture = await openAdmin(page);
  fixture.state.authenticated = false;
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
  await expect(page.getByText("admin session ended")).toBeVisible();
  expect(fixture.requests.some((request) => request.url().endsWith("/auth/session"))).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("responsive shell centers the right column and contains long content", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await openAdmin(page);
  const baseAccount = fixture.state.accounts.items[0]!;
  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: [
      baseAccount,
      {
        ...baseAccount,
        accountId: "ghes:long",
        host: `${"enterprise-".repeat(12)}example.test`,
        numericUserId: "99999999999999999999",
        login: `${"long-login-".repeat(12)}account`,
        displayName: `${"Long directory identity ".repeat(8)}`,
      },
    ],
  };
  fixture.state.models = {
    ...fixture.state.models,
    items: fixture.state.models.items.map((model, index) => index === 0
      ? { ...model, id: `model-${"long-".repeat(40)}` }
      : model),
  };
  fixture.state.events = [{
    ...operationalEvent(99),
    metadata: { source: "x".repeat(600) },
  }];

  const assertDocumentShape = async (): Promise<void> => {
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    const overflow = await page.evaluate(() => {
      window.scrollTo({ left: 10_000 });
      const rootScrollX = window.scrollX;
      window.scrollTo({ left: 0 });
      return {
        title: document.querySelector("h1")?.textContent ?? "",
        rootScrollX,
        tableContainersFit: [...document.querySelectorAll<HTMLElement>(".table-scroll")]
          .every((element) => element.getBoundingClientRect().right <= document.documentElement.clientWidth + 1),
      };
    });
    expect(overflow, overflow.title).toEqual({ title: overflow.title, rootScrollX: 0, tableContainersFit: true });
  };

  await assertDocumentShape();
  const menu = page.getByRole("button", { name: "Open navigation" });
  const sidebar = page.locator('[data-layout-region="navigation"]');
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await menu.click();
  await expect(page.getByRole("button", { name: "Overview" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");

  for (const view of ["Accounts", "Models", "Configuration", "Responses History", "Events", "Overview"]) {
    await menu.click();
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await page.getByRole("button", { name: view }).click();
    await expect(page.getByRole("heading", { name: view, exact: true })).toBeFocused();
    await assertDocumentShape();
  }

  for (const width of [900, 1600, 2560, 3440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
    for (const view of ["Overview", "Accounts", "Models", "Configuration", "Responses History", "Events"]) {
      await page.getByRole("button", { name: view }).click();
      await expect(page.getByRole("heading", { name: view, exact: true })).toBeFocused();
      const gaps = await page.evaluate(() => {
        const column = document.querySelector<HTMLElement>('[data-layout-region="main-column"]')!
          .getBoundingClientRect();
        const frame = document.querySelector<HTMLElement>('[data-layout-region="content-frame"]')!
          .getBoundingClientRect();
        return {
          left: frame.left - column.left,
          right: column.right - frame.right,
        };
      });
      expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(1);
      await assertDocumentShape();
    }
  }
});

test("responsive authentication, empty, and error states stay contained", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);

  await page.evaluate(() => {
    location.hash = "bootstrap_token=state-secret";
  });
  await page.getByRole("button", { name: "Try current session" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  fixture.state.accounts = { ...fixture.state.accounts, defaultAccountId: null, items: [] };
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "No accounts connected" })).toBeVisible();

  fixture.state.failStatus = true;
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("alert")).toContainText("Overview unavailable");
  const rootScrollX = await page.evaluate(() => {
    window.scrollTo({ left: 10_000 });
    return window.scrollX;
  });
  expect(rootScrollX).toBe(0);
});

test("live SSE deduplicates replay before applying the 512 event bound", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.events = [];
  const unique = Array.from({ length: 512 }, (_, index) => {
    const event = operationalEvent(index + 1);
    return `id: ${event.eventId}\n${sse("operational", { kind: "operational", event })}`;
  }).join("");
  const replayed = operationalEvent(512);
  fixture.state.streamBodies = [
    `${unique}id: ${replayed.eventId}\n${sse("operational", { kind: "operational", event: replayed })}`,
  ];
  fixture.state.streamHoldsMs = [1_000];

  await page.goto("/admin/#bootstrap_token=dedupe-secret");
  await page.getByRole("button", { name: "Events" }).click();
  const eventList = page.getByRole("list", { name: "Operational events" });
  await expect(eventList.getByRole("listitem")).toHaveCount(512);
  await expect(page.getByText("EVENT 1", { exact: true })).toBeVisible();
  await expect(page.getByText("EVENT 512", { exact: true })).toHaveCount(1);
});

test("production Admin bundle excludes prototype content", async () => {
  const root = path.resolve("dist", "admin");
  const files = await readdir(root, { recursive: true });
  const text = (await Promise.all(files
    .filter((file) => /\.(?:css|html|js)$/u.test(file))
    .map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  expect(text).not.toMatch(
    /MOCK DATA|Simulate connection|Reset preview|sample-a|sample-b|ljie-PI|jl87pi|resp_preview_|SIMULATED SESSION|SAMPLE FEED|variant-pick|DESIGN PREVIEW/u,
  );
});
