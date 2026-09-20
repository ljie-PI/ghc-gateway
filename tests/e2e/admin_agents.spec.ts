import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN_FIXTURE_NOW_MS,
  installAdminFixture,
  type AdminFixture,
} from "./fixtures/admin_fixture.js";

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
    await page.goto("/");
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
    await expect(name).toHaveValue("Keep my name");
    await id.press("ArrowDown");
    await id.press("Enter");
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

test("Models refresh invalidates cached agent choices without rereading local config", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).click();
  await expect(codex.getByRole("option")).toHaveCount(2);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).click();
  await expect(codex.getByRole("option")).toHaveCount(1);
  await expect(codex.getByRole("option")).toContainText("claude-beta");
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents"))).toHaveLength(1);
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
});

test("unchanged Accounts reads retain the current agent catalog", async ({ page }) => {
  const fixture = await openAgents(page);
  await page.getByRole("region", { name: "Codex", exact: true }).getByRole("combobox").click();
  await expect(page.getByRole("region", { name: "Codex", exact: true }).getByRole("option")).toHaveCount(2);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("region", { name: "Codex", exact: true }).getByRole("combobox").click();
  await expect(page.getByRole("region", { name: "Codex", exact: true }).getByRole("option")).toHaveCount(2);
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
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();
    const accountReadsBeforeMutation = accountReads(fixture);

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
      await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
      const completed = page.waitForResponse((response) => target.test(response.url()));
      release();
      await (await completed).body();
      await settleBrowser(page);
      await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
      expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
      expect(accountReads(fixture)).toBe(accountReadsBeforeMutation + 1);
    } finally {
      release();
    }
  });
}

for (const mutation of ["default selection", "removal"] as const) {
  test(`an Accounts ${mutation} invalidates and reloads agent choices once`, async ({ page }) => {
    await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
    const fixture = await installAdminFixture(page);
    addEnterpriseAccount(fixture);
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    const enterprise = page.getByRole("row").filter({ hasText: "Enterprise Admin" });
    if (mutation === "default selection") {
      await enterprise.getByRole("button", { name: "Use this account", exact: true }).click();
      await expect(enterprise.getByRole("button", { name: "In use", exact: true })).toBeDisabled();
    } else {
      page.once("dialog", (dialog) => dialog.accept());
      await enterprise.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(enterprise).toHaveCount(0);
    }

    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    await page.route("**/admin/api/v1/agents/models", async (route) => {
      markStarted();
      await held;
      await route.fallback();
    }, { times: 1 });
    try {
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await started;
      await expect(page.getByText("Loading model choices...", { exact: true })).toBeVisible();
      await expect(modelChoiceStatus(page)).toHaveText("Loading model choices");
      release();
      await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
      await advance(page, fixture, 5_000);
      expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
    } finally {
      release();
    }
  });
}

for (const change of ["account", "default", "credential"] as const) {
  test(`mounted Agents observes a real ${change} revision once and preserves drafts`, async ({ page }) => {
    await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
    const fixture = await installAdminFixture(page);
    if (change === "default") addEnterpriseAccount(fixture);
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
    await expect.poll(() => accountReads(fixture)).toBeGreaterThanOrEqual(1);
    const card = page.getByRole("region", { name: "Codex", exact: true });
    const id = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
    const name = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
    await id.fill("gpt-alpha");
    await name.fill("Keep my draft");

    if (change === "account") addEnterpriseAccount(fixture);
    if (change === "default") {
      fixture.state.accounts = {
        ...fixture.state.accounts,
        defaultAccountId: "ghes:2",
        defaultRevision: fixture.state.accounts.defaultRevision + 1,
      };
    }
    if (change === "credential") {
      const account = fixture.state.accounts.items[0]!;
      fixture.state.accounts = {
        ...fixture.state.accounts,
        items: [{ ...account, revision: account.revision + 1 }],
      };
    }
    fixture.state.models = { ...fixture.state.models, items: fixture.state.models.items.slice(1) };
    fixture.state.agentsCatalogRevision = "d".repeat(64);

    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    await page.route("**/admin/api/v1/agents/models", async (route) => {
      markStarted();
      await held;
      await route.fallback();
    }, { times: 1 });
    try {
      await advance(page, fixture, 5_000);
      await started;
      await expect(page.getByText("Loading model choices...", { exact: true })).toBeVisible();
      await expect(modelChoiceStatus(page)).toHaveText("Loading model choices");
      await expect(id).toHaveValue("gpt-alpha");
      await expect(name).toHaveValue("Keep my draft");
      await advance(page, fixture, 10_000);
      release();
      await expect(modelChoiceStatus(page)).toHaveText("No matching models");
      await expect(id).toHaveValue("gpt-alpha");
      await expect(name).toHaveValue("Keep my draft");
      await advance(page, fixture, 5_000);
      expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
    } finally {
      release();
    }
  });
}

