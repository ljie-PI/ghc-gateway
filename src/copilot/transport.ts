import type { IncomingHttpHeaders } from "node:http";
import type * as Undici from "undici";
import type { Dispatcher } from "undici";
import type { BoundAccount } from "../accounts/account_directory.js";
import type { CredentialStore } from "../accounts/credential_store.js";
import type { ChatResponse } from "../protocols/chat_completions/types.js";
import { type EndpointDiscovery, MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";
import {
  BoundedInferencePoolRegistry,
  DEFAULT_INFERENCE_POOL_LIMITS,
  InferencePoolAcquireTimeoutError,
  type InferenceConnectionProfile,
  type InferencePoolInspection,
  type InferencePoolLimits,
} from "./inference_pool.js";
import { outboundHeaders } from "./backend.js";
import type { TokenRefreshError } from "./token_refresh.js";
import { getValidToken } from "./token_refresh.js";
import type { BoundCopilot, CopilotBackend, CopilotTarget } from "./backend.js";
import type {
  MessagesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "./upstream_types.js";

type UndiciModule = typeof Undici;

let undiciModulePromise: Promise<UndiciModule> | undefined;

function loadUndici(): Promise<UndiciModule> {
  undiciModulePromise ??= import("undici");
  return undiciModulePromise;
}

export class UpstreamBodyLimitError extends Error {
  constructor() {
    super("upstream response body exceeds limit");
    this.name = "UpstreamBodyLimitError";
  }
}

export class UpstreamTimeoutError extends Error {
  constructor() {
    super("upstream timeout");
    this.name = "UpstreamTimeoutError";
  }
}

export class InvalidUpstreamResponseError extends Error {
  constructor() {
    super("invalid upstream response");
    this.name = "InvalidUpstreamResponseError";
  }
}

export type CopilotTransportFailureKind =
  | "aborted"
  | "invalid_upstream_response"
  | "upstream_timeout"
  | "upstream_network";

export function classifyCopilotTransportError(error: unknown): CopilotTransportFailureKind {
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }
  if (error instanceof UpstreamBodyLimitError || error instanceof InvalidUpstreamResponseError) {
    return "invalid_upstream_response";
  }
  if (error instanceof UpstreamTimeoutError) {
    return "upstream_timeout";
  }
  return "upstream_network";
}

export interface CopilotTransportDeps {
  readonly credentials: CredentialStore;
  readonly nowMs?: () => number;
  readonly refreshCopilotToken: (githubToken: string, signal?: AbortSignal) => Promise<{ token: string; expiresAtMs: number }>;
  readonly endpointDiscovery: Pick<EndpointDiscovery, "discover">;
  readonly fetchImpl?: typeof fetch;
  readonly poolLimits?: InferencePoolLimits;
  readonly createDispatcher?: (
    profile: InferenceConnectionProfile,
    limits: InferencePoolLimits,
  ) => Dispatcher | Promise<Dispatcher>;
}

export interface HttpCopilotBackendInspection {
  readonly closed: boolean;
  readonly responseLeases: number;
  readonly pools: InferencePoolInspection;
}

export class HttpCopilotBackend implements CopilotBackend {
  private readonly pools: BoundedInferencePoolRegistry;
  private readonly responseLeases = new Set<OwnedResponseLease>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly deps: CopilotTransportDeps) {
    this.pools = new BoundedInferencePoolRegistry(
      deps.createDispatcher ?? createInferenceDispatcher,
      deps.poolLimits ?? DEFAULT_INFERENCE_POOL_LIMITS,
    );
  }

  async bind(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<BoundCopilot> {
    if (this.closed) {
      throw closedError();
    }
    const nowMs = this.deps.nowMs ?? Date.now;
    const token = await getValidToken(
      this.deps.credentials,
      account,
      nowMs(),
      this.deps.refreshCopilotToken,
      signal,
    );
    const discovered = await this.deps.endpointDiscovery.discover(account, signal);
    if (this.closed) {
      throw closedError();
    }
    const target: CopilotTarget = { endpoint: discovered.endpoint, token };
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return {
      accountId: account.accountId,
      target,
      completeChat: (request) => this.completeJson(
        `${target.endpoint}/chat/completions`,
        target.token,
        request.body,
        request.signal,
        fetchImpl,
        request.nonstreamBodyBytes,
        request.connectTimeoutMs,
        request.firstByteTimeoutMs,
        chatExtraHeaders(request.hasVisionInput),
      ),
      openChatStream: (request) => this.openStream(
        `${target.endpoint}/chat/completions`,
        target.token,
        request.body,
        request.signal,
        fetchImpl,
        request.connectTimeoutMs,
        request.firstByteTimeoutMs,
        chatExtraHeaders(request.hasVisionInput),
      ),
      completeResponses: (request) => this.completeJson(
        responsesUrl(target.endpoint),
        target.token,
        request.body,
        request.signal,
        fetchImpl,
        request.nonstreamBodyBytes,
        request.connectTimeoutMs,
        request.firstByteTimeoutMs,
        responsesExtraHeaders(request),
      ),
      openResponsesStream: (request) => this.openStream(
        responsesUrl(target.endpoint),
        target.token,
        request.body,
        request.signal,
        fetchImpl,
        request.connectTimeoutMs,
        request.firstByteTimeoutMs,
        responsesExtraHeaders(request),
      ),
      completeMessages: (request) => this.completeJson(
        messagesUrl(target.endpoint),
        target.token,
        request.body,
        request.signal,
        fetchImpl,
        request.nonstreamBodyBytes,
        request.connectTimeoutMs,
        request.firstByteTimeoutMs,
        messagesExtraHeaders(request),
      ),
      openMessagesStream: (request) => this.openStream(
        messagesUrl(target.endpoint),
        target.token,
        request.body,
        request.signal,
        fetchImpl,
        request.connectTimeoutMs,
        request.firstByteTimeoutMs,
        messagesExtraHeaders(request),
      ),
    };
  }

  inspect(): HttpCopilotBackendInspection {
    return {
      closed: this.closed,
      responseLeases: this.responseLeases.size,
      pools: this.pools.inspect(),
    };
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeBackend();
    return await this.closePromise;
  }

  private async closeBackend(): Promise<void> {
    if (this.closed && this.responseLeases.size === 0) {
      await this.pools.close();
      return;
    }
    this.closed = true;
    const leaseResults = await Promise.allSettled([...this.responseLeases].map(async (lease) => lease.cancel()));
    await this.pools.close();
    const errors = leaseResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to release upstream responses");
    }
  }

  forceClose(): void {
    this.closed = true;
    for (const lease of this.responseLeases) {
      lease.forceCancel();
    }
    this.pools.forceClose();
  }

  private async completeJson(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    maxBodyBytes: number | undefined,
    connectTimeoutMs: number | undefined,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<ChatResponse & UpstreamByteResponse> {
    const response = await this.exchange(
      url,
      token,
      body,
      signal,
      fetchImpl,
      connectTimeoutMs,
      firstByteTimeoutMs,
      extraHeaders,
    );
    if (response.status < 200 || response.status >= 300) {
      await response.cancel();
      return { status: response.status, headers: response.headers, body: new Uint8Array() };
    }
    try {
      const bytes = await readResponseBody(response.bytes, maxBodyBytes, firstByteTimeoutMs, signal);
      return { status: response.status, headers: response.headers, body: bytes };
    } catch (error: unknown) {
      await response.cancel();
      throw error;
    }
  }

  private async openStream(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    connectTimeoutMs: number | undefined,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<UpstreamByteStream> {
    const response = await this.exchange(
      url,
      token,
      body,
      signal,
      fetchImpl,
      connectTimeoutMs,
      firstByteTimeoutMs,
      extraHeaders,
    );
    if (response.status < 200 || response.status >= 300) {
      await response.cancel();
    }
    return response;
  }

  private async exchange(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    connectTimeoutMs: number | undefined,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<OwnedResponseLease> {
    if (this.closed) {
      throw closedError();
    }
    const createLease = (
      status: number,
      headers: Headers,
      source: AsyncIterable<Uint8Array>,
      cancelExchange: () => Promise<void>,
      releasePool: () => void = () => undefined,
    ): OwnedResponseLease => {
      const lease = new OwnedResponseLease(status, headers, source, cancelExchange, () => {
        releasePool();
        this.responseLeases.delete(lease);
      });
      this.responseLeases.add(lease);
      if (this.closed) {
        lease.forceCancel();
        throw closedError();
      }
      return lease;
    };
    return fetchImpl === fetch
      ? await undiciWithRedirects(
        this.pools,
        createLease,
        url,
        token,
        body,
        signal,
        connectTimeoutMs,
        firstByteTimeoutMs,
        extraHeaders,
      )
      : await fetchWithRedirects(
        fetchImpl,
        createLease,
        url,
        token,
        body,
        signal,
        connectTimeoutMs,
        firstByteTimeoutMs,
        extraHeaders,
      );
  }
}

type LeaseFactory = (
  status: number,
  headers: Headers,
  source: AsyncIterable<Uint8Array>,
  cancelExchange: () => Promise<void>,
  releasePool?: () => void,
) => OwnedResponseLease;

interface UndiciBody extends AsyncIterable<Uint8Array | Buffer | string> {
  once?(event: "error", listener: (error: Error) => void): unknown;
  destroy(error?: Error): void;
}

class OwnedResponseLease implements UpstreamByteStream {
  readonly bytes: AsyncIterable<Uint8Array>;
  private iterator: AsyncIterator<Uint8Array> | undefined;
  private iterationStarted = false;
  private released = false;
  private exchangeCanceled = false;

  constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly source: AsyncIterable<Uint8Array>,
    private readonly cancelExchange: () => Promise<void>,
    private readonly onRelease: () => void,
  ) {
    this.bytes = {
      [Symbol.asyncIterator]: () => this.iterate(),
    };
  }

  async cancel(): Promise<void> {
    if (this.released) {
      return;
    }
    let cancellationError: unknown;
    try {
      await boundedOperation(this.cancelOwnedExchange(), 1_000);
    } catch (error: unknown) {
      cancellationError = error;
    }
    const iterator = this.iterator;
    if (iterator?.return !== undefined) {
      try {
        await boundedIteratorReturn(iterator, 1_000);
      } catch (error: unknown) {
        cancellationError ??= error;
      }
    }
    this.release();
    if (cancellationError !== undefined) {
      throw cancellationError;
    }
  }

  forceCancel(): void {
    if (this.released) {
      return;
    }
    this.exchangeCanceled = true;
    void this.cancelExchange().catch(() => undefined);
    void this.iterator?.return?.().catch(() => undefined);
    this.release();
  }

  private async *iterate(): AsyncGenerator<Uint8Array> {
    if (this.iterationStarted) {
      throw new Error("upstream response body is single-use");
    }
    this.iterationStarted = true;
    if (this.released) {
      return;
    }
    const iterator = this.source[Symbol.asyncIterator]();
    this.iterator = iterator;
    let completed = false;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          completed = true;
          return;
        }
        yield next.value;
      }
    } finally {
      if (completed) {
        this.release();
      } else {
        await this.cancel();
      }
    }
  }

  private async cancelOwnedExchange(): Promise<void> {
    if (this.exchangeCanceled) {
      return;
    }
    this.exchangeCanceled = true;
    await this.cancelExchange();
  }

  private release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.iterator = undefined;
    this.onRelease();
  }
}

