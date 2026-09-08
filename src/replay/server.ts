import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReplayExchangeRecord } from "./types.js";

export interface ReplayServerOptions {
  readonly port?: number; // default 31488
  readonly corpusDir: string;
  readonly exchanges: readonly ReplayExchangeRecord[];
}

export interface ReplayReceipt {
  readonly method: string;
  readonly path: string;
  readonly model?: string | undefined;
  readonly stream: boolean;
  readonly matchedCaseId?: string | undefined;
}

export class MockCopilotReplayServer {
  private readonly port: number;
  private readonly corpusDir: string;
  private readonly exchanges: readonly ReplayExchangeRecord[];
  private server: Server | undefined;
  private readonly receipts: ReplayReceipt[] = [];

  constructor(options: ReplayServerOptions) {
    this.port = options.port ?? 31488;
    this.corpusDir = options.corpusDir;
    this.exchanges = options.exchanges;
  }

  get recordedReceipts(): readonly ReplayReceipt[] {
    return this.receipts;
  }

  clearReceipts(): void {
    this.receipts.length = 0;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.destroy();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname;

    // Read full request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);
    let bodyJson: Record<string, unknown> | undefined;
    try {
      if (rawBody.length > 0) {
        bodyJson = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      }
    } catch {
      // not JSON
    }

    const requestedModel = typeof bodyJson?.model === "string" ? bodyJson.model : undefined;
    const isStream = bodyJson?.stream === true;

    // 1. Models catalog endpoints: /v1/models and /models
    if (method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      this.receipts.push({ method, path: pathname, stream: false });
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
      return;
    }

    // 2. Match exchange
    const match = this.exchanges.find((ex) => {
      if (ex.request.method.toUpperCase() !== method) return false;
      if (ex.request.path !== pathname) return false;
      if (ex.logicalModel !== requestedModel && ex.upstreamModel !== requestedModel) return false;
      if (ex.response.stream !== isStream) return false;
      const rawText = rawBody.toString("utf8");

      const isMixed = ex.caseId.includes(".mixed-image-tool.");
      const isParallel = ex.caseId.includes(".parallel-tools.");
      const isPlainImage = ex.caseId.includes(".image.");
      const isToolResult = ex.caseId.includes(".tool-result.");
      const isToolCall = ex.caseId.includes(".tool-call.");
      const isReasoning = ex.caseId.includes(".reasoning-effort.");

      const hasVision = rawText.includes("image");
      const hasToolResult = rawText.includes("function_call_output") || rawText.includes("tool_result") || rawText.includes("\"role\":\"tool\"");
      const hasTools = rawText.includes("tools") || rawText.includes("get_weather");
      const hasParallel = rawText.includes("Paris") || rawText.includes("twice") || rawText.includes("simultaneously");
      const hasReasoning = rawText.includes("quantum") || rawText.includes("reasoning_effort") || rawText.includes("output_config");

      if (isReasoning) {
        return hasReasoning;
      }
      if (isMixed) {
        return hasVision && hasTools && !hasToolResult;
      }
      if (isParallel) {
        return hasParallel && hasTools && !hasToolResult;
      }
      if (isPlainImage) {
        return hasVision && !hasTools;
      }
      if (isToolResult) {
        return hasToolResult;
      }
      if (isToolCall) {
        return hasTools && !hasToolResult && !hasVision && !hasParallel;
      }

      // Plain text case
      return !hasVision && !hasTools && !hasToolResult && !hasReasoning;
    });

    if (!match) {
      this.receipts.push({ method, path: pathname, model: requestedModel, stream: isStream });
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no matching replay exchange for ${method} ${pathname} ${requestedModel} (stream: ${isStream})` }));
      return;
    }

    this.receipts.push({
      method,
      path: pathname,
      model: requestedModel,
      stream: isStream,
      matchedCaseId: match.caseId,
    });

    // Read response payload from file
    const bodyFilePath = path.isAbsolute(match.response.bodyFile)
      ? match.response.bodyFile
      : path.join(this.corpusDir, match.response.bodyFile);
    const bodyBytes = await readFile(bodyFilePath);

    const headers: Record<string, string> = {
      ...match.response.headers,
    };
    if (match.response.stream) {
      headers["content-type"] = "text/event-stream; charset=utf-8";
    } else {
      headers["content-type"] = headers["content-type"] ?? "application/json; charset=utf-8";
      headers["content-length"] = String(bodyBytes.byteLength);
    }

    res.writeHead(match.response.status, headers);
    res.end(bodyBytes);
  }
}