test("account removal never publishes an older revision of the same account after Refresh", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  addEnterpriseAccount(fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  const enterprise = page.getByRole("row").filter({ hasText: "Enterprise Admin" });
  await expect(enterprise).toBeVisible();

  let releaseRemoval = (): void => undefined;
  let markRemovalStarted = (): void => undefined;
  const removalHeld = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  const removalStarted = new Promise<void>((resolve) => { markRemovalStarted = resolve; });
  const enterpriseAccount = fixture.state.accounts.items.find((account) => account.accountId === "ghes:2")!;
  const staleRemoved = { ...enterpriseAccount, state: "removed" as const, revision: enterpriseAccount.revision + 1 };
  await page.route(/\/accounts\/ghes%3A2$/u, async (route) => {
    markRemovalStarted();
    await removalHeld;
    await route.fulfill({ json: { data: staleRemoved } });
  });
  page.once("dialog", (dialog) => dialog.accept());
  await enterprise.getByRole("button", { name: "Remove", exact: true }).click({ noWaitAfter: true });
  await removalStarted;

  const refreshedAccounts = {
    ...fixture.state.accounts,
    items: fixture.state.accounts.items.map((account) => account.accountId === "ghes:2"
      ? { ...account, displayName: "Reauthenticated Enterprise", revision: staleRemoved.revision + 1 }
      : account),
  };
  await page.route("**/admin/api/v1/accounts", async (route) => {
    await route.fulfill({ json: { data: refreshedAccounts } });
  }, { times: 1 });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Reauthenticated Enterprise", { exact: true })).toBeVisible();

  await page.route("**/admin/api/v1/accounts", async (route) => {
    await route.fulfill({
      status: 500,
      json: { error: { code: "internal_error", message: "synthetic", requestId: "synthetic" } },
    });
  }, { times: 1 });
  try {
    releaseRemoval();
    await expect(page.getByRole("alert")).toContainText("internal error");
    await expect(page.getByText("Reauthenticated Enterprise", { exact: true })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Reauthenticated Enterprise" })
      .getByText("Connected", { exact: true })).toBeVisible();
  } finally {
    releaseRemoval();
  }
});

test("Agent catalog publication waits for an account baseline across navigation", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  let release = (): void => undefined;
  let markStarted = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await page.route("**/admin/api/v1/accounts", async (route) => {
    markStarted();
    await held;
    await route.fallback().catch(() => undefined);
  }, { times: 1 });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await started;
    await expect(page.locator(".agent-card")).toHaveCount(2);
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(0);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    release();
    addEnterpriseAccount(fixture);
    fixture.state.models = { ...fixture.state.models, items: fixture.state.models.items.slice(1) };
    fixture.state.agentsCatalogRevision = "d".repeat(64);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(modelChoiceStatus(page)).toHaveText("1 model choice");
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
  } finally {
    release();
  }
});

test("manual Agent Refresh waits for a successful account baseline before loading the catalog", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  let release = (): void => undefined;
  let markStarted = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await page.route("**/admin/api/v1/accounts", async (route) => {
    markStarted();
    await held;
    await route.fallback();
  }, { times: 1 });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await started;
    await expect(page.locator(".agent-card")).toHaveCount(2);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => fixture.requests.filter((request) => request.url().endsWith("/agents")).length)
      .toBe(2);
    await settleBrowser(page);
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(0);

    addEnterpriseAccount(fixture);
    fixture.state.models = { ...fixture.state.models, items: fixture.state.models.items.slice(1) };
    fixture.state.agentsCatalogRevision = "d".repeat(64);
    release();
    await expect(modelChoiceStatus(page)).toHaveText("1 model choice");
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
  } finally {
    release();
  }
});

