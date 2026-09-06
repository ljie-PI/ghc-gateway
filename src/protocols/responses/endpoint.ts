import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { loadCapabilitySnapshot, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
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
import { createStreamResponseWriter } from "../../gateway/stream_response.js";
import {
  boundedCleanup,
  createExchangeCancellation,
  createOwnedStreamCleanup,
  nextWithDeadline,
  withByteIdleDeadlines,
} from "../../gateway/stream_execution.js";
import { duplicateMemberNames, isWireJsonArray, isWireJsonNumber, isWireJsonObject, memberValues, parseWireJson, serializeWireJson, type WireJson, type WireJsonObject } from "../../serialization/wire_json.js";
import type { UpstreamByteResponse, UpstreamByteStream } from "../../copilot/upstream_types.js";
import type { ChatRequest } from "../chat_completions/types.js";
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
import { consumeResponsesPreviousResponseId } from "./dto.js";
import { convertChatResponseToResponses } from "./bridge_nonstream.js";
import { prepareChatBridgeRequest } from "./bridge_request.js";
import {
  type ResponsesContinuationOwnership,
  type ResponsesHistory,
} from "./history.js";
import { completeNativeResponses, normalizeNativeResponsesStream, openNativeResponsesStream } from "./native.js";
import type { ChatBridgePlan } from "./planner.js";
import { RESPONSES_JSON_HEADERS, RESPONSES_STREAM_HEADERS } from "./wire.js";
import type { TelemetryRecorder, UsageUpdate } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { presentResponsesFailure } from "./failure_presenter.js";
import { planProtocolExecution, prepareConvertedRequest } from "../conversion/planner.js";
import { completeConvertedOperation, openConvertedOperation } from "../conversion/operation.js";
import { convertBufferedResponse } from "../conversion/buffered.js";
import type {
  ConversionCheckpointIntent,
  ConvertedProtocolPlan,
  SemanticUsage,
} from "../conversion/types.js";

export interface ResponsesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry?: ModelCapabilityRegistry;
  readonly catalog?: CopilotModelCatalog;
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
  const protocols = resolved.capability.protocols.value;
  const extendedChat = hasExtendedResponsesTools(planningRequest.body)
    && protocols?.includes("chat") === true
    && (forcedTarget === "chat"
      || (forcedTarget === undefined
        && protocols?.includes("responses") !== true
        && protocols?.includes("chat") === true));
  if (extendedChat) {
    validateExtendedResponsesRequest(
      planningRequest.body,
      resolved.upstreamModel,
      resolved.capability,
    );
    if (decoded.stream) {
      throw new GatewayFailureError({
        kind: "unsupported_semantics",
        source: "converter",
        phase: "convert",
      });
    }
    validateExternalContinuation(decoded.previousResponseId, continuation, "chat_bridge");
    usage.setProtocol("openai_responses_bridge");
    const ownership = continuationOwnership(
      account.accountId,
      resolved.upstreamModel,
      bound.target.endpoint,
      "chat_bridge",
    );
    const extendedPlan: ChatBridgePlan = {
      kind: "chat_bridge",
      originalRequest: planningRequest,
      resolvedModel: resolved,
    };
    return await extendedBridgeNonstreamResponse(dependencies, ownership, bound, extendedPlan, scope, usage);
  }
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
    return decoded.stream
      ? await nativeStreamResponse(
        dependencies.history,
        ownership,
        bound,
        nativePlan,
        scope,
        usage,
        dependencies.performanceObserver,
      )
      : await nativeNonstreamResponse(dependencies.history, ownership, bound, nativePlan, scope, usage);
  }
  return decoded.stream
    ? await convertedStreamResponse(dependencies, ownership, bound, plan, scope, usage)
    : await convertedNonstreamResponse(dependencies, ownership, bound, plan, scope, usage);
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
    cancelExchange,
  );
}

