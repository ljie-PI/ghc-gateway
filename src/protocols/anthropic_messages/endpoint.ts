import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { loadCapabilitySnapshot, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import { ModelCapabilityUnavailableError } from "../../copilot/model_capabilities.js";
import {
  normalizeAccountBindingFailure,
  normalizeCatalogFailure,
  normalizeCopilotBindingFailure,
  normalizeTransportFailure,
} from "../../copilot/failures.js";
import {
  GatewayFailureError,
  safeRetryAfter,
} from "../../gateway/failures.js";
import type { DecodedHttpRequest, RouteRegistration } from "../../gateway/hono_app.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import { createRequestAttempt } from "../../gateway/request_attempt.js";
import { boundedCleanup } from "../../gateway/stream_execution.js";
import { memberValues, type WireJsonObject } from "../../serialization/wire_json.js";
import type { ChatRequest } from "../chat_completions/types.js";
import { resolveModel } from "../model_catalog/resolver.js";
import { reconcilePreferredModelIfCurrent } from "../model_catalog/preferred.js";
import { convertChatResponse } from "./bridge.js";
import { convertAnthropicRequest } from "./request.js";
import { createAnthropicStreamResponse } from "./stream.js";
import type { TelemetryRecorder } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { presentAnthropicFailure } from "./failure_presenter.js";

export interface AnthropicMessagesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry?: ModelCapabilityRegistry;
  readonly catalog?: CopilotModelCatalog;
  readonly preferences: AccountModelPreferences;
  readonly copilot: CopilotBackend;
  readonly createUuid?: () => string;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createAnthropicMessagesRoute(dependencies: AnthropicMessagesRouteDependencies): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/messages",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentAnthropicFailure,
    createAttempt: (requestId, config) => createRequestAttempt({
      requestId,
      config,
      protocol: "anthropic",
      abortedErrorCount: 1,
      ...(dependencies.usageRecorder === undefined ? {} : { recorder: dependencies.usageRecorder }),
      ...(dependencies.nowMs === undefined ? {} : { nowMs: dependencies.nowMs }),
    }),
    endpoint: (request, scope) => executeAnthropicMessages(dependencies, request, scope),
  };
}

async function executeAnthropicMessages(
  dependencies: AnthropicMessagesRouteDependencies,
  request: Readonly<DecodedHttpRequest>,
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const usage = scope.attempt;
  if (request.body === undefined) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  assertAnthropicVersion(request.headers);
  const requestedModel = readRequestedModel(request.body);
  if (requestedModel.value !== undefined) {
    usage.setRequestedModel(requestedModel.value);
  }
  const account = await bindAccount(dependencies, scope.signal);
  usage.setAccount(account.accountId);
  const preference = dependencies.preferences.get(account.accountId);
  const catalog = await loadCatalog(dependencies, account, preference, scope.signal);
  const resolved = resolveModel(catalog, requestedModel.value, preference);
  if ("kind" in resolved) {
    throw new GatewayFailureError({ kind: resolved.kind });
  }
  usage.setResolvedModel(resolved.upstreamModel);
  if (resolved.capability.protocols.value?.includes("chat") !== true) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      cause: new ModelCapabilityUnavailableError(),
    });
  }
  const chatBody = convertAnthropicRequest(
    request.body,
    resolved.upstreamModel,
    resolved.capability.profile.chatOutputTokenField.value,
    resolved.capability.defaultOutputTokens,
  );
  const stream = chatBody.stream === true;
  const copilot = await bindCopilot(dependencies.copilot, account, scope.signal);
  const chatRequest: ChatRequest = {
    model: resolved.upstreamModel,
    body: new TextEncoder().encode(JSON.stringify(chatBody)),
    stream,
    hasVisionInput: hasVisionInput(chatBody.messages),
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  };

  if (!stream) {
    const upstream = await completeChat(copilot, chatRequest);
    throwIfUpstreamHttp(upstream);
    if (upstream.body.byteLength > scope.config.limits.nonstreamBodyBytes) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return measureBuffered(dependencies, () => {
      const body = convertBufferedChatResponse(upstream);
      usage.success(anthropicUsageTokens(body));
      return new Response(JSON.stringify(body), {
        headers: { ...JSON_HEADERS, "request-id": scope.requestId },
      });
    });
  }

  function convertBufferedChatResponse(upstream: Parameters<typeof convertChatResponse>[0]) {
    try {
      return convertChatResponse(upstream);
    } catch (error: unknown) {
      if (error instanceof GatewayFailureError) {
        throw error;
      }
      throw new GatewayFailureError({
        kind: "invalid_upstream_response",
        source: "converter",
        phase: "convert",
        cause: error,
      });
    }
  }

  const upstream = await openChatStream(copilot, chatRequest);
  if (upstream.status >= 400) {
    await boundedCleanup(upstream.cancel());
  }
  throwIfUpstreamHttp(upstream);
  return await createAnthropicStreamResponse({
    upstream,
    model: resolved.upstreamModel,
    createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    scope,
    ...(dependencies.performanceObserver === undefined ? {} : { performanceObserver: dependencies.performanceObserver }),
    onTerminal: (result) => result.kind === "success"
      ? usage.success(result.usage)
      : usage.failure(result.error),
  });
}

