import { expect, test, type Locator, type Page } from "@playwright/test";
import { installAdminFixture, type AdminFixture } from "./fixtures/admin_fixture.js";

test.use({ locale: "en-US" });

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

test("Models hides the previous account diagnostics while the next catalog loads", async ({ page }) => {
  const fixture = await openModels(page, (fixture) => {
    const first = fixture.state.accounts.items[0]!;
    fixture.state.accounts = { ...fixture.state.accounts, items: [first, {
      ...first, accountId: "ghes:2", host: "github.example.test", login: "enterprise", displayName: "Enterprise Admin",
    }] };
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/models\?accountId=ghes%3A2$/u, async (route) => {
    await pending;
    await route.fulfill({ json: { data: { ...fixture.state.models,
      accountId: "ghes:2", catalogGeneration: 9, credentialGeneration: 4,
    } } });
  });
  const metadata = page.locator(".toolbar").first().locator(".subtle");
  try {
    await page.getByLabel("Account", { exact: true }).selectOption("ghes:2");
    await expect(page.getByText("Loading model catalog...", { exact: true })).toBeVisible();
    await expect(metadata).toHaveCount(0);
  } finally { release(); }
  await expect(metadata).toContainText("Generation 9 · credential 4 · fetched");
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

async function expectInlineBadges(source: Locator, labels: string[]): Promise<void> {
  const badges = source.locator(".badge");
  await expect(badges).toHaveText(labels);
  const geometry = await badges.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: rect.top, height: rect.height, left: rect.left, right: rect.right,
      font: style.font, padding: style.padding, borderWidth: style.borderWidth,
      whiteSpace: style.whiteSpace, textTransform: style.textTransform,
    };
  }));
  const first = geometry[0]!;
  for (const [index, badge] of geometry.entries()) {
    expect(Math.abs(badge.top - first.top)).toBeLessThanOrEqual(1);
    expect(badge.height).toBe(first.height);
    expect(badge.font).toBe(first.font);
    expect(badge.padding).toBe(first.padding);
    expect(badge.borderWidth).toBe(first.borderWidth);
    expect(badge.whiteSpace).toBe("nowrap");
    expect(badge.textTransform).toBe("none");
    if (index > 0) expect(badge.left).toBeGreaterThanOrEqual(geometry[index - 1]!.right);
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`models controls and source rows stay bounded at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openModels(page, metadataCases);
    await expectInlineBadges(
      page.locator("tbody[data-model-id=\"upstream-conflict\"] > tr").first().getByRole("cell").nth(2),
      ["Protocols: Upstream", "Protocol conflict"],
    );
    await expectInlineBadges(
      page.locator("tbody[data-model-id=\"discovered-builtin\"] > tr").first().getByRole("cell").nth(2),
      ["Protocols: Built-in"],
    );
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
  await expect(page.getByText("Protocols identifies", { exact: false })).toContainText("not live inference validation");
  for (const [id, labels] of [
    ["gpt-alpha", ["Protocols: Upstream"]],
    ["upstream-conflict", ["Protocols: Upstream", "Protocol conflict"]],
    ["discovered-builtin", ["Protocols: Built-in"]],
    ["unknown-model", ["Protocols: Unknown"]],
  ] as const) {
    const source = page.locator(`tbody[data-model-id="${id}"] > tr`).first().getByRole("cell").nth(2);
    await expectInlineBadges(source, [...labels]);
    await expect(source).not.toContainText("live");
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

test("models allow inspection and preference selection without metadata editing or additions", async ({ page }) => {
  const fixture = await openModels(page);
  const model = page.locator('tbody[data-model-id="claude-beta"]');
  await model.getByText("Capability details", { exact: true }).click();
  await expect(model.locator("dl")).toContainText("Native HTTP protocols");
  await expect(model.locator("dl")).toContainText("Built-in revision");
  await expect(page.locator("main input, main fieldset, main form")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(model.getByRole("button")).toHaveText(["Set preferred"]);
  await model.getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByRole("status")).toHaveText("claude-beta is now preferred.");
  const mutations = fixture.requests.filter((request) => request.method() !== "GET"
    && new URL(request.url()).pathname.startsWith("/admin/api/v1/models"));
  expect(mutations.map((request) => new URL(request.url()).pathname)).toEqual(["/admin/api/v1/models/preferred"]);
  expect(mutations[0]?.headers()["x-ghcg-csrf"]).toBe("csrf-memory-only");
});

test("models refresh clears stale success, stays quiet on success, and retains errors and invalid preference", async ({ page }) => {
  const fixture = await openModels(page);
  await page.locator("tbody[data-model-id=\"claude-beta\"]").getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByRole("status")).toHaveText("claude-beta is now preferred.");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await page.route("**/admin/api/v1/models/refresh", async (route) => {
    await route.fulfill({ status: 200, json: { data: fixture.state.models } });
  }, { times: 1 });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Catalog refreshed", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toHaveCount(0);

  await page.locator("tbody[data-model-id=\"gpt-alpha\"]").getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByRole("status")).toHaveText("gpt-alpha is now preferred.");
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