async function extendedBridgeNonstreamResponse(
  dependencies: ResponsesRouteDependencies,
  ownership: Readonly<ResponsesContinuationOwnership>,
  bound: BoundCopilot,
  plan: ChatBridgePlan,
  scope: Readonly<RequestScope>,
  usage: RequestAttempt,
): Promise<Response> {
  const prepared = await prepareChatBridgeRequest(plan, dependencies.history, {
    reasoningConfig: null,
    chatOutputTokenField: plan.resolvedModel.capability.profile.chatOutputTokenField.value,
  }, scope.signal);
  const request = extendedChatRequest(prepared.body, plan.resolvedModel.upstreamModel, false, scope);
  const upstream = await transportCall(() => bound.completeChat(request), request.signal);
  assertUpstreamSuccess(upstream);
  const measured = measure(dependencies.performanceObserver, "buffered", () => {
    const shared = convertBufferedResponse(upstream.body, {
      source: "chat",
      target: "responses",
      model: plan.resolvedModel.upstreamModel,
      maxBytes: scope.config.limits.nonstreamBodyBytes,
      createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
      nowUnixSeconds: dependencies.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000)),
    });
    const chat = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
    const converted = convertChatResponseToResponses(chat, {
      originalRequest: plan.originalRequest,
      toolContext: prepared.toolContext,
      customLlmProvider: "github_copilot",
      modelId: plan.resolvedModel.upstreamModel,
      createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    });
    const merged = mergeExtendedResponseOutput(shared.body, converted.response);
    const responseId = memberValue(merged, "id");
    const output = memberValue(merged, "output");
    if (typeof responseId !== "string" || !isWireJsonArray(output)) {
      throw new GatewayFailureError({
        kind: "invalid_upstream_response",
        source: "converter",
        phase: "convert",
      });
    }
    return {
      historyRecord: { responseId, output: output.items },
      observations: shared.observations,
      bytes: Buffer.from(serializeWireJson(merged)),
    };
  });
  await persistContinuation(
    async () => measured.observations.terminal === "completed"
      ? await dependencies.history.recordCheckpoint(
        measured.historyRecord,
        ownership,
        "complete",
        scope.signal,
      )
      : await dependencies.history.recordReceipt({
        ...ownership,
        responseId: measured.historyRecord.responseId,
        checkpointState: "route_only",
      }, scope.signal),
    scope.signal,
  );
  usage.success(attemptUsage(measured.observations.usage));
  return new Response(measured.bytes, {
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

function mergeExtendedResponseOutput(
  shared: WireJsonObject,
  legacy: WireJsonObject,
): WireJsonObject {
  const sharedOutput = memberValue(shared, "output");
  const legacyOutput = memberValue(legacy, "output");
  if (!isWireJsonArray(sharedOutput) || !isWireJsonArray(legacyOutput)) {
    throw new GatewayFailureError({
      kind: "invalid_upstream_response",
      source: "converter",
      phase: "convert",
    });
  }
  const extendedByCallId = new Map<string, WireJson>();
  for (const item of legacyOutput.items) {
    if (!isWireJsonObject(item)) {
      continue;
    }
    const type = memberValue(item, "type");
    const callId = memberValue(item, "call_id");
    if (
      typeof callId === "string"
      && (type === "custom_tool_call"
        || type === "tool_search_call"
        || (type === "function_call" && memberValue(item, "namespace") !== undefined))
    ) {
      extendedByCallId.set(callId, item);
    }
  }
  const output = sharedOutput.items.map((item) => {
    if (!isWireJsonObject(item) || memberValue(item, "type") !== "function_call") {
      return item;
    }
    const callId = memberValue(item, "call_id");
    return typeof callId === "string" ? extendedByCallId.get(callId) ?? item : item;
  });
  return replaceWireMember(shared, "output", { kind: "array", items: output });
}

function replaceWireMember(object: WireJsonObject, key: string, value: WireJson): WireJsonObject {
  return {
    kind: "object",
    members: object.members.map((member) => member.key === key ? { key, value } : member),
  };
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
  const converted = measure(dependencies.performanceObserver, "buffered", () => convertBufferedResponse(
    upstream.body,
    {
      source: plan.target,
      target: "responses",
      model: plan.requestModel,
      maxBytes: scope.config.limits.nonstreamBodyBytes,
      createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
      nowUnixSeconds: dependencies.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000)),
      degradations: plan.request.degradations,
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

function extendedChatRequest(
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

const EXTENDED_RESPONSES_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "stream",
  "stream_options",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "response_format",
  "previous_response_id",
  "store",
  "background",
  "n",
  "metadata",
]);

function hasExtendedResponsesTools(body: WireJsonObject): boolean {
  const tools = memberValue(body, "tools");
  return isWireJsonArray(tools) && tools.items.some((tool) => (
    isWireJsonObject(tool) && memberValue(tool, "type") !== "function"
  ));
}

function validateExtendedResponsesRequest(
  body: WireJsonObject,
  model: string,
  capability: Parameters<typeof prepareConvertedRequest>[4],
): void {
  if (
    duplicateMemberNames(body).length > 0
    || body.members.some((member) => !EXTENDED_RESPONSES_KEYS.has(member.key))
  ) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      source: "converter",
      phase: "convert",
    });
  }
  const background = memberValue(body, "background");
  const store = memberValue(body, "store");
  if (
    (background !== undefined && background !== false)
    || (store !== undefined && store !== false)
  ) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      source: "converter",
      phase: "convert",
    });
  }
  const n = observedInteger(memberValue(body, "n"));
  if (memberValue(body, "n") !== undefined && n !== 1) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  const tools = memberValue(body, "tools");
  if (!isWireJsonArray(tools)) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  const toolNames = new Set<string>();
  for (const tool of tools.items) {
    if (!isWireJsonObject(tool) || duplicateMemberNames(tool).length > 0) {
      throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
    }
    const type = memberValue(tool, "type");
    if (type === "function") {
      const functionObject = validateExtendedFunctionTool(tool);
      toolNames.add(memberValue(functionObject, "name") as string);
      continue;
    }
    if (type === "custom") {
      assertExtendedToolKeys(tool, new Set(["type", "name", "description", "format"]));
      assertExtendedToolName(tool);
      const description = memberValue(tool, "description");
      const format = memberValue(tool, "format");
      if (description !== undefined && typeof description !== "string") {
        throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
      }
      if (format !== undefined) {
        if (
          !isWireJsonObject(format)
          || duplicateMemberNames(format).length > 0
          || format.members.some((member) => member.key !== "type")
          || memberValue(format, "type") !== "text"
        ) {
          throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
        }
      }
      toolNames.add(memberValue(tool, "name") as string);
      continue;
    }
    if (type === "namespace") {
      assertExtendedToolKeys(tool, new Set(["type", "name", "description", "tools", "children"]));
      assertExtendedToolName(tool);
      const children = memberValue(tool, "tools") ?? memberValue(tool, "children");
      if (!isWireJsonArray(children) || children.items.length === 0) {
        throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
      }
      for (const child of children.items) {
        if (!isWireJsonObject(child) || memberValue(child, "type") !== "function") {
          throw new GatewayFailureError({
            kind: "unsupported_semantics",
            source: "converter",
            phase: "convert",
          });
        }
        const functionObject = validateExtendedFunctionTool(child);
        toolNames.add(memberValue(functionObject, "name") as string);
      }
      continue;
    }
    if (type === "tool_search") {
      assertExtendedToolKeys(tool, new Set(["type"]));
      toolNames.add("tool_search");
      continue;
    }
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      source: "converter",
      phase: "convert",
    });
  }
  validateExtendedToolChoice(memberValue(body, "tool_choice"), toolNames);
  const parallel = memberValue(body, "parallel_tool_calls");
  if (parallel !== undefined && typeof parallel !== "boolean") {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  if (memberValue(body, "text") !== undefined || memberValue(body, "response_format") !== undefined) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      source: "converter",
      phase: "convert",
    });
  }
  const sanitized: WireJsonObject = {
    kind: "object",
    members: body.members
      .filter((member) => (
        member.key !== "tools"
        && member.key !== "tool_choice"
        && member.key !== "parallel_tool_calls"
        && member.key !== "input"
      ))
      .concat({ key: "input", value: sanitizedExtendedInput(memberValue(body, "input")) }),
  };
  prepareConvertedRequest("responses", "chat", sanitized, model, capability);
  rejectExtendedInstructionReordering(memberValue(body, "input"));
}

