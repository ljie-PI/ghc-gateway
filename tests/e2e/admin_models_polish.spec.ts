import { expect, test, type Locator, type Page } from "@playwright/test";
import { installAdminFixture, type AdminFixture } from "./fixtures/admin_fixture.js";

test.use({ locale: "en-US" });

async function openModels(page: Page, configure?: (fixture: AdminFixture) => void): Promise<AdminFixture> {
  const fixture = await installAdminFixture(page);
  configure?.(fixture);
  await page.goto("/admin/#bootstrap_token=synthetic-models-bootstrap");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  return fixture;
}

function metadataCases(fixture: AdminFixture): void {
  const base = fixture.state.models.items[0]!;
  fixture.state.models = {
    ...fixture.state.models,
    preferredModel: null,
    items: [
      base,
      {
        ...base, id: "configured-upstream", name: "Configured upstream", configured: true,
        override: { enabled: true }, overrideRevision: 1,
      },
      {
        ...base, id: "configured-conflict", name: "Configured conflict", configured: true,
        protocols: ["messages"], protocolsSource: "admin_override", protocolsConflict: true,
        override: { enabled: true, protocols: ["messages"] }, overrideRevision: 1,
      },
      {
        ...base, id: "manual-builtin", name: "Manual built-in", discovered: false, configured: true,
        verified: false, protocolsSource: "builtin", protocolsLiveState: "missing",
        override: { enabled: true }, overrideRevision: 1,
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
    const input = page.getByRole("textbox", { name: "Model ID", exact: true });
    const button = page.getByRole("button", { name: "Add configured model", exact: true });
    await expect(input).toHaveAttribute("placeholder", "Exact model ID");
    const inputBox = (await input.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    expect(Math.abs(inputBox.height - buttonBox.height)).toBeLessThanOrEqual(1);
    for (const box of [inputBox, buttonBox]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    if (viewport.width > 600) {
      expect(Math.abs(inputBox.y - buttonBox.y)).toBeLessThanOrEqual(1);
    } else {
      expect(inputBox.x).toBe(buttonBox.x);
      expect(inputBox.width).toBe(buttonBox.width);
    }
    await expectInlineBadges(
      page.locator("tbody[data-model-id=\"configured-conflict\"] > tr").first().getByRole("cell").nth(2),
      ["Discovered", "Configured override", "Protocols: Admin override", "Protocol conflict"],
    );
    await expectInlineBadges(
      page.locator("tbody[data-model-id=\"manual-builtin\"] > tr").first().getByRole("cell").nth(2),
      ["Configured / unverified", "Protocols: Built-in"],
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
  await expect(page.getByText("Discovered means", { exact: false })).toContainText("Admin override");
  await expect(page.getByText("Protocols identifies", { exact: false })).toContainText("not live inference validation");
  for (const [id, labels] of [
    ["gpt-alpha", ["Discovered", "Protocols: Upstream"]],
    ["configured-upstream", ["Discovered", "Configured override", "Protocols: Upstream"]],
    ["configured-conflict", ["Discovered", "Configured override", "Protocols: Admin override", "Protocol conflict"]],
    ["manual-builtin", ["Configured / unverified", "Protocols: Built-in"]],
    ["unknown-model", ["Discovered", "Protocols: Unknown"]],
  ] as const) {
    const source = page.locator(`tbody[data-model-id="${id}"] > tr`).first().getByRole("cell").nth(2);
    await expectInlineBadges(source, [...labels]);
    await expect(source).not.toContainText("admin_override");
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
  await unknown.getByText("Capability details and override").click();
  await expect(unknown.locator("dl")).toContainText("Default output");
  await expect(unknown.locator("dl")).toContainText((4096).toLocaleString("en-US"));
  await expect(unknown.locator("dl")).toContainText("Unknown ceiling fallback");
  await expect(unknown.locator("dl")).toContainText("Chat budget field");
  await expect(unknown.locator("dl")).toContainText("max_tokens");
  await expect(unknown.locator("dl")).toContainText("Malformed");
  await expect(unknown.getByPlaceholder("Use upstream/built-in", { exact: true })).toHaveCount(2);
  await expect(unknown.getByPlaceholder("Automatic policy", { exact: true })).toBeVisible();
});

test("models preserve exact entered IDs and save, reset, and preference confirmations", async ({ page }) => {
  const fixture = await openModels(page);
  const modelId = "MiXeD-Model.V2";
  const input = page.getByRole("textbox", { name: "Model ID", exact: true });
  await input.fill(modelId);
  await expect(input).toHaveValue(modelId);
  await expect(input).toHaveAttribute("autocapitalize", "none");
  expect(await input.evaluate((element) => getComputedStyle(element).textTransform)).toBe("none");
  await page.getByRole("button", { name: "Add configured model", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(`${modelId} added as configured and unverified.`);
  const model = page.locator(`tbody[data-model-id="${modelId}"]`);
  await expectInlineBadges(model.getByRole("row").first().getByRole("cell").nth(2), [
    "Configured / unverified", "Protocols: Admin override",
  ]);
  const addition = fixture.requests.find((request) => (
    request.method() === "PUT" && request.url().endsWith("/models/capabilities")
  ));
  expect(addition?.postDataJSON()).toMatchObject({ modelId, capabilities: { enabled: true, protocols: [] } });
  await model.getByText("Capability details and override").click();
  await model.getByLabel("messages").check();
  await model.getByLabel("Default output tokens").fill("2048");
  await model.getByRole("button", { name: "Save capability override" }).click();
  await expect(page.getByRole("status")).toHaveText(`${modelId} capability override saved.`);
  await model.getByRole("button", { name: "Reset override" }).click();
  await expect(page.getByRole("status")).toHaveText(`${modelId} capability override reset.`);
  await expect(model).toHaveCount(0);
  await page.locator("tbody[data-model-id=\"claude-beta\"]").getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByRole("status")).toHaveText("claude-beta is now preferred.");
});

test("models refresh clears stale success, stays quiet on success, and retains errors and invalid preference", async ({ page }) => {
  const fixture = await openModels(page);
  await page.locator("tbody[data-model-id=\"claude-beta\"]").getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByRole("status")).toHaveText("claude-beta is now preferred.");
  const refresh = page.getByRole("button", { name: "Refresh catalog" });
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
