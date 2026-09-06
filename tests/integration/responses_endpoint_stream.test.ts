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
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import type { ResponsesHistory, ResponsesHistoryRecord } from "../../src/protocols/responses/history.js";
import type { ResponsesRequest } from "../../src/protocols/responses/dto.js";

const nowMs = (): number => 1_700_000_000_000;

class RecordingHistory implements ResponsesHistory {
  readonly records: ResponsesHistoryRecord[] = [];

  async enrich(request: Readonly<ResponsesRequest>): Promise<ResponsesRequest> {
    return request as ResponsesRequest;
  }

  async record(record: Readonly<ResponsesHistoryRecord>): Promise<void> {
    this.records.push(record);
  }
}

describe("Responses endpoint stream integration", () => {
  it("commits bridge stream checkpoints before completed bytes reach the caller", async () => {
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
        return { data: [{ id: "chat", name: "Chat", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } }] };
      },
    });
    const history = new RecordingHistory();
    const backend = new ScriptedCopilotBackend({
      chatStream: [
        bytes("data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n"),
        bytes("data: [DONE]\n\n"),
      ],
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
    try {
      const response = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chat", input: "hi", stream: true }),
      }));
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
      await reader.cancel();
    } finally {
      await gateway.close();
      closeDatabase(database);
    }
  });

  function bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  }
});
