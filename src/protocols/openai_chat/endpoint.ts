import type { AccountDirectory, BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { loadCapabilitySnapshot, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import { parseChatSse } from "../../copilot/chat_sse.js";
import {
  normalizeAccountBindingFailure,
  normalizeCatalogFailure,
  normalizeChatStreamFailure,
  normalizeCopilotBindingFailure,
  normalizeTransportFailure,
  upstreamStreamEventFailure,
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
  createExchangeCancellation,
  createOwnedStreamCleanup,
  withByteIdleDeadlines,
} from "../../gateway/stream_execution.js";
import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { resolveModel, type ResolvedModel } from "../model_catalog/resolver.js";
import type { ChatRequest, ChatStreamFrame } from "../chat_completions/types.js";
import { readThroughFirstSemanticChatFrame } from "../chat_completions/stream_semantics.js";
import type { TelemetryRecorder, UsageUpdate } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { encodeOpenAiChatDone, encodeOpenAiChatSseChunk } from "./wire.js";
import { presentOpenAiChatFailure } from "./failure_presenter.js";
import { planProtocolExecution } from "../conversion/planner.js";
import { completeConvertedOperation, openConvertedOperation } from "../conversion/operation.js";
import { convertBufferedResponse } from "../conversion/buffered.js";
import type { ConvertedProtocolPlan, SemanticUsage } from "../conversion/types.js";

export interface OpenAiChatRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry?: ModelCapabilityRegistry;
  readonly catalog?: CopilotModelCatalog;
  readonly preferences?: Pick<AccountModelPreferences, "get">;
  readonly copilot: CopilotBackend;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
  readonly createUuid?: () => string;
}

interface DecodedOpenAiChatRequest {
  readonly body: WireJsonObject;
  readonly requestedModel?: string;
  readonly stream: boolean;
}

interface PreparedOpenAiChatRequest {
  readonly body: WireJsonObject;
  readonly bytes: Uint8Array;
  readonly stream: boolean;
  readonly hasVisionInput: boolean;
  readonly resolvedModel: string;
}

export function createOpenAiChatRoute(dependencies: OpenAiChatRouteDependencies): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentOpenAiChatFailure,
    createAttempt: (requestId, config) => createRequestAttempt({
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

      const decoded = decodeOpenAiChatRequest(request.body);
      if (decoded.requestedModel !== undefined) {
        usage.setRequestedModel(decoded.requestedModel);
      }
      const account = await bindAccount(dependencies.directory, scope.signal);
      usage.setAccount(account.accountId);
      const preference = decoded.requestedModel === undefined
        ? (dependencies.preferences ?? dependencies.directory.preferences).get(account.accountId)
        : null;
      const catalog = await loadCatalog(dependencies, account, scope.signal);
      const resolved = resolveOpenAiChatModel(decoded, catalog, preference);
      usage.setResolvedModel(resolved.upstreamModel);
      const plan = planProtocolExecution({
        source: "chat",
        body: decoded.body,
        stream: decoded.stream,
        capability: resolved.capability,
        resolvedModel: resolved.upstreamModel,
      });
      const copilot = await bindCopilot(dependencies.copilot, account, scope);
      if (plan.kind === "converted") {
        return await executeConvertedChat(dependencies, copilot, plan, scope, usage);
      }
      const prepared = prepareOpenAiChatRequest(decoded, resolved);

      if (!prepared.stream) {
        const upstream = await completeChat(copilot, {
          model: prepared.resolvedModel,
          body: prepared.bytes,
          stream: false,
          hasVisionInput: prepared.hasVisionInput,
          nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
          connectTimeoutMs: scope.config.timeouts.connectMs,
          firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
          signal: scope.signal,
        });
        assertUpstreamSuccess(upstream.status, upstream.headers);
        if (upstream.body.byteLength > scope.config.limits.nonstreamBodyBytes) {
          throw new GatewayFailureError({ kind: "invalid_upstream_response" });
        }

        return measure(dependencies.performanceObserver, "buffered", () => {
          const payload = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
          usage.success(usageNumbers(usageObservationFromPayload(payload)));
          return new Response(Buffer.from(serializeWireJson(payload)), {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "x-request-id": scope.requestId,
            },
          });
        });
      }

      const upstreamController = new AbortController();
      const abortUpstream = (): void => upstreamController.abort();
      scope.signal.addEventListener("abort", abortUpstream, { once: true });
      const upstream = await openChatStream(copilot, {
        model: prepared.resolvedModel,
        body: prepared.bytes,
        stream: true,
        hasVisionInput: prepared.hasVisionInput,
        nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
        connectTimeoutMs: scope.config.timeouts.connectMs,
        firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
        signal: upstreamController.signal,
      });
      if (upstream.status < 200 || upstream.status >= 300) {
        await boundedCleanup(upstream.cancel());
      }
      assertUpstreamSuccess(upstream.status, upstream.headers);

      const cancelExchange = createExchangeCancellation(upstream);
      const frames = parseChatSse(withByteIdleDeadlines(
        upstream.bytes,
        scope.signal,
        scope.config.timeouts.firstByteMs,
        scope.config.timeouts.streamIdleMs,
        cancelExchange,
      ), scope.config.limits.sseEventBytes);
      const cleanupUpstream = createOwnedStreamCleanup(upstream, frames, 1_000, cancelExchange);
      let firstFrames: readonly ChatStreamFrame[];
      try {
        firstFrames = await readThroughFirstSemanticChatFrame(
          frames,
          scope.signal,
          scope.config.timeouts.firstByteMs,
        );
      } catch (error: unknown) {
        const failure = normalizeChatStreamFailure(error, scope.signal);
        if (failure.failure.kind === "upstream_timeout") {
          upstreamController.abort(failure);
        }
        upstreamController.abort();
        await cleanupUpstream();
        throw failure;
      }
      if (firstFrames.at(-1)?.kind === "error") {
        upstreamController.abort();
        await cleanupUpstream();
        throw upstreamStreamEventFailure();
      }

      return openAiChatStreamResponse({
        status: upstream.status,
        signal: scope.signal,
        requestId: scope.requestId,
        firstFrames,
        frames,
        cleanupUpstream,
        scope,
        abortUpstream,
        releaseUpstreamAbort: () => scope.signal.removeEventListener("abort", abortUpstream),
        dependencies,
        usage,
      });
    },
  };
}

