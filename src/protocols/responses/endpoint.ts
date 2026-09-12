import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
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
import type { DecodedHttpRequest, RouteRegistration } from "../../gateway/hono_app.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import { createRequestAttempt, type AttemptUsage, type RequestAttempt } from "../../gateway/request_attempt.js";
import { createConvertedStreamResponse } from "../../gateway/converted_stream_response.js";
import {
  boundedCleanup,
  createStreamExecutionResponse,
  withByteIdleDeadlines,
  type StreamExecutionEmission,
} from "../../gateway/stream_execution.js";
import { isWireJsonArray, isWireJsonNumber, isWireJsonObject, memberValues, parseWireJson, type WireJson, type WireJsonObject } from "../../serialization/wire_json.js";
import type { UpstreamByteResponse, UpstreamByteStream } from "../../copilot/upstream_types.js";
import { resolveModel } from "../model_catalog/resolver.js";
import { reconcilePreferredModelIfCurrent } from "../model_catalog/preferred.js";
import {
  continuationModel,
  continuationOwnership,
  isTerminalResponsesEvent,
  ownedContinuationReceipt,
  persistContinuation,
  resolveResponsesContinuation,
  responseIdFromPayload,
  validateContinuationTarget,
  validateExternalContinuation,
} from "./continuation.js";
import { decodeResponsesRequest, ResponsesRequestDecodeError } from "./decoder.js";
import { consumeResponsesPreviousResponseId, type ResponsesRequest } from "./dto.js";
import {
  type ResponsesContinuationOwnership,
  type ResponsesHistory,
} from "./history.js";
import { completeNativeResponses, normalizeNativeResponsesStream, openNativeResponsesStream } from "./native.js";
import { RESPONSES_JSON_HEADERS, RESPONSES_STREAM_HEADERS } from "./wire.js";
import type { TelemetryRecorder, UsageUpdate } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { presentResponsesFailure } from "./failure_presenter.js";
import { withUpstreamProtocol } from "../../gateway/execution_evidence.js";
import { planProtocolExecution } from "../conversion/planner.js";
import { completeConvertedOperation, openConvertedOperation } from "../conversion/operation.js";
import { convertBufferedPlannedResponse } from "../conversion/buffered.js";
import type {
  ConversionCheckpointIntent,
  ConvertedProtocolPlan,
  SemanticUsage,
} from "../conversion/types.js";

export interface ResponsesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry: ModelCapabilityRegistry;
  readonly preferences: AccountModelPreferences;
  readonly copilot: CopilotBackend;
  readonly history: ResponsesHistory;
  readonly nowUnixSeconds?: () => number;
  readonly createUuid?: () => string;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
}

export function createResponsesRoute(dependencies: ResponsesRouteDependencies): RouteRegistration {
  requireModelCapabilityRegistry(dependencies.registry);
  return {
    method: "POST",
    path: "/v1/responses",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentResponsesFailure,
    createAttempt: (requestId, config) => createRequestAttempt({
      requestId,
      config,
      protocol: "openai_responses_unknown",
      abortedErrorCount: 1,
      ...(dependencies.usageRecorder === undefined ? {} : { recorder: dependencies.usageRecorder }),
      ...(dependencies.nowMs === undefined ? {} : { nowMs: dependencies.nowMs }),
    }),
    endpoint: (request, scope) => executeResponses(dependencies, request, scope),
  };
}

