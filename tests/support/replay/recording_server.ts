import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BoundCopilot } from "../../../src/copilot/backend.js";
import { UpstreamBodyLimitError, UpstreamTimeoutError } from "../../../src/copilot/transport.js";
import {
  isMessagesBetaToken, MESSAGES_VERSION, type MessagesBetaToken, type UpstreamByteResponse, type UpstreamByteStream,
  type UpstreamRequestLimits,
} from "../../../src/copilot/upstream_types.js";
import { serveReplayCatalog } from "./catalog.js";

export type RecordingRoute = "/chat/completions" | "/responses" | "/v1/messages";

/** One expected gateway upstream request, forwarded to the bound Copilot account. */
export interface RecordingStep {
  readonly caseId: string;
  readonly path: RecordingRoute;
  readonly model: string;
  readonly stream: boolean;
}

/** Exact upstream entity bytes for one accepted step; no request or credential content. */
export interface RecordedExchange {
  readonly caseId: string;
  readonly path: RecordingRoute;
  readonly stream: boolean;
  readonly status: 200;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly capturedAt: string;
}

export type RecordingFailureCode =
  | "capture_request_mismatch" | "capture_http_status" | "capture_invalid_response"
  | "capture_body_limit" | "capture_timeout" | "capture_cancelled" | "capture_incomplete" | "capture_failed";

/** Content-free recording failure. Status is only an upstream HTTP status code. */
export class RecordingFailure extends Error {
  constructor(readonly code: RecordingFailureCode, readonly caseId?: string, readonly status?: number) {
    super(code);
    this.name = "RecordingFailure";
  }
}

export interface RecordingServerOptions {
  readonly bound: BoundCopilot;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  readonly maxRequestBodyBytes?: number;
  readonly maxResponseBodyBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly firstByteTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

interface Selection {
  readonly steps: readonly RecordingStep[];
  readonly exchanges: RecordedExchange[];
  failure?: RecordingFailure;
}

const MIB = 1024 * 1024;

/**
 * Recording counterpart of the mock replay server. The production gateway under test sends its
 * real upstream requests here; each selected step is forwarded once through the bound Copilot
 * transport, streamed back unchanged and retained in memory for explicit publication.
 */
export class RecordingCopilotServer {
  private readonly options: Required<Omit<RecordingServerOptions, "bound" | "signal" | "now">>;
  private readonly closing = new AbortController();
  private readonly now: () => Date;
  private server: Server | undefined;
  private selection: Selection | undefined;
  /** Requests are handled strictly one at a time, in arrival order. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly config: RecordingServerOptions) {
    this.now = config.now ?? (() => new Date());
    this.options = {
      maxRequestBodyBytes: config.maxRequestBodyBytes ?? 32 * MIB,
      maxResponseBodyBytes: config.maxResponseBodyBytes ?? 32 * MIB,
      connectTimeoutMs: config.connectTimeoutMs ?? 30_000,
      firstByteTimeoutMs: config.firstByteTimeoutMs ?? 120_000,
      idleTimeoutMs: config.idleTimeoutMs ?? 120_000,
    };
  }

  get origin(): string {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === "string") throw new Error("recording server is not running");
    return `http://127.0.0.1:${address.port}`;
  }

  /** The first failure of the selected steps, if any. */
  get failure(): RecordingFailure | undefined { return this.selection?.failure; }

  async start(): Promise<void> {
    if (this.server !== undefined) throw new Error("recording server already started");
    const server = createServer((req, res) => { this.receive(req, res); });
    this.server = server;
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }

  async stop(): Promise<void> {
    this.closing.abort();
    const server = this.server;
    this.server = undefined;
    this.selection = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    // Aborted handling, including its bounded upstream release, finishes before stop resolves.
    await this.tail;
  }

  selectSteps(steps: readonly RecordingStep[]): void {
    if (this.selection !== undefined || steps.length === 0) throw new Error("recording lifecycle conflict");
    this.selection = { steps: [...steps], exchanges: [] };
  }

