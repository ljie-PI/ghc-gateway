import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { isRecord, isReplayId, MAX_REPLAY_STEPS, readReplayResponse, replayConfigurationError, validateReplayCorpus } from "./corpus.js";
import { independentRequestMatches } from "./legacy.js";
import type { ReplayExchangeRecord, ReplayScenario } from "./types.js";

export { parseReplayManifest, validateReplayCorpus } from "./corpus.js";
export type { ReplayScenario, ReplayScenarioStep } from "./types.js";

export interface ReplayServerOptions {
  readonly port?: number;
  readonly corpusDir: string;
  readonly exchanges: readonly ReplayExchangeRecord[];
  readonly faultMode?: "disconnect_early" | "stall_first_byte" | undefined;
  readonly maxRequestBodyBytes?: number;
  readonly maxReceipts?: number;
  readonly requestTimeoutMs?: number;
}

export interface ReplayReceipt {
  readonly method: string;
  readonly path: string;
  readonly model?: string | undefined;
  readonly stream: boolean;
  readonly matchedCaseId?: string | undefined;
  readonly scenarioId?: string | undefined;
  readonly scenarioStep?: number | undefined;
}

interface SelectedScenario {
  readonly id: string;
  readonly steps: readonly {
    readonly exchange: ReplayExchangeRecord;
    readonly matchesRequest: (body: unknown) => boolean;
  }[];
  next: number;
}

export class MockCopilotReplayServer {
  private readonly port: number;
  private readonly corpusDir: string;
  private readonly exchanges: readonly ReplayExchangeRecord[];
  private readonly maxRequestBodyBytes: number;
  private readonly maxReceipts: number;
  private readonly requestTimeoutMs: number;
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly receipts: ReplayReceipt[] = [];
  private selected: SelectedScenario | undefined;
  private inFlight: ServerResponse | undefined;
  public faultMode: "disconnect_early" | "stall_first_byte" | undefined;

