import { AccountDirectoryError, type AccountDirectory, type BoundAccount } from "../../accounts/account_directory.js";
import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { CapiFetchError } from "../../copilot/models_source.js";
import { loadCapabilitySnapshot, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import {
  isModelCapabilityUnavailable,
  ModelCapabilityUnavailableError,
} from "../../copilot/model_capabilities.js";
import { parseChatSse } from "../../copilot/chat_sse.js";
import { TokenRefreshError } from "../../copilot/token_refresh.js";
import {
  classifyCopilotTransportError,
  mapTokenRefreshError,
} from "../../copilot/transport.js";
import { GatewayFailureError, type GatewayFailure } from "../../gateway/failures.js";
import type { RouteRegistration } from "../../gateway/hono_app.js";
import type { RequestScope } from "../../gateway/request_scope.js";
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
import type { TelemetryOutcome, TelemetryRecorder, UsageUpdate } from "../../telemetry/recorder.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import { encodeOpenAiChatDone, encodeOpenAiChatSseChunk, serializeOpenAiErrorBody } from "./wire.js";

export interface OpenAiChatRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry?: ModelCapabilityRegistry;
  readonly catalog?: CopilotModelCatalog;
  readonly preferences?: Pick<AccountModelPreferences, "get">;
  readonly copilot: CopilotBackend;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
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

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createOpenAiChatRoute(dependencies: OpenAiChatRouteDependencies): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: (failure, requestId) => {
      recordUsageSample(dependencies, {
        occurredAtMs: (dependencies.nowMs ?? Date.now)(),
        accountId: "unbound",
        protocol: "openai_chat",
        resolvedModel: "unresolved",
        outcome: telemetryOutcome(failure),
        requestCount: 1,
        errorCount: failure.kind === "aborted" ? 0 : 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        latencyMs: 0,
      });
      return presentOpenAiFailure(failure, requestId);
    },
    endpoint: async (request, scope) => {
      const startedAtMs = (dependencies.nowMs ?? Date.now)();
      if (request.body === undefined) {
        throw new GatewayFailureError({ kind: "invalid_request" });
      }

      const decoded = decodeOpenAiChatRequest(request.body);
      const account = await bindAccount(dependencies.directory, scope.signal);
      const preference = decoded.requestedModel === undefined
        ? (dependencies.preferences ?? dependencies.directory.preferences).get(account.accountId)
        : null;
      const catalog = await loadCatalog(dependencies, account, scope.signal);
      const resolved = resolveOpenAiChatModel(decoded, catalog, preference);
      if (resolved.capability.protocols.value?.includes("chat") !== true) {
        throw new GatewayFailureError({
          kind: "unsupported_semantics",
          cause: new ModelCapabilityUnavailableError(),
        });
      }
      const copilot = await bindCopilot(dependencies.copilot, account, scope);
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
          recordUsageSample(dependencies, {
            occurredAtMs: (dependencies.nowMs ?? Date.now)(),
            accountId: account.accountId,
            protocol: "openai_chat",
            resolvedModel: resolved.upstreamModel,
            outcome: "success",
            requestCount: 1,
            errorCount: 0,
            ...usageNumbers(usageObservationFromPayload(payload)),
            latencyMs: (dependencies.nowMs ?? Date.now)() - startedAtMs,
          });
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
        await upstream.cancel();
      }
      assertUpstreamSuccess(upstream.status, upstream.headers);

      const frames = parseChatSse(withBodyTimeouts(
        upstream.bytes,
        scope,
        scope.config.timeouts.firstByteMs,
        scope.config.timeouts.streamIdleMs,
        () => upstreamController.abort(new GatewayFailureError({ kind: "upstream_timeout" })),
      ), scope.config.limits.sseEventBytes);
      let first: ChatStreamFrame;
      try {
        first = await firstFrameWithTimeout(scope, frames, scope.config.timeouts.firstByteMs, () => {
          upstreamController.abort(new GatewayFailureError({ kind: "upstream_timeout" }));
        });
      } catch (error: unknown) {
        upstreamController.abort();
        await upstream.cancel();
        void frames.return(undefined).catch(() => undefined);
        throw error;
      }
      if (first.kind === "error") {
        upstreamController.abort();
        await upstream.cancel();
        void frames.return(undefined).catch(() => undefined);
        throw new GatewayFailureError({ kind: "invalid_upstream_response" });
      }

      return openAiChatStreamResponse({
        status: upstream.status,
        signal: scope.signal,
        requestId: scope.requestId,
        first,
        frames,
        scope,
        abortUpstream,
        releaseUpstreamAbort: () => scope.signal.removeEventListener("abort", abortUpstream),
        dependencies,
        accountId: account.accountId,
        resolvedModel: resolved.upstreamModel,
        startedAtMs,
      });
    },
  };
}

