import { expect, test, type Locator, type Page } from "@playwright/test";
import { installAdminFixture } from "./fixtures/admin_fixture.js";

async function openAgents(page: Page) {
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=one-time-secret");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();
  return fixture;
}

async function expectOnlyVisuallyHidden(locator: Locator): Promise<void> {
  expect(await locator.evaluateAll((elements) => elements.every((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || box.width <= 1 || box.height <= 1;
  }))).toBe(true);
}

test("agents view presents concise Codex-first cards with primary actions", async ({ page }) => {
  await openAgents(page);
  const labels = await page.locator(".nav-item").allTextContents();
  expect(labels.map((label) => label.replace(/\[\d+\]/u, "").trim()))
    .toEqual(["Overview", "Accounts", "Models", "Agents", "Configuration", "Events"]);

  const cards = page.locator(".agent-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).getByRole("heading", { level: 2 })).toHaveText("Codex");
  await expect(cards.nth(1).getByRole("heading", { level: 2 })).toHaveText("Claude Code");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toHaveClass(/(^|\s)primary(\s|$)/u);
  await expect(refresh).toHaveCSS("background-color", "rgb(32, 29, 29)");
  await expect(page.getByText(/Refresh only reads configuration/)).toHaveCount(0);
  await expect(page.getByText(/Restart clients after applying or restoring/)).toHaveCount(0);

  for (const title of ["Codex", "Claude Code"]) {
    const card = page.locator(".agent-card", { has: page.getByRole("heading", { name: title }) });
    await expect(card).toBeVisible();
    await expect(card.getByText("Model mapping")).toBeVisible();
    await expect(card.getByRole("button", { name: "Apply changes" })).toHaveClass(/(^|\s)primary(\s|$)/u);
    await expect(card.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect(card.locator("select")).toHaveCount(0);
    await expect(card.locator("input[type='radio']")).toHaveCount(0);
    await expect(card.getByText(/first row is the startup model/)).toBeVisible();
  }

  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  await expect(claude.locator(".agent-role")).toHaveCount(0);
  await expect(claude.locator(".agent-mapping-row")).toHaveCount(3);
  for (const role of ["Sonnet", "Opus", "Haiku"]) {
    await expectOnlyVisuallyHidden(claude.getByText(role, { exact: true }));
    await expect(claude.getByRole("textbox", { name: `${role} Display name`, exact: true })).toHaveValue(role);
    await expect(claude.getByRole("textbox", { name: `${role} Copilot model ID`, exact: true })).toHaveCount(1);
  }

  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await expect(codex.getByRole("textbox", { name: "Model 1 Display name", exact: true })).toHaveCount(1);
  await codex.getByRole("button", { name: "Add model" }).click();
  await expect(codex.getByRole("textbox", { name: "Model 2 Display name", exact: true })).toHaveCount(1);
  await codex.getByRole("button", { name: "Remove model 2" }).click();
  await expect(codex.locator(".agent-mapping-row")).toHaveCount(1);
});

test("Agents reuses the session snapshot until explicit Refresh", async ({ page }) => {
  const fixture = await openAgents(page);
  await expect(page.locator(".agent-card")).toHaveCount(2);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(1);

  fixture.state.agents.codex = { ...fixture.state.agents.codex, state: "installed" };
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".agent-card")).toHaveCount(2);
  await expect(page.getByText("Reading agent configuration...", { exact: true })).toHaveCount(0);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(1);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".agent-card").first().locator(".badge")).toHaveText("Configuration installed");
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(2);

  fixture.state.failAgents = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("internal error");
  await expect(page.locator(".agent-card")).toHaveCount(2);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(3);
});

test("Claude additional settings explains the optional subagent mapping without a visible role label", async ({ page }) => {
  await openAgents(page);
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  await claude.getByText("Additional settings", { exact: true }).click();
  await expect(claude.getByText(/model Claude Code uses for delegated subagent work/)).toBeVisible();
  await claude.getByRole("button", { name: "Add subagent mapping", exact: true }).click();
  await expect(claude.locator(".agent-role")).toHaveCount(0);
  await expectOnlyVisuallyHidden(claude.getByText("Subagent", { exact: true }));
  await expect(claude.getByRole("textbox", { name: "Subagent Display name", exact: true })).toHaveValue("Subagent");
  await expect(claude.getByRole("textbox", { name: "Subagent Copilot model ID", exact: true })).toHaveCount(1);
});

