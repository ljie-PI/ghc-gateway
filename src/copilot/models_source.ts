import type { IncomingHttpHeaders } from "node:http";
import type * as Undici from "undici";
import type { Dispatcher } from "undici";
import { copilotHeaders } from "./identity.js";
import { capiModelsUrl, type CapiModelsResponse, type CopilotModelsSource } from "./model_catalog.js";
import { MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";

export type CapiFailureKind = "upstream_http" | "upstream_timeout" | "upstream_network" | "invalid_upstream_response";

interface CapiTransportLimits {
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly bodyLimitBytes: number;
}

interface CapiHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

const DEFAULT_CAPI_LIMITS: CapiTransportLimits = {
  connectTimeoutMs: 30_000,
  totalTimeoutMs: 600_000,
  bodyLimitBytes: 33_554_432,
};

const CAPI_DISPATCHER_CONNECTIONS = 8;

type UndiciModule = typeof Undici;

let undiciModulePromise: Promise<UndiciModule> | undefined;

function loadUndici(): Promise<UndiciModule> {
  undiciModulePromise ??= import("undici");
  return undiciModulePromise;
}

export class CapiFetchError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
    readonly failureKind: CapiFailureKind = "upstream_http",
  ) {
    super("capi fetch failed");
    this.name = "CapiFetchError";
  }
}

