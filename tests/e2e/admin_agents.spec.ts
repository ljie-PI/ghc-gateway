import { expect, test, type Locator, type Page } from "@playwright/test";

import { installAdminFixture } from "./fixtures/admin_fixture.js";



test("catalog choices fill names only after explicit selection and unchanged mappings can be applied again", async ({ page }) => {
  const fixture = await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const apply = card.getByRole("button", { name: "Apply changes", exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(card.getByRole("alert")).toBeVisible();
  const model = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  await model.fill("gpt-alpha");
  await expect(card.getByRole("textbox", { name: "Model 1 Display name", exact: true })).toHaveValue("");
  await model.press("ArrowDown");
  await model.press("Enter");
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

test("catalog failure leaves local inspection visible and Apply reports missing choices", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agentsCatalogRevision = null;
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".agent-card")).toHaveCount(2);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await card.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Manual");
  await card.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Apply failed: model catalog unavailable.");
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/apply"))).toBe(false);
});

test("Apply validates drafts without disabling and posts exact custom display names", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  const apply = codex.getByRole("button", { name: "Apply changes" });
  await expect(apply).toBeEnabled();
  await expect(codex.getByText("No unapplied changes")).toHaveCount(0);

  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await expect(codex.getByText("Unapplied changes")).toHaveCount(0);
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

test("Claude applies fixed roles plus extra model menu mappings", async ({ page }) => {
  const fixture = await openAgents(page);
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  for (const role of ["Sonnet", "Opus", "Haiku"]) {
    await chooseModel(claude, `${role} Copilot model ID`, "gpt-alpha");
  }
  await claude.getByRole("button", { name: "Add model", exact: true }).click();
  await chooseModel(claude, "Model 4 Copilot model ID", "claude-beta");
  page.once("dialog", (dialog) => dialog.accept());
  await claude.getByRole("button", { name: "Apply changes" }).click();
  await expect(claude.locator(".badge")).toHaveText("Configuration installed");
  expect(fixture.requests.find((item) => item.url().endsWith("/agents/apply"))?.postDataJSON().mappings).toEqual([
    { modelId: "gpt-alpha", displayName: "Alpha" }, { modelId: "gpt-alpha", displayName: "Alpha" },
    { modelId: "gpt-alpha", displayName: "Alpha" }, { modelId: "claude-beta", displayName: "Beta" },
  ]);
  expect(fixture.requests.some((item) => item.url().endsWith("/agents/restore"))).toBe(false);
});

test("Codex takeover uses an accessible confirmation dialog and revision token", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agents.codex = {
    ...fixture.state.agents.codex,
    state: "conflict",
    mappings: [{ modelId: "gpt-alpha", displayName: "Alpha" }],
    takeover: {
      revision: "d".repeat(64),
      configPath: "C:/Users/octo/.codex/config.toml",
      catalogPath: "C:/Users/octo/.codex/models.json",
    },
  };
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await expect(card.getByRole("button", { name: "Take over Codex configuration", exact: true })).toHaveCount(0);
  const apply = card.getByRole("button", { name: "Apply changes", exact: true });
  await apply.click();
  const dialog = page.getByRole("dialog", { name: "Take over Codex configuration?" });
  await expect(dialog).toBeVisible();
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/apply"))).toBe(false);
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/takeover"))).toBe(false);
  await expect(dialog).toContainText("auth.json is untouched");
  for (const target of fixture.state.agents.codex.takeover === null ? [] : [
    fixture.state.agents.codex.takeover.configPath,
    fixture.state.agents.codex.takeover.catalogPath,
  ]) await expect(dialog).toContainText(target);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/takeover"))).toBe(false);
  await apply.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/takeover"))).toBe(false);

  await apply.click();
  await dialog.getByRole("button", { name: "Take over configuration", exact: true }).click();
  await expect(card.locator(".badge")).toHaveText("Configuration installed");
  const request = fixture.requests.find((item) => item.url().endsWith("/agents/takeover"));
  expect(request?.postDataJSON()).toMatchObject({
    agent: "codex",
    expectedRevision: "7".repeat(64),
    catalogRevision: "c".repeat(64),
    takeoverRevision: "d".repeat(64),
    mappings: [{ modelId: "gpt-alpha", displayName: "Alpha" }],
  });
  expect(JSON.stringify(request?.postDataJSON())).not.toContain("config.toml");
});



async function openAgents(page: Page) {
  const fixture = await installAdminFixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();
  return fixture;
}



async function chooseModel(card: Locator, inputName: string, query: string): Promise<void> {
  const input = card.getByRole("combobox", { name: inputName, exact: true });
  await input.fill(query);
  await input.press("ArrowDown");
  await input.press("Enter");
}
