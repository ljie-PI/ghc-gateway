import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { projectAgent } from "../../src/agents/transform.js";

const origin = "http://127.0.0.1:32567";
const mappings = ["real-sonnet", "real-opus", "real-haiku"].map((modelId, index) => ({ modelId, displayName: `Friendly ${index}` }));
const models = mappings.map((row, i) => ({ modelId: row.modelId, maxInputTokens: i === 0 ? 32000 : null }));

describe("agent configuration projection", () => {
  it("projects Claude native roles, clears competing auth/backends and preserves hooks/MCP/unrelated settings", () => {
    const config = { env: { ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_USE_BEDROCK: "1", KEEP_ME: "yes" },
      apiKeyHelper: "secret-command", model: "old", hooks: { Stop: [] }, mcpServers: { local: { command: "node" } }, theme: "dark" };
    const value = JSON.parse(projectAgent("claude", Buffer.from(`\ufeff${JSON.stringify(config)}\r\n`), mappings, origin, "unused", models).config.toString());
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
    const result = projectAgent("codex", Buffer.from(source), mappings, origin, "C:\\test\\ghcg-models.json", models);
    expect(parse(result.config.toString())).toMatchObject({ model: "real-sonnet", model_provider: "ghc_gateway", model_catalog_json: "C:\\test\\ghcg-models.json",
      model_providers: { other: { name: "Other" }, ghc_gateway: { base_url: `${origin}/v1`, wire_api: "responses", requires_openai_auth: false, experimental_bearer_token: "ghcg-local" } },
      mcp_servers: { local: { command: "node" } }, web_search: "live" });
    const catalog = JSON.parse(result.catalog!.toString());
    expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(mappings.map((row) => row.modelId));
    expect(catalog.models[0]).toMatchObject({ display_name: "Friendly 0", context_window: 32000, shell_type: "shell_command", supported_reasoning_levels: [], supports_reasoning_summary_parameter: false, experimental_supported_tools: [], input_modalities: ["text"] });
    expect(catalog.models[1].context_window).toBeUndefined();
    expect(catalog.models[1].default_reasoning_level).toBeUndefined();
  });
  it.each(["profile=\"work\"", "[profiles.work]\nmodel=\"other\"", "[agents.worker]\nconfig_file=\"other.toml\"", "[model_providers.ghc_gateway]\nname=\"external\"", "invalid=\"unterminated"])(
    "refuses unsupported Codex routing/configuration without parser diagnostics: %s",
    (source) => {
      expect(() => projectAgent("codex", Buffer.from(source), mappings, origin, "catalog.json", models)).toThrow("agent invalid config");
    },
  );
  it("rejects unknown models, duplicate Codex IDs, invalid labels/IDs, endpoint injection and role count", () => {
    expect(() => projectAgent("codex", null, mappings, origin, "catalog.json", [])).toThrow("agent models unavailable");
    expect(() => projectAgent("codex", null, [mappings[0]!, mappings[0]!], origin, "catalog.json", models)).toThrow("validation failed");
    expect(() => projectAgent("claude", null, mappings.slice(0, 1), origin, "catalog.json", models)).toThrow("validation failed");
    expect(() => projectAgent("claude", null, mappings, "https://evil.example", "catalog.json", models)).toThrow("validation failed");
    expect(() => projectAgent("claude", Buffer.from("{\"secret\":\"broken"), mappings, origin, "catalog.json", models)).toThrow("agent invalid config");
  });
});