  /**
   * Return every selected exchange in order, or the first failure. An SDK may resolve on its
   * terminal event before the upstream body ends, so this first waits for in-flight handling.
   */
  async finishSteps(): Promise<readonly RecordedExchange[]> {
    await this.tail;
    const selection = this.selection;
    if (selection === undefined) throw new Error("recording lifecycle conflict");
    this.selection = undefined;
    if (selection.failure !== undefined) throw selection.failure;
    if (selection.exchanges.length !== selection.steps.length) {
      throw new RecordingFailure("capture_incomplete", selection.steps[selection.exchanges.length]?.caseId);
    }
    return selection.exchanges;
  }

  abortSteps(): void {
    this.selection = undefined;
  }

  private receive(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "GET" && (pathname === "/models" || pathname === "/v1/models")) {
      req.resume();
      serveReplayCatalog(res);
      return;
    }
    this.tail = this.tail.then(() => this.handle(req, res)).catch(() => { res.destroy(); });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const selection = this.selection;
    const step = selection?.steps[selection.exchanges.length];
    if (selection === undefined || step === undefined || selection.failure !== undefined) {
      reject(req, res, 409);
      return;
    }
    // The upstream read is owned here, not by the gateway connection: a gateway that stops
    // reading after its terminal event must not truncate the recorded upstream bytes.
    const signal = AbortSignal.any([this.config.signal, this.closing.signal]);
    // Commit before the gateway can observe the end of the response.
    const commit = (exchange: RecordedExchange): void => { selection.exchanges.push(exchange); };
    try {
      await this.forward(req, res, step, signal, commit);
    } catch (error: unknown) {
      selection.failure ??= failureOf(error, step.caseId, signal);
      if (res.headersSent) res.destroy();
      else reject(req, res, 502);
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    step: RecordingStep,
    signal: AbortSignal,
    commit: (exchange: RecordedExchange) => void,
  ): Promise<void> {
    const body = await readBody(req, this.options.maxRequestBodyBytes);
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body).toString("utf8")); }
    catch { throw new RecordingFailure("capture_request_mismatch"); }
    const model = isRecord(parsed) ? parsed.model : undefined;
    const stream = isRecord(parsed) && parsed.stream === true;
    if (req.method !== "POST" || req.url !== step.path || model !== step.model || stream !== step.stream) {
      throw new RecordingFailure("capture_request_mismatch");
    }
    const limits = {
      body,
      nonstreamBodyBytes: this.options.maxResponseBodyBytes,
      connectTimeoutMs: this.options.connectTimeoutMs,
      firstByteTimeoutMs: this.options.firstByteTimeoutMs,
      signal,
    };
    const operation = upstreamOperation(this.config.bound, step, req, limits);
    if (!stream) {
      const response = await operation.complete();
      const contentType = acceptedContentType(response.status, response.headers, "application/json");
      if (response.body.byteLength > this.options.maxResponseBodyBytes) throw new RecordingFailure("capture_body_limit");
      commit({ caseId: step.caseId, path: step.path, stream, status: 200, contentType, body: response.body, capturedAt: this.now().toISOString() });
      res.writeHead(200, { "content-type": contentType, "content-length": String(response.body.byteLength) });
      await endResponse(res, response.body);
      return;
    }
    const upstream = await operation.open();
    try {
      const contentType = acceptedContentType(upstream.status, upstream.headers, "text/event-stream");
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
      const bytes = await this.relay(upstream, res, signal);
      commit({ caseId: step.caseId, path: step.path, stream, status: 200, contentType, body: bytes, capturedAt: this.now().toISOString() });
      await endResponse(res);
    } finally {
      await Promise.race([upstream.cancel(), new Promise((resolve) => setTimeout(resolve, 3_000).unref())]).catch(() => undefined);
    }
  }

  /** Relay stream bytes unchanged while retaining a bounded exact copy. */
  private async relay(upstream: UpstreamByteStream, res: ServerResponse, signal: AbortSignal): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let size = 0;
    const iterator = upstream.bytes[Symbol.asyncIterator]();
    const { promise: abort, dispose } = abortPromise(signal);
    try {
      for (;;) {
        let timer: NodeJS.Timeout | undefined;
        const idle = new Promise<never>((_resolve, rejectIdle) => {
          timer = setTimeout(() => rejectIdle(new RecordingFailure("capture_timeout")), this.options.idleTimeoutMs);
        });
        let next: IteratorResult<Uint8Array>;
        try { next = await Promise.race([iterator.next(), idle, abort]); }
        finally { clearTimeout(timer); }
        if (next.done === true) break;
        size += next.value.byteLength;
        if (size > this.options.maxResponseBodyBytes) throw new RecordingFailure("capture_body_limit");
        const chunk = Buffer.from(next.value);
        chunks.push(chunk);
        if (!res.destroyed && !res.write(chunk)) await Promise.race([writable(res), abort]);
      }
    } finally { dispose(); }
    return Buffer.concat(chunks, size);
  }
}

