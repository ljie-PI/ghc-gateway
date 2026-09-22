import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { requireModelCapabilityRegistry, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import {
  MESSAGES_BETA_FEATURES,
  MESSAGES_VERSION,
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
import { presentAnthropicMessagesFailure } from "./failure_presenter.js";
import { withUpstreamProtocol } from "../../gateway/execution_evidence.js";
import { planProtocolExecution } from "../conversion/planner.js";
import { completeConvertedOperation, openConvertedOperation } from "../conversion/operation.js";
import { convertBufferedResponse } from "../conversion/buffered.js";
import type { ConvertedProtocolPlan, SemanticUsage } from "../conversion/types.js";
import { observeDiagnosticStream, observeDiagnosticUpstream } from "../../gateway/diagnostic_upstream.js";
import type { RequestDiagnostics } from "../../telemetry/diagnostics.js";
import type { ReasoningCarrierBinding, ReasoningCarrierStore } from "../conversion/reasoning_carriers.js";
import {
  carrierBinding,
  claimReasoningCarriers,
  reasoningCarrierTokens,
  resolveReasoningCarriers,
} from "../conversion/reasoning_carrier_preflight.js";
import {
  createNativeMessagesStreamResponse,
  nativeMessagesUsage,
  serializeNativeMessagesRequest,
  validatedNativeMessagesBody,
} from "./native.js";
import {
  validateMessagesRequestSecurity,
  validateNativeMessagesRequestEnvelope,
} from "./request_validation.js";

export interface AnthropicMessagesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry: ModelCapabilityRegistry;
  readonly preferences: AccountModelPreferences;
  readonly copilot: CopilotBackend;
  readonly createUuid?: () => string;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
  readonly reasoningCarriers?: ReasoningCarrierStore;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;
const ANTHROPIC_BETA_LIMITS = {
  bytes: 8 * 1024,
  tokens: 64,
} as const;
const ANTHROPIC_BETA_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export function createAnthropicMessagesRoute(dependencies: AnthropicMessagesRouteDependencies): RouteRegistration {
  requireModelCapabilityRegistry(dependencies.registry);
  return {
    method: "POST",
    path: "/v1/messages",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentAnthropicMessagesFailure,
    createAttempt: (requestId, config, diagnostics) => createRequestAttempt({
      ...(diagnostics === undefined ? {} : { diagnostics }),
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
  scope.diagnostics?.stage("request_validation");
  assertAnthropicVersion(request.headers, scope.diagnostics);
  const betaFeatures = readAnthropicBetaFeatures(request.headers, scope.diagnostics);
  validateMessagesRequestSecurity(request.body);
  const requestedModel = readRequestedModel(request.body);
  if (requestedModel.value !== undefined) {
    usage.setRequestedModel(requestedModel.value);
  }
  scope.diagnostics?.stage("account_binding");
  const account = await bindAccount(dependencies, scope.signal);
  usage.setAccount(account.accountId);
  if (dependencies.reasoningCarriers === undefined && reasoningCarrierTokens(request.body, "messages").length > 0) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  const carrierClaim = dependencies.reasoningCarriers === undefined
    ? undefined
    : claimReasoningCarriers(request.body, "messages", account.accountId, dependencies.reasoningCarriers);
  if (
    requestedModel.value !== undefined
    && carrierClaim !== undefined
    && requestedModel.value !== carrierClaim.binding.modelId
  ) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  const effectiveModel = carrierClaim?.binding.modelId ?? requestedModel.value;
  const preference = effectiveModel === undefined ? dependencies.preferences.get(account.accountId) : null;
  scope.diagnostics?.stage("model_resolution");
  const catalog = await loadCatalog(dependencies, account, preference, scope.signal);
  const resolved = resolveModel(catalog, effectiveModel, preference);
  if ("kind" in resolved) {
    throw new GatewayFailureError({ kind: resolved.kind });
  }
  usage.setResolvedModel(resolved.upstreamModel);
  const stream = readStream(request.body);
  scope.diagnostics?.stage("account_binding");
  const copilot = await bindCopilot(dependencies.copilot, account, scope.signal);
  const inboundBinding = carrierClaim === undefined ? undefined : carrierBinding({
    accountId: account.accountId,
    modelId: resolved.upstreamModel,
    endpoint: copilot.target.endpoint,
    sourceProtocol: carrierClaim.binding.sourceProtocol,
    wireProtocol: "messages",
  });
  const carrierRecords = dependencies.reasoningCarriers === undefined || inboundBinding === undefined
    ? undefined
    : resolveReasoningCarriers(carrierClaim, inboundBinding, dependencies.reasoningCarriers);
  let plan = planProtocolExecution({
    diagnostics: scope.diagnostics,
    source: "messages",
    body: request.body,
    stream,
    capability: resolved.capability,
    resolvedModel: resolved.upstreamModel,
    ...(carrierClaim === undefined ? {} : { forcedTarget: carrierClaim.binding.sourceProtocol }),
    ...(carrierRecords === undefined ? {} : { carrierRecords }),
  });
  if (plan.kind === "converted") {
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
    scope.diagnostics?.stage("planning", { degradations: plan.request.degradations });
  }
  if (plan.kind === "native") {
    validateNativeMessagesRequestEnvelope(request.body);
    return withUpstreamProtocol(
      await executeNativeMessages(
        copilot,
        request.body,
        request.headerFields,
        resolved.upstreamModel,
        stream,
        betaFeatures,
        scope,
        usage,
      ),
      "messages",
    );
  }
  return withUpstreamProtocol(
    await executeConvertedMessages(
      dependencies,
      copilot,
      plan,
      scope,
      usage,
      dependencies.reasoningCarriers === undefined || plan.target !== "responses" ? undefined : carrierBinding({
        accountId: account.accountId,
        modelId: resolved.upstreamModel,
        endpoint: copilot.target.endpoint,
        sourceProtocol: plan.target,
        wireProtocol: "messages",
      }),
    ),
    plan.target,
  );
}

async function executeNativeMessages(
  copilot: BoundCopilot,
  body: WireJsonObject,
  clientHeaderFields: DecodedHttpRequest["headerFields"],
  model: string,
  stream: boolean,
  betaFeatures: readonly string[],
  scope: Readonly<RequestScope>,
  usage: ReturnType<typeof createRequestAttempt>,
): Promise<Response> {
  const bytes = serializeNativeMessagesRequest(body, model, scope.diagnostics);
  const upstreamRequest = {
    body: bytes,
    version: MESSAGES_VERSION,
    betaFeatures,
    clientHeaderFields,
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  } as const;
  scope.diagnostics?.stage("upstream_request");
  if (!stream) {
    const upstream = observeDiagnosticUpstream(await completeMessages(copilot, upstreamRequest), scope.diagnostics);
    throwIfUpstreamHttp(upstream);
    const validated = validatedNativeMessagesBody(
      upstream.body,
      scope.config.limits.nonstreamBodyBytes,
      scope.diagnostics,
    );
    usage.success(attemptUsage(nativeMessagesUsage(validated, scope.config.limits.nonstreamBodyBytes)));
    return new Response(Buffer.from(validated), {
      status: upstream.status,
      headers: { ...JSON_HEADERS, "request-id": scope.requestId },
    });
  }
  const upstream = observeDiagnosticStream(await openMessagesStream(copilot, upstreamRequest), scope.diagnostics);
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
  carrierBindingValue?: ReasoningCarrierBinding,
): Promise<Response> {
  if (!plan.stream) {
    const upstream = await completeConvertedOperation(copilot, plan, scope);
    throwIfUpstreamHttp(upstream);
    const createdTokens: string[] = [];
    try {
      const converted = measureBuffered(dependencies, () => convertBufferedResponse(upstream.body, {
        diagnostics: scope.diagnostics,
        source: plan.target,
        target: "messages",
        model: plan.requestModel,
        maxBytes: scope.config.limits.nonstreamBodyBytes,
        createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
        nowUnixSeconds: () => Math.floor((dependencies.nowMs?.() ?? Date.now()) / 1000),
        degradations: plan.request.degradations,
        ...(dependencies.reasoningCarriers === undefined || carrierBindingValue === undefined ? {} : {
          carrier: {
            store: dependencies.reasoningCarriers,
            binding: carrierBindingValue,
            stream: false,
            onCreated: (token: string) => createdTokens.push(token),
          },
        }),
      }));
      if (dependencies.reasoningCarriers !== undefined && carrierBindingValue !== undefined && createdTokens.length > 0) {
        if (converted.observations.terminal === "completed") {
          dependencies.reasoningCarriers.promote(createdTokens, carrierBindingValue);
        } else {
          dependencies.reasoningCarriers.discard(createdTokens, carrierBindingValue);
        }
      }
      usage.success(attemptUsage(converted.observations.usage));
      return new Response(Buffer.from(converted.bytes), {
        status: upstream.status,
        headers: { ...JSON_HEADERS, "request-id": scope.requestId },
      });
    } catch (error: unknown) {
      if (dependencies.reasoningCarriers !== undefined && carrierBindingValue !== undefined) {
        dependencies.reasoningCarriers.discard(createdTokens, carrierBindingValue);
      }
      throw error;
    }
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
    ...(dependencies.reasoningCarriers === undefined || carrierBindingValue === undefined ? {} : {
      carrier: { store: dependencies.reasoningCarriers, binding: carrierBindingValue },
    }),
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
    // Usage Buckets use inclusive input; only Messages wire subtracts cache subsets.
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheTokens: value.cacheReadTokens + value.cacheWriteTokens,
  };
}

function measureBuffered<T>(dependencies: AnthropicMessagesRouteDependencies, work: () => T): T {
  return dependencies.performanceObserver === undefined
    ? work()
    : dependencies.performanceObserver.measure("buffered", work);
}

function assertAnthropicVersion(headers: Headers, diagnostics?: RequestDiagnostics): void {
  const value = headers.get("anthropic-version");
  diagnostics?.set({
    messagesVersion: value === null ? "missing" : value.trim() === "2023-06-01" ? "supported" : "unsupported",
  });
  if (value === null || value.includes(",") || value.trim() !== "2023-06-01") {
    diagnostics?.stage("request_validation", { code: value === null ? "anthropic_version_missing" : "anthropic_version_unsupported" });
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
}

function readAnthropicBetaFeatures(headers: Headers, diagnostics?: RequestDiagnostics): readonly string[] {
  const values = headers.get("anthropic-beta");
  if (values === null) {
    return [];
  }
  const encodedBytes = new TextEncoder().encode(values).byteLength;
  if (encodedBytes > ANTHROPIC_BETA_LIMITS.bytes) {
    diagnostics?.stage("request_validation", { code: "anthropic_beta_unsupported" });
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (values.trim().length === 0) {
    diagnostics?.stage("request_validation", { code: "anthropic_beta_unsupported" });
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const features = values.split(",").map((value) => value.trim());
  if (
    features.length > ANTHROPIC_BETA_LIMITS.tokens
    || features.some((feature) => !ANTHROPIC_BETA_TOKEN.test(feature))
  ) {
    diagnostics?.stage("request_validation", { code: "anthropic_beta_unsupported" });
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const supported = new Set<string>(MESSAGES_BETA_FEATURES);
  diagnostics?.set({
    messagesBetas: features.filter((feature): feature is typeof MESSAGES_BETA_FEATURES[number] => supported.has(feature)),
    unknownBetaCount: features.filter((feature) => !supported.has(feature)).length,
  });
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
    const catalog = await dependencies.registry.get(account, signal);
    await reconcilePreferredModelIfCurrent(
      dependencies.preferences,
      dependencies.directory,
      dependencies.registry,
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
