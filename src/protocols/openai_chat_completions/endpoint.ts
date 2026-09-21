import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import type { ChatCompletionsUpstreamRequest } from "../../copilot/upstream_types.js";
import { requireModelCapabilityRegistry, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import {
  normalizeAccountBindingFailure,
  normalizeCatalogFailure,
  normalizeCopilotBindingFailure,
  normalizeTransportFailure,
} from "../../copilot/failures.js";
import {
  failureFromSignal,
  GatewayFailureError,
  safeRetryAfter,
} from "../../gateway/failures.js";
import type { RouteRegistration } from "../../gateway/hono_app.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import { createRequestAttempt, type RequestAttempt } from "../../gateway/request_attempt.js";
import { createConvertedStreamResponse } from "../../gateway/converted_stream_response.js";
import {
  boundedCleanup,
} from "../../gateway/stream_execution.js";
import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { resolveModel, type ResolvedModel } from "../model_catalog/resolver.js";
import type { TelemetryRecorder } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { presentOpenaiChatCompletionsFailure } from "./failure_presenter.js";
import { withUpstreamProtocol } from "../../gateway/execution_evidence.js";
import { planProtocolExecution } from "../conversion/planner.js";
import { completeConvertedOperation, openConvertedOperation } from "../conversion/operation.js";
import { convertBufferedResponse } from "../conversion/buffered.js";
import type { ConvertedProtocolPlan, SemanticUsage } from "../conversion/types.js";
import { diagnosticShape, observeDiagnosticProtocolStatus } from "../conversion/diagnostics.js";
import { observeDiagnosticStream, observeDiagnosticUpstream } from "../../gateway/diagnostic_upstream.js";
import {
  createNativeChatCompletionsStreamResponse,
  nativeChatCompletionsUsage,
  validatedNativeChatCompletionsBody,
} from "./native.js";

export interface OpenaiChatCompletionsRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry: ModelCapabilityRegistry;
  readonly preferences?: Pick<AccountModelPreferences, "get">;
  readonly copilot: CopilotBackend;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
  readonly createUuid?: () => string;
}

interface DecodedOpenaiChatCompletionsRequest {
  readonly body: WireJsonObject;
  readonly requestedModel?: string;
  readonly stream: boolean;
}

interface PreparedOpenaiChatCompletionsRequest {
  readonly body: WireJsonObject;
  readonly bytes: Uint8Array;
  readonly stream: boolean;
  readonly hasVisionInput: boolean;
  readonly resolvedModel: string;
}