test("mounted Agents retries a failed automatic catalog reload at the bounded observation cadence", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await openAgents(page);
  await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const id = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const name = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
  await id.fill("gpt-alpha");
  await name.fill("Retry draft");
  const account = fixture.state.accounts.items[0]!;
  fixture.state.accounts = {
    ...fixture.state.accounts,
    items: [{ ...account, revision: account.revision + 1 }],
  };
  fixture.state.models = { ...fixture.state.models, items: fixture.state.models.items.slice(1) };
  fixture.state.agentsCatalogRevision = "d".repeat(64);
  let automaticCatalogRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/agents/models")) automaticCatalogRequests += 1;
  });
  await page.route("**/admin/api/v1/agents/models", async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: { code: "upstream_unavailable", message: "synthetic", requestId: "synthetic" } },
    });
  }, { times: 1 });

  await advance(page, fixture, 5_000);
  await expect(page.getByRole("alert")).toContainText("upstream unavailable");
  expect(automaticCatalogRequests).toBe(1);
  await advance(page, fixture, 4_999);
  expect(automaticCatalogRequests).toBe(1);
  await advance(page, fixture, 1);
  await expect(modelChoiceStatus(page)).toHaveText("No matching models");
  await expect(id).toHaveValue("gpt-alpha");
  await expect(name).toHaveValue("Retry draft");
  expect(automaticCatalogRequests).toBe(2);
});

test("a held device-flow completion cannot invalidate agent choices after Accounts is left", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await installAdminFixture(page);
  fixture.state.devicePollStates = ["complete"];
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Octo Admin", { exact: true })).toBeVisible();
  const heldPoll = fixture.holdNextDevicePoll();
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  fixture.state.deviceNowMs += 5_000;
  await page.clock.fastForward(5_000);
  await heldPoll.started;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
  const accountReadsAfterNavigation = accountReads(fixture);
  heldPoll.release();
  await heldPoll.responseFinished;
  await settleBrowser(page);
  await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(1);
  expect(accountReads(fixture)).toBe(accountReadsAfterNavigation);
});

test("device-flow account completion invalidates cached agent choices once", async ({ page }) => {
  await page.clock.install({ time: ADMIN_FIXTURE_NOW_MS });
  const fixture = await installAdminFixture(page);
  fixture.state.devicePollStates = ["complete"];
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Start login", exact: true }).click();
  fixture.state.deviceNowMs += 5_000;
  await page.clock.fastForward(5_000);
  await expect(page.getByText("Enterprise Admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Loading accounts...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models"))).toHaveLength(2);
});

for (const action of ["read", "refresh"] as const) {
  test(`an abandoned Models ${action} cannot invalidate newer Agents choices`, async ({ page }) => {
    await openAgents(page);
    await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
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
      await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
      release();
      await canceled;
      await expect(modelChoiceStatus(page)).toHaveText("2 model choices");
      await expect(page.getByText("Model catalog unavailable.", { exact: false })).toHaveCount(0);
    } finally { release(); }
  });
}

async function openAgents(page: Page) {
  const fixture = await installAdminFixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();
  return fixture;
}

function modelChoiceStatus(page: Page): Locator {
  return page.getByRole("region", { name: "Codex", exact: true }).getByRole("status").last();
}

async function chooseModel(card: Locator, inputName: string, query: string): Promise<void> {
  const input = card.getByRole("combobox", { name: inputName, exact: true });
  await input.fill(query);
  await input.press("ArrowDown");
  await input.press("Enter");
}

function addEnterpriseAccount(fixture: AdminFixture): void {
  if (fixture.state.accounts.items.some((account) => account.accountId === "ghes:2")) return;
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
}

function accountReads(fixture: AdminFixture): number {
  return fixture.requests.filter((request) => request.method() === "GET" && request.url().endsWith("/accounts")).length;
}

async function advance(page: Page, fixture: AdminFixture, milliseconds: number): Promise<void> {
  fixture.state.deviceNowMs += milliseconds;
  await page.clock.fastForward(milliseconds);
}