function telemetryOutcome(failure: Readonly<GatewayFailure>): TelemetryOutcome {
  switch (failure.kind) {
  case "invalid_request":
  case "body_too_large":
  case "unsupported_media_type":
  case "unsupported_semantics":
  case "model_not_found":
    return "client_error";
  case "authentication":
  case "permission":
    return "authentication_error";
  case "queue_full":
  case "queue_timeout":
    return "overloaded";
  case "upstream_timeout":
    return "timeout";
  case "aborted":
    return "aborted";
  case "upstream_http":
  case "upstream_network":
  case "upstream_stream_error":
  case "upstream_stream_truncated":
  case "invalid_upstream_response":
  case "invalid_tool_arguments":
  case "invalid_logprobs":
    return "upstream_error";
  case "internal":
    return "internal_error";
  }
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
    if (error instanceof AccountDirectoryError && (error.code === "no_default" || error.code === "not_found")) {
      throw new GatewayFailureError({ kind: "authentication" });
    }
    throw error;
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
    if (error instanceof CapiFetchError) {
      const retry = validRetryAfterValue(error.retryAfter);
      if (error.failureKind === "upstream_timeout") {
        throw new GatewayFailureError({ kind: "upstream_network", cause: error });
      }
      if (error.failureKind === "upstream_network") {
        throw new GatewayFailureError({ kind: "upstream_network", cause: error });
      }
      if (error.failureKind === "invalid_upstream_response") {
        throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
      }
      throw new GatewayFailureError({
        kind: "upstream_http",
        status: error.status,
        ...(retry === undefined ? {} : { retryAfter: retry }),
      });
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayFailureError({ kind: "aborted" });
    }
    if (error instanceof TypeError) {
      throw new GatewayFailureError({ kind: "upstream_network", cause: error });
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

async function completeChat(
  copilot: BoundCopilot,
  request: Readonly<ChatRequest>,
) {
  try {
    return await copilot.completeChat(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error);
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
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    if (error instanceof TokenRefreshError) {
      throw new GatewayFailureError({ kind: mapTokenRefreshError(error), cause: error });
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayFailureError({ kind: "aborted" });
    }
    throw new GatewayFailureError({ kind: "upstream_network", cause: error });
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
    rejectTimeout(new GatewayFailureError({ kind: "aborted" }));
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
    throw upstreamCallFailure(error);
  }
}

function upstreamCallFailure(error: unknown): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  const kind = classifyCopilotTransportError(error);
  if (kind === "aborted") {
    return new GatewayFailureError({ kind });
  }
  return new GatewayFailureError({ kind, cause: error });
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
  return validRetryAfterValue(headers.get("retry-after") ?? undefined);
}

function validRetryAfterValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return value;
  }
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return undefined;
}

async function nextFrame(frames: AsyncGenerator<ChatStreamFrame>): Promise<ChatStreamFrame> {
  try {
    const next = await frames.next();
    if (next.done === true) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return next.value;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

async function firstFrameWithTimeout(
  scope: Readonly<RequestScope>,
  frames: AsyncGenerator<ChatStreamFrame>,
  ms: number,
  onTimeout: () => void,
): Promise<ChatStreamFrame> {
  let timedOut = false;
  let clear = (): void => undefined;
  const timeout = new Promise<ChatStreamFrame>((_resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new GatewayFailureError({ kind: "upstream_timeout" }));
    }, ms);
    const onAbort = (): void => reject(new GatewayFailureError({ kind: "aborted" }));
    scope.signal.addEventListener("abort", onAbort, { once: true });
    clear = () => {
      clearTimeout(timer);
      scope.signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([nextFrame(frames), timeout]);
  } catch (error: unknown) {
    if (timedOut) {
      onTimeout();
      void frames.return(undefined).catch(() => undefined);
    }
    throw error;
  } finally {
    clear();
  }
}

async function* withBodyTimeouts(
  bytes: AsyncIterable<Uint8Array>,
  scope: Readonly<RequestScope>,
  firstByteMs: number,
  idleMs: number,
  onTimeout: () => void,
): AsyncIterable<Uint8Array> {
  const iterator = bytes[Symbol.asyncIterator]();
  let seenBytes = false;
  try {
    for (;;) {
      const timeout = bodyTimeout(seenBytes ? idleMs : firstByteMs, scope.signal);
      let next: IteratorResult<Uint8Array>;
      try {
        next = await Promise.race([
          iterator.next(),
          timeout.promise,
        ]);
      } finally {
        timeout.clear();
      }
      if (next.done === true) {
        return;
      }
      seenBytes = true;
      yield next.value;
    }
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError && error.failure.kind === "upstream_timeout") {
      onTimeout();
      void iterator.return?.().catch(() => undefined);
    }
    throw error;
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
}

function bodyTimeout(ms: number, signal: AbortSignal): {
  readonly promise: Promise<IteratorResult<Uint8Array>>;
  readonly clear: () => void;
} {
  let clear = (): void => undefined;
  const promise = new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new GatewayFailureError({ kind: "aborted" }));
      return;
    }
    const timer = setTimeout(() => reject(new GatewayFailureError({ kind: "upstream_timeout" })), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GatewayFailureError({ kind: "aborted" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });
  return { promise, clear };
}