type UpstreamLimits = Pick<UpstreamRequestLimits, "nonstreamBodyBytes" | "connectTimeoutMs" | "firstByteTimeoutMs" | "signal"> & { readonly body: Uint8Array };

/** The one route-to-transport dispatch: the typed request and its buffered and streamed calls. */
function upstreamOperation(bound: BoundCopilot, step: RecordingStep, req: IncomingMessage, limits: UpstreamLimits): {
  complete(): Promise<UpstreamByteResponse>;
  open(): Promise<UpstreamByteStream>;
} {
  const hasVisionInput = header(req, "copilot-vision-request") === "true";
  switch (step.path) {
  case "/chat/completions": {
    const request = { ...limits, model: step.model, stream: step.stream, hasVisionInput };
    return { complete: () => bound.completeChat(request), open: () => bound.openChatStream(request) };
  }
  case "/responses": {
    const request = { ...limits, ...responsesFields(req), hasVisionInput };
    return { complete: () => bound.completeResponses(request), open: () => bound.openResponsesStream(request) };
  }
  case "/v1/messages": {
    const request = { ...limits, ...messagesFields(req) };
    return { complete: () => bound.completeMessages(request), open: () => bound.openMessagesStream(request) };
  }
  }
}

function responsesFields(req: IncomingMessage): { initiator: "user" | "agent"; requestId: string } {
  const initiator = header(req, "x-initiator");
  const requestId = header(req, "x-request-id");
  if ((initiator !== "user" && initiator !== "agent") || requestId === undefined || requestId.length === 0) {
    throw new RecordingFailure("capture_request_mismatch");
  }
  return { initiator, requestId };
}

function messagesFields(req: IncomingMessage): { version: typeof MESSAGES_VERSION; betaFeatures: readonly MessagesBetaToken[] } {
  if (header(req, "anthropic-version") !== MESSAGES_VERSION) throw new RecordingFailure("capture_request_mismatch");
  const beta = header(req, "anthropic-beta");
  const betaFeatures = beta === undefined ? [] : beta.split(",").map((value) => value.trim());
  if (!betaFeatures.every(isMessagesBetaToken)) throw new RecordingFailure("capture_request_mismatch");
  return { version: MESSAGES_VERSION, betaFeatures };
}

function acceptedContentType(status: number, headers: Headers, mediaType: string): string {
  if (status !== 200) throw new RecordingFailure("capture_http_status", undefined, Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined);
  const value = headers.get("content-type");
  if (value?.split(";", 1)[0]?.trim().toLowerCase() !== mediaType) throw new RecordingFailure("capture_invalid_response");
  return value;
}

function failureOf(error: unknown, caseId: string, signal: AbortSignal): RecordingFailure {
  if (error instanceof RecordingFailure) return new RecordingFailure(error.code, caseId, error.status);
  if (error instanceof UpstreamBodyLimitError) return new RecordingFailure("capture_body_limit", caseId);
  if (error instanceof UpstreamTimeoutError) return new RecordingFailure("capture_timeout", caseId);
  return new RecordingFailure(signal.aborted ? "capture_cancelled" : "capture_failed", caseId);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) throw new RecordingFailure("capture_body_limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

/** One listener per relay; the returned promise never produces an unhandled rejection. */
function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, rejectAbort) => {
    listener = () => rejectAbort(new RecordingFailure("capture_cancelled"));
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  promise.catch(() => undefined);
  return { promise, dispose: () => { if (listener !== undefined) signal.removeEventListener("abort", listener); } };
}

async function endResponse(res: ServerResponse, body?: Uint8Array): Promise<void> {
  if (res.destroyed) return;
  await new Promise<void>((resolve) => {
    res.once("close", resolve);
    res.end(body, resolve);
  });
}

/** Resolve once the downstream can accept more bytes or has gone away. */
function writable(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function reject(req: IncomingMessage, res: ServerResponse, status: number): void {
  req.resume();
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error: "recording request rejected" }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
