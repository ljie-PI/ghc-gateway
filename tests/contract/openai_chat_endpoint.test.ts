import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory, type BoundAccount } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import type { BoundCopilot, CopilotBackend, CopilotTarget } from "../../src/copilot/backend.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import { CopilotModelCatalog, type CapiModelsResponse } from "../../src/copilot/model_catalog.js";
import { InvalidUpstreamResponseError, UpstreamTimeoutError } from "../../src/copilot/transport.js";
import { defaultRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createOpenAiChatRoute } from "../../src/protocols/openai_chat/endpoint.js";
import type {
  NativeResponsesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "../../src/copilot/upstream_types.js";
import type { ChatRequest, ChatResponse } from "../../src/protocols/chat_completions/types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nowMs = (): number => 1_700_000_000_000;

class CapturingCopilotBackend implements CopilotBackend {
  readonly chatRequests: ChatRequest[] = [];
  readonly chatStreamRequests: ChatRequest[] = [];

  constructor(
    private readonly options: {
      readonly chat?: ChatResponse;
      readonly chatError?: unknown;
      readonly chatPromise?: Promise<ChatResponse>;
      readonly chatStream?: UpstreamByteStream;
    },
  ) {}

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const target: CopilotTarget = { endpoint: "https://api.githubcopilot.com", token: "scripted-token" };
    return {
      accountId: account.accountId,
      target,
      completeChat: async (request) => {
        this.chatRequests.push(request);
        if (this.options.chatError !== undefined) {
          throw this.options.chatError;
        }
        if (this.options.chatPromise !== undefined) {
          return await withScriptedFirstByteTimeout(this.options.chatPromise, request.firstByteTimeoutMs);
        }
        if (this.options.chat === undefined) {
          throw new Error("missing scripted chat response");
        }
        return this.options.chat;
      },
      openChatStream: async (request) => {
        this.chatStreamRequests.push(request);
        if (this.options.chatStream === undefined) {
          throw new Error("missing scripted stream response");
        }
        return this.options.chatStream;
      },
      completeResponses: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse> => {
        throw new Error("responses must not be called");
      },
      openResponsesStream: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream> => {
        throw new Error("responses stream must not be called");
      },
      completeMessages: async () => { throw new Error("messages must not be called"); },
      openMessagesStream: async () => { throw new Error("messages stream must not be called"); },
    };
  }

  async close(): Promise<void> {}

  forceClose(): void {}
}

async function openAiGateway(backend: CapturingCopilotBackend, options: {
  readonly preferred?: "valid" | "invalid" | "missing";
  readonly requestId?: string;
  readonly usageUpdates?: unknown[];
  readonly nowMs?: () => number;
  readonly runtime?: RuntimeConfigSnapshot;
  readonly capiError?: CapiFetchError;
  readonly capiFetch?: (signal: AbortSignal) => Promise<CapiModelsResponse>;
  readonly throwingPreferences?: boolean;
} = {}): Promise<{ readonly gw: Gateway; readonly close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-openai-chat-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    nowMs,
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
  const account = await accounts.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "t" },
  });
  if (options.preferred !== "missing") {
    const preference = accounts.preferences.set(account.accountId, {
      modelId: options.preferred === "invalid" ? "missing-model" : "gpt",
      catalogGeneration: 0,
    }, 0);
    if (options.preferred === "invalid") {
      accounts.preferences.markInvalidIfMissing(account.accountId, new Set(["gpt"]), preference.catalogGeneration + 1);
    }
  }
  const capi: CapiModelsResponse = {
    data: [
      { id: "gpt", name: "GPT", vendor: "openai", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } },
      { id: "claude", name: "Claude", vendor: "anthropic", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } },
    ],
  };
  const catalog = new CopilotModelCatalog({
    async fetch(_accountId, signal) {
      if (options.capiError !== undefined) {
        throw options.capiError;
      }
      if (options.capiFetch !== undefined) {
        return await options.capiFetch(signal);
      }
      return capi;
    },
  }, () => new Date("2026-08-30T05:00:00.000Z"));
  const dependencies: { readonly createRequestId?: () => string } = options.requestId === undefined
    ? {}
    : { createRequestId: () => options.requestId ?? "req_test" };
  const routeDependencies = {
    directory: accounts,
    catalog,
    copilot: backend,
    ...(options.throwingPreferences
      ? {
        preferences: {
          get: () => {
            throw new Error("preference state must not be read");
          },
        },
      }
      : {}),
    ...(options.usageUpdates === undefined
      ? {}
      : {
        usageRecorder: {
          recordUsage: (update: unknown): void => {
            options.usageUpdates?.push(update);
          },
        },
      }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  };
  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
  }, [createOpenAiChatRoute(routeDependencies)], dependencies);
  return {
    gw,
    close: async () => {
      await gw.close();
      closeDatabase(database);
    },
  };
}