async function fetchWithRedirects(
  fetchImpl: typeof fetch,
  createLease: LeaseFactory,
  url: string,
  token: string,
  body: Uint8Array,
  signal: AbortSignal,
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
  extraHeaders?: Headers,
): Promise<OwnedResponseLease> {
  let current = url;
  let headers = outboundHeaders(token, extraHeaders);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const timeout = responseStartTimeout(connectTimeoutMs, firstByteTimeoutMs);
    const fetchSignal = timeout === undefined ? signal : AbortSignal.any([signal, timeout.signal]);
    const fetchPromise = fetchImpl(current, {
      method: "POST",
      headers,
      body: Buffer.from(body),
      signal: fetchSignal,
      redirect: "manual",
    });
    let response: Response;
    try {
      response = await (timeout === undefined
        ? fetchPromise
        : Promise.race([fetchPromise, timeout.promise]));
    } catch (error: unknown) {
      void fetchPromise.then(async (late) => cancelResponseBody(late)).catch(() => undefined);
      if (timeout?.timedOut() === true || error instanceof UpstreamTimeoutError) {
        throw new UpstreamTimeoutError();
      }
      throw error;
    } finally {
      timeout?.clear();
    }
    const wrapped = wrapFetchResponse(response, createLease);
    if (response.status < 300 || response.status >= 400) {
      return wrapped;
    }
    const location = response.headers.get("location");
    if (location === null) {
      return wrapped;
    }
    await wrapped.cancel();
    if (attempt === MAX_REDIRECTS) {
      throw new InvalidUpstreamResponseError();
    }
    const next = safeRedirectTarget(location, current);
    headers = stripSecretsOnRedirect(current, next, headers);
    current = next;
  }
  throw new InvalidUpstreamResponseError();
}