async function settleBrowser(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

test("Agents reuses the cached snapshot until explicit Refresh", async ({ page }) => {
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
  await chooseModel(claude, "Model 4 Copilot model ID", "claude-beta");
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

for (const [state, label, message] of [
  ["conflict", "External changes detected", "Apply failed: external changes detected."],
  ["recovery_required", "Recovery required", "Apply failed: recovery required."],
  ["unsafe_path", "Unsupported or unsafe path", "Apply failed: unsafe configuration path."],
] as const) {
  test(`Apply reports a returned ${state} status without claiming installation`, async ({ page }) => {
    const fixture = await openAgents(page);
    fixture.state.agentsApplyResult = state;
    const codex = page.getByRole("region", { name: "Codex", exact: true });
    await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
    await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
    page.once("dialog", (dialog) => dialog.accept());
    await codex.getByRole("button", { name: "Apply changes", exact: true }).click();

    await expect(codex.locator(".badge")).toHaveText(label);
    await expect(codex.getByRole("alert")).toHaveText(message);
    await expect(codex.getByText(/Configuration installed\. Restart/)).toHaveCount(0);
  });
}

for (const [change, state, revision, label] of [
  ["revision", "installed", "e".repeat(64), "Configuration installed"],
  ["state", "conflict", null, "External changes detected"],
] as const) {
  test(`a Refresh with a newer ${change} clears stale Apply success`, async ({ page }) => {
    const fixture = await openAgents(page);
    const codex = page.getByRole("region", { name: "Codex", exact: true });
    await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
    await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
    page.once("dialog", (dialog) => dialog.accept());
    await codex.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect(codex.getByText(/Configuration installed\. Restart/)).toBeVisible();

    fixture.state.agents.codex = {
      ...fixture.state.agents.codex,
      state,
      revision: revision ?? fixture.state.agents.codex.revision,
      backupAvailable: false,
    };
    await page.getByRole("button", { name: "Refresh", exact: true }).click();

    await expect(codex.locator(".badge")).toHaveText(label);
    await expect(codex.getByText(/Configuration installed\. Restart/)).toHaveCount(0);
    await codex.getByText("Configuration details", { exact: true }).click();
    await expect(codex.getByText("Not created", { exact: true })).toBeVisible();
  });
}

test("Refresh immediately dismisses unchanged Apply success", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  const id = codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const name = codex.getByRole("textbox", { name: "Model 1 Display name", exact: true });
  await id.fill("gpt-alpha");
  await name.fill("Fast");
  page.once("dialog", (dialog) => dialog.accept());
  await codex.getByRole("button", { name: "Apply changes", exact: true }).click();
  const success = codex.getByText(/Configuration installed\. Restart/);
  await expect(success).toBeVisible();
  await codex.getByRole("button", { name: "Add model", exact: true }).click();
  const secondId = codex.getByRole("combobox", { name: "Model 2 Copilot model ID", exact: true });
  const secondName = codex.getByRole("textbox", { name: "Model 2 Display name", exact: true });
  await secondId.fill("claude-beta");
  await secondName.fill("Draft Beta");
  const stableIds = await codex.getByRole("combobox").evaluateAll((inputs) => inputs.map((input) => input.id));

  const refresh = fixture.holdNextAgentsRead();
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await refresh.started;
    await expect(success).toHaveCount(0);
    await expect(id).toHaveValue("gpt-alpha");
    await expect(name).toHaveValue("Fast");
    await expect(secondId).toHaveValue("claude-beta");
    await expect(secondName).toHaveValue("Draft Beta");
    expect(await codex.getByRole("combobox").evaluateAll((inputs) => inputs.map((input) => input.id))).toEqual(stableIds);
    refresh.release();
    await refresh.responseFinished;
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(success).toHaveCount(0);
    await expect(codex.locator(".agent-mapping-row")).toHaveCount(2);
    await expect(secondName).toHaveValue("Draft Beta");
    expect(await codex.getByRole("combobox").evaluateAll((inputs) => inputs.map((input) => input.id))).toEqual(stableIds);
  } finally { refresh.release(); }
});

test("failed Refresh dismisses Apply failure and preserves the dirty draft", async ({ page }) => {
  const fixture = await openAgents(page);
  fixture.state.agentsApplyConflict = true;
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  const id = codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const name = codex.getByRole("textbox", { name: "Model 1 Display name", exact: true });
  await id.fill("gpt-alpha");
  await name.fill("Keep draft");
  page.once("dialog", (dialog) => dialog.accept());
  await codex.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(codex.getByRole("alert")).toHaveText("Apply failed: external changes detected.");
  await codex.getByRole("button", { name: "Add model", exact: true }).click();
  const secondId = codex.getByRole("combobox", { name: "Model 2 Copilot model ID", exact: true });
  const secondName = codex.getByRole("textbox", { name: "Model 2 Display name", exact: true });
  await secondId.fill("claude-beta");
  await secondName.fill("Surviving row");
  const survivingId = await secondId.getAttribute("id");
  await codex.getByRole("button", { name: "Remove model 1", exact: true }).click();
  const remainingId = codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const remainingName = codex.getByRole("textbox", { name: "Model 1 Display name", exact: true });
  await expect(remainingId).toHaveAttribute("id", survivingId!);

  fixture.state.failAgents = true;
  const refresh = fixture.holdNextAgentsRead();
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await refresh.started;
    await expect(codex.getByRole("alert")).toHaveCount(0);
    await expect(codex.locator(".agent-mapping-row")).toHaveCount(1);
    await expect(remainingId).toHaveAttribute("id", survivingId!);
    await expect(remainingId).toHaveValue("claude-beta");
    await expect(remainingName).toHaveValue("Surviving row");
    refresh.release();
    await refresh.responseFinished;
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toContainText("internal error");
    await expect(codex.getByRole("alert")).toHaveCount(0);
    await expect(codex.locator(".agent-mapping-row")).toHaveCount(1);
    await expect(remainingId).toHaveAttribute("id", survivingId!);
    await expect(remainingName).toHaveValue("Surviving row");
  } finally { refresh.release(); }
});