async function executeResponses(
  dependencies: ResponsesRouteDependencies,
  request: Readonly<DecodedHttpRequest>,
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const usage = scope.attempt;
  if (request.body === undefined) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const decoded = decodeRequest(request.body);
  if (decoded.model !== undefined) {
    usage.setRequestedModel(decoded.model);
  }
  const account = await bindAccount(dependencies.directory, scope.signal);
  usage.setAccount(account.accountId);
  const continuation = await resolveResponsesContinuation(
    dependencies.history,
    decoded.previousResponseId,
    account.accountId,
    scope.signal,
  );
  const continuationReceipt = ownedContinuationReceipt(continuation);
  const requestedModel = continuationModel(decoded.model, continuationReceipt);
  const preference = dependencies.preferences.get(account.accountId);
  const catalog = await loadCatalog(dependencies, account, preference, scope.signal);
  const resolved = resolveModel(catalog, requestedModel, preference);
  if ("kind" in resolved) {
    if (continuationReceipt !== undefined) {
      throw new GatewayFailureError({
        kind: "continuation_conflict",
        source: "continuation",
        phase: "resume",
      });
    }
    throw new GatewayFailureError({ kind: resolved.kind });
  }
  usage.setResolvedModel(resolved.upstreamModel);
  const bound = await bindCopilot(dependencies.copilot, account, scope.signal);
  validateContinuationTarget(continuationReceipt, bound.target.endpoint);
  const convertedContinuation = continuationReceipt !== undefined
    && continuationReceipt.upstreamProtocol !== "responses";
  let planningRequest = decoded;
  if (convertedContinuation && continuationReceipt !== undefined) {
    if (
      continuationReceipt.upstreamProtocol === "messages"
      && !hasClientMessagesContinuationContext(decoded)
    ) {
      throw new GatewayFailureError({
        kind: "continuation_unavailable",
        source: "continuation",
        phase: "resume",
      });
    }
    try {
      planningRequest = consumeResponsesPreviousResponseId(
        await dependencies.history.enrich(decoded, continuationReceipt, scope.signal),
      );
    } catch (error: unknown) {
      if (scope.signal.aborted) {
        throw new GatewayFailureError(failureFromSignal(scope.signal, {
          source: "continuation",
          phase: "resume",
        }));
      }

      throw new GatewayFailureError({
        kind: "continuation_unavailable",
        source: "continuation",
        phase: "resume",
        cause: error,
      });
    }
  }
  const forcedTarget = continuationReceipt?.upstreamProtocol;
  const plan = planProtocolExecution({
    source: "responses",
    body: planningRequest.body,
    stream: decoded.stream,
    capability: resolved.capability,
    resolvedModel: resolved.upstreamModel,
    ...(forcedTarget === undefined ? {} : { forcedTarget }),
  });
  validateExternalContinuation(
    decoded.previousResponseId,
    continuation,
    plan.kind === "native" ? "native_responses" : plan.target === "messages" ? "messages_bridge" : "chat_bridge",
  );
  usage.setProtocol(plan.kind === "native" ? "openai_responses_native" : "openai_responses_bridge");
  const ownership = continuationOwnership(
    account.accountId,
    resolved.upstreamModel,
    bound.target.endpoint,
    plan.kind === "native" ? "native_responses" : plan.target === "messages" ? "messages_bridge" : "chat_bridge",
  );
  if (plan.kind === "native") {
    const nativePlan = {
      kind: "native_responses" as const,
      originalRequest: decoded,
      resolvedModel: resolved,
      upstreamUrl: `${bound.target.endpoint.replace(/\/+$/u, "")}/responses`,
      stream: decoded.stream,
    };
    return withUpstreamProtocol(decoded.stream
      ? await nativeStreamResponse(
        dependencies.history,
        ownership,
        bound,
        nativePlan,
        scope,
        usage,
        dependencies.performanceObserver,
      )
      : await nativeNonstreamResponse(dependencies.history, ownership, bound, nativePlan, scope, usage), "responses");
  }
  return withUpstreamProtocol(decoded.stream
    ? await convertedStreamResponse(dependencies, ownership, bound, plan, scope, usage)
    : await convertedNonstreamResponse(dependencies, ownership, bound, plan, scope, usage), plan.target);
}

function decodeRequest(body: WireJsonObject) {
  try {
    return decodeResponsesRequest(body);
  } catch (error: unknown) {
    if (error instanceof ResponsesRequestDecodeError) {
      throw new GatewayFailureError({ kind: "invalid_request", cause: error });
    }
    throw error;
  }
}

