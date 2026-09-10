import type {
  CapabilityCatalogSnapshot,
  EffectiveModelCapabilitySnapshot,
} from "../../copilot/capability_registry.js";

export type ModelResolutionSource = "explicit" | "preferred";

export interface ResolvedModel {
  readonly requestedModel?: string;
  readonly upstreamModel: string;
  readonly source: ModelResolutionSource;
  readonly capability: EffectiveModelCapabilitySnapshot;
}

export type ModelResolveError =
  | { readonly kind: "invalid_request" }
  | { readonly kind: "model_not_found" };

export function resolveModel(
  catalog: CapabilityCatalogSnapshot,
  requested: string | undefined,
  preferred: { readonly modelId: string; readonly validity: "valid" | "invalid" } | null,
): ResolvedModel | ModelResolveError {
  const ids = new Set(catalog.models.map((model) => model.modelId));
  if (requested !== undefined) {
    if (requested.length === 0) {
      return { kind: "invalid_request" };
    }
    if (!ids.has(requested)) {
      return { kind: "model_not_found" };
    }
    return resolved(catalog, requested, "explicit", requested);
  }
  if (preferred === null || preferred.validity !== "valid" || preferred.modelId.length === 0 || !ids.has(preferred.modelId)) {
    return { kind: "invalid_request" };
  }
  return resolved(catalog, undefined, "preferred", preferred.modelId);
}

function resolved(
  catalog: CapabilityCatalogSnapshot,
  requested: string | undefined,
  source: ModelResolutionSource,
  upstreamModel: string,
): ResolvedModel {
  const model = catalog.models.find((item) => item.modelId === upstreamModel);
  if (model === undefined) {
    throw new Error("resolved model capability is missing");
  }
  return {
    ...(requested === undefined ? {} : { requestedModel: requested }),
    upstreamModel,
    source,
    capability: model,
  };
}