test("mapping edits gate Apply changes and apply posts exact text mappings", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  const apply = codex.getByRole("button", { name: "Apply changes" });
  await expect(apply).toBeDisabled();
  await expect(codex.getByText("No unapplied changes")).toBeVisible();

  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await codex.getByRole("textbox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await expect(codex.getByText("Unapplied changes")).toBeVisible();
  await expect(apply).toBeEnabled();
  await expect(apply).toHaveAttribute("type", "submit");
  await expect(apply).toHaveCSS("background-color", "rgb(32, 29, 29)");

  page.once("dialog", (dialog) => dialog.accept());
  await apply.click();
  await expect(codex.getByText(/Configuration installed\. Restart the client/)).toBeVisible();
  await expect(codex.getByText("No unapplied changes")).toBeVisible();

  const request = fixture.requests.find((item) => item.url().endsWith("/agents/apply"));
  expect(request?.method()).toBe("POST");
  expect(request?.postDataJSON()).toMatchObject({
    agent: "codex",
    catalogRevision: "c".repeat(64),
    mappings: [{ displayName: "Fast", modelId: "gpt-alpha" }],
  });
});

test("an in-flight Refresh cannot overwrite a newer Apply result", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await codex.getByRole("textbox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  fixture.state.agentsDelayMs = 1_000;
  await page.getByRole("button", { name: "Refresh", exact: true }).click({ noWaitAfter: true });
  page.once("dialog", (dialog) => dialog.accept());
  await codex.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(codex.locator(".badge")).toHaveText("Configuration installed");
  await page.waitForTimeout(1_100);
  await expect(codex.locator(".badge")).toHaveText("Configuration installed");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("restore confirms and returns the card to Not managed", async ({ page }) => {
  const fixture = await openAgents(page);
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  for (const [role, model] of [["Sonnet", "gpt-alpha"], ["Opus", "gpt-alpha"], ["Haiku", "claude-beta"]] as const) {
    await claude.getByRole("textbox", { name: `${role} Copilot model ID`, exact: true }).fill(model);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await claude.getByRole("button", { name: "Apply changes" }).click();
  await expect(claude.locator(".badge")).toHaveText("Configuration installed");
  await expect(claude.getByRole("button", { name: "Restore" })).toBeEnabled();

  let confirmed = false;
  page.once("dialog", (dialog) => {
    confirmed = true;
    expect(dialog.message()).toContain("restores the configuration saved before the first apply");
    void dialog.accept();
  });
  await claude.getByRole("button", { name: "Restore" }).click();
  expect(confirmed).toBe(true);
  await expect(claude.locator(".badge")).toHaveText("Not managed");
  expect(fixture.requests.some((item) => item.url().endsWith("/agents/restore"))).toBe(true);
});

test("conflict and unavailable states block apply without destructive actions", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agents.codex = { ...fixture.state.agents.codex, state: "conflict" };
  fixture.state.agents.claude = { ...fixture.state.agents.claude, state: "recovery_required" };
  fixture.state.agentsApplyConflict = false;
  await page.goto("/admin/#bootstrap_token=one-time-secret");
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();

  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await expect(codex.locator(".badge")).toHaveText("External changes detected");
  await expect(codex.getByText(/Outside edits are never overwritten/)).toBeVisible();
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await codex.getByRole("textbox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await expect(codex.getByRole("button", { name: "Apply changes" })).toBeDisabled();

  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  await expect(claude.locator(".badge")).toHaveText("Recovery required");
  await expect(claude.getByRole("button", { name: "Restore" })).toBeDisabled();
});

test("agents cards stay responsive without horizontal scrolling", async ({ page }) => {
  await openAgents(page);
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
});

test("agents mapping rows are keyboard operable with unique accessible labels", async ({ page }) => {
  await openAgents(page);
  const names = await page.locator(".agent-card input").evaluateAll((inputs) => inputs.map((input) =>
    (input as HTMLInputElement).labels?.[0]?.textContent?.replace(/\s+/gu, " ").trim() ?? ""));
  expect(names.length).toBe(8);
  expect(names.every((name) => name !== "")).toBe(true);
  expect(new Set(names).size).toBe(names.length);
});