async function undiciWithRedirects(
  pools: BoundedInferencePoolRegistry,
  createLease: LeaseFactory,
  url: string,
  token: string,
  body: Uint8Array,
  signal: AbortSignal,
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
  extraHeaders?: Headers,
): Promise<OwnedResponseLease> {
  const { errors: undiciErrors, request: undiciRequest } = await loadUndici();
  let current = url;
  let headers = outboundHeaders(token, extraHeaders);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    let dispatcherLease;
    try {
      dispatcherLease = await pools.acquire(
        canonicalOrigin(current),
        connectTimeoutMs ?? 30_000,
        signal,
        minimumTimeout(connectTimeoutMs, firstByteTimeoutMs),
      );
    } catch (error: unknown) {
      if (error instanceof InferencePoolAcquireTimeoutError) {
        throw new UpstreamTimeoutError();
      }
      throw error;
    }
    const releasePool = once(dispatcherLease.release);
    const requestPromise = undiciRequest(current, {
      method: "POST",
      headers: headersToRecord(headers),
      body: Buffer.from(body),
      signal,
      dispatcher: dispatcherLease.dispatcher,
      ...(firstByteTimeoutMs === undefined ? {} : { headersTimeout: firstByteTimeoutMs }),
      bodyTimeout: 0,
    });
    let response: Awaited<ReturnType<UndiciModule["request"]>>;
    try {
      response = await requestPromise;
    } catch (error: unknown) {
      releasePool();
      void requestPromise.then((late) => {
        destroyUndiciBody(late.body);
        releasePool();
      }).catch(() => undefined);
      if (isUndiciTimeout(error, undiciErrors)) {
        throw new UpstreamTimeoutError();
      }
      throw error;
    }
    const responseHeaders = incomingHeadersToHeaders(response.headers);
    const wrapped = createLease(
      response.statusCode,
      responseHeaders,
      undiciBody(response.body as UndiciBody),
      async () => destroyUndiciBody(response.body),
      releasePool,
    );
    if (response.statusCode < 300 || response.statusCode >= 400) {
      return wrapped;
    }
    const location = responseHeaders.get("location");
    if (location === null) {
      return wrapped;
    }
    await wrapped.cancel();
    if (attempt === MAX_REDIRECTS) {
      throw new InvalidUpstreamResponseError();
    }
    const next = safeRedirectTarget(location, current);
    headers = stripSecretsOnRedirect(current, next, headers);
    current = next;
  }
  throw new InvalidUpstreamResponseError();
}

