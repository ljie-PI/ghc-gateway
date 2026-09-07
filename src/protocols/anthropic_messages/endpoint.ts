import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { loadCapabilitySnapshot, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import {
  MESSAGES_VERSION,
  type MessagesBetaFeature,
} from "../../copilot/upstream_types.js";
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
import { createConvertedStreamResponse } from "../../gateway/converted_stream_response.js";
import { memberValues, type WireJsonObject } from "../../serialization/wire_json.js";
import { resolveModel } from "../model_catalog/resolver.js";
import { reconcilePreferredModelIfCurrent } from "../model_catalog/preferred.js";
import type { TelemetryRecorder } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { presentAnthropicFailure } from "./failure_presenter.js";
import { planProtocolExecution } from "../conversion/planner.js";
import { completeConvertedOperation, openConvertedOperation } from "../conversion/operation.js";
import { convertBufferedResponse } from "../conversion/buffered.js";
import type { ConvertedProtocolPlan, SemanticUsage } from "../conversion/types.js";
import {
  createNativeMessagesStreamResponse,
  nativeMessagesUsage,
  serializeNativeMessagesRequest,
  validatedNativeMessagesBody,
} from "./native.js";

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
  const betaFeatures = readAnthropicBetaFeatures(request.headers);
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
  const stream = readStream(request.body);
  let plan = planProtocolExecution({
    source: "messages",
    body: request.body,
    stream,
    capability: resolved.capability,
    resolvedModel: resolved.upstreamModel,
  });
  if (plan.kind === "converted") {
    if (betaFeatures.some((feature) => (
      feature !== "prompt-caching-2024-07-31"
      && feature !== "interleaved-thinking-2025-05-14"
    ))) {
      throw new GatewayFailureError({
        kind: "unsupported_semantics",
        source: "converter",
        phase: "convert",
      });
    }
    const existingDegradations = plan.request.degradations;
    const betaDegradations = [
      ...(betaFeatures.includes("prompt-caching-2024-07-31")
        ? ["cache.control_omitted" as const]
        : []),
      ...(betaFeatures.includes("interleaved-thinking-2025-05-14")
        ? ["reasoning.presentation_omitted" as const]
        : []),
    ].filter((rule) => !existingDegradations.includes(rule));
    if (betaDegradations.length > 0) {
      plan = Object.freeze({
        ...plan,
        request: Object.freeze({
          ...plan.request,
          degradations: [...existingDegradations, ...betaDegradations],
        }),
      });
    }
  }
  const copilot = await bindCopilot(dependencies.copilot, account, scope.signal);
  if (plan.kind === "native") {
    return await executeNativeMessages(
      copilot,
      request.body,
      resolved.upstreamModel,
      stream,
      betaFeatures,
      scope,
      usage,
    );
  }
  return await executeConvertedMessages(dependencies, copilot, plan, scope, usage);
}

async function executeNativeMessages(
  copilot: BoundCopilot,
  body: WireJsonObject,
  model: string,
  stream: boolean,
  betaFeatures: readonly MessagesBetaFeature[],
  scope: Readonly<RequestScope>,
  usage: ReturnType<typeof createRequestAttempt>,
): Promise<Response> {
  const bytes = serializeNativeMessagesRequest(body, model);
  const upstreamRequest = {
    body: bytes,
    version: MESSAGES_VERSION,
    betaFeatures,
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  } as const;
  if (!stream) {
    const upstream = await completeMessages(copilot, upstreamRequest);
    throwIfUpstreamHttp(upstream);
    const validated = validatedNativeMessagesBody(
      upstream.body,
      scope.config.limits.nonstreamBodyBytes,
    );
    usage.success(attemptUsage(nativeMessagesUsage(validated, scope.config.limits.nonstreamBodyBytes)));
    return new Response(Buffer.from(validated), {
      status: upstream.status,
      headers: { ...JSON_HEADERS, "request-id": scope.requestId },
    });
  }
  const upstream = await openMessagesStream(copilot, upstreamRequest);
  if (upstream.status >= 400) {
    await boundedCleanup(upstream.cancel());
  }
  throwIfUpstreamHttp(upstream);
  return await createNativeMessagesStreamResponse({
    upstream,
    scope,
    onTerminal: (result) => result.kind === "success"
      ? usage.success(attemptUsage(result.usage))
      : usage.failure(result.error),
  });
}