test("an in-flight Refresh cannot overwrite a newer Apply result", async ({ page }) => {
  const fixture = await openAgents(page);
  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  const refresh = fixture.holdNextAgentsRead();
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click({ noWaitAfter: true });
    await refresh.started;
    page.once("dialog", (dialog) => dialog.accept());
    await codex.getByRole("button", { name: "Apply changes", exact: true }).click();
    await expect(codex.locator(".badge")).toHaveText("Configuration installed");
    await expect(codex.getByText(/Configuration installed\. Restart/)).toBeVisible();
    refresh.release();
    await refresh.responseFinished;
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(codex.locator(".badge")).toHaveText("Configuration installed");
    await expect(codex.getByText(/Configuration installed\. Restart/)).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { refresh.release(); }
});

for (const [state, label, message] of [
  ["recovery_required", "Recovery required", "Apply failed: recovery required."],
  ["unsafe_path", "Unsupported or unsafe path", "Apply failed: unsafe configuration path."],
] as const) {
  test(`Codex ${state} without takeover evidence uses ordinary Apply and remains fail closed`, async ({ page }) => {
    const fixture = await installAdminFixture(page);
    fixture.state.agents.codex = { ...fixture.state.agents.codex, state, takeover: null };
    fixture.state.agentsApplyResult = state;
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const codex = page.getByRole("region", { name: "Codex", exact: true });
    await expect(codex.locator(".badge")).toHaveText(label);
    await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
    await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");

    await codex.getByRole("button", { name: "Apply changes", exact: true }).click();

    await expect(codex.getByRole("alert")).toHaveText(message);
    expect(fixture.requests.filter((request) => request.url().endsWith("/agents/apply"))).toHaveLength(1);
    expect(fixture.requests.some((request) => request.url().endsWith("/agents/takeover"))).toBe(false);
    await expect(page.getByRole("dialog", { name: "Take over Codex configuration?" })).toHaveCount(0);
  });
}

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