async function nativeNonstreamResponse(
  history: ResponsesHistory,
  ownership: Readonly<ResponsesContinuationOwnership>,
  bound: BoundCopilot,
  plan: Parameters<typeof completeNativeResponses>[1],
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  const upstream = await transportCall(
    () => completeNativeResponses(bound, plan, nativeOptions(scope)),
    scope.signal,
  );
  assertUpstreamSuccess(upstream);
  const payload = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
  const responseId = responseIdFromPayload(payload);
  if (responseId !== undefined) {
    await persistContinuation(
      async () => await history.recordReceipt({
        ...ownership,
        responseId,
        checkpointState: "complete",
      }, scope.signal),
      scope.signal,
    );
  }
  if (usage.enabled) {
    usage.finish(nativeOutcome(payload), responsesUsage(payload));
  }
  return new Response(Buffer.from(upstream.body), {
    status: upstream.status,
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

async function nativeStreamResponse(
  history: ResponsesHistory,
  ownership: Readonly<ResponsesContinuationOwnership>,
  bound: BoundCopilot,
  plan: Parameters<typeof openNativeResponsesStream>[1],
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
  performanceObserver?: ProtocolPerformanceObserver,
): Promise<Response> {
  const upstream = await transportCall(
    () => openNativeResponsesStream(bound, plan, nativeOptions(scope)),
    scope.signal,
  );
  if (upstream.status < 200 || upstream.status >= 300) {
    await boundedCleanup(upstream.cancel());
  }
  assertUpstreamSuccess(upstream);
  const bytes = withByteIdleDeadlines(
    upstream.bytes,
    scope.signal,
    scope.config.timeouts.firstByteMs,
    scope.config.timeouts.streamIdleMs,
  );
  const observed = usage.enabled ? createNativeStreamObservation(usage) : undefined;
  return await streamBytesResponse(
    normalizeNativeResponsesStream(
      bytes,
      scope.config.limits.sseEventBytes,
      observed?.observe,
      performanceObserver,
      async (event) => {
        const responseId = responseIdFromPayload(event);
        if (responseId === undefined) {
          return;
        }
        await persistContinuation(
          async () => await history.recordReceipt({
            ...ownership,
            responseId,
            checkpointState: isTerminalResponsesEvent(event) ? "complete" : "route_only",
          }, scope.signal),
          scope.signal,
        );
      },
    ),
    upstream,
    scope,
    usage.failure,
    () => observed?.finish(),
  );
}

async function convertedNonstreamResponse(
  dependencies: ResponsesRouteDependencies,
  ownership: Readonly<ResponsesContinuationOwnership>,
  bound: BoundCopilot,
  plan: Readonly<ConvertedProtocolPlan>,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  const upstream = await completeConvertedOperation(bound, plan, scope);
  assertUpstreamSuccess(upstream);
  const converted = measure(dependencies.performanceObserver, "buffered", () => convertBufferedPlannedResponse(
    upstream.body,
    plan,
    {
      maxBytes: scope.config.limits.nonstreamBodyBytes,
      createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
      nowUnixSeconds: dependencies.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000)),
    },
  ));
  if (converted.checkpoint !== undefined) {
    await persistConvertedCheckpoint(
      dependencies,
      ownership,
      converted.checkpoint,
      scope,
    );
  }
  usage.success(attemptUsage(converted.observations.usage));
  return new Response(Buffer.from(converted.bytes), {
    status: upstream.status,
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

async function convertedStreamResponse(
  dependencies: ResponsesRouteDependencies,
  ownership: Readonly<ResponsesContinuationOwnership>,
  bound: BoundCopilot,
  plan: Readonly<ConvertedProtocolPlan>,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  const upstream = await openConvertedOperation(bound, plan, scope);
  if (upstream.status < 200 || upstream.status >= 300) {
    await boundedCleanup(upstream.cancel());
  }
  assertUpstreamSuccess(upstream);
  return await createConvertedStreamResponse({
    upstream,
    plan,
    scope,
    model: plan.requestModel,
    createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    nowUnixSeconds: dependencies.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000)),
    performanceObserver: dependencies.performanceObserver,
    headers: { ...RESPONSES_STREAM_HEADERS, "x-request-id": scope.requestId },
    persistCheckpoint: async (intent) => await persistConvertedCheckpoint(
      dependencies,
      ownership,
      intent,
      scope,
    ),
    onTerminal: (result) => result.kind === "success"
      ? usage.success(attemptUsage(result.usage))
      : usage.failure(result.error),
  });
}

async function persistConvertedCheckpoint(
  dependencies: ResponsesRouteDependencies,
  ownership: Readonly<ResponsesContinuationOwnership>,
  intent: Readonly<ConversionCheckpointIntent>,
  scope: Readonly<RequestScope>,
): Promise<void> {
  await measureAsync(
    dependencies.performanceObserver,
    "checkpoint",
    async () => await persistContinuation(
      async () => {
        if (intent.state === "route_only") {
          await dependencies.history.recordReceipt({
            ...ownership,
            responseId: intent.responseId,
            checkpointState: "route_only",
          }, scope.signal);
          return;
        }
        await dependencies.history.recordCheckpoint(
          { responseId: intent.responseId, output: intent.output },
          ownership,
          intent.state,
          scope.signal,
        );
      },
      scope.signal,
    ),
  );
}

function measure<T>(
  observer: ProtocolPerformanceObserver | undefined,
  measurement: "buffered" | "event",
  work: () => T,
): T {
  return observer === undefined ? work() : observer.measure(measurement, work);
}

async function measureAsync<T>(
  observer: ProtocolPerformanceObserver | undefined,
  measurement: "checkpoint",
  work: () => Promise<T>,
): Promise<T> {
  return observer === undefined ? await work() : await observer.measureAsync(measurement, work);
}

async function streamBytesResponse(
  bytes: AsyncIterable<Uint8Array>,
  upstream: UpstreamByteStream,
  scope: Readonly<RequestScope>,
  onFailure: (error: unknown) => void,
  onSuccess?: () => void,
): Promise<Response> {
  return await createStreamExecutionResponse({
    upstream,
    emissions: responseByteEmissions(bytes),
    signal: scope.signal,
    deliverySignal: scope.deliverySignal,
    headers: { ...RESPONSES_STREAM_HEADERS, "x-request-id": scope.requestId },
    firstEmissionTimeoutMs: scope.config.timeouts.firstByteMs,
    normalizeFailure: (error) => error,
    onTerminal: (result) => {
      if (result.kind === "failure") {
        onFailure(result.error);
      } else {
        onSuccess?.();
      }
    },
  });
}

async function* responseByteEmissions(
  bytes: AsyncIterable<Uint8Array>,
): AsyncIterable<StreamExecutionEmission<undefined>> {
  const iterator = bytes[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        yield {
          kind: "terminal",
          outcome: { kind: "success", value: undefined },
          writerMode: "close",
        };
        return;
      }
      yield { kind: "wire", bytes: next.value };
    }
  } finally {
    if (iterator.return !== undefined) {
      await iterator.return();
    }
  }
}

