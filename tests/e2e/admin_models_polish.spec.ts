import { expect, test, type Page } from "@playwright/test";
import { installAdminFixture, type AdminFixture } from "./fixtures/admin_fixture.js";

test.use({ locale: "en-US" });

test("Models is a read-only directory with shared capability fields", async ({ page }) => {
  const fixture = await openModels(page);
  await expect(page.getByRole("columnheader")).toHaveText(["Model", "Native interfaces", "Per-request token limits"]);
  await expect(page.getByRole("button", { name: /preferred/i })).toHaveCount(0);
  await page.locator("tbody").first().getByText("Capability details", { exact: true }).click();
  await expect(page.locator("tbody").first()).toContainText("Context window");
  await expect(page.locator("tbody").first()).toContainText("144,000");
  await expect(page.locator("tbody").first()).toContainText("temperature");
  expect(fixture.requests.some((request) => request.url().endsWith("/models/preferred"))).toBe(false);
});

async function navigateTo(page: Page, view: "Overview" | "Models"): Promise<void> {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: view, exact: true }).click();
  await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
}

async function openModels(page: Page, configure?: (fixture: AdminFixture) => void): Promise<AdminFixture> {
  const fixture = await installAdminFixture(page);
  configure?.(fixture);
  await page.goto("/admin/#bootstrap_token=synthetic-models-bootstrap");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await navigateTo(page, "Models");
  await expect(page.getByRole("table")).toBeVisible();
  return fixture;
}

