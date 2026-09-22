import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { OrderedHeaderFields } from "../../../src/gateway/header_fields.js";

/** Synthetic data only. Never point credentials or captured upstream content at this responder. */
export interface HttpRequestObservation {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly rawHeaderFields: OrderedHeaderFields;
  readonly body: Uint8Array;
}

export interface HttpReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  /** Runs after headers are flushed. All writes and barriers have a bounded lifetime. */
  readonly stream?: (exchange: HttpStreamControl) => Promise<void>;
}

export interface HttpExpectation {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string | null>>;
  /** Exact bytes, or an explicit test-owned predicate; no implicit JSON normalization. */
  readonly body: Uint8Array | ((body: Uint8Array) => boolean);
  readonly reply: HttpReply;
  readonly times?: number;
}

export interface HttpStreamControl {
  readonly request: HttpRequestObservation;
  readonly closed: boolean;
  readonly ended: boolean;
  readonly backpressureWrites: number;
  write(bytes: Uint8Array): Promise<void>;
  end(bytes?: Uint8Array): Promise<void>;
  disconnect(): void;
  waitForClose(): Promise<void>;
}

export interface HttpMockLimits {
  readonly requests: number;
  readonly bodyBytes: number;
  readonly responseBytes: number;
  readonly retainedBodyBytes: number;
  readonly activeExchanges: number;
  readonly sockets: number;
  /** At least 3ms, leaving room for Node's header deadline and its checking interval. */
  readonly waitMs: number;
  readonly keepAliveMs: number;
}

class HttpStreamClosedError extends Error {
  constructor() { super("synthetic HTTP stream closed"); }
}

const DEFAULT_LIMITS: HttpMockLimits = {
  requests: 128, bodyBytes: 1024 * 1024, responseBytes: 8 * 1024 * 1024,
  retainedBodyBytes: 8 * 1024 * 1024, activeExchanges: 8, sockets: 16, waitMs: 5_000, keepAliveMs: 1_000,
};

