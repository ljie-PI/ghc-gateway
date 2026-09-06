import type { AccountDirectory } from "../../accounts/account_directory.js";
import {
  normalizeAccountBindingFailure,
  normalizeCatalogFailure,
} from "../../copilot/failures.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import type { RouteRegistration } from "../../gateway/hono_app.js";
import {
  serializeAnthropicModels,
  serializeOpenAiModels,
  type ModelMetadata,
} from "./wire.js";
import { presentModelCatalogFailure } from "./failure_presenter.js";

export interface ModelCatalogRouteDependencies {
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly preferences: AccountModelPreferences;
  readonly metadata?: ReadonlyMap<string, ModelMetadata>;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createModelCatalogRoutes(dependencies: ModelCatalogRouteDependencies): readonly RouteRegistration[] {
  return [
    {
      method: "GET",
      path: "/v1/models",
      admission: "none",
      body: "none",
      presentFailure: presentModelCatalogFailure,
      endpoint: async (request, scope) => {
        const catalog = await loadCatalog(dependencies, scope.signal);
        const anthropic = request.headers.has("anthropic-version");
        const metadata = dependencies.metadata ?? new Map<string, ModelMetadata>();
        const body = anthropic
          ? serializeAnthropicModels(catalog, metadata)
          : serializeOpenAiModels(catalog, metadata);
        return new Response(body, {
          headers: { ...JSON_HEADERS, "x-request-id": scope.requestId },
        });
      },
    },
  ];
}

async function loadCatalog(
  dependencies: ModelCatalogRouteDependencies,
  signal: AbortSignal,
) {
  let account;
  try {
    account = await dependencies.directory.bindDefault(signal);
  } catch (error: unknown) {
    throw normalizeAccountBindingFailure(error);
  }
  try {
    const catalog = await dependencies.catalog.get(account.accountId, signal);
    const visible = new Set(catalog.models.map((model) => model.id));
    dependencies.preferences.markInvalidIfMissing(account.accountId, visible, catalog.generation);
    return catalog;
  } catch (error: unknown) {
    throw normalizeCatalogFailure(error, signal);
  }
}
