import { AccountDirectoryError, type AccountDirectory } from "../../accounts/account_directory.js";
import { GatewayFailureError, type GatewayFailure } from "../../gateway/failures.js";
import { CapiFetchError } from "../../copilot/models_source.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import { loadCapabilitySnapshot, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import type { FailurePresenter, RouteRegistration } from "../../gateway/hono_app.js";
import {
  serializeAnthropicModels,
  serializeOpenAiModels,
  serializeOpenAiModelsError,
} from "./wire.js";
import { reconcilePreferredModel } from "./preferred.js";

export interface ModelCatalogRouteDependencies {
  readonly directory: AccountDirectory;
  readonly registry?: ModelCapabilityRegistry;
  readonly catalog?: CopilotModelCatalog;
  readonly preferences: AccountModelPreferences;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createModelCatalogRoutes(dependencies: ModelCatalogRouteDependencies): readonly RouteRegistration[] {
  const modelsPresenter: FailurePresenter = (failure, requestId) => {
    const status = statusFor(failure.kind, failure);
    const headers = new Headers({ ...JSON_HEADERS, "x-request-id": requestId });
    if (failure.kind === "upstream_http" && failure.retryAfter !== undefined) {
      headers.set("retry-after", failure.retryAfter);
    }
    return new Response(serializeOpenAiModelsError(status), { status, headers });
  };
  return [
    {
      method: "GET",
      path: "/v1/models",
      admission: "none",
      body: "none",
      presentFailure: modelsPresenter,
      endpoint: async (request, scope) => {
        const catalog = await loadCatalog(dependencies, scope.signal);
        const anthropic = request.headers.has("anthropic-version");
        const body = anthropic
          ? serializeAnthropicModels(catalog)
          : serializeOpenAiModels(catalog);
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
    if (error instanceof AccountDirectoryError && (error.code === "no_default" || error.code === "not_found")) {
      throw new GatewayFailureError({ kind: "authentication" });
    }
    throw error;
  }
  try {
    const observedPreference = dependencies.preferences.get(account.accountId);
    const catalog = await loadCapabilitySnapshot(dependencies, account, signal);
    reconcilePreferredModel(dependencies.preferences, account.accountId, catalog, observedPreference);
    return catalog;
  } catch (error: unknown) {
    if (error instanceof CapiFetchError) {
      if (error.failureKind === "upstream_timeout") {
        throw new GatewayFailureError({ kind: "upstream_timeout", cause: error });
      }

      if (error.failureKind === "upstream_network") {
        throw new GatewayFailureError({ kind: "upstream_network", cause: error });
      }
      if (error.failureKind === "invalid_upstream_response") {
        throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
      }
      throw new GatewayFailureError({
        kind: "upstream_http",
        status: error.status,
        ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
      });
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

function statusFor(kind: GatewayFailure["kind"], failure?: GatewayFailure): number {
  if (kind === "authentication") {
    return 401;
  }
  if (kind === "permission") {
    return 403;
  }
  if (kind === "upstream_http" && failure !== undefined && "status" in failure) {
    return failure.status;
  }
  if (kind === "internal") {
    return 500;
  }
  return 502;
}
