import { expect, test, type Page } from "@playwright/test";
import { installAdminFixture } from "./fixtures/admin_fixture.js";

async function openAgents(page: Page) {
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=one-time-secret");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();
  return fixture;
}

test("agents view sits between Models and Configuration with two consistent cards", async ({ page }) => {
  await openAgents(page);
  const labels = await page.locator(".nav-item").allTextContents();
  expect(labels.map((label) => label.replace(/\[\d+\]/u, "").trim()))
    .toEqual(["Overview", "Accounts", "Models", "Agents", "Configuration", "Events"]);

  for (const title of ["Claude Code", "Codex"]) {
    const card = page.locator(".agent-card", { has: page.getByRole("heading", { name: title }) });
    await expect(card).toBeVisible();
    await expect(card.getByText("Model mapping")).toBeVisible();
    await expect(card.getByRole("button", { name: "Apply changes" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect(card.locator("select")).toHaveCount(0);
    await expect(card.locator("input[type='radio']")).toHaveCount(0);
    await expect(card.getByText(/first row is the startup model/)).toBeVisible();
  }
  // Claude maps its three native roles; Codex rows are addable/removable.
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  await expect(claude.locator(".agent-mapping-row")).toHaveCount(3);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await codex.getByRole("button", { name: "Add model" }).click();
  await expect(codex.locator(".agent-mapping-row")).toHaveCount(2);
  await codex.getByRole("button", { name: "Remove model 2" }).click();
  await expect(codex.locator(".agent-mapping-row")).toHaveCount(1);
});

test("mapping edits gate Apply changes and apply posts exact text mappings", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  const apply = codex.getByRole("button", { name: "Apply changes" });
  await expect(apply).toBeDisabled();
  await expect(codex.getByText("No unapplied changes")).toBeVisible();

  await codex.getByLabel("Display name").fill("Fast");
  await codex.getByLabel("Copilot model ID").fill("gpt-alpha");
  await expect(codex.getByText("Unapplied changes")).toBeVisible();
  await expect(apply).toBeEnabled();

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

test("restore confirms and returns the card to Not managed", async ({ page }) => {
  const fixture = await openAgents(page);
  const claude = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Claude Code" }) });
  for (const [index, model] of ["gpt-alpha", "gpt-alpha", "claude-beta"].entries()) {
    await claude.getByLabel("Copilot model ID").nth(index).fill(model);
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
  await codex.getByLabel("Display name").fill("Fast");
  await codex.getByLabel("Copilot model ID").fill("gpt-alpha");
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

test("agents mapping rows are keyboard operable with unique labels", async ({ page }) => {
  await openAgents(page);
  await expect(page.locator(".agent-card")).toHaveCount(2);
  const evidence = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>(".agent-card input, .agent-card button")];
    const name = (element: HTMLElement): string => {
      const explicit = element.getAttribute("aria-label");
      if (explicit !== null && explicit !== "") return explicit;
      const wrapped = element.closest("label")?.textContent?.trim();
      if (wrapped !== undefined && wrapped !== "") return wrapped;
      return element.textContent?.trim() ?? "";
    };
    return {
      controls: controls.length,
      unnamed: controls.filter((element) => name(element) === "").length,
      dialogs: document.querySelectorAll(".agent-card").length,
    };
  });
  expect(evidence.dialogs).toBe(2);
  expect(evidence.controls).toBeGreaterThan(10);
  expect(evidence.unnamed).toBe(0);
});
