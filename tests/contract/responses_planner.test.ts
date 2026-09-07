import { describe, expect, it } from "vitest";
import type { EffectiveModelCapabilitySnapshot } from "../../src/copilot/capability_registry.js";
import { GatewayFailureError } from "../../src/gateway/failures.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import { planResponsesExecution } from "../../src/protocols/responses/planner.js";
import { isWireJsonObject, parseWireJson } from "../../src/serialization/wire_json.js";
import type { ResolvedModel } from "../../src/protocols/model_catalog/resolver.js";

describe("Responses planner", () => {
  it("prefers native Responses, otherwise uses declared Chat, and rejects unknown", () => {
    expect(plan(["responses"]).kind).toBe("native_responses");
    expect(plan(["chat", "responses"]).kind).toBe("native_responses");
    expect(plan(["chat"]).kind).toBe("chat_bridge");
    expect(() => plan(["messages"])).toThrow(GatewayFailureError);
    expect(() => plan(null)).toThrow(GatewayFailureError);
  });

  it("freezes the original request, resolved model, stream flag, and normalized native URL", () => {
    const request = decode("{\"stream\":true,\"model\":\"native\",\"input\":\"hi\"}");
    const resolved = resolvedModel(["responses"]);
    const plan = planResponsesExecution(request, resolved, {
      endpoint: "https://api.githubcopilot.com/",
      token: "secret",
    });
    expect(plan).toMatchObject({
      kind: "native_responses",
      originalRequest: request,
      resolvedModel: resolved,
      upstreamUrl: "https://api.githubcopilot.com/responses",
      stream: true,
    });
  });

  function plan(protocols: readonly ("chat" | "messages" | "responses")[] | null) {
    return planResponsesExecution(decode("{\"model\":\"model\"}"), resolvedModel(protocols), {
      endpoint: "https://copilot.example.test",
      token: "secret",
    });
  }

  function resolvedModel(
    protocols: readonly ("chat" | "messages" | "responses")[] | null,
  ): ResolvedModel {
    return {
      requestedModel: "model",
      upstreamModel: "model",
      source: "explicit",
      capability: capability(protocols),
    };
  }

  function capability(
    protocols: readonly ("chat" | "messages" | "responses")[] | null,
  ): EffectiveModelCapabilitySnapshot {
    return {
      accountId: "github.com/1", modelId: "model", name: "model", vendor: "github",
      discovered: true, configured: false, verified: true, enabled: true, visible: true, override: null,
      protocols: {
        value: protocols,
        source: protocols === null ? "unknown" : "live",
        conflict: false,
        liveState: protocols === null ? "missing" : "value",
      },
      maxInputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
      maxOutputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
      defaultOutputTokens: {
        configuration: { value: null, source: "unknown", conflict: false, liveState: "missing" },
        effective: 4096, source: "unknown_fallback", valid: true,
      },
      profile: {
        chatOutputTokenField: { value: "max_tokens", source: "builtin", conflict: false, liveState: "missing" },
        supportedParameters: { value: [], source: "unknown", conflict: false, liveState: "missing" },
      },
      revision: { credentialGeneration: 1, catalogGeneration: 1, overrideRevision: 0, builtinRevision: null },
    };
  }

  function decode(json: string) {
    const parsed = parseWireJson(new TextEncoder().encode(json), { maxBytes: 1024, maxDepth: 16 });
    if (!isWireJsonObject(parsed)) {
      throw new Error("expected object");
    }
    return decodeResponsesRequest(parsed);
  }
});
