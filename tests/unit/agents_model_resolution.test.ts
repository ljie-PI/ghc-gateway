import { describe, expect, it } from "vitest";
import { capabilitySnapshotFromCatalog } from "../../src/copilot/capability_registry.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { resolveModel } from "../../src/protocols/model_catalog/resolver.js";
import { planProtocolExecution } from "../../src/protocols/conversion/planner.js";
import { projectAgent } from "../../src/agents/transform.js";
import { parseLiveModelCapabilities } from "../../src/copilot/model_capabilities.js";
import { isWireJsonObject, parseWireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";

const origin = "http://127.0.0.1:32567";

function wireBody(value: unknown): WireJsonObject {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const parsed = parseWireJson(bytes, { maxBytes: bytes.byteLength, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) throw new Error("expected object");
  return parsed;
}
const account = {
  accountId: "github.com/42",
  environment: resolveGitHubEnvironment("github.com"),
  userId: "42",
  login: "octocat",
  displayName: null,
  credentialGeneration: 4,
};

function snapshotWith(models: readonly { id: string; protocols: readonly string[] }[]) {
  return capabilitySnapshotFromCatalog(account, {
    accountId: account.accountId,
    generation: 7,
    credentialGeneration: 4,
    fetchedAt: "2027-01-15T08:00:00.000Z",
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      vendor: "test",
      modelPickerEnabled: true,
      capabilities: parseLiveModelCapabilities({
        supported_endpoints: model.protocols.map((protocol) => `/v1/${protocol === "chat" ? "chat/completions" : protocol}`),
        max_input_tokens: 128_000,
      }),
    })),
  });
}

describe("agent configuration compatibility with Gateway model resolution", () => {
  it("resolves every generated Codex catalog slug explicitly and plans native Responses", () => {
    const snapshot = snapshotWith([
      { id: "gpt-test", protocols: ["responses"] },
      { id: "claude-test", protocols: ["messages", "chat"] },
    ]);
    const projection = projectAgent("codex", null, [
      { displayName: "Coding", modelId: "gpt-test" },
      { displayName: "Writer", modelId: "claude-test" },
    ], origin, "ghcg-models.json", [
      { modelId: "gpt-test", maxInputTokens: 128_000 },
      { modelId: "claude-test", maxInputTokens: 128_000 },
    ]);
    const catalog = JSON.parse(projection.catalog!.toString()) as { models: { slug: string }[] };
    for (const entry of catalog.models) {
      const resolved = resolveModel(snapshot, entry.slug, null);
      expect(resolved).toMatchObject({ upstreamModel: entry.slug, source: "explicit" });
    }
    const config = projection.config.toString();
    expect(config).toContain("model = \"gpt-test\"");

    // Native protocol short-circuit: a Responses-capable model needs no conversion.
    const resolved = resolveModel(snapshot, "gpt-test", null);
    if (!("upstreamModel" in resolved)) throw new Error("resolution failed");
    const plan = planProtocolExecution({
      source: "responses",
      stream: false,
      body: wireBody({}),
      resolvedModel: "gpt-test",
      capability: resolved.capability,
    });
    expect(plan).toMatchObject({ kind: "native", target: "responses" });

    // A Messages-only model still routes deterministically through conversion.
    const converted = resolveModel(snapshot, "claude-test", null);
    if (!("upstreamModel" in converted)) throw new Error("resolution failed");
    const bridged = planProtocolExecution({
      source: "responses",
      stream: false,
      body: wireBody({ model: "claude-test", input: "hi" }),
      resolvedModel: "claude-test",
      capability: converted.capability,
    });
    expect(bridged.kind).toBe("converted");
    expect(bridged.target).toBe("chat");
  });

  it("resolves Claude role model IDs explicitly through the Messages endpoint", () => {
    const snapshot = snapshotWith([
      { id: "sonnet-real", protocols: ["messages"] },
      { id: "opus-real", protocols: ["chat"] },
      { id: "haiku-real", protocols: ["messages"] },
    ]);
    const projection = projectAgent("claude", null, [
      { displayName: "Sonnet", modelId: "sonnet-real" },
      { displayName: "Opus", modelId: "opus-real" },
      { displayName: "Haiku", modelId: "haiku-real" },
    ], origin, "unused", [
      { modelId: "sonnet-real", maxInputTokens: null },
      { modelId: "opus-real", maxInputTokens: null },
      { modelId: "haiku-real", maxInputTokens: null },
    ]);
    const env = JSON.parse(projection.config.toString()).env as Record<string, string>;
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
      const resolved = resolveModel(snapshot, env[key]!, null);
      expect(resolved).toMatchObject({ upstreamModel: env[key], source: "explicit" });
    }
    expect(env.ANTHROPIC_BASE_URL).toBe(origin);
  });
});