function measureBuffered<T>(dependencies: AnthropicMessagesRouteDependencies, work: () => T): T {
  return dependencies.performanceObserver === undefined
    ? work()
    : dependencies.performanceObserver.measure("buffered", work);
}

function assertAnthropicVersion(headers: Headers): void {
  const value = headers.get("anthropic-version");
  if (value === null || value.includes(",") || value.trim() !== "2023-06-01") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
}

function readRequestedModel(body: WireJsonObject): { readonly value: string | undefined } {
  const values = memberValues(body, "model");
  if (values.length === 0) {
    return { value: undefined };
  }
  const value = values[0];
  if (typeof value !== "string") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  return { value };
}

async function bindAccount(
  dependencies: AnthropicMessagesRouteDependencies,
  signal: AbortSignal,
) {
  try {
    return await dependencies.directory.bindDefault(signal);
  } catch (error: unknown) {
    throw normalizeAccountBindingFailure(error);
  }
}

async function loadCatalog(
  dependencies: AnthropicMessagesRouteDependencies,
  account: Readonly<BoundAccount>,
  observedPreference: ReturnType<AccountModelPreferences["get"]>,
  signal: AbortSignal,
) {
  try {
    const catalog = await loadCapabilitySnapshot(dependencies, account, signal);
    await reconcilePreferredModelIfCurrent(
      dependencies.preferences,
      dependencies.directory,
      dependencies,
      account,
      catalog,
      observedPreference,
      signal,
    );
    return catalog;
  } catch (error: unknown) {
    throw normalizeCatalogFailure(error, signal);
  }
}

async function bindCopilot(
  copilot: CopilotBackend,
  account: Awaited<ReturnType<AccountDirectory["bindDefault"]>>,
  signal: AbortSignal,
): Promise<BoundCopilot> {
  try {
    return await copilot.bind(account, signal);
  } catch (error: unknown) {
    throw normalizeCopilotBindingFailure(error, signal);
  }
}

async function completeChat(
  copilot: BoundCopilot,
  request: Readonly<ChatRequest>,
) {
  try {
    return await copilot.completeChat(request);
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, request.signal, { source: "transport", phase: "headers" });
  }
}

async function openChatStream(
  copilot: BoundCopilot,
  request: Readonly<ChatRequest>,
) {
  try {
    return await copilot.openChatStream(request);
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, request.signal, { source: "transport", phase: "headers" });
  }
}

function throwIfUpstreamHttp(response: { readonly status: number; readonly headers: Headers }): void {
  if (response.status < 400) {
    return;
  }
  const retryAfter = retryAfterHeader(response.status, response.headers);
  throw new GatewayFailureError({
    kind: "upstream_http",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

function retryAfterHeader(status: number, headers: Headers): string | undefined {
  if (status !== 429) {
    return undefined;
  }
  return safeRetryAfter(headers.get("retry-after") ?? undefined);
}

function hasVisionInput(messages: unknown[]): boolean {
  return JSON.stringify(messages).includes("\"image_url\"");
}

interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
}

function anthropicUsageTokens(response: unknown): UsageTokens {
  const root = asObject(response);
  const usage = asObject(root?.usage);
  return {
    inputTokens: safeInteger(usage?.input_tokens),
    outputTokens: safeInteger(usage?.output_tokens),
    cacheTokens: safeInteger(usage?.cache_read_input_tokens) + safeInteger(usage?.cache_creation_input_tokens),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