async function executeConvertedMessages(
  dependencies: AnthropicMessagesRouteDependencies,
  copilot: BoundCopilot,
  plan: Readonly<ConvertedProtocolPlan>,
  scope: Readonly<RequestScope>,
  usage: ReturnType<typeof createRequestAttempt>,
): Promise<Response> {
  if (!plan.stream) {
    const upstream = await completeConvertedOperation(copilot, plan, scope);
    throwIfUpstreamHttp(upstream);
    const converted = measureBuffered(dependencies, () => convertBufferedResponse(upstream.body, {
      source: plan.target,
      target: "messages",
      model: plan.requestModel,
      maxBytes: scope.config.limits.nonstreamBodyBytes,
      createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
      nowUnixSeconds: () => Math.floor((dependencies.nowMs?.() ?? Date.now()) / 1000),
      degradations: plan.request.degradations,
    }));
    usage.success(attemptUsage(converted.observations.usage));
    return new Response(Buffer.from(converted.bytes), {
      status: upstream.status,
      headers: { ...JSON_HEADERS, "request-id": scope.requestId },
    });
  }
  const upstream = await openConvertedOperation(copilot, plan, scope);
  if (upstream.status >= 400) {
    await boundedCleanup(upstream.cancel());
  }
  throwIfUpstreamHttp(upstream);
  return await createConvertedStreamResponse({
    upstream,
    plan,
    scope,
    model: plan.requestModel,
    createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    nowUnixSeconds: () => Math.floor((dependencies.nowMs?.() ?? Date.now()) / 1000),
    performanceObserver: dependencies.performanceObserver,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "request-id": scope.requestId,
    },
    onTerminal: (result) => result.kind === "success"
      ? usage.success(attemptUsage(result.usage))
      : usage.failure(result.error),
  });
}

function readStream(body: WireJsonObject): boolean {
  const values = memberValues(body, "stream");
  if (values.length > 1 || (values[0] !== undefined && typeof values[0] !== "boolean")) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  return values[0] === true;
}

function attemptUsage(value: Readonly<SemanticUsage>) {
  return {
    inputTokens: Math.max(0, value.inputTokens - value.cacheReadTokens - value.cacheWriteTokens),
    outputTokens: value.outputTokens,
    cacheTokens: value.cacheReadTokens + value.cacheWriteTokens,
  };
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

function readAnthropicBetaFeatures(headers: Headers): readonly MessagesBetaFeature[] {
  const values = headers.get("anthropic-beta");
  if (values === null || values.trim().length === 0) {
    return [];
  }
  const supported = new Set<MessagesBetaFeature>([
    "prompt-caching-2024-07-31",
    "interleaved-thinking-2025-05-14",
    "context-1m-2025-08-07",
  ]);
  const features: MessagesBetaFeature[] = [];
  for (const raw of values.split(",")) {
    const value = raw.trim();
    if (!supported.has(value as MessagesBetaFeature)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    const feature = value as MessagesBetaFeature;
    if (!features.includes(feature)) {
      features.push(feature);
    }
  }
  return features;
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

async function completeMessages(
  copilot: BoundCopilot,
  request: Parameters<BoundCopilot["completeMessages"]>[0],
) {
  try {
    return await copilot.completeMessages(request);
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, request.signal, { source: "transport", phase: "headers" });
  }
}

async function openMessagesStream(
  copilot: BoundCopilot,
  request: Parameters<BoundCopilot["openMessagesStream"]>[0],
) {
  try {
    return await copilot.openMessagesStream(request);
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, request.signal, { source: "transport", phase: "headers" });
  }
}

function throwIfUpstreamHttp(response: { readonly status: number; readonly headers: Headers }): void {
  if (response.status >= 200 && response.status < 300) {
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