function nativeOptions(scope: Readonly<RequestScope>) {
  return {
    requestId: scope.requestId,
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  };
}

function attemptUsage(value: Readonly<SemanticUsage>): AttemptUsage {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheTokens: value.cacheReadTokens + value.cacheWriteTokens,
  };
}

function assertUpstreamSuccess(response: Pick<UpstreamByteResponse, "status" | "headers">): void {
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

function parseUpstreamObject(body: Uint8Array, maxBytes: number): WireJsonObject {
  try {
    const parsed = parseWireJson(body, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

async function bindAccount(directory: AccountDirectory, signal: AbortSignal) {
  try {
    return await directory.bindDefault(signal);
  } catch (error: unknown) {
    throw normalizeAccountBindingFailure(error);
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

async function transportCall<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, signal, { source: "transport", phase: "headers" });
  }
}

async function loadCatalog(
  dependencies: ResponsesRouteDependencies,
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

function retryAfterHeader(status: number, headers: Headers): string | undefined {
  if (status !== 429) {
    return undefined;
  }
  return safeRetryAfter(headers.get("retry-after") ?? undefined);
}

type UsageTokens = AttemptUsage;

function responsesUsage(payload: WireJsonObject): UsageTokens {
  return responsesUsageNumbers(responsesUsageObservation(payload));
}

interface UsageObservation {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

function responsesUsageNumbers(observation: UsageObservation): UsageTokens {
  return {
    inputTokens: observation.inputTokens ?? 0,
    outputTokens: observation.outputTokens ?? 0,
    cacheTokens: (observation.cacheReadTokens ?? 0) + (observation.cacheWriteTokens ?? 0),
  };
}

function responsesUsageObservation(payload: WireJsonObject): UsageObservation {
  const usage = objectMember(payload, "usage") ?? objectMember(objectMember(payload, "response"), "usage");
  const details = objectMember(usage, "input_tokens_details");
  const inputTokens = observedInteger(memberValue(usage, "input_tokens"));
  const outputTokens = observedInteger(memberValue(usage, "output_tokens"));
  const cacheReadTokens = observedInteger(memberValue(details, "cached_tokens"));
  const cacheWriteTokens = observedInteger(memberValue(details, "cache_write_tokens"));
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function nativeOutcome(payload: WireJsonObject): UsageUpdate["outcome"] {
  return memberValue(payload, "status") === "failed"
    || memberValue(objectMember(payload, "response"), "status") === "failed"
    || memberValue(payload, "type") === "response.failed"
    || memberValue(payload, "type") === "error"
    ? "upstream_error"
    : "success";
}

function createNativeStreamObservation(usage: RequestAttempt): {
  readonly observe: (event: Readonly<WireJsonObject>) => void;
  readonly finish: () => void;
} {
  let observation: UsageObservation = {};
  let outcome: UsageUpdate["outcome"] = "success";
  return {
    observe(event) {
      const observed = responsesUsageObservation(event);
      observation = { ...observation, ...observed };
      const type = memberValue(event, "type");
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error") {
        outcome = nativeOutcome(event);
      }
    },
    finish() {
      usage.finish(outcome, responsesUsageNumbers(observation));
    },
  };
}

function objectMember(object: WireJsonObject | undefined, key: string): WireJsonObject | undefined {
  const value = object === undefined ? undefined : memberValue(object, key);
  return isWireJsonObject(value) ? value : undefined;
}

function memberValue(object: WireJsonObject | undefined, key: string): WireJson | undefined {
  if (object === undefined) {
    return undefined;
  }
  const values = memberValues(object, key);
  return values.length === 1 ? values[0] : undefined;
}

function hasClientMessagesContinuationContext(request: Readonly<ResponsesRequest>): boolean {
  const instructions = memberValue(request.body, "instructions");
  if (hasNonEmptyContinuationContent(instructions)) {
    return true;
  }
  const input = memberValue(request.body, "input");
  if (typeof input === "string") {
    return input.trim().length > 0;
  }
  const items = isWireJsonArray(input) ? input.items : isWireJsonObject(input) ? [input] : [];
  return items.some((item) => {
    if (!isWireJsonObject(item)) {
      return false;
    }
    const type = memberValue(item, "type");
    const role = memberValue(item, "role");
    return (type === undefined || type === "message")
      && (role === "user" || role === "system" || role === "developer")
      && hasNonEmptyContinuationContent(memberValue(item, "content"));
  });
}

function hasNonEmptyContinuationContent(value: WireJson | undefined): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (isWireJsonArray(value)) {
    return value.items.some((item) => hasNonEmptyContinuationContent(item));
  }
  if (!isWireJsonObject(value)) {
    return false;
  }
  const type = memberValue(value, "type");
  if (type === "input_text" || type === "text") {
    return hasNonEmptyContinuationContent(memberValue(value, "text"));
  }
  if (type === "input_image") {
    return hasNonEmptyContinuationContent(memberValue(value, "image_url"));
  }
  if (type === "image") {
    const source = objectMember(value, "source");
    return hasNonEmptyContinuationContent(memberValue(source, "url"))
      || hasNonEmptyContinuationContent(memberValue(source, "data"));
  }
  return false;
}

function observedInteger(value: WireJson | undefined): number | undefined {
  if (!isWireJsonNumber(value) || !/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return undefined;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