test("conflict and recovery states keep Apply clickable while reporting backend errors", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agents.codex = { ...fixture.state.agents.codex, state: "conflict" };
  fixture.state.agents.claude = { ...fixture.state.agents.claude, state: "recovery_required" };
  fixture.state.agentsApplyConflict = true;
  await page.goto("/");
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeFocused();

  const codex = page.locator(".agent-card", { has: page.getByRole("heading", { name: "Codex" }) });
  await expect(codex.locator(".badge")).toHaveText("External changes detected");
  await codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await codex.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Fast");
  await expect(codex.getByRole("button", { name: "Apply changes" })).toBeEnabled();
  await codex.getByRole("button", { name: "Apply changes" }).click();
  await expect(codex.getByRole("alert")).toHaveText("Apply failed: external changes detected.");

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

test("model combobox filters usable choices and supports standard keyboard navigation", async ({ page }) => {
  await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const input = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const displayName = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });

  await input.click();
  await expect(card.getByRole("option")).toHaveText(["gpt-alphaAlpha", "claude-betaBeta"]);
  await input.fill("BETA");
  await expect(card.getByRole("option")).toHaveCount(1);
  await expect(card.getByRole("option")).toContainText("claude-beta");
  await expect(displayName).toHaveValue("");

  await input.press("ArrowUp");
  const optionId = await input.getAttribute("aria-activedescendant");
  expect(optionId).toBeTruthy();
  await expect(page.locator(`#${optionId}`)).toContainText("claude-beta");
  await expect(page.locator(`#${optionId}`)).toHaveAttribute("aria-selected", "true");
  await input.press("Home");
  await expect(input).toHaveJSProperty("selectionStart", 0);
  await input.press("End");
  await expect(input).toHaveJSProperty("selectionStart", 4);
  await input.press("Enter");
  await expect(input).toHaveValue("claude-beta");
  await expect(displayName).toHaveValue("Beta");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/u);
  await expect(card.locator(".agent-model-listbox")).toBeHidden();

  await input.press("ArrowDown");
  await input.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await input.press("Tab");
  await expect(displayName).toBeFocused();
});

test("mouse model selection fills the row and collapses the combobox", async ({ page }) => {
  await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const input = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const displayName = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
  await input.click();

  await card.getByRole("option").filter({ hasText: "claude-beta" }).click();

  await expect(input).toHaveValue("claude-beta");
  await expect(displayName).toHaveValue("Beta");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/u);
  await expect(card.locator(".agent-model-listbox")).toBeHidden();
});

test("combobox row IDs stay unique and stable across add and remove", async ({ page }) => {
  await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const first = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const firstId = await first.getAttribute("id");
  await card.getByRole("button", { name: "Add model", exact: true }).click();
  const second = card.getByRole("combobox", { name: "Model 2 Copilot model ID", exact: true });
  const secondId = await second.getAttribute("id");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(secondId).not.toBe(firstId);
  await expect(second).toHaveAttribute("aria-controls", `${secondId}-listbox`);
  await card.getByRole("button", { name: "Remove model 1", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true })).toHaveAttribute("id", secondId!);
});

test.describe("touch model combobox", () => {
  test.use({ hasTouch: true });

  test("combobox popups stay isolated and touch scrolling does not select", async ({ page }) => {
    const fixture = await installAdminFixture(page);
    const base = fixture.state.models.items[0]!;
    fixture.state.models = {
      ...fixture.state.models,
      items: Array.from({ length: 20 }, (_, index) => ({
        ...base,
        id: `touch-model-${index.toString().padStart(2, "0")}`,
        name: `Touch Model ${index}`,
      })),
    };
    await page.goto("/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 500 });
    const codex = page.getByRole("region", { name: "Codex", exact: true });
    const claude = page.getByRole("region", { name: "Claude Code", exact: true });
    const codexInput = codex.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
    const claudeInput = claude.getByRole("combobox", { name: "Sonnet Copilot model ID", exact: true });
    await codexInput.click();
    await expect(codex.getByRole("listbox")).toBeVisible();
    await claudeInput.click();
    await expect(codex.locator(".agent-model-listbox")).toBeHidden();
    await expect(claude.getByRole("listbox").first()).toBeVisible();

    const listbox = claude.getByRole("listbox").first();
    const box = await listbox.boundingBox();
    expect(box).not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const x = Math.round(box!.x + box!.width / 2);
    const startY = Math.round(box!.y + box!.height - 18);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
    for (const y of [startY - 30, startY - 60, startY - 90, startY - 120]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => listbox.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(claudeInput).toHaveValue("");
    await expect(codexInput).toHaveValue("");
    await expect(claudeInput).toHaveAttribute("aria-expanded", "true");
    await expect(listbox).toBeVisible();
  });

  test("touch tap selection fills the row and collapses the combobox", async ({ page }) => {
    await openAgents(page);
    const card = page.getByRole("region", { name: "Codex", exact: true });
    const input = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
    const displayName = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
    await input.tap();

    await card.getByRole("option").filter({ hasText: "claude-beta" }).tap();

    await expect(input).toHaveValue("claude-beta");
    await expect(displayName).toHaveValue("Beta");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/u);
    await expect(card.locator(".agent-model-listbox")).toBeHidden();
  });
});

test("combobox closes on outside focus and row removal", async ({ page }) => {
  await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const first = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  await first.click();
  await page.getByRole("heading", { name: "Agents", exact: true }).click();
  await expect(card.locator(".agent-model-listbox")).toBeHidden();

  await card.getByRole("button", { name: "Add model", exact: true }).click();
  await card.getByRole("combobox", { name: "Model 2 Copilot model ID", exact: true }).click();
  await expect(card.getByRole("listbox")).toBeVisible();
  await card.getByRole("button", { name: "Remove model 2", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "Model 2 Copilot model ID", exact: true })).toHaveCount(0);
  await expect(card.locator(".agent-model-listbox:not([hidden])")).toHaveCount(0);
});

