import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
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
  await page.getByRole("button", { name: "End session" }).focus();
  await page.keyboard.press("Tab");
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
  await expect(page.getByRole("heading", { name: "Control room locked" })).toBeFocused();
  await expect(page.getByText("admin session ended")).toBeVisible();
  expect(fixture.requests.some((request) => request.url().endsWith("/auth/logout"))).toBe(false);
  expect(fixture.requests.filter((request) => request.url().endsWith("/status"))).toHaveLength(2);
  expect(fixture.requests.find((request) => request.url().endsWith("/auth/bootstrap"))?.postData())
    .toBe("{\"token\":\"one-time-secret\"}");
});

test("github-and-ghes-account-lifecycle", async ({ page }) => {
  const fixture = await openAdmin(page);
  await keyboardNavigate(page, "Accounts");
  await page.getByLabel("GitHub host").fill("github.example.test");
  await page.getByRole("button", { name: "Start login" }).click();
  await expect(page.getByText("ABCD-1234")).toBeVisible();
  await page.getByRole("button", { name: "I've authorized" }).click();
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  fixture.state.conflictAccount = true;
  await page.getByRole("button", { name: "Make default" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await page.getByRole("button", { name: "Make default" }).click();
  expect(fixture.requests.find((request) => request.url().endsWith("/accounts/default"))?.headers()["x-ghcg-csrf"])
    .toBe("csrf-memory-only");
  fixture.state.failAccountRemoval = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("article")
    .filter({ hasText: "Enterprise Admin" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("alert")).toContainText("internal error");
  await expect(page.getByRole("article").filter({ hasText: "Enterprise Admin" }).getByText("removing"))
    .toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("article")
    .filter({ hasText: "Enterprise Admin" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("article").filter({ hasText: "Enterprise Admin" }).getByText("removed"))
    .toBeVisible();
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
  const card = page.getByRole("article").filter({ hasText: "manual-model" });
  await expect(card.getByText(/Configured \/ unverified/)).toBeVisible();
  await card.getByLabel("messages").check();
  await card.getByLabel("Default output tokens").fill("2048");
  await card.getByRole("button", { name: "Save capability override" }).click();
  await expect(page.getByText("manual-model capability override saved.")).toBeVisible();
  expect(fixture.requests.find((request) => request.url().endsWith("/models/capabilities")
    && request.method() === "PUT")?.headers()["x-ghcg-csrf"]).toBe("csrf-memory-only");
  await card.getByRole("button", { name: "Reset override" }).click();
  await expect(page.getByRole("article").filter({ hasText: "manual-model" })).toHaveCount(0);
  await page.getByLabel("Model ID").fill("manual-model");
  await page.getByRole("button", { name: "Add configured model" }).click();
  await expect(page.getByRole("article").filter({ hasText: "manual-model" })).toBeVisible();
});

test("config-revision-and-security-rejection", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Configuration" }).click();
  await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeFocused();
  await expect(page.getByText("REVISION 7")).toBeVisible();
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
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  fixture.state.conflictHistory = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByRole("heading", { name: "History is empty" })).toBeVisible();
  await expect(page.getByText("Responses history cleared.")).toBeVisible();
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
  await expect(page.getByText("connecting", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toBeVisible();
  await expect(page.getByRole("banner").getByText("live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeFocused();
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
  await expect(page.locator(".timeline > li")).toHaveCount(501);
  await expect(page.getByText("EVENT 520", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load newer events" }).click();
  await expect(page.getByText("EVENT 520", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline > li")).toHaveCount(512);
  await page.getByRole("button", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toHaveCount(0);
});

test("daemon-restart-invalidates-session", async ({ page }) => {
  const fixture = await openAdmin(page);
  fixture.state.authenticated = false;
  await expect(page.getByRole("heading", { name: "Control room locked" })).toBeFocused();
  await expect(page.getByText("admin session ended")).toBeVisible();
  expect(fixture.requests.some((request) => request.url().endsWith("/auth/session"))).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