function validateExtendedToolChoice(value: WireJson | undefined, names: ReadonlySet<string>): void {
  if (value === undefined) {
    return;
  }
  if (value === "auto" || value === "none" || value === "required") {
    return;
  }
  if (!isWireJsonObject(value) || duplicateMemberNames(value).length > 0) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  assertExtendedToolKeys(value, new Set(["type", "name", "namespace"]));
  const type = memberValue(value, "type");
  const name = memberValue(value, "name");
  if (
    (type !== "custom" && type !== "function" && type !== "tool_search")
    || typeof name !== "string"
    || !names.has(name)
  ) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
}

function sanitizedExtendedInput(value: WireJson | undefined): WireJson {
  if (!isWireJsonArray(value)) {
    return value ?? { kind: "array", items: [] };
  }
  const ordinary: WireJson[] = [];
  const calls = new Set<string>();
  for (const item of value.items) {
    if (!isWireJsonObject(item)) {
      ordinary.push(item);
      continue;
    }
    const type = memberValue(item, "type");
    if (type === "custom_tool_call" || type === "tool_search_call") {
      assertExtendedToolKeys(
        item,
        type === "custom_tool_call"
          ? new Set(["type", "id", "call_id", "name", "input", "status"])
          : new Set(["type", "id", "call_id", "arguments", "status", "execution"]),
      );
      const callId = memberValue(item, "call_id");
      if (typeof callId !== "string" || callId.length === 0 || calls.has(callId)) {
        throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
      }
      if (type === "custom_tool_call") {
        if (
          typeof memberValue(item, "name") !== "string"
          || typeof memberValue(item, "input") !== "string"
        ) {
          throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
        }
      }
      calls.add(callId);
      continue;
    }
    if (type === "custom_tool_call_output" || type === "tool_search_output") {
      assertExtendedToolKeys(item, new Set(["type", "id", "call_id", "output", "status", "tools"]));
      const callId = memberValue(item, "call_id");
      if (
        typeof callId !== "string"
        || memberValue(item, "output") === undefined
        || !calls.delete(callId)
      ) {
        throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
      }
      continue;
    }
    ordinary.push(item);
  }
  if (calls.size > 0) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  return { kind: "array", items: ordinary };
}

