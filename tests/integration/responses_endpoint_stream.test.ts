import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { withSetupCleanup, startHttpCopilot, closeAll, jsonStream, waitForHttp, assertTransportReleased } from "../../scripts/tooling/test_support/http_copilot.js";
import type { HttpExpectation } from "../../scripts/tooling/test_support/copilot_http.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import type { ResponsesRequest } from "../../src/protocols/openai_responses/dto.js";
import { createOpenaiResponsesRoute } from "../../src/protocols/openai_responses/endpoint.js";
import { testModelCapabilityRegistry } from "../contract/model_capability_registry_harness.js";
import type {
  ResponsesHistory,
  ResponsesHistoryRecord,
  ResponsesReceiptRecord,
} from "../../src/protocols/openai_responses/history.js";
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/responses", body: jsonStream(true), times: 2,
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
        await exchange.write(bytes(wire));
        await exchange.waitForClose();
      } },
    }];
    const history = new RecordingHistory();
    const usageUpdates: UsageUpdate[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    const opened = await streamGateway(history, expectations, { runtime, usageUpdates });
    try {
      const response = await opened.gateway.fetch(responsesRequest("native"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-request-id")).toBe("req_stream");
      expect(response.headers.get("x-ghcg-upstream-protocol")).toBe("responses");

      expect(await response.text()).toBe(wire);
      await waitForHttp(() => opened.upstream.streams[0]?.closed === true);
      expect(opened.upstream.streams[0]?.ended).toBe(false);
      assertTransportReleased(opened.backend);
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
      await waitForHttp(() => opened.upstream.streams[1]?.closed === true);
      assertTransportReleased(opened.backend);
      opened.upstream.assertSatisfied();
    } finally {
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"),
      bytes("data: [DONE]\n\n"),
    ]) } }];
    const opened = await streamGateway(history, expectations);
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
    const usageUpdates: UsageUpdate[] = [];
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true),
      reply: { headers: { "content-type": "text/event-stream" }, stream: async (exchange) => {
        await exchange.write(bytes("data: {\"id\":\"chatcmpl_cancel\",\"choices\":[{\"delta\":{\"content\":\"unfinished\"},\"finish_reason\":null}]}\n\n"));
        await exchange.waitForClose();
      } },
    }];
    const opened = await streamGateway(history, expectations, { usageUpdates });
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
      await waitForHttp(() => opened.upstream.streams[0]?.closed === true);
      expect(opened.upstream.streams[0]?.ended).toBe(false);
      assertTransportReleased(opened.backend);
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([bytes(upstream)]) } }];
    const opened = await streamGateway(history, expectations, { usageUpdates });
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"),
      bytes("data: [DONE]\n\n"),
    ]) } }];

    const opened = await streamGateway(history, expectations, { usageUpdates });
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
      const expectations: HttpExpectation[] = mode === "stream"
        ? [{ method: "POST", path: "/responses", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
          bytes("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_native_secret\",\"output\":[]}}\n\n"),
        ]) } }]
        : [{ method: "POST", path: "/responses", body: jsonStream(false), reply: {
          status: 200,
          headers: {},
          body: bytes("{\"id\":\"resp_native_secret\",\"output\":[]}"),
        } }];
      const opened = await streamGateway(history, expectations);
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"),
      bytes("data: [DONE]\n\n"),
    ]) } }];
    const opened = await streamGateway(history, expectations, { usageUpdates });
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
    const expectations: HttpExpectation[] = [{ method: "POST", path: "/chat/completions", body: jsonStream(true), reply: { headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
      bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"),
      bytes("data: [DONE]\n\n"),
    ]) } }];
    const opened = await streamGateway(history, expectations);
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
  expectations: readonly HttpExpectation[],
  options: {
    readonly runtime?: ReturnType<typeof defaultRuntimeConfigSnapshot>;
    readonly usageUpdates?: UsageUpdate[];
  } = {},
) {
  return await withSetupCleanup(async (own) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-responses-stream-"));
    own(() => rm(dir, { recursive: true, force: true }));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    own(() => closeDatabase(database));
    const credentials = new MemoryCredentialStore();
    const accountCoordinator = new AccountCoordinator();
    const accounts = new AccountDirectory(database, credentials, accountCoordinator, nowMs);
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
    const http = await startHttpCopilot({ credentials, accountCoordinator, nowMs, expectations });
    own(() => http.close());
    const registry = testModelCapabilityRegistry(catalog);
    own(() => registry.close());
    const gateway = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
    }, [createOpenaiResponsesRoute({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
      copilot: http.backend,
      history,
      nowUnixSeconds: () => 1_700_000_000,
      createUuid: () => "00000000-0000-4000-8000-000000000001",
      ...(options.usageUpdates === undefined
        ? {}
        : { usageRecorder: { recordUsage: (update: UsageUpdate) => options.usageUpdates?.push(update) } }),
    })], { createRequestId: () => "req_stream" });
    own(() => gateway.close());
    return {
      gateway, upstream: http.upstream, backend: http.backend,
      async close() {
        await closeAll([() => gateway.close(), () => registry.close(), () => http.close(), () => closeDatabase(database), () => rm(dir, { recursive: true, force: true })]);
      },
    };
  });
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
