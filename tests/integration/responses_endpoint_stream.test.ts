import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
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
import type {
  ResponsesHistory,
  ResponsesHistoryRecord,
  ResponsesReceiptRecord,
} from "../../src/protocols/responses/history.js";

const nowMs = (): number => 1_700_000_000_000;

class RecordingHistory implements ResponsesHistory {
  readonly records: ResponsesHistoryRecord[] = [];
  readonly receipts: string[] = [];
  readonly checkpointStates: Array<"partial" | "complete"> = [];
  readonly receiptStates: Array<"route_only" | "partial" | "complete"> = [];

  constructor(private readonly failAt?: "receipt" | "checkpoint") {}

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
    if (this.failAt === "checkpoint") {
      throw new Error("synthetic checkpoint failure");
    }
    this.records.push(record);
    this.checkpointStates.push(checkpointState);
  }
}

describe("Responses endpoint stream integration", () => {
  it("commits bridge stream checkpoints before completed bytes reach the caller", async () => {
    const history = new RecordingHistory();
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
      let seenCompletedItem = false;
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        const text = new TextDecoder().decode(next.value);
        if (text.includes("response.output_item.done")) {
          expect(history.records.length).toBeGreaterThan(0);
          seenCompletedItem = true;
          break;
        }
      }
      expect(seenCompletedItem).toBe(true);
      expect(history.receipts).toHaveLength(1);
      await reader.cancel();
    } finally {
      await opened.close();
    }
  });

  it("fails before exposing a converted response ID when its receipt cannot persist", async () => {
    const history = new RecordingHistory("receipt");
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"),
        bytes("data: [DONE]\n\n"),
      ],
    });

    const opened = await streamGateway(history, backend);
    try {
      const response = await opened.gateway.fetch(responsesRequest());
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("response continuation could not be saved");
      expect(body).not.toContain("chatcmpl_stream");
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
      expect(history.receipts).toHaveLength(1);
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
      expect(history.records[1]?.output).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});

async function streamGateway(
  history: ResponsesHistory,
  backend: ScriptedCopilotBackend,
): Promise<{ readonly gateway: Awaited<ReturnType<typeof createGateway>>; close(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-responses-stream-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    nowMs,
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
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
    runtime: defaultRuntimeConfigSnapshot(),
  }, [createResponsesRoute({
    directory: accounts,
    catalog,
    preferences: accounts.preferences,
    copilot: backend,
    history,
    nowUnixSeconds: () => 1_700_000_000,
    createUuid: () => "00000000-0000-4000-8000-000000000001",
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
