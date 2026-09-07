import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog, type CapiModelsResponse } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type Gateway, type GatewayDependencies } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createAnthropicMessagesRoute } from "../../src/protocols/anthropic_messages/endpoint.js";
import type { RuntimeConfigSnapshot } from "../../src/config/schema.js";
import type { ChatRequest } from "../../src/protocols/chat_completions/types.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

export const ACCOUNT_ID = "github.com/1";

const nowMs = (): number => 1_700_000_000_000;

export interface AnthropicGatewayFixture {
  readonly gw: Gateway;
  readonly backend: ScriptedCopilotBackend;
  readonly capturedRequests: ChatRequest[];
  close(): Promise<void>;
}

export async function anthropicGateway(options: {
  readonly backend?: ScriptedCopilotBackend;
  readonly runtime?: RuntimeConfigSnapshot;
  readonly gatewayDependencies?: Readonly<GatewayDependencies>;
  readonly preferredModel?: string;
  readonly createUuid?: () => string;
  readonly catalogFetch?: () => Promise<CapiModelsResponse> | CapiModelsResponse;
  readonly usageUpdates?: UsageUpdate[];
  readonly telemetryNowMs?: () => number;
} = {}): Promise<AnthropicGatewayFixture> {
  const database = openDatabase({
    path: ":memory:",
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
      return options.catalogFetch?.() ?? {
        data: [
          { id: "gpt", name: "GPT", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } },
          { id: "o1", name: "O1", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_completion_tokens" } },
          { id: "gpt-5", name: "GPT 5", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], supported_parameters: ["reasoning_effort"], supported_reasoning_efforts: ["xhigh"], chat_output_token_field: "max_tokens" } },
          { id: "deepseek-reasoner", name: "DeepSeek", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } },
        ],
      };
    },
  }, () => new Date("2026-01-02T03:04:05.000Z"));

  if (options.preferredModel !== undefined) {
    accounts.preferences.set(ACCOUNT_ID, { modelId: options.preferredModel, catalogGeneration: 0 }, 0);
  }

  const capturedRequests: ChatRequest[] = [];
  const backend = options.backend ?? new ScriptedCopilotBackend({
    chat(request) {
      capturedRequests.push(request);
      return {
        status: 200,
        headers: new Headers(),
        body: new TextEncoder().encode(JSON.stringify({
          id: "chatcmpl_1",
          model: "gpt",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        })),
      };
    },
    chatStream: [new TextEncoder().encode("data: [DONE]\n\n")],
  });

  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:\\ghc-gateway-tests\\anthropic\\.test-home" }),
    runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
  }, [createAnthropicMessagesRoute({
    directory: accounts,
    catalog,
    preferences: accounts.preferences,
    copilot: backend,
    createUuid: options.createUuid ?? (() => "00000000-0000-4000-8000-000000000001"),
    ...(options.usageUpdates === undefined
      ? {}
      : { usageRecorder: { recordUsage: (update: UsageUpdate) => options.usageUpdates?.push(update) } }),
    ...(options.telemetryNowMs === undefined ? {} : { nowMs: options.telemetryNowMs }),
  })], {
    createRequestId: () => "req_test_1",
    ...options.gatewayDependencies,
  });

  return {
    gw,
    backend,
    capturedRequests,
    async close() {
      await gw.close();
      closeDatabase(database);
    },
  };
}

export function anthropicRequest(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("http://127.0.0.1:31400/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export function decodeChatBody(request: ChatRequest): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}

export function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${asciiJson(data)}\n\n`);
}

function asciiJson(value: unknown): string {
  const json = JSON.stringify(value);
  let escaped = "";
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code > 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += json[index];
    }
  }
  return escaped;
}