/** A bounded HTTP seam, deliberately independent of Vitest and CopilotBackend. */
export async function startCopilotHttpMock(options: {
  readonly expectations?: readonly HttpExpectation[];
  readonly limits?: Partial<HttpMockLimits>;
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key as keyof HttpMockLimits]
      || (key === "waitMs" && value < 3)) {
      throw new Error("invalid synthetic HTTP limit");
    }
  }
  const expectations: { value: HttpExpectation; remaining: number }[] = [];
  const requests: HttpRequestObservation[] = [];
  const streams: HttpStreamControl[] = [];
  const sockets = new Set<Socket>();
  const matchedSockets = new WeakSet<object>();
  const socketWork = new WeakMap<Socket, { unfinished: number; completedReadBytes: number | undefined }>();
  let attempts = 0;
  let retainedBodyBytes = 0;
  let activeExchanges = 0;
  const handlers = new Set<Promise<void>>();
  let failure: string | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const fail = (code: string): void => { failure ??= code; };
  function add(expectation: HttpExpectation): void {
    const times = expectation.times ?? 1;
    if (stopped || expectations.length >= limits.requests || !Number.isSafeInteger(times) || times < 1 || times > limits.requests
      || (typeof expectation.body !== "function" && expectation.body.byteLength > limits.bodyBytes)
      || (expectation.reply.body?.byteLength ?? 0) > limits.responseBytes
      || (expectation.reply.body !== undefined && expectation.reply.stream !== undefined)) {
      throw new Error("invalid synthetic HTTP expectation");
    }
    expectations.push({ value: expectation, remaining: times });
  }
  for (const expectation of options.expectations ?? []) add(expectation);
  function matchesBody(predicate: (body: Uint8Array) => boolean, body: Uint8Array): boolean {
    const result: unknown = predicate(body);
    if (result instanceof Promise) void result.catch(() => undefined);
    // Throw to stop matching: an invalid callback cannot fall through to a later expectation.
    if (typeof result !== "boolean") throw new Error("invalid synthetic predicate result");
    return result === true;
  }
  const keepAliveTimeout = Math.min(limits.keepAliveMs, limits.waitMs);
  const keepAliveTimeoutBuffer = 1_000;
  // Let Node's parser reject even partial pipelined headers before either socket timer
  // can mistake them for idle. The header deadline plus checking interval uses at most
  // two thirds of the earlier deadline, including at the minimum configurable wait.
  const headerCheckMs = Math.floor(Math.min(limits.waitMs, keepAliveTimeout + keepAliveTimeoutBuffer) / 3);
  const server = createServer({
    maxHeaderSize: 16 * 1024, headersTimeout: headerCheckMs,
    connectionsCheckingInterval: headerCheckMs, requestTimeout: limits.waitMs,
  }, (request, response) => {
    const handler = handle(request, response).catch((error: unknown) => {
      if (!stopped && !(response.destroyed && error instanceof HttpStreamClosedError)) fail("exchange failed");
      response.destroy();
    }).finally(() => handlers.delete(handler));
    handlers.add(handler);
  });
  // Node restores server.timeout when a keep-alive connection starts another request.
  server.timeout = limits.waitMs;
  server.keepAliveTimeout = keepAliveTimeout;
  server.keepAliveTimeoutBuffer = keepAliveTimeoutBuffer;
  server.on("connection", (socket) => {
    if (stopped || sockets.size >= limits.sockets) {
      fail("socket limit");
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const work = { unfinished: 0, completedReadBytes: undefined as number | undefined };
    socketWork.set(socket, work);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(limits.waitMs, () => {
      // Node reuses this listener for keep-alive expiry after a completed response.
      // Later socket reads and unfinished (including pipelined) responses are not idle.
      if (work.unfinished !== 0 || work.completedReadBytes !== socket.bytesRead) fail("socket timeout");
      socket.destroy();
    });
  });
  server.on("clientError", (error, socket) => {
    // Cancelling a matched response may reset the socket before its flushed headers are read.
    if ((error as NodeJS.ErrnoException).code === "ERR_HTTP_REQUEST_TIMEOUT") {
      // Undici may open a spare connection without sending any HTTP bytes.
      if (!(socket instanceof Socket && socket.bytesRead === 0)) fail("request timeout");
    } else if ((error as NodeJS.ErrnoException).code !== "ECONNRESET" || !matchedSockets.has(socket)) {
      fail("invalid HTTP request");
    }
    socket.destroy();
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const socket = request.socket;
    const work = socketWork.get(socket)!;
    work.unfinished += 1;
    response.once("finish", () => {
      work.unfinished -= 1;
      if (work.unfinished === 0) work.completedReadBytes = socket.bytesRead;
    });
    response.once("close", () => { if (!response.writableFinished) work.unfinished -= 1; });
    const timer = setTimeout(() => { fail("exchange timeout"); request.destroy(); response.destroy(); }, limits.waitMs);
    response.once("close", () => clearTimeout(timer));
    if (activeExchanges >= limits.activeExchanges) {
      fail("active exchange limit");
      response.writeHead(503, { connection: "close" }).end();
      request.resume();
      return;
    }
    activeExchanges += 1;
    response.once("close", () => { activeExchanges -= 1; });
    attempts += 1;
    if (attempts > limits.requests) {
      fail("request limit");
      response.writeHead(429, { connection: "close" }).end();
      request.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).byteLength;
      if (size > limits.bodyBytes) {
        fail("request body limit");
        response.writeHead(413, { connection: "close" }).end();
        request.resume();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    if (retainedBodyBytes + size > limits.retainedBodyBytes) {
      fail("retained body limit");
      response.writeHead(413, { connection: "close" }).end();
      return;
    }
    retainedBodyBytes += size;
    const rawHeaderFields = [] as { name: string; value: string }[];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      rawHeaderFields.push(Object.freeze({ name: request.rawHeaders[i]!, value: request.rawHeaders[i + 1]! }));
    }
    const observation: HttpRequestObservation = {
      method: request.method ?? "", path: request.url ?? "", headers: new Headers(),
      rawHeaderFields: Object.freeze(rawHeaderFields), body: Buffer.concat(chunks, size),
    };
    for (const field of rawHeaderFields) {
      observation.headers.append(field.name, field.value);
    }
    requests.push(observation);
    let matched: typeof expectations[number] | undefined;
    try {
      matched = expectations.find(({ value, remaining }) => remaining > 0
        && value.method === observation.method && value.path === observation.path
        && Object.entries(value.headers ?? {}).every(([key, expected]) => observation.headers.get(key) === expected)
        && (typeof value.body === "function" ? matchesBody(value.body, observation.body) : Buffer.from(value.body).equals(observation.body)));
    } catch { fail("predicate failed"); }
    if (matched === undefined) {
      fail("request mismatch");
      response.writeHead(409, { "content-type": "application/json" }).end("{\"error\":\"synthetic HTTP mismatch\"}");
      return;
    }
    matched.remaining -= 1;
    matchedSockets.add(request.socket);
    const reply = matched.value.reply;
    response.writeHead(reply.status ?? 200, reply.headers);
    if (reply.stream === undefined) {
      response.end(reply.body);
      return;
    }
    let closed = response.destroyed;
    let ended = false;
    let written = 0;
    let backpressureWrites = 0;
    let resolveClose = (): void => undefined;
    const close = new Promise<void>((resolve) => { resolveClose = resolve; });
    response.once("close", () => { closed = true; resolveClose(); });
    const checkBytes = (bytes: Uint8Array): void => {
      written += bytes.byteLength;
      if (written > limits.responseBytes) { fail("response body limit"); throw new Error("synthetic HTTP response body limit"); }
      if (ended) throw new Error("synthetic HTTP stream ended");
      if (closed) throw new HttpStreamClosedError();
    };
    const control: HttpStreamControl = {
      request: observation,
      get closed() { return closed; },
      get ended() { return ended; },
      get backpressureWrites() { return backpressureWrites; },
      async write(bytes) {
        checkBytes(bytes);
        // The write callback waits for the bounded Node writable queue, including backpressure.
        await boundedHttpWait(new Promise<void>((resolve, reject) => {
          if (!response.write(bytes, (error) => error == null ? resolve() : reject(new HttpStreamClosedError()))) {
            backpressureWrites += 1;
          }
        }), limits.waitMs);
      },
      async end(bytes = new Uint8Array()) {
        checkBytes(bytes);
        ended = true;
        await boundedHttpWait(new Promise<void>((resolve) => response.end(bytes, resolve)), limits.waitMs);
      },
      disconnect() { response.destroy(); },
      async waitForClose() { if (!closed) await boundedHttpWait(close, limits.waitMs); },
    };
    streams.push(control);
    response.flushHeaders();
    await boundedHttpWait(reply.stream(control), limits.waitMs);
    // A stream may deliberately remain open for a test-side end/disconnect barrier.
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("synthetic HTTP listener unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get requests(): readonly HttpRequestObservation[] { return requests; },
    get streams(): readonly HttpStreamControl[] { return streams; },
    get socketCount() { return sockets.size; },
    get activeExchanges() { return activeExchanges; },
    get retainedBodyBytes() { return retainedBodyBytes; },
    expect: add,
    assertSatisfied() {
      if (failure !== undefined) throw new Error(`synthetic HTTP ${failure}`);
      if (expectations.some((entry) => entry.remaining !== 0)) throw new Error("synthetic HTTP expectations pending");
    },
    assertHealthy() { if (failure !== undefined) throw new Error(`synthetic HTTP ${failure}`); },
    async stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopped = true;
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
        await boundedHttpWait(Promise.all([closed, ...handlers]), limits.waitMs);
        // Node's server-close callback may precede the sockets' close notifications.
        await new Promise<void>((resolve) => setImmediate(resolve));
      })();
      await stopPromise;
    },
  };
}

export type CopilotHttpMock = Awaited<ReturnType<typeof startCopilotHttpMock>>;

export async function boundedHttpWait<T>(promise: Promise<T>, ms = DEFAULT_LIMITS.waitMs): Promise<T> {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > DEFAULT_LIMITS.waitMs) throw new Error("invalid synthetic HTTP wait limit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic HTTP wait timeout")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
