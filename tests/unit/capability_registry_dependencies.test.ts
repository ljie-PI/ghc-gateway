import { describe, expect, it } from "vitest";
import type { AccountDirectory } from "../../src/accounts/account_directory.js";
import type { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import type { AccountModelPreferences } from "../../src/accounts/model_preferences.js";
import type { DeviceFlowService } from "../../src/accounts/device_flow.js";
import type { CopilotBackend } from "../../src/copilot/backend.js";
import type { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import type { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import type { RuntimeConfigStore } from "../../src/config/runtime_config.js";
import type { ResponsesHistory } from "../../src/protocols/openai_responses/history.js";
import type { ApplicationContext } from "../../src/main.js";
import { createPublicRouteRegistrations } from "../../src/main.js";
import type { ModelCatalogRouteDependencies } from "../../src/protocols/model_catalog/routes.js";
import type { OpenaiChatCompletionsRouteDependencies } from "../../src/protocols/openai_chat_completions/endpoint.js";
import type { AnthropicMessagesRouteDependencies } from "../../src/protocols/anthropic_messages/endpoint.js";
import type { OpenaiResponsesRouteDependencies } from "../../src/protocols/openai_responses/endpoint.js";
import type { CommandDispatcherDependencies } from "../../src/cli/commands/dispatcher.js";

const directory = {} as AccountDirectory;
const accountCoordinator = {} as AccountCoordinator;
const registry = {} as ModelCapabilityRegistry;
const catalog = {} as CopilotModelCatalog;
const preferences = {} as AccountModelPreferences;
const copilot = {} as CopilotBackend;
const history = {} as ResponsesHistory;
const runtimeConfig = {} as RuntimeConfigStore;
const deviceFlows = {} as Pick<DeviceFlowService, "start" | "poll" | "cancel">;

// Compile-time authority contract: every effective consumer requires the registry.
const validApplication: ApplicationContext = { accountCoordinator, directory, registry, copilot, history };
const validModels: ModelCatalogRouteDependencies = { directory, registry, preferences };
const validChat: OpenaiChatCompletionsRouteDependencies = { directory, registry, preferences, copilot };
const validMessages: AnthropicMessagesRouteDependencies = { directory, registry, preferences, copilot };
const validResponses: OpenaiResponsesRouteDependencies = { directory, registry, preferences, copilot, history };
const validDispatcher: CommandDispatcherDependencies = { directory, registry, deviceFlows, runtimeConfig };
void [validApplication, validModels, validChat, validMessages, validResponses, validDispatcher];

// @ts-expect-error catalog-only application composition is forbidden
const invalidApplication: ApplicationContext = { directory, catalog, copilot, history };
// @ts-expect-error model routes require registry
const invalidModels: ModelCatalogRouteDependencies = { directory, catalog, preferences };
// @ts-expect-error Chat requires registry
const invalidChat: OpenaiChatCompletionsRouteDependencies = { directory, catalog, preferences, copilot };
// @ts-expect-error Messages requires registry
const invalidMessages: AnthropicMessagesRouteDependencies = { directory, catalog, preferences, copilot };
// @ts-expect-error Responses requires registry
const invalidResponses: OpenaiResponsesRouteDependencies = { directory, catalog, preferences, copilot, history };
// @ts-expect-error CLI dispatcher requires registry
const invalidDispatcher: CommandDispatcherDependencies = { directory, catalog, deviceFlows, runtimeConfig };
void [invalidApplication, invalidModels, invalidChat, invalidMessages, invalidResponses, invalidDispatcher];

describe("capability registry construction authority", () => {
  it("fails closed when unsafe JavaScript composition omits the registry", () => {
    expect(() => createPublicRouteRegistrations({ directory, copilot, history } as ApplicationContext))
      .toThrow("model capability registry is unavailable");
  });
});