function wrapFetchResponse(response: Response, createLease: LeaseFactory): OwnedResponseLease {
  if (response.body === null) {
    return createLease(response.status, response.headers, empty(), async () => undefined);
  }
  const reader = response.body.getReader();
  return createLease(
    response.status,
    response.headers,
    webReaderBody(reader),
    async () => {
      await reader.cancel();
    },
  );
}

function responseStartTimeout(
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
): {
  readonly signal: AbortSignal;
  readonly promise: Promise<never>;
  readonly clear: () => void;
  readonly timedOut: () => boolean;
} | undefined {
  const ms = minimumTimeout(connectTimeoutMs, firstByteTimeoutMs);
  if (ms === undefined) {
    return undefined;
  }
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new UpstreamTimeoutError();
    controller.abort(error);
    rejectTimeout(error);
  }, ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    promise,
    clear: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
}

async function createInferenceDispatcher(
  profile: InferenceConnectionProfile,
  limits: InferencePoolLimits,
): Promise<Dispatcher> {
  const { Pool } = await loadUndici();
  return new Pool(profile.origin, {
    connectTimeout: profile.connectTimeoutMs,
    connections: limits.connectionsPerEntry,
    pipelining: 1,
    keepAliveTimeout: limits.idleTimeoutMs,
    keepAliveMaxTimeout: limits.idleTimeoutMs,
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  if (response.body.locked) {
    throw new Error("upstream response body is locked without an owned reader");
  }
  await response.body.cancel();
}

export function mapTokenRefreshError(error: TokenRefreshError): "authentication" | "upstream_network" | "upstream_timeout" {
  if (error.code === "missing" || error.code === "unauthorized") {
    return "authentication";
  }
  if (error.code === "timeout") {
    return "upstream_timeout";
  }
  return "upstream_network";
}

function chatExtraHeaders(hasVisionInput: boolean): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (hasVisionInput) {
    headers.set("copilot-vision-request", "true");
  }
  return headers;
}

function responsesExtraHeaders(request: {
  readonly hasVisionInput: boolean;
  readonly initiator: "user" | "agent";
  readonly requestId: string;
}): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "openai-intent": "conversation-panel",
    "x-request-id": request.requestId,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-initiator": request.initiator,
  });
  if (request.hasVisionInput) {
    headers.set("copilot-vision-request", "true");
  }
  return headers;
}