  constructor(options: ReplayServerOptions) {
    if ("recordBodies" in options) throw replayConfigurationError();
    this.port = options.port ?? 31488;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) throw replayConfigurationError();
    this.corpusDir = options.corpusDir;
    this.exchanges = structuredClone(options.exchanges);
    this.faultMode = options.faultMode;
    this.maxRequestBodyBytes = boundedOption(options.maxRequestBodyBytes, 32 * 1024 * 1024);
    this.maxReceipts = boundedOption(options.maxReceipts, 1024);
    this.requestTimeoutMs = boundedOption(options.requestTimeoutMs, 30_000);
  }

  get baseUrl(): string {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === "string") throw new Error("replay server is not running");
    return `http://127.0.0.1:${address.port}`;
  }

  get recordedReceipts(): readonly ReplayReceipt[] {
    return this.receipts.map((receipt) => ({ ...receipt }));
  }

  clearReceipts(): void {
    this.receipts.length = 0;
  }

  /** One explicit scope at a time. Completion remains selected until finish/abort. */
  selectScenario(scenario: ReplayScenario): void {
    this.requireIdle();
    if (this.selected !== undefined) throw new Error("replay scenario already selected");
    if (!isRecord(scenario) || !isReplayId(scenario.id) || !Array.isArray(scenario.steps)
      || scenario.steps.length === 0 || scenario.steps.length > MAX_REPLAY_STEPS) throw replayConfigurationError();
    const steps = Array.from(scenario.steps, (step: unknown) => {
      if (!isRecord(step) || typeof step.exchangeId !== "string" || typeof step.matchesRequest !== "function"
        || step.matchesRequest.constructor.name === "AsyncFunction") throw replayConfigurationError();
      const exchange = this.exchanges.find((candidate) => candidate.caseId === step.exchangeId);
      if (exchange === undefined) throw replayConfigurationError();
      return { exchange, matchesRequest: step.matchesRequest as (body: unknown) => boolean };
    });
    this.selected = { id: scenario.id, steps, next: 0 };
  }

  finishScenario(): void {
    this.requireIdle();
    if (this.selected === undefined || this.selected.next !== this.selected.steps.length) throw new Error("replay scenario incomplete");
    this.selected = undefined;
  }

  /** Explicit abandonment after requests drain; stop() cancels in-flight work. */
  abortScenario(): void {
    this.requireIdle();
    this.selected = undefined;
  }

  private requireIdle(): void {
    if (this.server?.listening !== true || this.stopping !== undefined || this.inFlight !== undefined) throw new Error("replay lifecycle conflict");
  }

  async start(): Promise<void> {
    if (this.stopping !== undefined) throw new Error("replay lifecycle conflict");
    if (this.starting !== undefined) return this.starting;
    if (this.server?.listening === true) return;
    this.starting = this.listen();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async listen(): Promise<void> {
    await validateReplayCorpus(this.corpusDir, this.exchanges);
    this.selected = undefined;
    this.clearReceipts();
    const server = createServer((req, res) => this.receive(req, res));
    this.server = server;
    server.maxConnections = 16;
    server.headersTimeout = this.requestTimeoutMs;
    server.requestTimeout = this.requestTimeoutMs;
    server.setTimeout(this.requestTimeoutMs, (socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", resolve);
      });
    } catch {
      this.server = undefined;
      server.close();
      throw new Error("replay listener failed");
    }
  }

  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = this.close();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  private async close(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.selected = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    this.inFlight = undefined;
  }

  private receive(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "GET" && (pathname === "/models" || pathname === "/v1/models")) {
      this.record({ method: "GET", path: pathname, stream: false });
      req.resume();
      serveCatalog(res);
      return;
    }
    if (this.inFlight !== undefined) {
      this.record({ method: "POST", path: "unmatched", stream: false, ...this.scenarioReceipt() });
      rejectRequest(req, res, 409, "replay request in flight");
      return;
    }
    this.inFlight = res;
    const timer = setTimeout(() => res.destroy(), this.requestTimeoutMs);
    timer.unref();
    const release = (): void => {
      clearTimeout(timer);
      if (this.inFlight === res) this.inFlight = undefined;
    };
    res.once("finish", release);
    res.once("close", release);
    this.handleRequest(req, res, pathname).catch(() => {
      if (res.headersSent) res.destroy();
      else rejectRequest(req, res, 500, "replay request failed");
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > this.maxRequestBodyBytes) {
        rejectRequest(req, res, 413, "replay request too large");
        return;
      }
      chunks.push(bytes);
    }
    const rawText = Buffer.concat(chunks, size).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(rawText); } catch { /* Invalid JSON never matches. */ }
    const requestedModel = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
    const stream = isRecord(body) && body.stream === true;
    const receipt: ReplayReceipt = {
      method: req.method === "POST" ? "POST" : "unmatched",
      path: this.exchanges.some((exchange) => exchange.request.path === pathname) ? pathname : "unmatched",
      model: this.exchanges.some((exchange) => exchange.upstreamModel === requestedModel || exchange.logicalModel === requestedModel) ? requestedModel : undefined,
      stream,
      ...this.scenarioReceipt(),
    };
    if (!isRecord(body) || (body.stream !== undefined && typeof body.stream !== "boolean")) {
      this.record(receipt);
      rejectRequest(req, res, 400, "invalid replay request");
      return;
    }
    let match: ReplayExchangeRecord | undefined;
    const selected = this.selected;
    if (selected !== undefined) {
      const step = selected.steps[selected.next];
      if (step !== undefined && routeMatches(step.exchange, req.method, pathname, requestedModel, stream)
        && predicateMatches(step.matchesRequest, body)) match = step.exchange;
    } else {
      const candidates = this.exchanges.filter((exchange) => exchange.selection !== "explicit"
        && routeMatches(exchange, req.method, pathname, requestedModel, stream)
        && independentRequestMatches(exchange, rawText));
      if (candidates.length > 1) {
        this.record(receipt);
        rejectRequest(req, res, 409, "ambiguous replay request");
        return;
      }
      match = candidates[0];
    }
    if (match === undefined) {
      this.record(receipt);
      rejectRequest(req, res, selected === undefined ? 404 : 409, "replay request mismatch");
      return;
    }
    // Recheck bytes before committing. A missing/changed file cannot advance a scope.
    const bytes = await readReplayResponse(this.corpusDir, match);
    if (res.destroyed) return;
    if (selected !== undefined) selected.next += 1;
    this.record({ ...receipt, matchedCaseId: match.caseId });
    const headers = { ...match.response.headers };
    if (match.response.stream) headers["content-type"] = "text/event-stream; charset=utf-8";
    else {
      headers["content-type"] ??= "application/json; charset=utf-8";
      headers["content-length"] = String(bytes.length);
    }
    // Faults consume an accepted step; the request owns the scope until close/timeout.
    if (this.faultMode === "stall_first_byte") return;
    res.writeHead(match.response.status, headers);
    if (this.faultMode === "disconnect_early") {
      if (match.response.stream) res.write(bytes.subarray(0, Math.min(20, bytes.length)));
      res.destroy();
      return;
    }
    res.end(bytes);
  }

  private scenarioReceipt(): Pick<ReplayReceipt, "scenarioId" | "scenarioStep"> {
    return this.selected === undefined ? {} : { scenarioId: this.selected.id, scenarioStep: this.selected.next + 1 };
  }

  private record(receipt: ReplayReceipt): void {
    if (this.receipts.length === this.maxReceipts) this.receipts.shift();
    this.receipts.push(receipt);
  }
}

function boundedOption(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw replayConfigurationError();
  return result;
}

function predicateMatches(predicate: (body: unknown) => boolean, body: unknown): boolean {
  try {
    const result: unknown = predicate(body);
    if (result instanceof Promise) void result.catch(() => undefined);
    return result === true;
  } catch {
    return false;
  }
}

function routeMatches(exchange: ReplayExchangeRecord, method: string | undefined, pathname: string, model: string | undefined, stream: boolean): boolean {
  return exchange.request.method === method && exchange.request.path === pathname
    && (exchange.logicalModel === model || exchange.upstreamModel === model) && exchange.response.stream === stream;
}

function rejectRequest(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  req.resume();
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error }));
}

function serveCatalog(res: ServerResponse): void {
  const catalogData = {
    data: [
      {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        vendor: "Google",
        model_picker_enabled: true,
        model_info: {
          supported_endpoints: ["/chat/completions"],
          supported_parameters: ["temperature", "top_p", "response_format"],
          max_input_tokens: 128_000,
          max_output_tokens: 64_000,
          chat_output_token_field: "max_tokens",
        },
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        vendor: "OpenAI",
        model_picker_enabled: true,
        model_info: {
          supported_endpoints: ["/responses"],
          supported_parameters: ["temperature", "top_p", "response_format"],
          max_input_tokens: 128_000,
          max_output_tokens: 128_000,
        },
      },
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        vendor: "Anthropic",
        model_picker_enabled: true,
        model_info: {
          supported_endpoints: ["/messages"],
          supported_parameters: ["temperature", "top_p"],
          max_input_tokens: 128_000,
          max_output_tokens: 16_384,
          default_output_tokens: 4_096,
        },
      },
    ],
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(catalogData));
}
