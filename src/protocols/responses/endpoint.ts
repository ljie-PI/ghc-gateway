import type { AccountDirectory } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import { iterateChatFrames, type BoundCopilot, type CopilotBackend } from "../../copilot/backend.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import {
  normalizeAccountBindingFailure,
  normalizeCatalogFailure,
  normalizeChatFrames,
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
import { createStreamResponseWriter } from "../../gateway/stream_response.js";
import {
  boundedCleanup,
  createExchangeCancellation,
  createOwnedStreamCleanup,
  nextWithDeadline,
  withByteIdleDeadlines,
} from "../../gateway/stream_execution.js";
import { isWireJsonNumber, isWireJsonObject, memberValues, parseWireJson, serializeWireJson, type WireJson, type WireJsonObject } from "../../serialization/wire_json.js";
import type { UpstreamByteResponse, UpstreamByteStream } from "../../copilot/upstream_types.js";
import type { ChatRequest } from "../chat_completions/types.js";
import { resolveModel } from "../model_catalog/resolver.js";
import { convertChatResponseToResponses } from "./bridge_nonstream.js";
import { prepareChatBridgeRequest } from "./bridge_request.js";
import { convertChatStream, type ResponsesStreamEmission } from "./bridge_stream.js";
import { decodeResponsesRequest, ResponsesRequestDecodeError } from "./decoder.js";
import type { ResponsesHistory } from "./history.js";
import { completeNativeResponses, normalizeNativeResponsesStream, openNativeResponsesStream } from "./native.js";
import { planResponsesExecution, type ChatBridgePlan } from "./planner.js";
import {
  encodeResponsesSseEvent,
  RESPONSES_JSON_HEADERS,
  RESPONSES_STREAM_HEADERS,
} from "./wire.js";
import type { TelemetryRecorder, UsageUpdate } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { presentResponsesFailure } from "./failure_presenter.js";