export function createOpenaiChatCompletionsRoute(dependencies: OpenaiChatCompletionsRouteDependencies): RouteRegistration {
  requireModelCapabilityRegistry(dependencies.registry);
  return {
    method: "POST",
    path: "/v1/chat/completions",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentOpenaiChatCompletionsFailure,
    createAttempt: (requestId, config, diagnostics) => createRequestAttempt({
      ...(diagnostics === undefined ? {} : { diagnostics }),
      requestId,
      config,
      protocol: "openai_chat",
      abortedErrorCount: 0,
      ...(dependencies.usageRecorder === undefined ? {} : { recorder: dependencies.usageRecorder }),
      ...(dependencies.nowMs === undefined ? {} : { nowMs: dependencies.nowMs }),
    }),
    endpoint: async (request, scope) => {
      const usage = scope.attempt;
      if (request.body === undefined) {
        throw new GatewayFailureError({ kind: "invalid_request" });
      }

      scope.diagnostics?.stage("request_validation");
      const decoded = decodeOpenaiChatCompletionsRequest(request.body);
      if (decoded.requestedModel !== undefined) {
        usage.setRequestedModel(decoded.requestedModel);
      }
      scope.diagnostics?.stage("account_binding");
      const account = await bindAccount(dependencies.directory, scope.signal);
      usage.setAccount(account.accountId);
      const preference = decoded.requestedModel === undefined
        ? (dependencies.preferences ?? dependencies.directory.preferences).get(account.accountId)
        : null;
      scope.diagnostics?.stage("model_resolution");
      const catalog = await loadCatalog(dependencies, account, scope.signal);
      const resolved = resolveOpenaiChatCompletionsModel(decoded, catalog, preference);
      usage.setResolvedModel(resolved.upstreamModel);
      const plan = planProtocolExecution({
        diagnostics: scope.diagnostics,
        source: "chat",
        body: decoded.body,
        stream: decoded.stream,
        capability: resolved.capability,
        resolvedModel: resolved.upstreamModel,
      });
      scope.diagnostics?.stage("account_binding");
      const copilot = await bindCopilot(dependencies.copilot, account, scope);
      if (plan.kind === "converted") {
        return withUpstreamProtocol(
          await executeConvertedChat(dependencies, copilot, plan, scope, usage),
          plan.target,
        );
      }
      const prepared = prepareOpenaiChatCompletionsRequest(decoded, resolved);
      scope.diagnostics?.shape("upstream_request", () => diagnosticShape(prepared.body));
      scope.diagnostics?.stage("upstream_request");

      if (!prepared.stream) {
        const upstream = observeDiagnosticUpstream(await completeChat(copilot, {
          model: prepared.resolvedModel,
          body: prepared.bytes,
          stream: false,
          hasVisionInput: prepared.hasVisionInput,
          nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
          connectTimeoutMs: scope.config.timeouts.connectMs,
          firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
          signal: scope.signal,
        }), scope.diagnostics);
        assertUpstreamSuccess(upstream.status, upstream.headers);
        if (upstream.body.byteLength > scope.config.limits.nonstreamBodyBytes) {
          throw new GatewayFailureError({ kind: "invalid_upstream_response" });
        }

        return withUpstreamProtocol(measure(dependencies.performanceObserver, "buffered", () => {
          const payload = validatedNativeChatCompletionsBody(upstream.body, scope.config.limits.nonstreamBodyBytes);
          observeDiagnosticProtocolStatus(scope.diagnostics, "chat", payload);
          scope.diagnostics?.shape("upstream_output", () => diagnosticShape(payload));
          scope.diagnostics?.shape("client_output", () => diagnosticShape(payload));
          usage.success(attemptUsage(nativeChatCompletionsUsage(payload)));
          return new Response(Buffer.from(serializeWireJson(payload)), {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "x-request-id": scope.requestId,
            },
          });
        }), "chat");
      }

      const upstream = observeDiagnosticStream(await openChatStream(copilot, {
        model: prepared.resolvedModel,
        body: prepared.bytes,
        stream: true,
        hasVisionInput: prepared.hasVisionInput,
        nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
        connectTimeoutMs: scope.config.timeouts.connectMs,
        firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
        signal: scope.signal,
      }), scope.diagnostics);
      if (upstream.status < 200 || upstream.status >= 300) {
        await boundedCleanup(upstream.cancel());
      }
      assertUpstreamSuccess(upstream.status, upstream.headers);

      return withUpstreamProtocol(await createNativeChatCompletionsStreamResponse({
        upstream,
        scope,
        ...(dependencies.performanceObserver === undefined
          ? {}
          : { performanceObserver: dependencies.performanceObserver }),
        onUsage: (observed) => usage.observeUsage(attemptUsage(observed)),
        onTerminal: (result) => result.kind === "success"
          ? usage.success(attemptUsage(result.usage))
          : usage.failure(result.error),
      }), "chat");
    },
  };
}