test("combobox reports no usable models and excludes unusable catalog items", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  await page.route("**/admin/api/v1/agents/models", async (route) => {
    await route.fulfill({ json: { data: {
      accountId: fixture.state.models.accountId,
      catalogRevision: "c".repeat(64),
      items: fixture.state.models.items,
      usableModelIds: [],
    } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).click();
  await expect(card.locator(".agent-model-empty")).toHaveText("No usable models");
  await expect(card.getByRole("option")).toHaveCount(0);
});

test("active option clears when catalog loading replaces choices", async ({ page }) => {
  const fixture = await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const input = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", /option/u);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/admin/api/v1/agents/models", async (route) => { await held; await route.fallback(); }, { times: 1 });
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card.locator(".agent-model-empty")).toHaveText("Loading model choices");
    await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/u);
  } finally {
    release();
  }
  expect(fixture.requests.filter((request) => request.url().endsWith("/agents/models")).length).toBeGreaterThanOrEqual(1);
});

test("combobox popup matches input width and stays inside each viewport", async ({ page }) => {
  await openAgents(page);
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 500 });
    const card = page.getByRole("region", { name: "Codex", exact: true });
    const input = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
    await input.click();
    const listbox = card.getByRole("listbox");
    const [inputBox, listBox] = await Promise.all([input.boundingBox(), listbox.boundingBox()]);
    expect(inputBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(Math.abs(inputBox!.width - listBox!.width)).toBeLessThanOrEqual(1);
    expect(listBox!.x).toBeGreaterThanOrEqual(0);
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(width + 1);
    expect(listBox!.y).toBeGreaterThanOrEqual(0);
    expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(501);
    await input.press("Escape");
  }
});

test("combobox opens above with bounded scrolling and follows the visual viewport", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  const base = fixture.state.models.items[0]!;
  fixture.state.models = {
    ...fixture.state.models,
    items: Array.from({ length: 20 }, (_, index) => ({
      ...base,
      id: `model-${index.toString().padStart(2, "0")}`,
      name: `Model ${index}`,
    })),
  };
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 400 });
  const card = page.getByRole("region", { name: "Claude Code", exact: true });
  const input = card.getByRole("combobox", { name: "Haiku Copilot model ID", exact: true });
  await input.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await input.click();
  const popup = card.getByRole("listbox").last();
  await expect(popup.locator("[role=option]")).toHaveCount(20);
  expect(await popup.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const [inputBox, popupBox] = await Promise.all([input.boundingBox(), popup.boundingBox()]);
  expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(inputBox!.y + 1);

  const visualTop = Math.max(0, inputBox!.y - 100);
  await page.evaluate(({ top }) => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: top });
    Object.defineProperty(viewport, "height", { configurable: true, value: 200 });
    viewport.dispatchEvent(new Event("resize"));
  }, { top: visualTop });
  await expect.poll(() => popup.evaluate((element, top) => {
    const box = element.getBoundingClientRect();
    return box.top >= top && box.bottom <= top + 200;
  }, visualTop)).toBe(true);
});