function jsonRequest(body: string): Request {
  return new Request("http://127.0.0.1:31400/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "******",
      "x-request-id": "client",
    },
    body,
  });
}

describe("OpenAI Chat endpoint", () => {
  it("returns an explicit configuration error for unknown native capabilities without inference", async () => {
    const backend = new CapturingCopilotBackend({});
    const harness = await openAiGateway(backend, {
      capiFetch: async () => ({
        data: [{ id: "unknown", name: "Unknown", vendor: "test", model_picker_enabled: true }],
      }),
    });
    try {
      const response = await harness.gw.fetch(jsonRequest("{\"model\":\"unknown\",\"messages\":[]}"));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { message: "model native protocol capability is not configured" },
      });
      expect(backend.chatRequests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("registers only the exact route", async () => {
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      for (const url of ["/chat/completions", "/v1/chat/completions/", "/openai/v1/chat/completions"]) {
        const response = await gw.fetch(new Request(`http://127.0.0.1:31400${url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }));
        expect(response.status, url).toBe(404);
      }
    } finally {
      await close();
    }
  });

  it("preserves non-owned fields while rewriting the explicit model", async () => {
    const usageUpdates: unknown[] = [];
    let now = 1_000;
    const backend = new CapturingCopilotBackend({
      chat: {
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        body: encoder.encode("{\"z\":-0,\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":3}}}"),
      },
    });
    const { gw, close } = await openAiGateway(backend, {
      requestId: "req_generated",
      usageUpdates,
      nowMs: () => {
        now += 5;
        return now;
      },
      throwingPreferences: true,
    });
    try {
      const response = await gw.fetch(jsonRequest([
        "{\"unknown\":1e+2,",
        "\"stream\":false,",
        "\"model\":\"gpt\",",
        "\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
      ].join("")));
      expect(response.status).toBe(201);
      expect(response.headers.get("x-request-id")).toBe("req_generated");
      expect(await response.text()).toBe("{\"z\":-0,\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":3}}}");
      expect(decoder.decode(backend.chatRequests[0]?.body)).toBe(
        "{\"unknown\":1e+2,\"stream\":false,\"model\":\"gpt\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
      );
      expect(backend.chatRequests[0]?.hasVisionInput).toBe(false);
      expect(usageUpdates).toMatchObject([{
        accountId: "github.com/1",
        protocol: "openai_chat",
        resolvedModel: "gpt",
        outcome: "success",
        inputTokens: 1,
        outputTokens: 2,
        cacheTokens: 3,
      }]);
    } finally {
      await close();
    }
  });

  it("appends a valid preferred model when model is missing", async () => {
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"messages\":[]}"));
      expect(response.status).toBe(200);
      expect(decoder.decode(backend.chatRequests[0]?.body)).toBe("{\"messages\":[],\"model\":\"gpt\"}");
    } finally {
      await close();
    }
  });

  it("rejects duplicate top-level keys, invalid preference, and unknown explicit models before chat", async () => {
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
    });
    const { gw, close } = await openAiGateway(backend, { preferred: "invalid", requestId: "req_error" });
    try {
      const duplicate = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"\\u006dodel\":\"gpt\"}"));
      expect(duplicate.status).toBe(400);
      expect(await duplicate.text()).toBe(
        "{\"error\":{\"message\":\"invalid request\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":null}}",
      );

      const missing = await gw.fetch(jsonRequest("{\"messages\":[]}"));
      expect(missing.status).toBe(400);

      const unknown = await gw.fetch(jsonRequest("{\"model\":\"unknown\",\"messages\":[]}"));
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe(
        "{\"error\":{\"message\":\"model not found\",\"type\":\"not_found_error\",\"param\":null,\"code\":null}}",
      );
      expect(backend.chatRequests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("injects stream usage options in place and detects vision without mutating content", async () => {
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: streamFromText("data: [DONE]\n\n", 1),
        cancel: async () => undefined,
      },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest([
        "{\"model\":\"gpt\",",
        "\"stream_options\":{\"a\":1,\"include_usage\":false,\"z\":-0},",
        "\"stream\":true,",
        "\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,aa\"}}]}]}",
      ].join("")));
      expect(await response.text()).toBe("data: [DONE]\n\n");
      expect(backend.chatStreamRequests[0]?.hasVisionInput).toBe(true);
      expect(decoder.decode(backend.chatStreamRequests[0]?.body)).toBe(
        "{\"model\":\"gpt\",\"stream_options\":{\"a\":1,\"include_usage\":true,\"z\":-0},\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,aa\"}}]}]}",
      );
    } finally {
      await close();
    }
  });

  it("rejects stream-true non-object stream_options", async () => {
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: streamFromText("data: [DONE]\n\n", 8),
        cancel: async () => undefined,
      },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"stream\":true,\"stream_options\":null}"));
      expect(response.status).toBe(400);
      expect(backend.chatStreamRequests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rebuilds upstream HTTP failures safely with Retry-After only for 429", async () => {
    const backend = new CapturingCopilotBackend({
      chat: {
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        body: encoder.encode("{\"secret\":\"nope\"}"),
      },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("120");
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream request failed\",\"type\":\"rate_limit_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("keeps valid HTTP-date Retry-After values on upstream 429", async () => {
    const backend = new CapturingCopilotBackend({
      chat: {
        status: 429,
        headers: new Headers({ "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" }),
        body: encoder.encode("{\"secret\":\"nope\"}"),
      },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("Sun, 06 Nov 1994 08:49:37 GMT");
    } finally {
      await close();
    }
  });

  it("drops invalid catalog Retry-After values on 429", async () => {
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
    });
    const { gw, close } = await openAiGateway(backend, { capiError: new CapiFetchError(429, "120, 240") });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(backend.chatRequests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("preserves CAPI timeout and invalid-response failure categories", async () => {
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
    });
    const timeoutGateway = await openAiGateway(backend, {
      capiError: new CapiFetchError(502, undefined, "upstream_timeout"),
    });
    try {
      const response = await timeoutGateway.gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream request failed\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await timeoutGateway.close();
    }

    const invalidGateway = await openAiGateway(backend, {
      capiError: new CapiFetchError(502, undefined, "invalid_upstream_response"),
    });
    try {
      const response = await invalidGateway.gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await invalidGateway.close();
    }
  });

  it("classifies malformed upstream redirects as a safe invalid response", async () => {
    const backend = new CapturingCopilotBackend({
      chatError: new InvalidUpstreamResponseError(),
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("rejects invalid upstream non-stream bodies before success", async () => {
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("[]") },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("enforces non-stream upstream body limit at the inclusive boundary", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.limits.nonstreamBodyBytes = 1_048_576;
    const boundary = exactJsonObjectBytes(runtime.limits.nonstreamBodyBytes);
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: boundary },
    });
    const { gw, close } = await openAiGateway(backend, { runtime });
    try {
      const ok = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(ok.status).toBe(200);
      expect((await ok.arrayBuffer()).byteLength).toBe(runtime.limits.nonstreamBodyBytes);
    } finally {
      await close();
    }
  });

  it("rejects non-stream upstream bodies over the captured limit", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.limits.nonstreamBodyBytes = 1_048_576;
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: exactJsonObjectBytes(runtime.limits.nonstreamBodyBytes + 1) },
    });
    const { gw, close } = await openAiGateway(backend, { runtime });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(502);
    } finally {
      await close();
    }
  });

  it("suppresses duplicate usage counters from telemetry without mutating wire data", async () => {
    const usageUpdates: unknown[] = [];
    const backend = new CapturingCopilotBackend({
      chat: {
        status: 200,
        headers: new Headers(),
        body: encoder.encode("{\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"prompt_tokens\":2,\"completion_tokens\":3}}"),
      },
    });
    const { gw, close } = await openAiGateway(backend, { usageUpdates });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(await response.text()).toBe("{\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"prompt_tokens\":2,\"completion_tokens\":3}}");
      expect(usageUpdates).toMatchObject([{ inputTokens: 0, outputTokens: 3, cacheTokens: 0 }]);
    } finally {
      await close();
    }
  });

  it("uses the OpenAI presenter for queue overload without Retry-After", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    let release!: (response: ChatResponse) => void;
    const chatPromise = new Promise<ChatResponse>((resolve) => {
      release = resolve;
    });
    const backend = new CapturingCopilotBackend({ chatPromise });
    const { gw, close } = await openAiGateway(backend, { runtime, requestId: "req_queue" });
    try {
      const first = gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      for (let index = 0; index < 50 && backend.chatRequests.length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(backend.chatRequests).toHaveLength(1);
      const second = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBeNull();
      expect(await second.text()).toBe(
        "{\"error\":{\"message\":\"server overloaded\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
      release({ status: 200, headers: new Headers(), body: encoder.encode("{}") });
      expect((await first).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("maps first-byte timeout to the OpenAI upstream timeout presenter", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1;
    const backend = new CapturingCopilotBackend({
      chatPromise: new Promise<ChatResponse>(() => undefined),
    });
    const { gw, close } = await openAiGateway(backend, { runtime, requestId: "req_timeout" });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("maps total timeout before commit to the OpenAI upstream timeout presenter", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.totalMs = 1;
    const backend = new CapturingCopilotBackend({
      chat: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
    });
    const { gw, close } = await openAiGateway(backend, {
      runtime,
      requestId: "req_total_timeout",
      capiFetch: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        return { data: [] };
      },
    });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\"}"));
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("does not let SSE comments bypass the first payload timeout", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.firstByteMs = 1;
    runtime.timeouts.streamIdleMs = 60_000;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: hangingStreamAfter(": keepalive\n\n"),
        cancel: async () => undefined,
      },
    });
    const { gw, close } = await openAiGateway(backend, { runtime });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"stream\":true}"));
      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "{\"error\":{\"message\":\"upstream timeout\",\"type\":\"api_error\",\"param\":null,\"code\":null}}",
      );
    } finally {
      await close();
    }
  });

  it("accepts an upstream SSE event at the inclusive event limit", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.limits.sseEventBytes = 65_536;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: streamFromText(`${exactSseEventText(runtime.limits.sseEventBytes)}data: [DONE]\n\n`, 65_536),
        cancel: async () => undefined,
      },
    });
    const { gw, close } = await openAiGateway(backend, { runtime });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"stream\":true}"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("data: [DONE]\n\n");
    } finally {
      await close();
    }
  });

  it("rejects an upstream SSE event over the captured event limit", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.limits.sseEventBytes = 65_536;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: streamFromText(exactSseEventText(runtime.limits.sseEventBytes + 1), 65_536),
        cancel: async () => undefined,
      },
    });
    const { gw, close } = await openAiGateway(backend, { runtime });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"stream\":true}"));
      expect(response.status).toBe(502);
    } finally {
      await close();
    }
  });

  it("closes a committed stream on idle timeout without synthesizing Done", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.streamIdleMs = 1;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: hangingStreamAfter("data: {\"choices\":[]}\n\n"),
        cancel: async () => undefined,
      },
    });
    const { gw, close } = await openAiGateway(backend, { runtime });
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"stream\":true}"));
      const reader = response.body?.getReader();
      const first = await reader?.read();
      expect(decoder.decode(first?.value)).toBe("data: {\"choices\":[]}\n\n");
      await expect(reader?.read()).rejects.toThrow(/stream error/u);
    } finally {
      await close();
    }
  });

  it("cancels invalid 2xx stream bodies before returning a pre-commit error", async () => {
    let canceled = false;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: {
          async *[Symbol.asyncIterator]() {
            try {
              yield encoder.encode("data: []\n\n");
            } finally {
              canceled = true;
            }
          },
        },
        cancel: async () => {
          canceled = true;
        },
      },
    });
    const { gw, close } = await openAiGateway(backend);
    try {
      const response = await gw.fetch(jsonRequest("{\"model\":\"gpt\",\"stream\":true}"));
      expect(response.status).toBe(502);
      expect(canceled).toBe(true);
    } finally {
      await close();
    }
  });

  it("writes zero bytes when the client aborts before the first stream payload", async () => {
    let canceled = false;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: cancelableBytes(() => {
          canceled = true;
        }),
        cancel: async () => {
          canceled = true;
        },
      },
    });
    const { gw, close } = await openAiGateway(backend);
    const controller = new AbortController();
    try {
      const pending = gw.fetch(new Request("http://127.0.0.1:31400/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"model\":\"gpt\",\"stream\":true}",
        signal: controller.signal,
      }));
      for (let index = 0; index < 20 && backend.chatStreamRequests.length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.abort();
      const response = await pending;
      expect(await response.text()).toBe("");
      for (let index = 0; index < 20 && !canceled; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(canceled).toBe(true);
    } finally {
      await close();
    }
  });

  it("writes no Done or error frame after a committed stream is aborted", async () => {
    let canceled = false;
    const backend = new CapturingCopilotBackend({
      chatStream: {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: cancelableBytes(() => {
          canceled = true;
        }, encoder.encode("data: {\"choices\":[]}\n\n")),
        cancel: async () => {
          canceled = true;
        },
      },
    });
    const { gw, close } = await openAiGateway(backend);
    const controller = new AbortController();
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"model\":\"gpt\",\"stream\":true}",
        signal: controller.signal,
      }));
      const reader = response.body?.getReader();
      const first = await reader?.read();
      expect(decoder.decode(first?.value)).toBe("data: {\"choices\":[]}\n\n");
      controller.abort();
      const next = await reader?.read().catch(() => ({ done: true, value: undefined }));
      expect(next?.value === undefined ? "" : decoder.decode(next.value)).not.toContain("[DONE]");
      for (let index = 0; index < 20 && !canceled; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(canceled).toBe(true);
    } finally {
      await close();
    }
  });
});

async function* streamFromText(text: string, split: number): AsyncIterable<Uint8Array> {
  const bytes = encoder.encode(text);
  for (let index = 0; index < bytes.byteLength; index += split) {
    yield bytes.slice(index, index + split);
  }
}

async function* hangingStreamAfter(text: string): AsyncIterable<Uint8Array> {
  yield encoder.encode(text);
  await new Promise<void>(() => undefined);
}

function cancelableBytes(onCancel: () => void, first?: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let sentFirst = first === undefined;
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          if (!sentFirst && first !== undefined) {
            sentFirst = true;
            return { done: false, value: first };
          }
          await new Promise<void>(() => undefined);
          return { done: true, value: undefined };
        },
        return: async (): Promise<IteratorResult<Uint8Array>> => {
          onCancel();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function exactJsonObjectBytes(size: number): Uint8Array {
  return encoder.encode(`{"x":"${"x".repeat(size - 8)}"}`);
}

function exactSseEventText(size: number): string {
  const prefix = "data: {\"choices\":[],\"x\":\"";
  const suffix = "\"}\n\n";
  return `${prefix}${"x".repeat(size - prefix.length - suffix.length)}${suffix}`;
}

async function withScriptedFirstByteTimeout(
  response: Promise<ChatResponse>,
  ms: number | undefined,
): Promise<ChatResponse> {
  if (ms === undefined) {
    return await response;
  }
  return await Promise.race([
    response,
    new Promise<ChatResponse>((_resolve, reject) => {
      setTimeout(() => reject(new UpstreamTimeoutError()), ms);
    }),
  ]);
}