export class HttpCopilotModelsSource implements CopilotModelsSource {
  private dispatcher: Dispatcher | undefined;
  private dispatcherPromise: Promise<Dispatcher> | undefined;
  private closingDispatcherPromise: Promise<Dispatcher> | undefined;
  private closingDispatcher: Dispatcher | undefined;
  private closed = false;
  private forceClosed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly resolve: (
      accountId: string,
      signal: AbortSignal,
      credentialGeneration?: number,
    ) => Promise<{ token: string; endpoint: string }>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly limits: CapiTransportLimits = DEFAULT_CAPI_LIMITS,
    private readonly createDispatcher: (limits: CapiTransportLimits) => Dispatcher | Promise<Dispatcher> = defaultCapiDispatcher,
  ) {}

  static production(
    resolve: (
      accountId: string,
      signal: AbortSignal,
      credentialGeneration?: number,
    ) => Promise<{ token: string; endpoint: string }>,
  ): HttpCopilotModelsSource {
    return new HttpCopilotModelsSource(resolve, fetch, DEFAULT_CAPI_LIMITS, defaultCapiDispatcher);
  }

  async fetch(
    accountId: string,
    signal: AbortSignal,
    credentialGeneration?: number,
  ): Promise<CapiModelsResponse> {
    if (this.closed) {
      throw new DOMException("closed", "AbortError");
    }
    const { token, endpoint } = await this.resolve(accountId, signal, credentialGeneration);
    const deadlineMs = Date.now() + this.limits.totalTimeoutMs;
    const response = await getWithRedirects(
      this.fetchImpl,
      capiModelsUrl(endpoint),
      token,
      signal,
      deadlineMs,
      this.limits,
      this.fetchImpl === fetch ? await this.sharedDispatcher(signal, deadlineMs) : undefined,
    );
    if (response.status < 200 || response.status >= 300) {
      await response.cancel();
      const status = response.status >= 300 && response.status < 400 ? 502 : response.status;
      throw new CapiFetchError(
        status,
        response.status === 429 ? validRetryAfter(response.headers) : undefined,
        status === response.status ? "upstream_http" : "invalid_upstream_response",
      );
    }
    try {
      const bytes = await readLimitedBody(response.body, signal, deadlineMs, this.limits);
      return JSON.parse(new TextDecoder().decode(bytes)) as CapiModelsResponse;
    } catch (error: unknown) {
      await response.cancel();
      if (signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      if (error instanceof CapiFetchError || isAbortError(error)) {
        throw error;
      }
      throw new CapiFetchError(502, undefined, "invalid_upstream_response");
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeDispatcher();
    return await this.closePromise;
  }

  private async closeDispatcher(): Promise<void> {
    this.closed = true;
    const pendingDispatcher = this.dispatcherPromise;
    this.dispatcherPromise = undefined;
    this.closingDispatcherPromise = pendingDispatcher;
    const dispatcher = this.dispatcher ?? await pendingDispatcher?.catch(() => undefined);
    this.closingDispatcherPromise = undefined;
    this.dispatcher = undefined;
    if (dispatcher !== undefined && !this.forceClosed) {
      this.closingDispatcher = dispatcher;
      await dispatcher.close();
      if (this.closingDispatcher === dispatcher) {
        this.closingDispatcher = undefined;
      }
    }
  }

  forceClose(): void {
    this.forceClosed = true;
    this.closed = true;
    const pendingDispatcher = this.dispatcherPromise ?? this.closingDispatcherPromise;
    this.dispatcherPromise = undefined;
    this.closingDispatcherPromise = undefined;
    const dispatcher = this.dispatcher ?? this.closingDispatcher;
    this.dispatcher = undefined;
    this.closingDispatcher = undefined;
    if (dispatcher !== undefined) {
      void dispatcher.destroy().catch(() => undefined);
    }
    if (pendingDispatcher !== undefined) {
      void pendingDispatcher.then(async (created) => created.destroy()).catch(() => undefined);
    }
  }

  private async sharedDispatcher(signal: AbortSignal, deadlineMs: number): Promise<Dispatcher> {
    if (this.closed) {
      throw new DOMException("closed", "AbortError");
    }
    if (this.dispatcher !== undefined) {
      return this.dispatcher;
    }
    const pending = this.dispatcherPromise ?? this.startDispatcher();
    const timeout = timeoutPromise<Dispatcher>(remainingMs(deadlineMs), signal);
    try {
      const dispatcher = await Promise.race([pending, timeout.promise]);
      if (this.closed) {
        throw new DOMException("closed", "AbortError");
      }
      return dispatcher;
    } finally {
      timeout.clear();
    }
  }

  private startDispatcher(): Promise<Dispatcher> {
    const pending = Promise.resolve()
      .then(async () => this.createDispatcher(this.limits))
      .then((created) => {
        if (!this.closed) {
          this.dispatcher ??= created;
          return this.dispatcher;
        }
        return created;
      })
      .finally(() => {
        if (this.dispatcherPromise === pending) {
          this.dispatcherPromise = undefined;
        }
      });
    this.dispatcherPromise = pending;
    return pending;
  }
}

async function defaultCapiDispatcher(limits: CapiTransportLimits): Promise<Dispatcher> {
  const { Agent } = await loadUndici();
  return new Agent({
    connectTimeout: limits.connectTimeoutMs,
    connections: CAPI_DISPATCHER_CONNECTIONS,
    pipelining: 1,
  });
}

async function getWithRedirects(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
  deadlineMs: number,
  limits: CapiTransportLimits,
  dispatcher: Dispatcher | undefined,
): Promise<CapiHttpResponse> {
  let current = url;
  let headers = new Headers({ ...copilotHeaders(), authorization: `Bearer ${token}`, "content-type": "application/json" });
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const response = fetchImpl === fetch && dispatcher !== undefined
      ? await undiciWithTimeout(current, headers, signal, deadlineMs, dispatcher)
      : await fetchWithTimeout(fetchImpl, current, headers, signal, deadlineMs, limits);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      return response;
    }
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch (_error: unknown) {
      await response.cancel();
      throw new CapiFetchError(502, undefined, "invalid_upstream_response");
    }
    headers = stripSecretsOnRedirect(current, next, headers);
    await response.cancel();
    current = next;
  }
  throw new CapiFetchError(502, undefined, "invalid_upstream_response");
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
  signal: AbortSignal,
  deadlineMs: number,
  limits: CapiTransportLimits,
): Promise<CapiHttpResponse> {
  const timeout = timeoutPromise<Response>(Math.min(limits.connectTimeoutMs, remainingMs(deadlineMs)), signal);
  try {
    const response = await Promise.race([
      fetchImpl(url, { method: "GET", headers, signal: timeout.signal, redirect: "manual" }),
      timeout.promise,
    ]);
    const wrappedBody = response.body === null ? emptyBody() : createWebBody(response.body);
    return {
      status: response.status,
      headers: response.headers,
      body: wrappedBody.bytes,
      cancel: wrappedBody.cancel,
    };
  } catch (error: unknown) {
    if (timeout.timedOut()) {
      throw new CapiFetchError(502, undefined, "upstream_timeout");
    }
    if (isAbortError(error)) {
      throw error;
    }
    throw new CapiFetchError(502, undefined, "upstream_network");
  } finally {
    timeout.clear();
  }
}

