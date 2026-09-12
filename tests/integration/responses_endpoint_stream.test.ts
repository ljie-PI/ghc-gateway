import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import {
  ScriptedCopilotBackend,
  type BoundCopilot,
  type CopilotBackend,
} from "../../src/copilot/backend.js";
import type {
  NativeResponsesUpstreamRequest,
  UpstreamByteStream,
} from "../../src/copilot/upstream_types.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import type { ResponsesRequest } from "../../src/protocols/responses/dto.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import { testModelCapabilityRegistry } from "../contract/model_capability_registry_harness.js";
import type {
  ResponsesHistory,
  ResponsesHistoryRecord,
  ResponsesReceiptRecord,
} from "../../src/protocols/responses/history.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

const nowMs = (): number => 1_700_000_000_000;

class RecordingHistory implements ResponsesHistory {
  readonly records: ResponsesHistoryRecord[] = [];
  readonly receipts: string[] = [];
  readonly checkpointStates: Array<"partial" | "complete"> = [];
  readonly receiptStates: Array<"route_only" | "partial" | "complete"> = [];

  constructor(
    private readonly failAt?: "receipt" | "checkpoint",
    private readonly beforeCheckpoint?: () => Promise<void>,
  ) {}

  async resolve() {
    return { kind: "none" } as const;
  }

  async enrich(request: Readonly<ResponsesRequest>): Promise<ResponsesRequest> {
    return request as ResponsesRequest;
  }

  async recordReceipt(receipt: Readonly<ResponsesReceiptRecord>): Promise<void> {
    if (this.failAt === "receipt") {
      throw new Error("synthetic receipt failure");
    }
    this.receipts.push(receipt.responseId);
    this.receiptStates.push(receipt.checkpointState);
  }

  async recordCheckpoint(
    record: Readonly<ResponsesHistoryRecord>,
    _ownership: Parameters<ResponsesHistory["recordCheckpoint"]>[1],
    checkpointState: "partial" | "complete",
  ): Promise<void> {
    await this.beforeCheckpoint?.();
    if (this.failAt === "checkpoint") {
      throw new Error("synthetic checkpoint failure");
    }
    this.records.push(record);
    this.checkpointStates.push(checkpointState);
  }
}

