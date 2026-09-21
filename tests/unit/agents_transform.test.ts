import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { projectAgent } from "../../src/agents/transform.js";
import { parseLiveModelCapabilities } from "../../src/copilot/model_capabilities.js";
import { registrySnapshotFromDiscovery } from "../contract/model_capability_registry_harness.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";

const origin = "http://127.0.0.1:32567";
const mappings = ["real-sonnet", "real-opus", "real-haiku"].map((modelId, index) => ({ modelId, displayName: `Friendly ${index}` }));
const field = <T>(value: T | null) => ({ value, source: value === null ? "unknown" as const : "live" as const, conflict: false, liveState: value === null ? "missing" as const : "value" as const });
const models = mappings.map((row, i) => ({
  modelId: row.modelId,
  protocols: field(["responses"] as const),
  capabilities: {
    contextWindowTokens: i === 0 ? 32000 : null,
    maxContextWindowTokens: i === 0 ? 32000 : null,
    reasoningLevels: [] as const,
    reasoningProtocols: [] as const,
    inputModalities: ["text"] as const,
    toolCalling: false,
    parallelToolCalling: false,
    reasoningSummaries: false,
    verbosity: false,
    search: false,
  },
}));
const account = {
  accountId: "github.com/42",
  environment: resolveGitHubEnvironment("github.com"),
  userId: "42",
  login: "octocat",
  displayName: null,
  credentialGeneration: 4,
} as const;

async function capabilityModels(entries: readonly { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }[]) {
  const snapshot = await registrySnapshotFromDiscovery(account, {
    accountId: account.accountId,
    generation: 7,
    credentialGeneration: account.credentialGeneration,
    fetchedAt: "2027-01-15T08:00:00.000Z",
    models: entries.map(({ id, fields }) => ({
      id,
      name: id,
      vendor: "test",
      modelPickerEnabled: true,
      capabilities: parseLiveModelCapabilities(fields),
    })),
  });
  return snapshot.models;
}