async function executeConvertedChat(
  dependencies: OpenaiChatCompletionsRouteDependencies,
  copilot: BoundCopilot,
  plan: Readonly<ConvertedProtocolPlan>,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  if (!plan.stream) {
    const upstream = await completeConvertedOperation(copilot, plan, scope);
    assertUpstreamSuccess(upstream.status, upstream.headers);
    const converted = measure(dependencies.performanceObserver, "buffered", () => convertBufferedResponse(
      upstream.body,
      {
        diagnostics: scope.diagnostics,
        source: plan.target,
        target: "chat",
        model: plan.requestModel,
        maxBytes: scope.config.limits.nonstreamBodyBytes,
        createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
        nowUnixSeconds: () => Math.floor((dependencies.nowMs?.() ?? Date.now()) / 1000),
        degradations: plan.request.degradations,
      },
    ));
    usage.success(attemptUsage(converted.observations.usage));
    return new Response(Buffer.from(converted.bytes), {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "x-request-id": scope.requestId,
      },
    });
  }

  const upstream = await openConvertedOperation(copilot, plan, scope);
  if (upstream.status < 200 || upstream.status >= 300) {
    await boundedCleanup(upstream.cancel());
  }
  assertUpstreamSuccess(upstream.status, upstream.headers);
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
      "x-request-id": scope.requestId,
    },
    onTerminal: (result) => result.kind === "success"
      ? usage.success(attemptUsage(result.usage))
      : usage.failure(result.error),
  });
}

function attemptUsage(value: Readonly<SemanticUsage>) {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheTokens: value.cacheReadTokens + value.cacheWriteTokens,
  };
}

export function decodeOpenaiChatCompletionsRequest(body: WireJsonObject): DecodedOpenaiChatCompletionsRequest {
  if (duplicateMemberNames(body).length > 0) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }

  const model = memberValues(body, "model")[0];
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }

  const streamValue = memberValues(body, "stream")[0];
  if (streamValue !== undefined && streamValue !== true && streamValue !== false) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (streamValue === true) {
    const streamOptions = memberValues(body, "stream_options")[0];
    if (streamOptions !== undefined) {
      validateStreamOptions(streamOptions);
    }
  }

  return {
    body,
    ...(model === undefined ? {} : { requestedModel: model }),
    stream: streamValue === true,
  };
}

export function prepareOpenaiChatCompletionsRequest(
  decoded: DecodedOpenaiChatCompletionsRequest,
  resolved: ResolvedModel,
): PreparedOpenaiChatCompletionsRequest {
  const members: Array<{ key: string; value: WireJson }> = [];
  let hasModel = false;
  let hasStreamOptions = false;

  for (const member of decoded.body.members) {
    if (member.key === "model") {
      hasModel = true;
      members.push({ key: member.key, value: resolved.upstreamModel });
      continue;
    }
    if (decoded.stream && member.key === "stream_options") {
      hasStreamOptions = true;
      members.push({ key: member.key, value: prepareStreamOptions(member.value) });
      continue;
    }
    members.push(member);
  }

  if (!hasModel) {
    members.push({ key: "model", value: resolved.upstreamModel });
  }
  if (decoded.stream && !hasStreamOptions) {
    members.push({
      key: "stream_options",
      value: { kind: "object", members: [{ key: "include_usage", value: true }] },
    });
  }

  const body: WireJsonObject = { kind: "object", members };
  return {
    body,
    bytes: serializeWireJson(body),
    stream: decoded.stream,
    hasVisionInput: hasVisionInput(decoded.body),
    resolvedModel: resolved.upstreamModel,
  };
}

function resolveOpenaiChatCompletionsModel(
  decoded: DecodedOpenaiChatCompletionsRequest,
  catalog: Awaited<ReturnType<ModelCapabilityRegistry["get"]>>,
  preference: ModelPreference | null,
): ResolvedModel {
  const resolved = resolveModel(catalog, decoded.requestedModel, preference);
  if ("kind" in resolved) {
    throw new GatewayFailureError({ kind: resolved.kind });
  }
  return resolved;
}

async function bindAccount(directory: AccountDirectory, signal: AbortSignal) {
  try {
    return await directory.bindDefault(signal);
  } catch (error: unknown) {
    throw normalizeAccountBindingFailure(error);
  }
}

async function loadCatalog(
  dependencies: Pick<OpenaiChatCompletionsRouteDependencies, "registry">,
  account: Readonly<BoundAccount>,
  signal: AbortSignal,
) {
  try {
    return await dependencies.registry.get(account, signal);
  } catch (error: unknown) {
    throw normalizeCatalogFailure(error, signal);
  }
}