describe("Responses endpoint stream integration", () => {
  it("owns native terminal cleanup and admission through the public response body", async () => {
    const wire = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\",\"output\":[],\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":1}}}}\n\n";
    const cancelStarted = deferred<void>();
    const releaseCancel = deferred<void>();
    const counts = { cancel: 0, returned: 0 };
    const source = singleOwnedChunk(bytes(wire), () => {
      counts.returned += 1;
    });
    let streams = 0;
    const backend = withResponsesStream(
      new ScriptedCopilotBackend({ responsesStream: [bytes(wire)] }),
      async (request, fallback) => {
        streams += 1;
        if (streams > 1) {
          return await fallback.openResponsesStream(request);
        }
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          bytes: source,
          cancel: async () => {
            counts.cancel += 1;
            cancelStarted.resolve();
            await releaseCancel.promise;
          },
        };
      },
    );
    const history = new RecordingHistory();
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    const opened = await streamGateway(history, backend, { runtime, usageUpdates });
    try {
      const response = await opened.gateway.fetch(responsesRequest("native"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-request-id")).toBe("req_stream");
      expect(response.headers.get("x-ghcg-upstream-protocol")).toBe("responses");

      const delivered = response.text();
      await cancelStarted.promise;
      expect(counts).toEqual({ cancel: 1, returned: 1 });
      const held = await opened.gateway.fetch(responsesRequest("native"));
      expect(held.status).toBe(503);
      await held.arrayBuffer();

      releaseCancel.resolve();
      expect(await delivered).toBe(wire);
      expect(counts).toEqual({ cancel: 1, returned: 1 });
      expect(usageUpdates.filter((update) => update.outcome === "success")).toMatchObject([{
        protocol: "openai_responses_native",
        outcome: "success",
        inputTokens: 5,
        outputTokens: 2,
        cacheTokens: 1,
      }]);

      const afterRelease = await opened.gateway.fetch(responsesRequest("native"));
      expect(afterRelease.status).toBe(200);
      expect(await afterRelease.text()).toBe(wire);
      expect(usageUpdates.filter((update) => update.outcome === "success")).toHaveLength(2);
    } finally {
      releaseCancel.resolve();
      await opened.close();
    }
  });

  it("commits bridge stream checkpoints before completed bytes reach the caller", async () => {
    const checkpointStarted = deferred<void>();
    const releaseCheckpoint = deferred<void>();
    let checkpointCalls = 0;
    const history = new RecordingHistory(undefined, async () => {
      checkpointCalls += 1;
      if (checkpointCalls === 1) {
        checkpointStarted.resolve();
        await releaseCheckpoint.promise;
      }
    });
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"),
        bytes("data: [DONE]\n\n"),
      ],
    });
    const opened = await streamGateway(history, backend);
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("expected response body");
      }
      let delivered = "";
      const consumption = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            return;
          }
          delivered += new TextDecoder().decode(next.value, { stream: true });
        }
      })();

      await checkpointStarted.promise;
      expect(history.records).toHaveLength(0);
      expect(delivered).not.toContain("response.output_text.done");
      expect(delivered).not.toContain("response.output_item.done");
      expect(delivered).not.toContain("response.completed");

      releaseCheckpoint.resolve();
      await consumption;
      expect(history.receiptStates).toEqual(["route_only"]);
      expect(history.checkpointStates).toEqual(["complete"]);
      expect(history.records).toHaveLength(1);
      expect(delivered).toContain("response.output_item.done");
      expect(delivered).toContain("response.completed");
    } finally {
      releaseCheckpoint.resolve();
      await opened.close();
    }
  });

  it("keeps only the route receipt when the client cancels before a checkpoint forms", async () => {
    const history = new RecordingHistory();
    let returned = 0;
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      chatStream: singleOwnedChunk(
        bytes("data: {\"id\":\"chatcmpl_cancel\",\"choices\":[{\"delta\":{\"content\":\"unfinished\"},\"finish_reason\":null}]}\n\n"),
        () => {
          returned += 1;
        },
      ),
    });
    const opened = await streamGateway(history, backend, { usageUpdates });
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("expected response body");
      }
      let delivered = "";
      while (!delivered.includes("response.output_text.delta")) {
        const next = await reader.read();
        if (next.done) {
          throw new Error("stream ended before the text delta");
        }
        delivered += new TextDecoder().decode(next.value, { stream: true });
      }
      expect(history.receiptStates).toEqual(["route_only"]);
      expect(history.checkpointStates).toEqual([]);
      expect(history.records).toEqual([]);
      expect(delivered).not.toContain("response.output_item.done");
      expect(delivered).not.toContain("response.completed");

      await reader.cancel();
      expect(returned).toBe(1);
      expect(history.receiptStates).toEqual(["route_only"]);
      expect(history.checkpointStates).toEqual([]);
      expect(history.records).toEqual([]);
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ protocol: "openai_responses_bridge", outcome: "aborted" }]);
    } finally {
      await opened.close();
    }
  });

  it.each([
    {
      item: "text",
      upstream: "data: {\"id\":\"chatcmpl_text_truncated\",\"choices\":[{\"delta\":{\"content\":\"unfinished\"},\"finish_reason\":null}]}\n\n",
      progressEvent: "response.output_text.delta",
    },
    {
      item: "tool",
      upstream: "data: {\"id\":\"chatcmpl_tool_truncated\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
      progressEvent: "response.function_call_arguments.delta",
    },
  ])("does not checkpoint an unfinished $item item when the upstream truncates", async ({ upstream, progressEvent }) => {
    const history = new RecordingHistory();
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({ chatStream: [bytes(upstream)] });
    const opened = await streamGateway(history, backend, { usageUpdates });
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      let delivered = "";
      await expect((async () => {
        for (;;) {
          const next = await reader?.read();
          if (next?.done !== false) {
            return;
          }
          delivered += new TextDecoder().decode(next.value, { stream: true });
        }
      })()).rejects.toThrow();

      expect(delivered).toContain(progressEvent);
      expect(delivered).not.toContain("response.output_item.done");
      expect(delivered).not.toContain("response.completed");
      expect(history.receiptStates).toEqual(["route_only"]);
      expect(history.checkpointStates).toEqual([]);
      expect(history.records).toEqual([]);
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ protocol: "openai_responses_bridge", outcome: "upstream_error" }]);
    } finally {
      await opened.close();
    }
  });

  it("fails before exposing a converted response ID when its receipt cannot persist", async () => {
    const history = new RecordingHistory("receipt");
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"),
        bytes("data: [DONE]\n\n"),
      ],
    });

    const opened = await streamGateway(history, backend, { usageUpdates });
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("x-request-id")).toBe("req_stream");
      const body = await response.text();
      expect(body).toContain("response continuation could not be saved");
      expect(body).not.toContain("chatcmpl_stream");
      expect(body).not.toContain("resp_");
      expect(history.receipts).toEqual([]);
      expect(history.records).toEqual([]);
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ protocol: "openai_responses_bridge", outcome: "internal_error" }]);
    } finally {
      await opened.close();
    }
  });

  it.each(["stream", "nonstream"] as const)(
    "fails before exposing a native %s response ID when its receipt cannot persist",
    async (mode) => {
      const history = new RecordingHistory("receipt");
      const backend = mode === "stream"
        ? new ScriptedCopilotBackend({
          responsesStream: [
            bytes("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_native_secret\",\"output\":[]}}\n\n"),
          ],
        })
        : new ScriptedCopilotBackend({
          responses: {
            status: 200,
            headers: new Headers(),
            body: bytes("{\"id\":\"resp_native_secret\",\"output\":[]}"),
          },
        });
      const opened = await streamGateway(history, backend);
      try {
        const response = await opened.gateway.fetch(responsesRequest("native", mode === "stream"));
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain("response continuation could not be saved");
        expect(body).not.toContain("resp_native_secret");
      } finally {
        await opened.close();
      }
    },
  );

  it("does not expose a tool checkpoint event when checkpoint persistence fails", async () => {
    const history = new RecordingHistory("checkpoint");
    const usageUpdates: UsageUpdate[] = [];
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"),
        bytes("data: [DONE]\n\n"),
      ],
    });
    const opened = await streamGateway(history, backend, { usageUpdates });
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      let delivered = "";
      await expect((async () => {
        const reader = response.body?.getReader();
        for (;;) {
          const next = await reader?.read();
          if (next?.done !== false) {
            return;
          }
          delivered += new TextDecoder().decode(next.value);
        }
      })()).rejects.toThrow();
      expect(delivered).toContain("response.created");
      expect(delivered).not.toContain("response.output_item.done");
      expect(delivered).not.toContain("response.completed");
      expect(history.receiptStates).toEqual(["route_only"]);
      expect(history.records).toEqual([]);
      expect(history.checkpointStates).toEqual([]);
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates).toMatchObject([{ protocol: "openai_responses_bridge", outcome: "internal_error" }]);
    } finally {
      await opened.close();
    }
  });

  it("persists tool-only partial and terminal checkpoints through the typed checkpoint path", async () => {
    const history = new RecordingHistory();
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"),
        bytes("data: [DONE]\n\n"),
      ],
    });
    const opened = await streamGateway(history, backend);
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(history.receiptStates).toEqual(["route_only"]);
      expect(history.checkpointStates).toEqual(["partial", "complete"]);
      expect(history.records).toHaveLength(2);
      expect(history.records[0]?.output).toHaveLength(1);
      expect(history.records[1]?.output).toEqual(history.records[0]?.output);
    } finally {
      await opened.close();
    }
  });
});

