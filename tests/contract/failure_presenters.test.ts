import { describe, expect, it, vi } from "vitest";
import {
  failureOutcome,
  type GatewayFailure,
} from "../../src/gateway/failures.js";
import {
  createOpenAiChatRoute,
  type OpenAiChatRouteDependencies,
} from "../../src/protocols/openai_chat/endpoint.js";
import { presentOpenAiChatFailure } from "../../src/protocols/openai_chat/failure_presenter.js";
import {
  createAnthropicMessagesRoute,
  type AnthropicMessagesRouteDependencies,
} from "../../src/protocols/anthropic_messages/endpoint.js";
import { presentAnthropicFailure } from "../../src/protocols/anthropic_messages/failure_presenter.js";
import {
  createResponsesRoute,
  type ResponsesRouteDependencies,
} from "../../src/protocols/responses/endpoint.js";
import { presentResponsesFailure } from "../../src/protocols/responses/failure_presenter.js";
import { presentModelCatalogFailure } from "../../src/protocols/model_catalog/failure_presenter.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";

const requestId = "req_failure_matrix";
const openAiModelsRequest = new Request("http://127.0.0.1:31400/v1/models");
const anthropicModelsRequest = new Request("http://127.0.0.1:31400/v1/models", {
  headers: { "anthropic-version": "2023-06-01" },
});