for (const width of [1440, 1100, 390, 320]) {
  test(`Models account diagnostics align or wrap without clipping at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openModels(page);
    const toolbar = page.locator(".toolbar").first();
    const label = (await toolbar.locator("label").boundingBox())!;
    const metadata = toolbar.locator(".subtle");
    await expect(metadata).toContainText("Generation 1 · credential 1 · fetched");
    const box = (await metadata.boundingBox())!;
    if (width === 1440) {
      expect(Math.abs(label.y + label.height / 2 - box.y - box.height / 2)).toBeLessThanOrEqual(1);
    }
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await metadata.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await toolbar.screenshot({ path: testInfo.outputPath(`model-account-toolbar-${width}.png`) });
  });
}

for (const width of [1440, 390, 320]) {
  test(`Models keeps the empty Account selector width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await openModels(page);
    const populated = page.getByRole("combobox", { name: "Account", exact: true });
    const populatedBox = (await populated.boundingBox())!;

    fixture.state.accounts = { ...fixture.state.accounts, defaultAccountId: null, items: [] };
    await navigateTo(page, "Overview");
    await navigateTo(page, "Models");

    const empty = page.getByRole("combobox", { name: "Account", exact: true });
    await expect(empty).toHaveValue("");
    await expect(empty.getByRole("option")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No active account", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
    const emptyBox = (await empty.boundingBox())!;
    expect(Math.abs(emptyBox.width - populatedBox.width)).toBeLessThanOrEqual(1);
    expect(emptyBox.x).toBeGreaterThanOrEqual(0);
    expect(emptyBox.x + emptyBox.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("Models renders rows, warnings and diagnostics only for the selected account", async ({ page }) => {
  const fixture = await openModels(page, (fixture) => {
    const first = fixture.state.accounts.items[0]!;
    fixture.state.accounts = { ...fixture.state.accounts, items: [first, {
      ...first, accountId: "ghes:2", host: "github.example.test", login: "enterprise", displayName: "Enterprise Admin",
    }] };
    fixture.state.models = {
      ...fixture.state.models,
      preferredModel: { revision: 2, modelId: "missing-model", validity: "invalid" },
    };
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/models\?accountId=ghes%3A2$/u, async (route) => {
    await pending;
    await route.fulfill({ json: { data: { ...fixture.state.models,
      accountId: "ghes:2", catalogGeneration: 9, credentialGeneration: 4,
      preferredModel: null,
      items: [{ ...fixture.state.models.items[0]!, id: "enterprise-model", name: "Enterprise Model" }],
    } } });
  });
  const metadata = page.locator(".toolbar").first().locator(".subtle");
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toBeVisible();
  try {
    await page.getByLabel("Account", { exact: true }).selectOption("ghes:2");
    await expect(page.getByText("Loading model catalog...", { exact: true })).toBeVisible();
    await expect(metadata).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toHaveCount(0);
    await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toHaveCount(0);
  } finally { release(); }
  await expect(metadata).toContainText("Generation 9 · credential 4 · fetched");
  await expect(page.locator("tbody[data-model-id=\"enterprise-model\"]")).toBeVisible();
  await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toHaveCount(0);
});

test("Models does not render the previous account catalog when switching fails", async ({ page }) => {
  const fixture = await openModels(page, (fixture) => {
    const first = fixture.state.accounts.items[0]!;
    fixture.state.accounts = { ...fixture.state.accounts, items: [first, {
      ...first, accountId: "ghes:2", host: "github.example.test", login: "enterprise", displayName: "Enterprise Admin",
    }] };
  });
  fixture.state.models = {
    ...fixture.state.models,
    preferredModel: { revision: 2, modelId: "missing-model", validity: "invalid" },
    items: [],
  };
  await navigateTo(page, "Overview");
  await navigateTo(page, "Models");
  await expect(page.getByRole("heading", { name: "Catalog is empty" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await expect(page.locator(".toolbar").first().locator(".subtle")).toContainText("Generation 1 · credential 1 · fetched");

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/models\?accountId=ghes%3A2$/u, async (route) => {
    await pending;
    await route.fulfill({
      status: 503,
      json: { error: { code: "upstream_unavailable", message: "upstream unavailable", requestId: "failed-switch" } },
    });
  });
  try {
    await page.getByLabel("Account", { exact: true }).selectOption("ghes:2");
    await expect(page.getByText("Loading model catalog...", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Catalog is empty" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toHaveCount(0);
    await expect(page.locator(".toolbar").first().locator(".subtle")).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole("alert")).toHaveText("upstream unavailable");
  await expect(page.getByText("Loading model catalog...", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Catalog is empty" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toHaveCount(0);
  await expect(page.locator(".toolbar").first().locator(".subtle")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("a superseded account response cannot overwrite the newer selection", async ({ page }) => {
  const fixture = await openModels(page, (fixture) => {
    const first = fixture.state.accounts.items[0]!;
    fixture.state.accounts = { ...fixture.state.accounts, items: [first, {
      ...first, accountId: "ghes:2", host: "github.example.test", login: "enterprise", displayName: "Enterprise Admin",
    }] };
  });
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  await page.route(/\/models\?accountId=ghes%3A2$/u, async (route) => {
    started();
    await pending;
    await route.fulfill({ json: { data: {
      ...fixture.state.models,
      accountId: "ghes:2",
      catalogGeneration: 9,
      credentialGeneration: 4,
      preferredModel: null,
      items: [{ ...fixture.state.models.items[0]!, id: "enterprise-model", name: "Enterprise Model" }],
    } } });
  });
  try {
    await page.getByLabel("Account", { exact: true }).selectOption("ghes:2");
    await entered;
    await page.getByLabel("Account", { exact: true }).selectOption("github:1");
    await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toBeVisible();
    const lateResponse = page.waitForResponse((response) => response.url().endsWith("/models?accountId=ghes%3A2"));
    release();
    await lateResponse;
    await expect(page.getByLabel("Account", { exact: true })).toHaveValue("github:1");
    await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toBeVisible();
    await expect(page.locator("tbody[data-model-id=\"enterprise-model\"]")).toHaveCount(0);
    await expect(page.locator(".toolbar").first().locator(".subtle"))
      .toContainText("Generation 1 · credential 1 · fetched");
  } finally { release(); }
});

test("an abandoned Models account switch cannot render after navigation", async ({ page }) => {
  await openModels(page, (fixture) => {
    const first = fixture.state.accounts.items[0]!;
    fixture.state.accounts = { ...fixture.state.accounts, items: [first, {
      ...first, accountId: "ghes:2", host: "github.example.test", login: "enterprise", displayName: "Enterprise Admin",
    }] };
  });
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  await page.route(/\/models\?accountId=ghes%3A2$/u, async (route) => {
    started();
    await pending;
    await route.fallback();
  });
  try {
    await page.getByLabel("Account", { exact: true }).selectOption("ghes:2");
    await entered;
    const canceled = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().endsWith("/models?accountId=ghes%3A2"),
    });
    await navigateTo(page, "Overview");
    release();
    await canceled;
    await navigateTo(page, "Models");
    await expect(page.getByLabel("Account", { exact: true })).toHaveValue("github:1");
    await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toBeVisible();
    await expect(page.locator("tbody[data-model-id=\"enterprise-model\"]")).toHaveCount(0);
    await expect(page.locator(".toolbar").first().locator(".subtle"))
      .toContainText("Generation 1 · credential 1 · fetched");
  } finally { release(); }
});

function metadataCases(fixture: AdminFixture): void {
  const base = fixture.state.models.items[0]!;
  fixture.state.models = {
    ...fixture.state.models,
    preferredModel: null,
    items: [
      base,
      {
        ...base, id: "upstream-conflict", name: "Upstream conflict",
        protocols: ["messages"], protocolsSource: "live", protocolsConflict: true,
      },
      {
        ...base, id: "discovered-builtin", name: "Discovered built-in",
        protocolsSource: "builtin", protocolsLiveState: "missing",
      },
      {
        ...base, id: "unknown-model", name: "Unknown model", protocols: null,
        protocolsSource: "unknown", protocolsLiveState: "malformed",
        maxInputTokens: null, maxInputTokensSource: "unknown", maxInputTokensLiveState: "missing",
        maxOutputTokens: null, maxOutputTokensSource: "unknown", maxOutputTokensLiveState: "malformed",
        defaultOutputTokens: {
          configured: null, configuredSource: "unknown", conflict: false, liveState: "missing",
          effective: 4096, source: "unknown_fallback", valid: true,
        },
      },
    ],
  };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`models controls and read-only rows stay bounded at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openModels(page, metadataCases);
    await expect(page.getByRole("columnheader")).toHaveCount(3);
    await expect(page.locator("tbody[data-model-id=\"upstream-conflict\"] > tr").first().getByRole("cell")).toHaveCount(3);
    await expect(page.getByText("Protocols: Upstream", { exact: true })).toHaveCount(0);
    const bounds = await page.locator(".table-scroll").evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      client: element.clientWidth,
      scroll: element.scrollWidth,
      overflow: getComputedStyle(element).overflowX,
      rootClient: document.documentElement.clientWidth,
      rootScroll: document.documentElement.scrollWidth,
    }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width);
    expect(bounds.rootScroll).toBeLessThanOrEqual(bounds.rootClient);
    expect(bounds.overflow).toBe("auto");
    if (viewport.width < 600) expect(bounds.scroll).toBeGreaterThan(bounds.client);
    await page.screenshot({ path: testInfo.outputPath(`models-${viewport.width}.png`), fullPage: true });
  });
}

test("models distinguish catalog membership from native protocol metadata sources", async ({ page }) => {
  await openModels(page, metadataCases);
  await expect(page.getByText("Only models discovered", { exact: false })).toContainText("upstream catalog");
  await expect(page.getByText("Capability details show", { exact: false })).toContainText("not live inference validation");
  for (const [id, labels] of [
    ["gpt-alpha", "Upstream"],
    ["upstream-conflict", "Upstream · Conflict"],
    ["discovered-builtin", "Built-in"],
    ["unknown-model", "Unknown"],
  ] as const) {
    const model = page.locator(`tbody[data-model-id="${id}"]`);
    await model.getByText("Capability details", { exact: true }).click();
    await expect(model.locator("dl")).toContainText(labels);
  }
});

test("models label per-request token ceilings and retain unknowns and budget details", async ({ page }) => {
  await openModels(page, metadataCases);
  await expect(page.getByRole("columnheader", { name: "Per-request token limits" })).toBeVisible();
  await page.getByText("About sources and token limits", { exact: true }).click();
  await expect(page.getByText("Token limits apply to each request, not account quota.")).toBeVisible();
  const known = page.locator("tbody[data-model-id=\"gpt-alpha\"]");
  await expect(known.getByRole("row").first()).toContainText(`Max input: ${(128000).toLocaleString("en-US")}`);
  await expect(known.getByRole("row").first()).toContainText(`Max output: ${(16000).toLocaleString("en-US")}`);
  const unknown = page.locator("tbody[data-model-id=\"unknown-model\"]");
  await expect(unknown.getByRole("row").first()).toContainText("Max input: Unknown");
  await expect(unknown.getByRole("row").first()).toContainText("Max output: Unknown");
  await unknown.getByText("Capability details").click();
  await expect(unknown.locator("dl")).toContainText("Default output");
  await expect(unknown.locator("dl")).toContainText((4096).toLocaleString("en-US"));
  await expect(unknown.locator("dl")).toContainText("Unknown ceiling fallback");
  await expect(unknown.locator("dl")).toContainText("Chat budget field");
  await expect(unknown.locator("dl")).toContainText("max_tokens");
  await expect(unknown.locator("dl")).toContainText("Malformed");
  await expect(unknown.locator("input, select, fieldset")).toHaveCount(0);
});

test("models allow inspection without metadata editing or preference actions", async ({ page }) => {
  const fixture = await openModels(page);
  const model = page.locator("tbody[data-model-id=\"claude-beta\"]");
  await model.getByText("Capability details", { exact: true }).click();
  await expect(model.locator("dl")).toContainText("Native HTTP protocols");
  await expect(model.locator("dl")).toContainText("Built-in revision");
  await expect(page.locator("main input, main fieldset, main form")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(model.getByRole("button")).toHaveCount(0);
  const mutations = fixture.requests.filter((request) => request.method() !== "GET"
    && new URL(request.url()).pathname.startsWith("/admin/api/v1/models"));
  expect(mutations).toEqual([]);
});

test("models refresh stays quiet on success and retains errors and invalid CLI preference", async ({ page }) => {
  const fixture = await openModels(page);
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await page.route("**/admin/api/v1/models/refresh", async (route) => {
    await route.fulfill({ status: 200, json: { data: fixture.state.models } });
  }, { times: 1 });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Catalog refreshed", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toHaveCount(0);

  await page.route("**/admin/api/v1/models/refresh", async (route) => {
    await route.fulfill({ status: 503, json: { error: { code: "upstream_unavailable", requestId: "synthetic-refresh" } } });
  }, { times: 1 });
  await refresh.click();
  await expect(page.getByRole("alert")).toContainText("upstream unavailable");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator("tbody[data-model-id=\"gpt-alpha\"]")).toBeVisible();

  await refresh.click();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("will not silently substitute one");
  await expect(page.getByRole("alert")).not.toContainText("upstream unavailable");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Catalog refreshed", { exact: false })).toHaveCount(0);
});