async function undiciWithTimeout(
  url: string,
  headers: Headers,
  signal: AbortSignal,
  deadlineMs: number,
  dispatcher: Dispatcher,
): Promise<CapiHttpResponse> {
  const { errors: undiciErrors, request: undiciRequest } = await loadUndici();
  const timeout = timeoutPromise<Awaited<ReturnType<UndiciModule["request"]>>>(remainingMs(deadlineMs), signal);
  try {
    const response = await Promise.race([undiciRequest(url, {
      method: "GET",
      headers: headersToRecord(headers),
      signal: timeout.signal,
      dispatcher,
      headersTimeout: positiveTimeoutMs(deadlineMs),
      bodyTimeout: 0,
    }), timeout.promise]);
    const body = response.body;
    return {
      status: response.statusCode,
      headers: incomingHeadersToHeaders(response.headers),
      body: undiciBody(body),
      cancel: async () => {
        destroyUndiciBody(body);
      },
    };
  } catch (error: unknown) {
    if (timeout.timedOut() || isUndiciTimeout(error, undiciErrors)) {
      throw new CapiFetchError(502, undefined, "upstream_timeout");
    }
    if (isAbortError(error)) {
      throw error;
    }
    throw new CapiFetchError(502, undefined, "upstream_network");
  } finally {
    timeout.clear();
  }
}

async function readLimitedBody(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  deadlineMs: number,
  limits: CapiTransportLimits,
): Promise<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const timeout = timeoutPromise<IteratorResult<Uint8Array>>(remainingMs(deadlineMs), signal);
      let next: IteratorResult<Uint8Array>;
      try {
        next = await Promise.race([iterator.next(), timeout.promise]);
      } catch (error: unknown) {
        if (timeout.timedOut()) {
          throw new CapiFetchError(502, undefined, "upstream_timeout");
        }
        throw error;
      } finally {
        timeout.clear();
      }
      if (next.done === true) {
        break;
      }
      total += next.value.byteLength;
      if (total > limits.bodyLimitBytes) {
        void iterator.return?.().catch(() => undefined);
        throw new CapiFetchError(502, undefined, "invalid_upstream_response");
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    void iterator.return?.().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function timeoutPromise<T>(ms: number, signal: AbortSignal): {
  readonly signal: AbortSignal;
  readonly promise: Promise<T>;
  readonly clear: () => void;
  readonly timedOut: () => boolean;
} {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timedOut = false;
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  if (signal.aborted) {
    controller.abort();
    rejectTimeout(new DOMException("aborted", "AbortError"));
    return { signal: combined, promise, clear: () => undefined, timedOut: () => false };
  }
  const onAbort = (): void => {
    controller.abort();
    rejectTimeout(new DOMException("aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new CapiFetchError(502, undefined, "upstream_timeout"));
  }, Math.max(0, ms));
  return {
    signal: combined,
    promise,
    clear: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}

function emptyBody(): { readonly bytes: AsyncIterable<Uint8Array>; readonly cancel: () => Promise<void> } {
  return {
    bytes: {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {},
    },
    cancel: async () => undefined,
  };
}

function createWebBody(body: ReadableStream<Uint8Array>): { readonly bytes: AsyncIterable<Uint8Array>; readonly cancel: () => Promise<void> } {
  const reader = body.getReader();
  let completed = false;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    reader.releaseLock();
  };
  return {
    bytes: {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              completed = true;
              return;
            }
            if (next.value !== undefined) {
              yield next.value;
            }
          }
        } finally {
          if (!completed) {
            void reader.cancel().catch(() => undefined);
          }
          release();
        }
      },
    },
    cancel: async () => {
      await reader.cancel().catch(() => undefined);
      release();
    },
  };
}

async function* undiciBody(
  body: AsyncIterable<Uint8Array | Buffer | string> & { destroy(error?: Error): void; on(event: "error", listener: (error: Error) => void): unknown },
): AsyncIterable<Uint8Array> {
  let completed = false;
  try {
    for await (const chunk of body) {
      yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    }
    completed = true;
  } finally {
    if (!completed) {
      destroyUndiciBody(body);
    }
  }
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function positiveTimeoutMs(deadlineMs: number): number {
  return Math.max(1, remainingMs(deadlineMs));
}

function validRetryAfter(headers: Headers): string | undefined {
  const value = headers.get("retry-after");
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return value;
  }
  if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
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

function destroyUndiciBody(body: { destroy(error?: Error): void; on(event: "error", listener: (error: Error) => void): unknown }): void {
  body.on("error", () => undefined);
  body.destroy();
}
