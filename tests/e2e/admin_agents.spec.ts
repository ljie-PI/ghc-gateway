import { expect, test, type Locator, type Page } from "@playwright/test";
import { installAdminFixture } from "./fixtures/admin_fixture.js";

test("catalog choices autofill names and unchanged mappings can be applied again", async ({ page }) => {
  const fixture = await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const apply = card.getByRole("button", { name: "Apply changes", exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(card.getByRole("alert")).toBeVisible();
  const model = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  await model.fill("gpt-alpha");
  await expect(card.getByRole("textbox", { name: "Model 1 Display name", exact: true })).toHaveValue("Alpha");
  page.once("dialog", (dialog) => dialog.accept());
  await apply.click();
  await expect(card.getByText(/Configuration installed\. Restart/)).toBeVisible();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(apply).toBeEnabled();
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/apply"))).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
  await expect(page.getByText("No unapplied changes", { exact: true })).toHaveCount(0);
});

test("local cards render before a held catalog and late choices preserve manual drafts", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/admin/api/v1/agents/models", async (route) => {
    await held;
    await route.fulfill({ json: { data: {
      accountId: fixture.state.models.accountId, catalogRevision: "c".repeat(64),
      items: fixture.state.models.items, usableModelIds: ["gpt-alpha", "claude-beta"],
    } } });
  });
  try {
    await page.goto("/admin/#bootstrap_token=synthetic-held-catalog");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.locator(".agent-card")).toHaveCount(2);
    await expect(page.getByText("Loading model choices...", { exact: true })).toBeVisible();
    const card = page.getByRole("region", { name: "Codex", exact: true });
    const id = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
    const name = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
    await id.fill("gpt-alpha");
    await name.fill("Keep my name");
    release();
    await expect(page.getByText("Loading model choices...", { exact: true })).toHaveCount(0);
    await expect(name).toHaveValue("Keep my name");
    await id.fill("claude-beta");
    await expect(name).toHaveValue("Beta");
    const idBox = await id.boundingBox();
    const nameBox = await name.boundingBox();
    expect(idBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(idBox!.x).toBeLessThan(nameBox!.x);
  } finally { release(); }
});

test("catalog failure leaves local inspection visible and Apply reports missing choices", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agentsCatalogRevision = null;
  await page.goto("/admin/#bootstrap_token=synthetic-no-catalog");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".agent-card")).toHaveCount(2);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await card.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Manual");
  await card.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("Model catalog is not ready");
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/apply"))).toBe(false);
});

test("Models refresh invalidates cached agent choices without rereading local config", async ({ page }) => {
  const fixture = await openAgents(page);
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(1);
  await expect(page.locator("#codex-model-options option")).toHaveAttribute("value", "claude-beta");
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(1);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
});

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
    await expect(card.getByRole("button", { name: "Restore" })).toHaveCount(0);
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
    await expect(claude.getByRole("combobox", { name: `${role} Copilot model ID`, exact: true })).toHaveCount(1);
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

test("Claude supports ordinary extra menu mappings without Additional settings or Subagent", async ({ page }) => {
  await openAgents(page);
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  await expect(claude.getByText("Additional settings", { exact: true })).toHaveCount(0);
  await claude.getByRole("button", { name: "Add model", exact: true }).click();
  await expect(claude.locator(".agent-role")).toHaveCount(0);
  await expect(claude.getByText("Subagent", { exact: true })).toHaveCount(0);
  await claude.getByRole("combobox", { name: "Model 4 Copilot model ID", exact: true }).fill("claude-beta");
  await expect(claude.getByRole("textbox", { name: "Model 4 Display name", exact: true })).toHaveValue("Beta");
  await claude.getByRole("button", { name: "Remove model 4", exact: true }).click();
  await expect(claude.locator(".agent-mapping-row")).toHaveCount(3);
});

test("Apply validates drafts without disabling and posts exact custom display names", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  const apply = codex.getByRole("button", { name: "Apply changes" });
  await expect(apply).toBeEnabled();
  await expect(codex.getByText("No unapplied changes")).toHaveCount(0);

  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await expect(codex.getByText("Unapplied changes")).toBeVisible();
  await expect(apply).toBeEnabled();
  await expect(apply).toHaveAttribute("type", "submit");
  await expect(apply).toHaveCSS("background-color", "rgb(32, 29, 29)");

  page.once("dialog", (dialog) => dialog.accept());
  await apply.click();
  await expect(codex.getByText(/Configuration installed\. Restart the client/)).toBeVisible();
  await expect(codex.getByText("No unapplied changes")).toHaveCount(0);

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
  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  fixture.state.agentsDelayMs = 1_000;
  await page.getByRole("button", { name: "Refresh", exact: true }).click({ noWaitAfter: true });
  page.once("dialog", (dialog) => dialog.accept());
  await codex.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(codex.locator(".badge")).toHaveText("Configuration installed");
  await page.waitForTimeout(1_100);
  await expect(codex.locator(".badge")).toHaveText("Configuration installed");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Claude applies fixed roles plus extra model menu mappings", async ({ page }) => {
  const fixture = await openAgents(page);
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  for (const role of ["Sonnet", "Opus", "Haiku"]) {
    await claude.getByRole("combobox", { name: `${role} Copilot model ID`, exact: true }).fill("gpt-alpha");
  }
  await claude.getByRole("button", { name: "Add model", exact: true }).click();
  await claude.getByRole("combobox", { name: "Model 4 Copilot model ID", exact: true }).fill("claude-beta");
  page.once("dialog", (dialog) => dialog.accept());
  await claude.getByRole("button", { name: "Apply changes" }).click();
  await expect(claude.locator(".badge")).toHaveText("Configuration installed");
  expect(fixture.requests.find((item) => item.url().endsWith("/agents/apply"))?.postDataJSON().mappings).toEqual([
    { modelId: "gpt-alpha", displayName: "Alpha" }, { modelId: "gpt-alpha", displayName: "Alpha" },
    { modelId: "gpt-alpha", displayName: "Alpha" }, { modelId: "claude-beta", displayName: "Beta" },
  ]);
  expect(fixture.requests.some((item) => item.url().endsWith("/agents/restore"))).toBe(false);
});

test("conflict and recovery states keep Apply clickable while reporting backend errors", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agents.codex = { ...fixture.state.agents.codex, state: "conflict" };
  fixture.state.agents.claude = { ...fixture.state.agents.claude, state: "recovery_required" };
  fixture.state.agentsApplyConflict = true;
  await page.goto("/admin/#bootstrap_token=one-time-secret");
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();

  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await expect(codex.locator(".badge")).toHaveText("External changes detected");
  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await expect(codex.getByRole("button", { name: "Apply changes" })).toBeEnabled();
  await codex.getByRole("button", { name: "Apply changes" }).click();
  await expect(codex.getByRole("alert")).toContainText("first backup changed");

  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  await expect(claude.locator(".badge")).toHaveText("Recovery required");
  await expect(claude.getByRole("button", { name: "Apply changes" })).toBeEnabled();
  await expect(claude.getByRole("button", { name: "Restore" })).toHaveCount(0);
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
  const inputs = page.locator(".agent-card input");
  await expect(inputs).toHaveCount(8);
  const names = await inputs.evaluateAll((elements) => elements.map((input) =>
    (input as HTMLInputElement).labels?.[0]?.textContent?.replace(/\s+/gu, " ").trim() ?? ""));
  expect(names.length).toBe(8);
  expect(names.every((name) => name !== "")).toBe(true);
  expect(new Set(names).size).toBe(names.length);
});
