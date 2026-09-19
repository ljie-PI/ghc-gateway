import { describe, expect, it } from "vitest";
import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { startHttpCopilot, jsonStream, waitForHttp, assertTransportReleased } from "../../scripts/tooling/test_support/http_copilot.js";
import { decodeResponsesRequest } from "../../src/protocols/openai_responses/decoder.js";
import {
  completeNativeResponses,
  nativeResponsesUpstreamRequest,
  openNativeResponsesStream,
  serializeNativeResponsesRequest,
  validatedNativeResponsesBody,
} from "../../src/protocols/openai_responses/native.js";
import { planResponsesExecution, type NativeResponsesPlan } from "../../src/protocols/openai_responses/planner.js";
import { isWireJsonObject, parseWireJson } from "../../src/serialization/wire_json.js";
import type { ResolvedModel } from "../../src/protocols/model_catalog/resolver.js";

describe("native Responses execution", () => {
  it("serializes only the resolved model change while preserving native fields and number lexemes", () => {
    const plan = nativePlan("{\"previous_response_id\":\"resp_1\",\"model\":\"requested\",\"store\":false,\"temperature\":1.20,\"reasoning\":{\"encrypted_content\":\"abc\"}}");
    expect(new TextDecoder().decode(serializeNativeResponsesRequest(plan))).toBe(
      "{\"previous_response_id\":\"resp_1\",\"model\":\"resolved\",\"store\":false,\"temperature\":1.20,\"reasoning\":{\"encrypted_content\":\"abc\"}}",
    );
  });

  it("builds upstream request metadata for native transport without invoking Chat", async () => {
    const http = await nativeHttp();
    try {
      const bound = await http.backend.bind(nativeAccount, new AbortController().signal);
      const plan = nativePlan("{\"input\":[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,abc\"}]}");
      const request = nativeResponsesUpstreamRequest(plan, {
        requestId: "req_native",
        nonstreamBodyBytes: 1024,
        connectTimeoutMs: 30,
        firstByteTimeoutMs: 120,
        signal: new AbortController().signal,
      });
      http.upstream.expect({ method: "POST", path: "/responses", body: request.body,
        headers: { "copilot-vision-request": "true", "x-initiator": "user", "x-request-id": "req_native" },
        reply: { body: new TextEncoder().encode("{\"id\":\"resp_1\",\"output\":[]}") },
      });
      await completeNativeResponses(bound, plan, {
        requestId: "req_native",
        nonstreamBodyBytes: 1024,
        connectTimeoutMs: 30,
        firstByteTimeoutMs: 120,
        signal: request.signal,
      });
      expect(http.upstream.requests).toHaveLength(1);
      http.upstream.assertSatisfied();
      expect(request).toMatchObject({
        hasVisionInput: true,
        initiator: "user",
        requestId: "req_native",
        nonstreamBodyBytes: 1024,
        connectTimeoutMs: 30,
        firstByteTimeoutMs: 120,
      });
      assertTransportReleased(http.backend);
    } finally { await http.close(); }
  });

  it("preserves valid native non-stream bodies and rejects malformed 2xx bodies", () => {
    const body = new TextEncoder().encode("{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":1}}");
    expect(validatedNativeResponsesBody({ status: 200, headers: new Headers(), body }, 1024)).toBe(body);
    expect(() => validatedNativeResponsesBody({
      status: 200,
      headers: new Headers(),
      body: new TextEncoder().encode("[]"),
    }, 1024)).toThrow(/GatewayFailureError|invalid/u);
  });

  it("rejects malformed native executor responses and releases non-SSE native streams", async () => {
    const plan = nativePlan("{\"model\":\"requested\",\"input\":\"hi\",\"stream\":true}");
    const signal = new AbortController().signal;
    const http = await nativeHttp();
    try {
      const bound = await http.backend.bind(nativeAccount, signal);
      const options = { requestId: "req_native", nonstreamBodyBytes: 1024, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, signal };
      http.upstream.expect({ method: "POST", path: "/responses", body: jsonStream(true), reply: { body: new TextEncoder().encode("[]") } });
      await expect(completeNativeResponses(bound, plan, options)).rejects.toThrow();
      assertTransportReleased(http.backend);
      http.upstream.expect({ method: "POST", path: "/responses", body: jsonStream(true),
        reply: { headers: { "content-type": "application/json" }, stream: async (exchange) => { await exchange.waitForClose(); } },
      });
      await expect(openNativeResponsesStream(bound, plan, options)).rejects.toThrow();
      await waitForHttp(() => http.upstream.streams[0]?.closed === true);
      expect(http.upstream.streams[0]?.ended).toBe(false);
      assertTransportReleased(http.backend);
      expect(http.upstream.requests).toHaveLength(2);
      http.upstream.assertSatisfied();
    } finally { await http.close(); }
  });

  function nativePlan(json: string): NativeResponsesPlan {
    const request = decode(json);
    const resolvedModel: ResolvedModel = {
      ...(request.model === undefined ? {} : { requestedModel: request.model }),
      upstreamModel: "resolved",
      source: "explicit",
      capability: {
        accountId: "test", modelId: "resolved", name: "resolved", vendor: "test",
        protocols: { value: ["responses"], source: "live", conflict: false, liveState: "value" },
        maxInputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
        maxOutputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
        defaultOutputTokens: {
          configuration: { value: null, source: "unknown", conflict: false, liveState: "missing" },
          effective: 4096, source: "unknown_fallback", valid: true,
        },
        capabilities: {
          contextWindowTokens: null, maxContextWindowTokens: null,
          reasoningLevels: [], reasoningProtocols: [], inputModalities: ["text"],
          toolCalling: false, parallelToolCalling: false, reasoningSummaries: false,
          verbosity: false, search: false,
        },
        profile: {
          chatOutputTokenField: { value: null, source: "unknown", conflict: false, liveState: "missing" },
          supportedParameters: { value: null, source: "unknown", conflict: false, liveState: "missing" },
          reasoningEfforts: { value: null, source: "unknown", conflict: false, liveState: "missing" },
        },
        revision: { credentialGeneration: 0, catalogGeneration: 0, builtinRevision: null },
      },
    };
    const plan = planResponsesExecution(request, resolvedModel, {
      endpoint: "https://api.githubcopilot.com/",
      token: "secret",
    });
    if (plan.kind !== "native_responses") {
      throw new Error("expected native plan");
    }
    return plan;
  }

  function decode(json: string) {
    const parsed = parseWireJson(new TextEncoder().encode(json), { maxBytes: 1024, maxDepth: 16 });
    if (!isWireJsonObject(parsed)) {
      throw new Error("expected object");
    }
    return decodeResponsesRequest(parsed);
  }
});

const nativeAccount = {
  accountId: "github.com/1", environment: resolveGitHubEnvironment("github.com"), userId: "1",
  login: "octo", displayName: "Octo", credentialGeneration: 1,
};
async function nativeHttp() {
  const credentials = new MemoryCredentialStore();
  await credentials.putGeneration(nativeAccount.accountId, 1, { generation: 1, githubToken: "native-test" });
  return await startHttpCopilot({ credentials, accountCoordinator: new AccountCoordinator(), nowMs: () => 1_700_000_000_000 });
}