function openAiChatStreamResponse(input: {
  readonly status: number;
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly first: ChatStreamFrame;
  readonly frames: AsyncGenerator<ChatStreamFrame>;
  readonly scope: Readonly<RequestScope>;
  readonly abortUpstream: () => void;
  readonly releaseUpstreamAbort: () => void;
  readonly dependencies: OpenAiChatRouteDependencies;
  readonly accountId: string;
  readonly resolvedModel: string;
  readonly startedAtMs: number;
}): Response {
  let pending: ChatStreamFrame | undefined = input.first;
  let closed = false;
  let usage: ChatUsageObservation = {};
  const closeFrames = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    input.releaseUpstreamAbort();
    void input.frames.return(undefined).catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (input.signal.aborted) {
        closeFrames();
        controller.close();
        return;
      }
      try {
        const frame = pending ?? await nextFrame(input.frames);
        pending = undefined;
        if (frame.kind === "chunk") {
          measure(input.dependencies.performanceObserver, "event", () => {
            usage = mergeUsageObservation(usage, usageObservationFromPayload(frame.chunk.payload));
            controller.enqueue(encodeOpenAiChatSseChunk(frame.chunk.payload));
          });
          return;
        }
        if (frame.kind === "done") {
          measure(input.dependencies.performanceObserver, "event", () => controller.enqueue(encodeOpenAiChatDone()));
          recordUsageSample(input.dependencies, {
            occurredAtMs: (input.dependencies.nowMs ?? Date.now)(),
            accountId: input.accountId,
            protocol: "openai_chat",
            resolvedModel: input.resolvedModel,
            outcome: "success",
            requestCount: 1,
            errorCount: 0,
            ...usageNumbers(usage),
            latencyMs: (input.dependencies.nowMs ?? Date.now)() - input.startedAtMs,
          });
          closeFrames();
          controller.close();
          return;
        }
        closeFrames();
        controller.error(new Error("upstream stream error"));
      } catch (_error) {
        closeFrames();
        controller.error(new Error("upstream stream error"));
      }
    },
    cancel(): void {
      closeFrames();
    },
  });
  input.signal.addEventListener("abort", () => {
    closeFrames();
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

function recordUsageSample(dependencies: OpenAiChatRouteDependencies, update: UsageUpdate): void {
  try {
    dependencies.usageRecorder?.recordUsage(update);
  } catch (_error) {
    // Telemetry is noncritical and must not change protocol bytes.
  }
}

function measure<T>(
  observer: ProtocolPerformanceObserver | undefined,
  measurement: "buffered" | "event",
  work: () => T,
): T {
  return observer === undefined ? work() : observer.measure(measurement, work);
}

function presentOpenAiFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const status = statusForFailure(failure);
  const headers = new Headers({ ...JSON_HEADERS, "x-request-id": requestId });
  if (failure.kind === "upstream_http" && failure.status === 429 && failure.retryAfter !== undefined) {
    headers.set("retry-after", failure.retryAfter);
  }
  return new Response(serializeOpenAiErrorBody(messageForFailure(failure), errorTypeForStatus(status)), {
    status,
    headers,
  });
}

function statusForFailure(failure: Readonly<GatewayFailure>): number {
  switch (failure.kind) {
  case "invalid_request":
    return 400;
  case "body_too_large":
    return 413;
  case "unsupported_media_type":
    return 415;
  case "unsupported_semantics":
    return 422;
  case "authentication":
    return 401;
  case "permission":
    return 403;
  case "model_not_found":
    return 404;
  case "queue_full":
  case "queue_timeout":
    return 503;
  case "upstream_network":
  case "upstream_stream_error":
  case "upstream_stream_truncated":
  case "invalid_upstream_response":
  case "invalid_tool_arguments":
  case "invalid_logprobs":
    return 502;
  case "upstream_timeout":
    return 504;
  case "upstream_http":
    return failure.status;
  case "internal":
  case "aborted":
    return 500;
  }
}

function messageForFailure(failure: Readonly<GatewayFailure>): string {
  switch (failure.kind) {
  case "invalid_request":
    return "invalid request";
  case "body_too_large":
    return "request body too large";
  case "unsupported_media_type":
    return "unsupported media type";
  case "unsupported_semantics":
    return isModelCapabilityUnavailable(failure.cause)
      ? "model native protocol capability is not configured"
      : "unsupported semantics";
  case "authentication":
    return "authentication failed";
  case "permission":
    return "permission denied";
  case "model_not_found":
    return "model not found";
  case "queue_full":
  case "queue_timeout":
    return "server overloaded";
  case "upstream_timeout":
    return "upstream timeout";
  case "invalid_upstream_response":
  case "upstream_stream_error":
  case "upstream_stream_truncated":
  case "invalid_tool_arguments":
  case "invalid_logprobs":
    return "invalid upstream response";
  case "upstream_http":
  case "upstream_network":
    return "upstream request failed";
  case "internal":
  case "aborted":
    return "internal error";
  }
}

function errorTypeForStatus(status: number): string {
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 403) {
    return "permission_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status === 400 || status === 409 || status === 413 || status === 415 || status === 422) {
    return "invalid_request_error";
  }
  return "api_error";
}