async function streamGateway(
  history: ResponsesHistory,
  backend: CopilotBackend,
  options: {
    readonly runtime?: ReturnType<typeof defaultRuntimeConfigSnapshot>;
    readonly usageUpdates?: UsageUpdate[];
  } = {},
): Promise<{ readonly gateway: Awaited<ReturnType<typeof createGateway>>; close(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-responses-stream-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    nowMs,
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), nowMs);
  await accounts.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "t" },
  });
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return {
        data: [{
          id: "chat",
          name: "Chat",
          vendor: "github",
          model_picker_enabled: true,
          model_info: {
            supported_endpoints: ["/chat/completions"],
            chat_output_token_field: "max_tokens",
          },
        }, {
          id: "native",
          name: "Native",
          vendor: "github",
          model_picker_enabled: true,
          model_info: { supported_endpoints: ["/responses"] },
        }],
      };
    },
  });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
  }, [createResponsesRoute({
    directory: accounts,
    registry: testModelCapabilityRegistry(catalog),
    preferences: accounts.preferences,
    copilot: backend,
    history,
    nowUnixSeconds: () => 1_700_000_000,
    createUuid: () => "00000000-0000-4000-8000-000000000001",
    ...(options.usageUpdates === undefined
      ? {}
      : { usageRecorder: { recordUsage: (update: UsageUpdate) => options.usageUpdates?.push(update) } }),
  })], { createRequestId: () => "req_stream" });
  return {
    gateway,
    async close() {
      await gateway.close();
      closeDatabase(database);
    },
  };
}

function responsesRequest(model = "chat", stream = true): Request {
  return new Request("http://127.0.0.1:31400/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hi", stream }),
  });
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function singleOwnedChunk(chunk: Uint8Array, onReturn: () => void): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let emitted = false;
      let returned = false;
      const pending = deferred<IteratorResult<Uint8Array>>();
      return {
        async next() {
          if (!emitted) {
            emitted = true;
            return { done: false, value: chunk };
          }
          return await pending.promise;
        },
        async return() {
          if (!returned) {
            returned = true;
            onReturn();
            pending.resolve({ done: true, value: undefined });
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function withResponsesStream(
  backend: ScriptedCopilotBackend,
  open: (
    request: NativeResponsesUpstreamRequest,
    fallback: BoundCopilot,
  ) => Promise<UpstreamByteStream>,
): CopilotBackend {
  return {
    async bind(account, signal) {
      const bound = await backend.bind(account, signal);
      return {
        ...bound,
        openResponsesStream: async (request) => await open(request, bound),
      };
    },
    async close() {
      await backend.close();
    },
    forceClose() {
      backend.forceClose();
    },
  };
}
