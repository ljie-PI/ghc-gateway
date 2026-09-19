import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { withSetupCleanup, startHttpCopilot, closeAll, jsonStream } from "../../scripts/tooling/test_support/http_copilot.js";
import type { HttpExpectation, HttpRequestObservation } from "../../scripts/tooling/test_support/copilot_http.js";
import type { CopilotTransportDeps } from "../../src/copilot/transport.js";
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
import type { UsageUpdate } from "../../src/telemetry/recorder.js";
import { testModelCapabilityRegistry } from "./model_capability_registry_harness.js";

export const ACCOUNT_ID = "github.com/1";

const nowMs = (): number => 1_700_000_000_000;

export interface AnthropicGatewayFixture {
  readonly gw: Gateway;
  readonly backend: Awaited<ReturnType<typeof startHttpCopilot>>["backend"];
  readonly upstream: Awaited<ReturnType<typeof startHttpCopilot>>["upstream"];
  readonly capturedRequests: readonly HttpRequestObservation[];
  close(): Promise<void>;
}

export async function anthropicGateway(options: {
  readonly expectations?: readonly HttpExpectation[];
  readonly missingCredentials?: boolean;
  readonly refreshCopilotToken?: CopilotTransportDeps["refreshCopilotToken"];
  readonly runtime?: RuntimeConfigSnapshot;
  readonly gatewayDependencies?: Readonly<GatewayDependencies>;
  readonly preferredModel?: string;
  readonly createUuid?: () => string;
  readonly catalogFetch?: () => Promise<CapiModelsResponse> | CapiModelsResponse;
  readonly usageUpdates?: UsageUpdate[];
  readonly telemetryNowMs?: () => number;
} = {}): Promise<AnthropicGatewayFixture> {
  return await withSetupCleanup(async (own) => {
    const database = openDatabase({
      path: ":memory:",
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
        return options.catalogFetch?.() ?? {
          data: [
            chatModel("gpt", "max_tokens"),
            chatModel("o1", "max_completion_tokens"),
            chatModel("gpt-5", "max_tokens", ["xhigh"]),
            chatModel("deepseek-reasoner", "max_tokens"),
          ],
        };
      },
    }, () => new Date("2026-01-02T03:04:05.000Z"));

    if (options.preferredModel !== undefined) {
      accounts.preferences.set(ACCOUNT_ID, { modelId: options.preferredModel, catalogGeneration: 0 }, 0);
    }

    if (options.missingCredentials) await credentials.removeAccount(ACCOUNT_ID);
    const http = await startHttpCopilot({
      credentials, accountCoordinator, nowMs,
      ...(options.refreshCopilotToken === undefined ? {} : { refreshCopilotToken: options.refreshCopilotToken }),
      expectations: options.expectations ?? [{
        method: "POST", path: "/chat/completions", body: jsonStream(false), times: 8,
        reply: { body: new TextEncoder().encode(JSON.stringify({
          id: "chatcmpl_1", model: "gpt",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        })) },
      }, {
        method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: { headers: { "content-type": "text/event-stream" }, body: new TextEncoder().encode("data: [DONE]\n\n") },
      }],
    });
    own(() => http.close());
    const registry = testModelCapabilityRegistry(catalog);
    own(() => registry.close());

    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\ghc-gateway-tests\\anthropic\\.test-home" }),
      runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
    }, [createAnthropicMessagesRoute({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
      copilot: http.backend,
      createUuid: options.createUuid ?? (() => "00000000-0000-4000-8000-000000000001"),
      ...(options.usageUpdates === undefined
        ? {}
        : { usageRecorder: { recordUsage: (update: UsageUpdate) => options.usageUpdates?.push(update) } }),
      ...(options.telemetryNowMs === undefined ? {} : { nowMs: options.telemetryNowMs }),
    })], {
      createRequestId: () => "req_test_1",
      ...options.gatewayDependencies,
    });
    own(() => gw.close());

    return {
      gw,
      backend: http.backend,
      upstream: http.upstream,
      capturedRequests: http.upstream.requests,
      async close() {
        await closeAll([() => gw.close(), () => registry.close(), () => http.close(), () => closeDatabase(database)]);
      },
    };
  });
}

function chatModel(
  id: string,
  chatOutputTokenField: "max_tokens" | "max_completion_tokens",
  reasoningEffort?: readonly string[],
) {
  return {
    id, name: id, vendor: "github", model_picker_enabled: true,
    model_info: {
      supported_endpoints: ["/chat/completions"],
      chat_output_token_field: chatOutputTokenField,
      ...(reasoningEffort === undefined ? {} : {
        supported_parameters: ["reasoning_effort"], supported_reasoning_efforts: reasoningEffort,
      }),
    },
    capabilities: { supports: {
      tool_calls: true, parallel_tool_calls: true, vision: true,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    } },
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

export function decodeChatBody(request: HttpRequestObservation): Record<string, unknown> {
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