async function completeChat(
  copilot: BoundCopilot,
  request: Readonly<ChatCompletionsUpstreamRequest>,
) {
  try {
    return await copilot.completeChat(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error, request.signal);
  }
}

async function bindCopilot(
  copilot: CopilotBackend,
  account: Awaited<ReturnType<AccountDirectory["bindDefault"]>>,
  scope: Readonly<RequestScope>,
): Promise<BoundCopilot> {
  try {
    return await withOperationTimeout(scope, scope.config.timeouts.connectMs, (signal) => copilot.bind(account, signal));
  } catch (error: unknown) {
    throw normalizeCopilotBindingFailure(error, scope.signal);
  }
}

async function withOperationTimeout<T>(
  scope: Readonly<RequestScope>,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutController = new AbortController();
  const operationSignal = AbortSignal.any([scope.signal, timeoutController.signal]);
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    const error = new GatewayFailureError({ kind: "upstream_timeout" });
    rejectTimeout(error);
    timeoutController.abort(error);
  }, ms);
  const onAbort = (): void => {
    timeoutController.abort();
    rejectTimeout(new GatewayFailureError(failureFromSignal(scope.signal, {
      source: "transport",
      phase: "connect",
    })));
  };
  scope.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work(operationSignal), timeout]);
  } catch (error: unknown) {
    const reason = timeoutController.signal.reason;
    if (reason instanceof GatewayFailureError && reason.failure.kind === "upstream_timeout") {
      throw reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    scope.signal.removeEventListener("abort", onAbort);
    if (!timeoutController.signal.aborted) {
      timeoutController.abort();
    }
  }
}

async function openChatStream(
  copilot: BoundCopilot,
  request: Readonly<ChatCompletionsUpstreamRequest>,
) {
  try {
    return await copilot.openChatStream(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error, request.signal);
  }
}

function upstreamCallFailure(error: unknown, signal: AbortSignal): GatewayFailureError {
  return normalizeTransportFailure(
    error,
    signal,
    { source: "transport", phase: "headers" },
  );
}

function prepareStreamOptions(value: WireJson): WireJsonObject {
  validateStreamOptions(value);
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const includeUsageCount = value.members.filter((member) => member.key === "include_usage").length;
  if (includeUsageCount > 1) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (includeUsageCount === 0) {
    return { kind: "object", members: [...value.members, { key: "include_usage", value: true }] };
  }
  return {
    kind: "object",
    members: value.members.map((member) => member.key === "include_usage"
      ? { key: member.key, value: true }
      : member),
  };
}

function validateStreamOptions(value: WireJson): void {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (value.members.filter((member) => member.key === "include_usage").length > 1) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
}

function hasVisionInput(body: WireJsonObject): boolean {
  const messages = memberValues(body, "messages")[0];
  if (!isWireJsonArray(messages)) {
    return false;
  }
  return messages.items.some((message) => {
    if (!isWireJsonObject(message)) {
      return false;
    }
    const content = memberValues(message, "content")[0];
    if (!isWireJsonArray(content)) {
      return false;
    }
    return content.items.some((part) => {
      if (!isWireJsonObject(part)) {
        return false;
      }
      return memberValues(part, "type")[0] === "image_url" && memberValues(part, "image_url").length > 0;
    });
  });
}

function assertUpstreamSuccess(status: number, headers: Headers): void {
  if (status >= 200 && status < 300) {
    return;
  }
  const retry = status === 429 ? retryAfter(headers) : undefined;
  throw new GatewayFailureError({
    kind: "upstream_http",
    status,
    ...(retry === undefined ? {} : { retryAfter: retry }),
  });
}

function retryAfter(headers: Headers): string | undefined {
  return safeRetryAfter(headers.get("retry-after") ?? undefined);
}

function measure<T>(
  observer: ProtocolPerformanceObserver | undefined,
  measurement: "buffered" | "event",
  work: () => T,
): T {
  return observer === undefined ? work() : observer.measure(measurement, work);
}