describe("semantic failure presenters", () => {
  it.each([
    [{ kind: "invalid_request" }, 400, 400, "client_error", "invalid request", "invalid_request_error", "invalid_request_error"],
    [{ kind: "body_too_large" }, 413, 413, "client_error", "request body too large", "invalid_request_error", "request_too_large"],
    [{ kind: "unsupported_media_type" }, 415, 415, "client_error", "unsupported media type", "invalid_request_error", "invalid_request_error"],
    [{ kind: "unsupported_semantics" }, 422, 400, "client_error", "unsupported semantics", "invalid_request_error", "invalid_request_error"],
    [{ kind: "authentication" }, 401, 401, "authentication_error", "authentication failed", "authentication_error", "authentication_error"],
    [{ kind: "permission" }, 403, 403, "authentication_error", "permission denied", "permission_error", "permission_error"],
    [{ kind: "model_not_found" }, 404, 404, "client_error", "model not found", "not_found_error", "not_found_error"],
    [{ kind: "queue_full" }, 503, 529, "overloaded", "server overloaded", "api_error", "overloaded_error"],
    [{ kind: "queue_timeout" }, 503, 529, "overloaded", "server overloaded", "api_error", "overloaded_error"],
    [{ kind: "upstream_timeout" }, 504, 504, "timeout", "upstream timeout", "api_error", "timeout_error"],
    [{ kind: "upstream_network" }, 502, 502, "upstream_error", "upstream request failed", "api_error", "api_error"],
    [{ kind: "upstream_stream_error" }, 502, 502, "upstream_error", "upstream request failed", "api_error", "api_error"],
    [{ kind: "upstream_stream_truncated" }, 502, 502, "upstream_error", "upstream request failed", "api_error", "api_error"],
    [{ kind: "invalid_upstream_response" }, 502, 502, "upstream_error", "invalid upstream response", "api_error", "api_error"],
    [{ kind: "invalid_tool_arguments" }, 502, 502, "upstream_error", "invalid upstream response", "api_error", "api_error"],
    [{ kind: "internal" }, 500, 500, "internal_error", "internal error", "api_error", "api_error"],
  ] satisfies ReadonlyArray<readonly [
    GatewayFailure,
    number,
    number,
    ReturnType<typeof failureOutcome>,
    string,
    string,
    string,
  ]>)(
    "projects $0 without changing protocol exceptions",
    async (failure, openAiStatus, anthropicStatus, outcome, message, openAiType, anthropicType) => {
      const chat = presentOpenAiChatFailure(failure, requestId);
      const messages = presentAnthropicFailure(failure, requestId);
      const responses = presentResponsesFailure(failure, requestId);

      expect(chat.status).toBe(openAiStatus);
      expect(messages.status).toBe(anthropicStatus);
      expect(responses.status).toBe(openAiStatus);
      expect(chat.headers.get("x-request-id")).toBe(requestId);
      expect(messages.headers.get("request-id")).toBe(requestId);
      expect(responses.headers.get("x-request-id")).toBe(requestId);
      expect(failureOutcome(failure)).toBe(outcome);

      const openAiBody = `{"error":{"message":${JSON.stringify(message)},"type":${JSON.stringify(openAiType)},"param":null,"code":null}}`;
      const anthropicBody = `{"type":"error","error":{"type":${JSON.stringify(anthropicType)},"message":${JSON.stringify(message)}},"request_id":"${requestId}"}`;
      expect(await chat.text()).toBe(openAiBody);
      expect(await messages.text()).toBe(anthropicBody);
      expect(await responses.text()).toBe(openAiBody);

      for (const body of [openAiBody, anthropicBody]) {
        expect(body).not.toContain("secret-token");
        expect(body).not.toContain("https://unsafe.example/private");
        expect(body).not.toContain("stack trace");
        expect(body).not.toContain("reasoning");
      }
    },
  );

  it("keeps model-list protocol envelopes and safe headers distinct", async () => {
    const failure: GatewayFailure = {
      kind: "upstream_http",
      status: 429,
      retryAfter: "120",
      source: "catalog",
      phase: "discover",
      cause: new Error("secret-token https://unsafe.example/private stack trace reasoning"),
    };
    const openai = presentModelCatalogFailure(failure, requestId, openAiModelsRequest);
    const anthropic = presentModelCatalogFailure(failure, requestId, anthropicModelsRequest);

    expect(openai.status).toBe(429);
    expect(openai.headers.get("x-request-id")).toBe(requestId);
    expect(openai.headers.get("request-id")).toBeNull();
    expect(JSON.parse(await openai.text())).toMatchObject({
      error: { type: "rate_limit_error", code: "429" },
    });

    expect(anthropic.status).toBe(429);
    expect(anthropic.headers.get("request-id")).toBe(requestId);
    expect(anthropic.headers.get("x-request-id")).toBeNull();
    expect(JSON.parse(await anthropic.text())).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error", message: "upstream request failed" },
      request_id: requestId,
    });
  });

  it("drops unsafe Retry-After values in every presenter", () => {
    const failure: GatewayFailure = {
      kind: "upstream_http",
      status: 429,
      retryAfter: "120, https://unsafe.example/private",
    };
    expect(presentOpenAiChatFailure(failure, requestId).headers.get("retry-after")).toBeNull();
    expect(presentAnthropicFailure(failure, requestId).headers.get("retry-after")).toBeNull();
    expect(presentResponsesFailure(failure, requestId).headers.get("retry-after")).toBeNull();
    expect(presentModelCatalogFailure(failure, requestId, openAiModelsRequest).headers.get("retry-after")).toBeNull();
  });

  it("does not record usage when presenters are invoked directly", () => {
    const recordUsage = vi.fn();
    const request = new Request("http://127.0.0.1:31400/");
    const failure: GatewayFailure = { kind: "upstream_timeout" };
    const registry = new ModelCapabilityRegistry(new CopilotModelCatalog({
      async fetch() { return { data: [] }; },
    }), { get: () => null });
    const chat = createOpenAiChatRoute({
      registry,
      usageRecorder: { recordUsage },
    } as unknown as OpenAiChatRouteDependencies);
    const messages = createAnthropicMessagesRoute({
      registry,
      usageRecorder: { recordUsage },
    } as unknown as AnthropicMessagesRouteDependencies);
    const responses = createResponsesRoute({
      registry,
      usageRecorder: { recordUsage },
    } as unknown as ResponsesRouteDependencies);

    chat.presentFailure(failure, requestId, request);
    messages.presentFailure(failure, requestId, request);
    responses.presentFailure(failure, requestId, request);

    expect(recordUsage).not.toHaveBeenCalled();
  });
});
