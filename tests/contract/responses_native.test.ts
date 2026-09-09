import { describe, expect, it } from "vitest";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import type { BoundAccount } from "../../src/accounts/account_directory.js";
import type { BoundCopilot } from "../../src/copilot/backend.js";
import type { NativeResponsesUpstreamRequest, UpstreamByteStream } from "../../src/copilot/upstream_types.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import {
  completeNativeResponses,
  nativeResponsesUpstreamRequest,
  openNativeResponsesStream,
  serializeNativeResponsesRequest,
  validatedNativeResponsesBody,
} from "../../src/protocols/responses/native.js";
import { planResponsesExecution, type NativeResponsesPlan } from "../../src/protocols/responses/planner.js";
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
    let captured: NativeResponsesUpstreamRequest | undefined;
    const backend = new ScriptedCopilotBackend({
      responses(request) {
        captured = request;
        return {
          status: 200,
          headers: new Headers(),
          body: new TextEncoder().encode("{\"id\":\"resp_1\",\"output\":[]}"),
        };
      },
    });
    const bound = await backend.bind({ accountId: "github.com/1" } as BoundAccount, new AbortController().signal);
    const plan = nativePlan("{\"input\":[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,abc\"}]}");
    const request = nativeResponsesUpstreamRequest(plan, {
      requestId: "req_native",
      nonstreamBodyBytes: 1024,
      connectTimeoutMs: 30,
      firstByteTimeoutMs: 120,
      signal: new AbortController().signal,
    });
    await completeNativeResponses(bound, plan, {
      requestId: "req_native",
      nonstreamBodyBytes: 1024,
      connectTimeoutMs: 30,
      firstByteTimeoutMs: 120,
      signal: request.signal,
    });
    expect(backend.captured.map((entry) => entry.kind)).toEqual(["responses"]);
    expect(captured).toMatchObject({
      hasVisionInput: true,
      initiator: "user",
      requestId: "req_native",
      nonstreamBodyBytes: 1024,
      connectTimeoutMs: 30,
      firstByteTimeoutMs: 120,
    });
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

  it("rejects malformed native executor responses and non-SSE native streams", async () => {
    const plan = nativePlan("{\"model\":\"requested\",\"input\":\"hi\",\"stream\":true}");
    const signal = new AbortController().signal;
    const invalidBody = await scriptedBound({
      responses: {
        status: 200,
        headers: new Headers(),
        body: new TextEncoder().encode("[]"),
      },
    });
    await expect(completeNativeResponses(invalidBody, plan, {
      requestId: "req_native",
      nonstreamBodyBytes: 1024,
      connectTimeoutMs: 30,
      firstByteTimeoutMs: 120,
      signal,
    })).rejects.toThrow();

    let canceled = 0;
    const invalidStream = await scriptedBound({
      stream: {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        bytes: emptyStream(),
        cancel: async () => { canceled += 1; },
      },
    });
    await expect(openNativeResponsesStream(invalidStream, plan, {
      requestId: "req_native",
      nonstreamBodyBytes: 1024,
      connectTimeoutMs: 30,
      firstByteTimeoutMs: 120,
      signal,
    })).rejects.toThrow();
    expect(canceled).toBe(1);
  });

  async function scriptedBound(options: {
    readonly responses?: Awaited<ReturnType<BoundCopilot["completeResponses"]>>;
    readonly stream?: UpstreamByteStream;
  }): Promise<BoundCopilot> {
    return {
      accountId: "github.com/1",
      target: { endpoint: "https://api.githubcopilot.com", token: "secret" },
      completeChat: async () => { throw new Error("chat must not be called"); },
      openChatStream: async () => { throw new Error("chat stream must not be called"); },
      completeResponses: async () => {
        if (options.responses === undefined) {
          throw new Error("responses missing");
        }
        return options.responses;
      },
      openResponsesStream: async () => {
        if (options.stream === undefined) {
          throw new Error("stream missing");
        }
        return options.stream;
      },
      completeMessages: async () => { throw new Error("messages must not be called"); },
      openMessagesStream: async () => { throw new Error("messages stream must not be called"); },
    };
  }

  async function* emptyStream(): AsyncIterable<Uint8Array> {}

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