export interface ResponsesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
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
  const catalog = await loadCatalog(dependencies, account.accountId, scope.signal);
  const resolved = resolveModel(catalog, decoded.model, dependencies.preferences.get(account.accountId));
  if ("kind" in resolved) {
    throw new GatewayFailureError({ kind: resolved.kind });
  }
  usage.setResolvedModel(resolved.upstreamModel);
  const bound = await bindCopilot(dependencies.copilot, account, scope.signal);
  const plan = planResponsesExecution(decoded, resolved, bound.target);
  usage.setProtocol(plan.kind === "native_responses" ? "openai_responses_native" : "openai_responses_bridge");
  if (plan.kind === "native_responses") {
    return decoded.stream
      ? await nativeStreamResponse(bound, plan, scope, usage, dependencies.performanceObserver)
      : await nativeNonstreamResponse(bound, plan, scope, usage);
  }
  return decoded.stream
    ? await bridgeStreamResponse(dependencies, bound, plan, scope, usage)
    : await bridgeNonstreamResponse(dependencies, bound, plan, scope, usage);
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
  if (usage.enabled) {
    const payload = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
    usage.finish(nativeOutcome(payload), responsesUsage(payload));
  }
  return new Response(Buffer.from(upstream.body), {
    status: upstream.status,
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

async function nativeStreamResponse(
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
  const cancelExchange = createExchangeCancellation(upstream);
  const bytes = withByteIdleDeadlines(
    upstream.bytes,
    scope.signal,
    scope.config.timeouts.firstByteMs,
    scope.config.timeouts.streamIdleMs,
    cancelExchange,
  );
  const observed = usage.enabled ? createNativeStreamObservation(usage) : undefined;
  return await streamBytesResponse(
    normalizeNativeResponsesStream(bytes, scope.config.limits.sseEventBytes, observed?.observe, performanceObserver),
    upstream,
    scope,
    usage.failure,
    cancelExchange,
  );
}

async function bridgeNonstreamResponse(
  dependencies: ResponsesRouteDependencies,
  bound: BoundCopilot,
  plan: ChatBridgePlan,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  const prepared = await prepareChatBridgeRequest(plan, dependencies.history, {
    reasoningConfig: null,
    ...promptCacheContext(bound.target.endpoint),
  }, scope.signal);
  const request = chatRequest(prepared.body, plan.resolvedModel.upstreamModel, false, scope);
  const upstream = await transportCall(() => bound.completeChat(request), request.signal);
  assertUpstreamSuccess(upstream);
  const measured = measure(dependencies.performanceObserver, "buffered", () => {
    const chat = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
    const converted = convertChatResponseToResponses(chat, {
      originalRequest: plan.originalRequest,
      toolContext: prepared.toolContext,
      customLlmProvider: "github_copilot",
      modelId: plan.resolvedModel.upstreamModel,
      createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    });
    return { converted, bytes: Buffer.from(serializeWireJson(converted.response)) };
  });
  await dependencies.history.record(measured.converted.historyRecord, scope.signal);
  usage.success(responsesUsage(measured.converted.response));
  return new Response(measured.bytes, {
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

async function bridgeStreamResponse(
  dependencies: ResponsesRouteDependencies,
  bound: BoundCopilot,
  plan: ChatBridgePlan,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  const prepared = await prepareChatBridgeRequest(plan, dependencies.history, {
    reasoningConfig: null,
    ...promptCacheContext(bound.target.endpoint),
  }, scope.signal);
  const request = chatRequest(prepared.body, plan.resolvedModel.upstreamModel, true, scope);
  const upstream = await transportCall(() => bound.openChatStream(request), request.signal);
  if (upstream.status < 200 || upstream.status >= 300) {
    await boundedCleanup(upstream.cancel());
  }
  assertUpstreamSuccess(upstream);
  const cancelExchange = createExchangeCancellation(upstream);
  const timedUpstream = {
    ...upstream,
    bytes: withByteIdleDeadlines(
      upstream.bytes,
      scope.signal,
      scope.config.timeouts.firstByteMs,
      scope.config.timeouts.streamIdleMs,
      cancelExchange,
    ),
  };
  const emissions = convertChatStream(normalizeChatFrames(iterateChatFrames(timedUpstream), scope.signal), {
    originalRequest: plan.originalRequest,
    toolContext: prepared.toolContext,
    model: plan.resolvedModel.upstreamModel,
    nowUnixSeconds: dependencies.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000)),
    uuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    customLlmProvider: "github_copilot",
    modelId: plan.resolvedModel.upstreamModel,
  });
  return await streamEmissionsResponse(
    emissions,
    dependencies.history,
    upstream,
    scope,
    usage,
    dependencies.performanceObserver,
    cancelExchange,
  );
}

async function streamEmissionsResponse(
  emissions: AsyncIterable<ResponsesStreamEmission>,
  history: ResponsesHistory,
  upstream: UpstreamByteStream,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
  performanceObserver?: ProtocolPerformanceObserver,
  cancelExchange?: () => Promise<void>,
): Promise<Response> {
  const bytes = (async function* (): AsyncIterable<Uint8Array> {
    for await (const emission of emissions) {
      if (scope.signal.aborted) {
        return;
      }
      if (emission.kind === "checkpoint") {
        await measureAsync(
          performanceObserver,
          "checkpoint",
          async () => await history.record(emission.historyRecord, scope.signal),
        );
      }
      if (usage.enabled) {
        observeBridgeEvent(usage, emission.event);
      }
      yield measure(performanceObserver, "event", () => encodeResponsesSseEvent(emission.event));
    }
  })();
  return await streamBytesResponse(bytes, upstream, scope, usage.failure, cancelExchange);
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
  cancelExchange = createExchangeCancellation(upstream),
): Promise<Response> {
  const iterator = bytes[Symbol.asyncIterator]();
  const cleanup = createOwnedStreamCleanup(upstream, iterator, 1_000, cancelExchange);
  let first: IteratorResult<Uint8Array>;
  try {
    first = await nextWithDeadline(
      iterator,
      scope.config.timeouts.firstByteMs,
      scope.signal,
      { source: "parser", phase: "stream" },
    );
  } catch (error: unknown) {
    onFailure(error);
    await cleanup();
    throw error;
  }
  const writer = createStreamResponseWriter({
    signal: scope.signal,
    headers: { ...RESPONSES_STREAM_HEADERS, "x-request-id": scope.requestId },
    onCancel: cleanup,
  });
  const onAbort = (): void => {
    onFailure(new GatewayFailureError(failureFromSignal(scope.signal, {
      source: "parser",
      phase: "stream",
    })));
  };
  scope.signal.addEventListener("abort", onAbort, { once: true });
  void (async () => {
    try {
      if (first.done !== true && !await writer.enqueue(first.value)) {
        await cleanup();
        return;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        if (!await writer.enqueue(next.value)) {
          await cleanup();
          return;
        }
      }
      await cleanup();
      writer.close();
    } catch (error: unknown) {
      onFailure(error);
      await cleanup();
      writer.abort();
    } finally {
      scope.signal.removeEventListener("abort", onAbort);
      await cleanup();
    }
  })();
  return writer.response;
}

function chatRequest(
  body: WireJsonObject,
  model: string,
  stream: boolean,
  scope: Readonly<RequestScope>,
): ChatRequest {
  const bytes = serializeWireJson(body);
  return {
    model,
    body: bytes,
    stream,
    hasVisionInput: new TextDecoder().decode(bytes).includes("\"image_url\""),
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  };
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
  accountId: string,
  signal: AbortSignal,
) {
  try {
    const catalog = await dependencies.catalog.get(accountId, signal);
    dependencies.preferences.markInvalidIfMissing(accountId, new Set(catalog.models.map((model) => model.id)), catalog.generation);
    return catalog;
  } catch (error: unknown) {
    throw normalizeCatalogFailure(error, signal);
  }
}

function promptCacheContext(endpoint: string): { readonly upstreamHost?: string; readonly upstreamPath?: string; readonly promptCacheRouting: "auto" } {
  try {
    const url = new URL(endpoint);
    return { upstreamHost: url.hostname, upstreamPath: url.pathname, promptCacheRouting: "auto" };
  } catch (_error: unknown) {
    return { promptCacheRouting: "auto" };
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
  const observed = responsesUsageObservation(payload);
  return {
    inputTokens: observed.inputTokens ?? 0,
    outputTokens: observed.outputTokens ?? 0,
    cacheTokens: observed.cacheTokens ?? 0,
  };
}

interface UsageObservation {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheTokens?: number;
}

function responsesUsageObservation(payload: WireJsonObject): UsageObservation {
  const usage = objectMember(payload, "usage") ?? objectMember(objectMember(payload, "response"), "usage");
  const details = objectMember(usage, "input_tokens_details");
  const inputTokens = observedInteger(memberValue(usage, "input_tokens"));
  const outputTokens = observedInteger(memberValue(usage, "output_tokens"));
  const cacheTokens = observedInteger(memberValue(details, "cached_tokens"));
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheTokens === undefined ? {} : { cacheTokens }),
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

function createNativeStreamObservation(usage: RequestAttempt): { readonly observe: (event: Readonly<WireJsonObject>) => void } {
  let observation: UsageObservation = {};
  return {
    observe(event) {
      const observed = responsesUsageObservation(event);
      observation = {
        ...((observed.inputTokens ?? observation.inputTokens) === undefined
          ? {}
          : { inputTokens: observed.inputTokens ?? observation.inputTokens }),
        ...((observed.outputTokens ?? observation.outputTokens) === undefined
          ? {}
          : { outputTokens: observed.outputTokens ?? observation.outputTokens }),
        ...((observed.cacheTokens ?? observation.cacheTokens) === undefined
          ? {}
          : { cacheTokens: observed.cacheTokens ?? observation.cacheTokens }),
      };
      const type = memberValue(event, "type");
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error") {
        usage.finish(nativeOutcome(event), {
          inputTokens: observation.inputTokens ?? 0,
          outputTokens: observation.outputTokens ?? 0,
          cacheTokens: observation.cacheTokens ?? 0,
        });
      }
    },
  };
}

function observeBridgeEvent(usage: RequestAttempt, event: WireJsonObject): void {
  if (memberValue(event, "type") === "response.completed") {
    usage.finish("success", chatUsage(objectMember(event, "response")));
  }
}

function chatUsage(response: WireJsonObject | undefined): UsageTokens {
  const usage = objectMember(response, "usage");
  const details = objectMember(usage, "prompt_tokens_details");
  return {
    inputTokens: observedInteger(memberValue(usage, "prompt_tokens")) ?? 0,
    outputTokens: observedInteger(memberValue(usage, "completion_tokens")) ?? 0,
    cacheTokens: observedInteger(memberValue(details, "cached_tokens")) ?? 0,
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

function observedInteger(value: WireJson | undefined): number | undefined {
  if (!isWireJsonNumber(value) || !/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return undefined;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