async function executeConvertedChat(
  dependencies: OpenAiChatRouteDependencies,
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

export function decodeOpenAiChatRequest(body: WireJsonObject): DecodedOpenAiChatRequest {
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

export function prepareOpenAiChatRequest(
  decoded: DecodedOpenAiChatRequest,
  resolved: ResolvedModel,
): PreparedOpenAiChatRequest {
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

function resolveOpenAiChatModel(
  decoded: DecodedOpenAiChatRequest,
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
  dependencies: Pick<OpenAiChatRouteDependencies, "registry" | "catalog">,
  account: Readonly<BoundAccount>,
  signal: AbortSignal,
) {
  try {
    return await loadCapabilitySnapshot(dependencies, account, signal);
  } catch (error: unknown) {
    throw normalizeCatalogFailure(error, signal);
  }
}

async function completeChat(
  copilot: BoundCopilot,
  request: Readonly<ChatRequest>,
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
  request: Readonly<ChatRequest>,
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

function parseUpstreamObject(body: Uint8Array, maxBytes: number): WireJsonObject {
  try {
    const payload = parseWireJson(body, {
      maxBytes,
      maxDepth: 64,
    });
    if (!isWireJsonObject(payload)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return payload;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
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

async function nextFrame(frames: AsyncGenerator<ChatStreamFrame>, signal: AbortSignal): Promise<ChatStreamFrame> {
  try {
    const next = await frames.next();
    if (next.done === true) {
      throw new GatewayFailureError({
        kind: "upstream_stream_truncated",
        source: "parser",
        phase: "stream",
      });
    }
    return next.value;
  } catch (error: unknown) {
    throw normalizeChatStreamFailure(error, signal);
  }
}

function openAiChatStreamResponse(input: {
  readonly status: number;
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly firstFrames: readonly ChatStreamFrame[];
  readonly frames: AsyncGenerator<ChatStreamFrame>;
  readonly cleanupUpstream: () => Promise<void>;
  readonly scope: Readonly<RequestScope>;
  readonly abortUpstream: () => void;
  readonly releaseUpstreamAbort: () => void;
  readonly dependencies: OpenAiChatRouteDependencies;
  readonly usage: RequestAttempt;
}): Response {
  const pending = [...input.firstFrames];
  let closed = false;
  let usage: ChatUsageObservation = {};
  const closeFrames = async (): Promise<void> => {
    if (closed) {
      await input.cleanupUpstream();
      return;
    }
    closed = true;
    input.releaseUpstreamAbort();
    await input.cleanupUpstream();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (input.signal.aborted) {
        await closeFrames();
        controller.close();
        return;
      }
      try {
        const frame = pending.shift() ?? await nextFrame(input.frames, input.signal);
        if (frame.kind === "chunk") {
          measure(input.dependencies.performanceObserver, "event", () => {
            usage = mergeUsageObservation(usage, usageObservationFromPayload(frame.chunk.payload));
            input.usage.observeUsage(usageNumbers(usage));
            controller.enqueue(encodeOpenAiChatSseChunk(frame.chunk.payload));
          });
          return;
        }
        if (frame.kind === "done") {
          measure(input.dependencies.performanceObserver, "event", () => controller.enqueue(encodeOpenAiChatDone()));
          input.usage.success(usageNumbers(usage));
          await closeFrames();
          controller.close();
          return;
        }
        input.usage.failure(upstreamStreamEventFailure());
        await closeFrames();
        controller.error(new Error("upstream stream error", { cause: upstreamStreamEventFailure() }));
      } catch (error: unknown) {
        input.usage.failure(normalizeChatStreamFailure(error, input.signal));
        await closeFrames();
        controller.error(new Error("upstream stream error", {
          cause: normalizeChatStreamFailure(error, input.signal),
        }));
      }
    },
    async cancel(): Promise<void> {
      await closeFrames();
    },
  });
  input.signal.addEventListener("abort", () => {
    void closeFrames();
  }, { once: true });
  return new Response(stream, {
    status: input.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-request-id": input.requestId,
    },
  });
}

interface ChatUsageObservation {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
}

function usageObservationFromPayload(value: WireJson): ChatUsageObservation {
  if (!isWireJsonObject(value)) {
    return {};
  }
  const usage = memberValues(value, "usage")[0];
  if (memberValues(value, "usage").length !== 1) {
    return {};
  }
  if (!isWireJsonObject(usage)) {
    return {};
  }
  const promptTokens = nonnegativeInteger(singleMemberValue(usage, "prompt_tokens"));
  const completionTokens = nonnegativeInteger(singleMemberValue(usage, "completion_tokens"));
  const details = singleMemberValue(usage, "prompt_tokens_details");
  const cachedTokens = isWireJsonObject(details) && memberValues(details, "cached_tokens").length === 1
    ? nonnegativeInteger(singleMemberValue(details, "cached_tokens"))
    : undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

function singleMemberValue(object: WireJsonObject, key: string): WireJson | undefined {
  const values = memberValues(object, key);
  return values.length === 1 ? values[0] : undefined;
}

function nonnegativeInteger(value: WireJson | undefined): number | undefined {
  if (value === undefined || typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "number") {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return undefined;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function mergeUsageObservation(left: ChatUsageObservation, right: ChatUsageObservation): ChatUsageObservation {
  return {
    ...((right.promptTokens ?? left.promptTokens) === undefined ? {} : { promptTokens: right.promptTokens ?? left.promptTokens }),
    ...((right.completionTokens ?? left.completionTokens) === undefined ? {} : { completionTokens: right.completionTokens ?? left.completionTokens }),
    ...((right.cachedTokens ?? left.cachedTokens) === undefined ? {} : { cachedTokens: right.cachedTokens ?? left.cachedTokens }),
  };
}

function usageNumbers(observation: ChatUsageObservation): Pick<UsageUpdate, "inputTokens" | "outputTokens" | "cacheTokens"> {
  return {
    inputTokens: observation.promptTokens ?? 0,
    outputTokens: observation.completionTokens ?? 0,
    cacheTokens: observation.cachedTokens ?? 0,
  };
}

function measure<T>(
  observer: ProtocolPerformanceObserver | undefined,
  measurement: "buffered" | "event",
  work: () => T,
): T {
  return observer === undefined ? work() : observer.measure(measurement, work);
}
