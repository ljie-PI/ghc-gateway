import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { describe, expect, it, vi } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { parseLiveModelCapabilities } from "../../src/copilot/model_capabilities.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as historyMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as continuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { createAnthropicMessagesRoute } from "../../src/protocols/anthropic_messages/endpoint.js";
import { createModelCatalogRoutes } from "../../src/protocols/model_catalog/routes.js";
import { createOpenAiChatRoute } from "../../src/protocols/openai_chat/endpoint.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";

const nowMs = (): number => 1_700_000_000_000;
const encoder = new TextEncoder();

describe("effective capability authority", () => {
  it("uses one shared registry snapshot per model and inference request", async () => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [
        embedMigration(runtimeConfigMigration),
        embedMigration(accountsMigration),
        embedMigration(historyMigration),
        embedMigration(continuationMigration),
      ],
      nowMs,
    });
    const directory = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), nowMs);
    const account = await directory.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "test-token" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return { data: [{
          id: "authority",
          name: "Authority",
          vendor: "test",
          model_picker_enabled: true,
          model_info: {
            supported_endpoints: ["/v1/responses"],
            max_input_tokens: 100_000,
            max_output_tokens: 12_000,
          },
        }] };
      },
    }, () => new Date(nowMs()));
    const registry = new ModelCapabilityRegistry(catalog, {
      get: (modelId) => modelId === "authority" ? {
        revision: "builtin-authority-v1",
        capabilities: parseLiveModelCapabilities({
          supported_endpoints: ["/v1/chat/completions"],
          max_input_tokens: 64_000,
          max_output_tokens: 16_000,
          chat_output_token_field: "max_tokens",
        }),
      } : null,
    });
    const snapshot = await registry.get(account, new AbortController().signal);
    expect(snapshot.models[0]).toMatchObject({
      modelId: "authority",
      protocols: { value: ["responses"], source: "live", conflict: true },
      maxInputTokens: { value: 100_000, source: "live", conflict: true },
      maxOutputTokens: { value: 12_000, source: "live", conflict: true },
      revision: { builtinRevision: "builtin-authority-v1" },
    });

    const backend = new ScriptedCopilotBackend({
      responses: {
        status: 200,
        headers: new Headers(),
        body: encoder.encode(JSON.stringify({
          id: "resp_authority",
          object: "response",
          created_at: 1_700_000_000,
          status: "completed",
          output: [{
            id: "msg_authority",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        })),
      },
    });
    const history = new SqliteResponsesHistory(database, { nowMs });
    const shared = {
      directory,
      registry,
      preferences: directory.preferences,
      copilot: backend,
    };
    const get = vi.spyOn(registry, "get");
    const gateway = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "." }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [
      ...createModelCatalogRoutes(shared),
      createOpenAiChatRoute(shared),
      createAnthropicMessagesRoute(shared),
      createResponsesRoute({ ...shared, history }),
    ], { createRequestId: () => "req_authority", onClose: () => registry.close() });
    try {
      const models = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(models.status).toBe(200);
      expect(await models.json()).toMatchObject({
        data: [{ id: "authority", max_input_tokens: 100_000, max_output_tokens: 12_000 }],
      });
      const chat = await gateway.fetch(jsonRequest("/v1/chat/completions", {
        model: "authority",
        messages: [{ role: "user", content: "hello" }],
      }));
      expect(chat.status).toBe(200);
      const messages = await gateway.fetch(jsonRequest("/v1/messages", {
        model: "authority",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }, { "anthropic-version": "2023-06-01" }));
      expect(messages.status).toBe(200);
      const responses = await gateway.fetch(jsonRequest("/v1/responses", {
        model: "authority",
        input: "hello",
      }));
      expect(responses.status).toBe(200);

      expect(get).toHaveBeenCalledTimes(4);
      expect(get.mock.calls.every(([bound]) => bound.accountId === account.accountId)).toBe(true);
      expect(backend.captured).toEqual([
        { accountId: account.accountId, kind: "responses" },
        { accountId: account.accountId, kind: "responses" },
        { accountId: account.accountId, kind: "responses" },
      ]);
    } finally {
      await gateway.close();
      closeDatabase(database);
    }
  });
});

function jsonRequest(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:31400${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