function messagesExtraHeaders(request: Readonly<MessagesUpstreamRequest>): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "anthropic-version": request.version,
  });
  if (request.betaFeatures.length > 0) {
    headers.set("anthropic-beta", request.betaFeatures.join(","));
  }
  return headers;
}

function responsesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, "")}/responses`;
}

function messagesUrl(endpoint: string): string {
  return `${canonicalOrigin(endpoint)}/v1/messages`;
}

function canonicalOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_error: unknown) {
    throw new InvalidUpstreamResponseError();
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== "") {
    throw new InvalidUpstreamResponseError();
  }
  return parsed.origin;
}

function safeRedirectTarget(location: string, current: string): string {
  try {
    const target = new URL(location, current);
    canonicalOrigin(target.toString());
    return target.toString();
  } catch (_error: unknown) {
    throw new InvalidUpstreamResponseError();
  }
}

async function* empty(): AsyncIterable<Uint8Array> {}

async function readResponseBody(
  source: AsyncIterable<Uint8Array>,
  maxBodyBytes: number | undefined,
  firstByteTimeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let seenBodyBytes = false;
  for (;;) {
    const next = seenBodyBytes || firstByteTimeoutMs === undefined
      ? await iterator.next()
      : await firstBodyChunk(iterator, firstByteTimeoutMs, signal);
    if (next.done === true) {
      break;
    }
    const chunk = next.value;
    signal.throwIfAborted();
    seenBodyBytes = true;
    total += chunk.byteLength;
    if (maxBodyBytes !== undefined && total > maxBodyBytes) {
      throw new UpstreamBodyLimitError();
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function firstBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  ms: number,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  let clear = (): void => undefined;
  const timeout = new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => reject(new UpstreamTimeoutError()), ms);
    timer.unref?.();
    const onAbort = (): void => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    clear();
  }
}

async function* webReaderBody(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<Uint8Array> {
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return;
      }
      if (next.value !== undefined) {
        yield next.value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* undiciBody(body: UndiciBody): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
  }
}

function destroyUndiciBody(body: {
  once?(event: "error", listener: (error: Error) => void): unknown;
  destroy(error?: Error): void;
}): void {
  body.once?.("error", () => undefined);
  body.destroy();
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function incomingHeadersToHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    result.set(key, value);
  }
  return result;
}

function isUndiciTimeout(error: unknown, undiciErrors: UndiciModule["errors"]): boolean {
  return error instanceof undiciErrors.ConnectTimeoutError
    || error instanceof undiciErrors.HeadersTimeoutError
    || error instanceof undiciErrors.BodyTimeoutError;
}

function minimumTimeout(
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
): number | undefined {
  if (connectTimeoutMs === undefined && firstByteTimeoutMs === undefined) {
    return undefined;
  }
  return Math.min(
    connectTimeoutMs ?? Number.POSITIVE_INFINITY,
    firstByteTimeoutMs ?? Number.POSITIVE_INFINITY,
  );
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    callback();
  };
}

async function boundedIteratorReturn(iterator: AsyncIterator<Uint8Array>, timeoutMs: number): Promise<void> {
  await boundedOperation(
    iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined }),
    timeoutMs,
  );
}

async function boundedOperation(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UpstreamTimeoutError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function closedError(): DOMException {
  return new DOMException("closed", "AbortError");
}
