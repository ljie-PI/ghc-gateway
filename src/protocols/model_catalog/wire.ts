import type { CapabilityCatalogSnapshot } from "../../copilot/capability_registry.js";
import { DEFAULT_MODEL_CREATED_AT_TIME } from "../../copilot/model_catalog.js";

export function coerceTokenLimit(value: unknown): number | undefined {
  if (typeof value === "boolean" || value === null || typeof value === "object") {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function serializeOpenAiModels(
  catalog: CapabilityCatalogSnapshot,
  created = DEFAULT_MODEL_CREATED_AT_TIME,
): string {
  const data = catalog.models.filter((model) => model.visible).map((model) => {
    const item: Record<string, unknown> = {
      id: model.modelId,
      object: "model",
      created,
      owned_by: "openai",
    };
    if (model.maxInputTokens.value !== null) {
      item.max_input_tokens = model.maxInputTokens.value;
    }
    if (model.maxOutputTokens.value !== null) {
      item.max_output_tokens = model.maxOutputTokens.value;
    }
    return item;
  });
  return JSON.stringify({ data, object: "list" });
}

export function serializeAnthropicModels(
  catalog: CapabilityCatalogSnapshot,
  created = DEFAULT_MODEL_CREATED_AT_TIME,
): string {
  const createdAt = new Date(created * 1000).toISOString().replace(/\.\d+Z$/u, "Z");
  const visible = catalog.models.filter((model) => model.visible);
  const data = visible.map((model) => {
    return {
      type: "model",
      id: model.modelId,
      display_name: model.modelId,
      created_at: createdAt,
      max_input_tokens: model.maxInputTokens.value,
      max_tokens: model.maxOutputTokens.value,
    };
  });
  const first = visible[0]?.modelId ?? null;
  const last = visible[visible.length - 1]?.modelId ?? null;
  return JSON.stringify({
    data,
    has_more: false,
    first_id: first,
    last_id: last,
  });
}

export function serializeOpenAiModelsError(status: number): string {
  const type = status === 401 || status === 403
    ? "authentication_error"
    : status === 429
      ? "rate_limit_error"
      : "api_error";
  return JSON.stringify({
    error: {
      message: "Failed to list GitHub Copilot models",
      type,
      param: null,
      code: String(status),
    },
  });
}
