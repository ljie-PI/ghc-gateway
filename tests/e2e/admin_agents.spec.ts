import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN_FIXTURE_NOW_MS,
  installAdminFixture,
  operationalEvent,
  sse,
} from "./fixtures/admin_fixture.js";

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

test("unchanged Accounts reads retain the current agent catalog", async ({ page }) => {
  const fixture = await openAgents(page);
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
});

for (const mutation of ["default selection", "removal"] as const) {
  test(`an Accounts ${mutation} completed after navigation cannot discard newer agent choices`, async ({ page }) => {
    const fixture = await installAdminFixture(page);
    const github = fixture.state.accounts.items[0]!;
    fixture.state.accounts = {
      ...fixture.state.accounts,
      items: [...fixture.state.accounts.items, {
        ...github,
        accountId: "ghes:2",
        host: "github.example.test",
        numericUserId: "2",
        login: "enterprise",
        displayName: "Enterprise Admin",
      }],
    };
    await page.goto("/admin/#bootstrap_token=held-account-mutation");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.locator("#codex-model-options option")).toHaveCount(2);
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();

    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const target = mutation === "default selection" ? /\/accounts\/default$/u : /\/accounts\/ghes%3A2$/u;
    await page.route(target, async (route) => {
      markStarted();
      await held;
      await route.fallback();
    });
    try {
      if (mutation === "default selection") {
        await page.getByRole("row").filter({ hasText: "Enterprise Admin" })
          .getByRole("button", { name: "Use this account", exact: true }).click({ noWaitAfter: true });
      } else {
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByRole("row").filter({ hasText: "Enterprise Admin" })
          .getByRole("button", { name: "Remove", exact: true }).click({ noWaitAfter: true });
      }
      await started;
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await expect(page.locator("#codex-model-options option")).toHaveCount(2);
      const completed = page.waitForResponse((response) => target.test(response.url()));
      release();
      await completed;
      await expect(page.locator("#codex-model-options option")).toHaveCount(2);
      expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
    } finally {
      release();
    }
  });
}

for (const mutation of ["default selection", "removal"] as const) {
  test(`an Accounts ${mutation} invalidates agent choices exactly once`, async ({ page }) => {
    const fixture = await installAdminFixture(page);
    const github = fixture.state.accounts.items[0]!;
    fixture.state.accounts = {
      ...fixture.state.accounts,
      items: [...fixture.state.accounts.items, {
        ...github,
        accountId: "ghes:2",
        host: "github.example.test",
        numericUserId: "2",
        login: "enterprise",
        displayName: "Enterprise Admin",
      }],
    };
    await page.goto("/admin/#bootstrap_token=account-mutation");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.locator("#codex-model-options option")).toHaveCount(2);
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    const enterprise = page.getByRole("row").filter({ hasText: "Enterprise Admin" });
    await expect(enterprise).toBeVisible();
    if (mutation === "default selection") {
      await enterprise.getByRole("button", { name: "Use this account", exact: true }).click();
      await expect(enterprise.getByRole("button", { name: "In use", exact: true })).toBeDisabled();
    } else {
      page.once("dialog", (dialog) => dialog.accept());
      await enterprise.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(enterprise).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.locator("#codex-model-options option")).toHaveCount(2);
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
  });
}

test("mounted Agents reloads once after an account revision event and preserves drafts", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  const heldStream = fixture.holdNextEventStream();
  fixture.state.streamBodies = [sse("operational", {
    kind: "operational",
    event: operationalEvent(41, "account_authenticated"),
  })];
  try {
    await page.goto("/admin/#bootstrap_token=held-account-event");
    await heldStream.started;
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const card = page.getByRole("region", { name: "Codex", exact: true });
    const id = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
    const name = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
    await id.fill("gpt-alpha");
    await name.fill("Keep my draft");
    fixture.state.models = { ...fixture.state.models, items: fixture.state.models.items.slice(1) };
    fixture.state.agentsCatalogRevision = "d".repeat(64);
    heldStream.release();
    await expect(page.locator("#codex-model-options option")).toHaveCount(1);
    await expect(page.locator("#codex-model-options option")).toHaveAttribute("value", "claude-beta");
    await expect(id).toHaveValue("gpt-alpha");
    await expect(name).toHaveValue("Keep my draft");
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(1);
  } finally {
    heldStream.release();
  }
});

test("an observed credential revision change invalidates agent choices exactly once", async ({ page }) => {
  const fixture = await openAgents(page);
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  const account = fixture.state.accounts.items[0]!;
  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: [{ ...account, revision: account.revision + 1 }],
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
});

test("a held device-flow completion cannot invalidate agent choices after Accounts is left", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await installAdminFixture(page);
  fixture.state.devicePollStates = ["complete"];
  await page.goto("/admin/#bootstrap_token=held-device-completion");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  const heldPoll = fixture.holdNextDevicePoll();
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  fixture.state.deviceNowMs += 5_000;
  await page.clock.fastForward(5_000);
  await heldPoll.started;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  heldPoll.release();
  await heldPoll.responseFinished;
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
});

test("device-flow account completion invalidates cached agent choices once", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await installAdminFixture(page);
  fixture.state.devicePollStates = ["complete"];
  await page.goto("/admin/#bootstrap_token=device-completion");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  fixture.state.deviceNowMs += 5_000;
  await page.clock.fastForward(5_000);
  await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
});

test("Admin Session teardown cancels a held agent catalog request", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  let release = (): void => undefined;
  let markStarted = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await page.route("**/admin/api/v1/agents/models", async (route) => {
    markStarted();
    await held;
    await route.fallback();
  });
  try {
    await page.goto("/admin/#bootstrap_token=teardown-agent-catalog");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await started;
    const canceled = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().endsWith("/agents/models"),
      timeout: 5_000,
    });
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
    release();
    await canceled;
    await page.waitForTimeout(50);
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
  } finally {
    release();
  }
});

test("Admin Session teardown does not reload an already loaded agent catalog", async ({ page }) => {
  const fixture = await openAgents(page);
  await expect(page.locator("#codex-model-options option")).toHaveCount(2);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Admin session closed" })).toBeFocused();
  await page.waitForTimeout(50);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
});

for (const action of ["read", "refresh"] as const) {
  test(`an abandoned Models ${action} cannot invalidate newer Agents choices`, async ({ page }) => {
    await openAgents(page);
    await expect(page.locator("#codex-model-options option")).toHaveCount(2);
    let release = (): void => undefined;
    let started = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const target = action === "read" ? /\/admin\/api\/v1\/models\?/u : /\/admin\/api\/v1\/models\/refresh$/u;
    await page.route(target, async (route) => {
      started();
      await held;
      await route.fallback();
    });
    try {
      await page.getByRole("button", { name: "Models", exact: true }).click();
      if (action === "refresh") {
        await expect(page.getByRole("table")).toBeVisible();
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
      }
      await entered;
      const canceled = page.waitForEvent("requestfailed", { predicate: (request) => target.test(request.url()), timeout: 5000 });
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await expect(page.locator("#codex-model-options option")).toHaveCount(2);
      release();
      await canceled;
      await expect(page.locator("#codex-model-options option")).toHaveCount(2);
      await expect(page.getByText("Model catalog unavailable.", { exact: false })).toHaveCount(0);
    } finally { release(); }
  });
}

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