function assertExtendedToolKeys(tool: WireJsonObject, allowed: ReadonlySet<string>): void {
  if (tool.members.some((member) => !allowed.has(member.key))) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      source: "converter",
      phase: "convert",
    });
  }
}

function assertExtendedToolName(tool: WireJsonObject): void {
  const name = memberValue(tool, "name");
  if (typeof name !== "string" || name.length === 0) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
}

function validateExtendedFunctionTool(tool: WireJsonObject): WireJsonObject {
  assertExtendedToolKeys(tool, new Set(["type", "function", "name", "description", "parameters", "strict"]));
  const nested = memberValue(tool, "function");
  const shape = isWireJsonObject(nested) ? nested : tool;
  if (isWireJsonObject(nested)) {
    if (duplicateMemberNames(nested).length > 0) {
      throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
    }
    assertExtendedToolKeys(nested, new Set(["name", "description", "parameters", "strict"]));
  }
  assertExtendedToolName(shape);
  const description = memberValue(shape, "description");
  const parameters = memberValue(shape, "parameters");
  const strict = memberValue(shape, "strict");
  if (
    (description !== undefined && typeof description !== "string")
    || !isWireJsonObject(parameters)
    || duplicateMemberNames(parameters).length > 0
    || (strict !== undefined && typeof strict !== "boolean")
  ) {
    throw new GatewayFailureError({ kind: "invalid_request", source: "converter", phase: "convert" });
  }
  return shape;
}

function rejectExtendedInstructionReordering(input: WireJson | undefined): void {
  if (!isWireJsonArray(input)) {
    return;
  }
  let ordinarySeen = false;
  for (const item of input.items) {
    if (!isWireJsonObject(item) || memberValue(item, "type") !== "message") {
      ordinarySeen = true;
      continue;
    }
    const role = memberValue(item, "role");
    if (role === "system" || role === "developer") {
      if (ordinarySeen) {
        throw new GatewayFailureError({
          kind: "unsupported_semantics",
          source: "converter",
          phase: "convert",
        });
      }
    } else {
      ordinarySeen = true;
    }
  }
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