test("Apply failures are concise, red, persist through edits, and clear after success", async ({ page }) => {
  const fixture = await openAgents(page);
  fixture.state.agentsApplyConflict = true;
  const card = page.getByRole("region", { name: "Codex", exact: true });
  const id = card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true });
  const name = card.getByRole("textbox", { name: "Model 1 Display name", exact: true });
  await id.fill("gpt-alpha");
  await name.fill("Keep draft");
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Apply changes", exact: true }).click();

  const alert = card.getByRole("alert");
  await expect(alert).toHaveText("Apply failed: external changes detected.");
  expect((await alert.textContent())!.trim().split(/\s+/u)).toHaveLength(5);
  await expect(alert).toHaveCSS("color", "rgb(180, 41, 32)");
  await expect(id).toHaveValue("gpt-alpha");
  await expect(name).toHaveValue("Keep draft");
  await name.fill("Still here");
  await expect(alert).toBeVisible();
  fixture.state.agentsApplyConflict = false;
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(card.locator(".badge")).toHaveText("Configuration installed");
});

test("canceling first Apply preserves the draft without reporting failure", async ({ page }) => {
  const fixture = await openAgents(page);
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await card.getByRole("combobox", { name: "Model 1 Copilot model ID", exact: true }).fill("gpt-alpha");
  await card.getByRole("textbox", { name: "Model 1 Display name", exact: true }).fill("Keep me");
  page.once("dialog", (dialog) => dialog.dismiss());
  await card.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.getByRole("textbox", { name: "Model 1 Display name", exact: true })).toHaveValue("Keep me");
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/apply"))).toBe(false);
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
      configBackupPath: "C:/Users/octo/.codex/config.toml.ghcg.bak",
      catalogBackupPath: "C:/Users/octo/.codex/models.json.ghcg.bak",
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
    fixture.state.agents.codex.takeover.configBackupPath,
    fixture.state.agents.codex.takeover.catalogBackupPath,
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

test("stale Codex takeover preserves the draft and reports concise failure", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agents.codex = {
    ...fixture.state.agents.codex,
    state: "conflict",
    mappings: [{ modelId: "gpt-alpha", displayName: "Keep me" }],
    takeover: {
      revision: "d".repeat(64),
      configPath: "C:/Users/octo/.codex/config.toml",
      catalogPath: "C:/Users/octo/.codex/models.json",
      configBackupPath: "C:/Users/octo/.codex/config.toml.ghcg.bak",
      catalogBackupPath: "C:/Users/octo/.codex/models.json.ghcg.bak",
    },
  };
  fixture.state.agentsTakeoverConflict = true;
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await card.getByRole("button", { name: "Apply changes", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Take over configuration", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Apply failed: stale configuration revision.");
  await expect(card.getByRole("textbox", { name: "Model 1 Display name", exact: true })).toHaveValue("Keep me");
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/apply"))).toBe(false);
});

test("unmanaged Codex takeover evidence routes Apply to the HTML dialog without native confirmation", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.agents.codex = {
    ...fixture.state.agents.codex,
    state: "not_managed",
    takeover: {
      revision: "d".repeat(64),
      configPath: "C:/Users/octo/.codex/config.toml",
      catalogPath: "C:/Users/octo/.codex/models.json",
      configBackupPath: "C:/Users/octo/.codex/config.toml.ghcg.bak",
      catalogBackupPath: "C:/Users/octo/.codex/models.json.ghcg.bak",
    },
  };
  let nativeConfirmation = false;
  page.on("dialog", (dialog) => {
    nativeConfirmation = true;
    void dialog.dismiss();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const card = page.getByRole("region", { name: "Codex", exact: true });

  await card.getByRole("button", { name: "Apply changes", exact: true }).click();

  await expect(page.getByRole("dialog", { name: "Take over Codex configuration?" })).toBeVisible();
  expect(nativeConfirmation).toBe(false);
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/apply"))).toBe(false);
  expect(fixture.requests.some((request) => request.url().endsWith("/agents/takeover"))).toBe(false);
});