describe("agent configuration projection", () => {
  it("accepts the canonical loopback origin for default HTTP port", () => {
    const projected = projectAgent(
      "claude",
      null,
      mappings,
      "http://127.0.0.1",
      "unused",
      models,
      null,
    );
    expect(JSON.parse(projected.config.toString()).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1");
  });
  it("exports extra Claude mappings as menu options, not a Subagent override", () => {
    const rows = [...mappings, { modelId: "extra-one", displayName: "Extra" }, { modelId: "extra-two", displayName: "Other" }];
    const available = [...models, ...["extra-one", "extra-two"].map((modelId) => ({ ...models[1]!, modelId }))];
    const config = JSON.parse(projectAgent("claude", Buffer.from("{\"env\":{\"CLAUDE_CODE_SUBAGENT_MODEL\":\"old\"}}"), rows, origin, "unused", available, null).config.toString());
    expect(config.modelPicker).toMatchObject({
      replaceBuiltInOptions: true,
      options: [
        { model: "real-sonnet", label: "Friendly 0" }, { model: "real-opus", label: "Friendly 1" },
        { model: "real-haiku", label: "Friendly 2" }, { model: "extra-one", label: "Extra" },
        { model: "extra-two", label: "Other" },
      ],
    });
    expect(config.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });
  it("projects Claude native roles, clears competing auth/backends and preserves hooks/MCP/unrelated settings", () => {
    const config = { env: { ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_USE_BEDROCK: "1", KEEP_ME: "yes" },
      apiKeyHelper: "secret-command", model: "old", hooks: { Stop: [] }, mcpServers: { local: { command: "node" } }, theme: "dark" };
    const value = JSON.parse(projectAgent("claude", Buffer.from(`\ufeff${JSON.stringify(config)}\r\n`), mappings, origin, "unused", models, null).config.toString());
    expect(value).toMatchObject({ model: "real-sonnet", hooks: config.hooks, mcpServers: config.mcpServers, theme: "dark", env: {
      KEEP_ME: "yes", ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: "ghcg-local", ANTHROPIC_MODEL: "real-sonnet",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "real-sonnet", ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Friendly 0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "real-opus", ANTHROPIC_DEFAULT_HAIKU_MODEL: "real-haiku",
    } });
    expect(value.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(value.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(value.apiKeyHelper).toBeUndefined();
  });
  it("generates a multi-model Responses catalog with actual request IDs and conservative metadata", () => {
    const source = "\ufeff# keep on restore\r\nmodel=\"old\"\r\nmodel_catalog_json=\"/external/catalog.json\"\r\nweb_search=\"live\"\r\n[model_providers.other]\r\nname=\"Other\"\r\n[mcp_servers.local]\r\ncommand=\"node\"\r\n";
    const result = projectAgent("codex", Buffer.from(source), mappings, origin, "C:\\test\\models.json", models, null, true);
    expect(parse(result.config.toString())).toMatchObject({ model: "real-sonnet", model_provider: "ghc_gateway", model_catalog_json: "C:\\test\\models.json",
      model_providers: { other: { name: "Other" }, ghc_gateway: { base_url: `${origin}/v1`, wire_api: "responses", requires_openai_auth: false, experimental_bearer_token: "ghcg-local" } },
      mcp_servers: { local: { command: "node" } }, web_search: "live" });
    const catalog = JSON.parse(result.catalog!.toString());
    expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(mappings.map((row) => row.modelId));
    expect(catalog.models[0]).toMatchObject({ display_name: "Friendly 0", context_window: 32000, shell_type: "disabled", effective_context_window_percent: 100, supported_reasoning_levels: [], supports_reasoning_summary_parameter: false, experimental_supported_tools: [], input_modalities: ["text"] });
    expect(catalog.models[1].context_window).toBeUndefined();
    expect(catalog.models[1].default_reasoning_level).toBeUndefined();
  });
  it("refuses to replace an unmanaged Codex provider reserved by another owner", () => {
    const source = "model = \"external\"\n[model_providers.ghc_gateway]\nbase_url = \"https://external.example/v1\"\nwire_api = \"responses\"\n";
    expect(() => projectAgent("codex", Buffer.from(source), mappings, origin, "models.json", models, null))
      .toThrow("agent conflict");
  });
  it("reapplies current Codex configuration without losing unrelated settings", () => {
    const first = projectAgent("codex", null, mappings.slice(0, 1), origin, "models.json", models.slice(0, 1), null);
    const second = projectAgent("codex", Buffer.from(`${first.config.toString()}\n[features]\nkeep = true\n`), mappings.slice(0, 1), origin, "models.json", models.slice(0, 1), first.config);
    expect(parse(second.config.toString()).features).toEqual({ keep: true });
  });
  it("projects input limits from shared field states without widening malformed or conflicting declarations", async () => {
    const entries = [
      { id: "missing", fields: { supported_endpoints: ["/responses"] } },
      { id: "context-fallback", fields: { supported_endpoints: ["/responses"], capabilities: { limits: { max_context_window_tokens: 144_000 } } } },
      { id: "malformed-explicit", fields: { supported_endpoints: ["/responses"], capabilities: { limits: { max_prompt_tokens: null, max_context_window_tokens: 144_000 } } } },
      { id: "conflicting-explicit", fields: { supported_endpoints: ["/responses"], max_input_tokens: 64_000, capabilities: { limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } } } },
      { id: "explicit", fields: { supported_endpoints: ["/responses"], capabilities: { limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } } } },
      { id: "malformed-context", fields: { supported_endpoints: ["/responses"], max_input_tokens: 128_000, capabilities: { limits: { max_context_window_tokens: null } } } },
    ] as const;
    const capabilitySnapshot = await capabilityModels(entries);
    const projection = projectAgent("codex", null, entries.map(({ id }) => ({ modelId: id, displayName: id })), origin, "models.json", capabilitySnapshot, null);
    const catalog = JSON.parse(projection.catalog!.toString()) as { models: Record<string, unknown>[] };
    expect(catalog.models.map(({ slug, priority, context_window, max_context_window }) => ({
      slug, priority, context_window, max_context_window,
    }))).toEqual([
      { slug: "missing", priority: 0, context_window: undefined, max_context_window: undefined },
      { slug: "context-fallback", priority: 1, context_window: 144_000, max_context_window: 144_000 },
      { slug: "malformed-explicit", priority: 2, context_window: undefined, max_context_window: undefined },
      { slug: "conflicting-explicit", priority: 3, context_window: undefined, max_context_window: undefined },
      { slug: "explicit", priority: 4, context_window: 128_000, max_context_window: 144_000 },
      { slug: "malformed-context", priority: 5, context_window: 128_000, max_context_window: 128_000 },
    ]);
  });
  it("advertises reasoning levels only when the selected Gateway route proves its parameter", async () => {
    const entries = [
      { id: "missing-parameter", fields: { supported_endpoints: ["/responses"], supported_reasoning_efforts: ["low", "high"] } },
      { id: "malformed-parameter", fields: { supported_endpoints: ["/responses"], supported_parameters: null, supported_reasoning_efforts: ["low", "high"] } },
      { id: "conflicting-parameter", fields: { supported_endpoints: ["/responses"], supported_parameters: ["reasoning"], model_info: { supported_parameters: ["reasoning.effort"] }, supported_reasoning_efforts: ["low", "high"] } },
      { id: "malformed-efforts", fields: { supported_endpoints: ["/responses"], supported_parameters: ["reasoning"], supported_reasoning_efforts: null } },
      { id: "native-responses", fields: { supported_endpoints: ["/responses"], supported_parameters: ["reasoning"], supported_reasoning_efforts: ["low", "high"] } },
      { id: "chat-bridge", fields: { supported_endpoints: ["/chat/completions"], supported_parameters: ["reasoning_effort"], supported_reasoning_efforts: ["low", "high"] } },
      { id: "messages-bridge", fields: { supported_endpoints: ["/messages"], supported_parameters: ["output_config.effort"], supported_reasoning_efforts: ["low", "high"] } },
      { id: "chat-priority", fields: { supported_endpoints: ["/chat/completions", "/messages"], supported_parameters: ["output_config.effort"], supported_reasoning_efforts: ["low", "high"] } },
    ] as const;
    const capabilitySnapshot = await capabilityModels(entries);
    const projection = projectAgent("codex", null, entries.map(({ id }) => ({ modelId: id, displayName: id })), origin, "models.json", capabilitySnapshot, null);
    const catalog = JSON.parse(projection.catalog!.toString()) as { models: { slug: string; supported_reasoning_levels: unknown[] }[] };
    expect(catalog.models.map(({ slug, supported_reasoning_levels }) => ({ slug, supported_reasoning_levels }))).toEqual([
      { slug: "missing-parameter", supported_reasoning_levels: [] },
      { slug: "malformed-parameter", supported_reasoning_levels: [] },
      { slug: "conflicting-parameter", supported_reasoning_levels: [] },
      { slug: "malformed-efforts", supported_reasoning_levels: [] },
      { slug: "native-responses", supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "high", description: "High" }] },
      { slug: "chat-bridge", supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "high", description: "High" }] },
      { slug: "messages-bridge", supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "high", description: "High" }] },
      { slug: "chat-priority", supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "high", description: "High" }] },
    ]);
  });
  it("projects effective model capabilities without adapter-specific reinterpretation", async () => {
    const [model] = await capabilityModels([{
      id: "capable",
      fields: {
        supported_endpoints: ["/responses"],
        supported_reasoning_efforts: ["ultra", "max", "high", "minimal", "none"],
        capabilities: {
          limits: { max_prompt_tokens: 120_000, max_context_window_tokens: 144_000 },
          supports: {
            reasoning_effort: ["none", "minimal", "high", "max", "ultra"], tool_calls: true, parallel_tool_calls: true, vision: true,
            reasoning_summaries: true, verbosity: true, search: true,
          },
        },
      },
    }]);
    const projection = projectAgent(
      "codex", null, [{ modelId: "capable", displayName: "Capable" }], origin, "models.json", [model!], null,
    );
    expect(JSON.parse(projection.catalog!.toString()).models[0]).toMatchObject({
      context_window: 120_000,
      max_context_window: 144_000,
      supported_reasoning_levels: [
        { effort: "none", description: "None" },
        { effort: "minimal", description: "Minimal" },
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
      support_verbosity: true,
      supports_reasoning_summaries: true,
      supports_reasoning_summary_parameter: true,
      supports_parallel_tool_calls: true,
      shell_type: "shell_command",
      supports_image_detail_original: true,
      supports_search_tool: true,
      input_modalities: ["text", "image"],
      effective_context_window_percent: 100,
    });
  });
  it("replaces stale Codex ownership evidence after management begins", () => {
    const source = Buffer.from("[model_providers.ghc_gateway]\nbase_url = \"https://external.example/v1\"\n");
    const managed = Buffer.from("model = \"old\"\n");
    const projected = parse(projectAgent("codex", source, mappings, origin, "models.json", models, managed).config.toString());
    expect(projected.model_providers).toMatchObject({ ghc_gateway: { base_url: `${origin}/v1` } });
  });
  it("replaces an externally changed provider after Codex management begins", () => {
    const first = projectAgent("codex", null, mappings, origin, "models.json", models, null);
    const changed = Buffer.from(first.config.toString().replace(`${origin}/v1`, "https://external.example/v1"));
    const projected = parse(projectAgent("codex", changed, mappings, origin, "models.json", models, first.config).config.toString());
    expect(projected.model_providers).toMatchObject({ ghc_gateway: { base_url: `${origin}/v1` } });
  });
  it("restores an externally removed provider after Codex management begins", () => {
    const first = projectAgent("codex", null, mappings, origin, "models.json", models, null);
    const projected = parse(projectAgent("codex", Buffer.from("model = \"external\"\n"), mappings, origin, "models.json", models, first.config).config.toString());
    expect(projected).toMatchObject({ model_provider: "ghc_gateway", model_providers: { ghc_gateway: { base_url: `${origin}/v1` } } });
  });
  it.each(["profile=\"work\"", "[profiles.work]\nmodel=\"other\"", "[agents.worker]\nconfig_file=\"other.toml\"", "invalid=\"unterminated"])(
    "refuses unsupported Codex routing/configuration without parser diagnostics: %s",
    (source) => {
      expect(() => projectAgent("codex", Buffer.from(source), mappings, origin, "catalog.json", models, null)).toThrow("agent invalid config");
    },
  );
  it("rejects unknown models, duplicate Codex IDs, invalid labels/IDs, endpoint injection and role count", () => {
    expect(() => projectAgent("codex", null, mappings, origin, "catalog.json", [], null)).toThrow("agent models unavailable");
    expect(() => projectAgent("codex", null, [mappings[0]!, mappings[0]!], origin, "catalog.json", models, null)).toThrow("validation failed");
    expect(() => projectAgent("claude", null, mappings.slice(0, 1), origin, "catalog.json", models, null)).toThrow("validation failed");
    expect(() => projectAgent("claude", null, mappings, "https://evil.example", "catalog.json", models, null)).toThrow("validation failed");
    expect(() => projectAgent("claude", Buffer.from("{\"secret\":\"broken"), mappings, origin, "catalog.json", models, null)).toThrow("agent invalid config");
  });
});
