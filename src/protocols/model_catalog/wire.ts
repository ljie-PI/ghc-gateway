import { DEFAULT_MODEL_CREATED_AT_TIME, type CatalogSnapshot } from "../../copilot/model_catalog.js";

export interface ModelMetadata {
  readonly mode?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

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
  catalog: CatalogSnapshot,
  metadata: ReadonlyMap<string, ModelMetadata>,
  created = DEFAULT_MODEL_CREATED_AT_TIME,
): string {
  const data = catalog.models.map((model) => {
    const meta = metadata.get(model.id);
    const item: Record<string, unknown> = {
      id: model.id,
      object: "model",
      created,
      owned_by: "openai",
    };
    if (meta?.mode !== undefined) {
      item.mode = meta.mode;
    }
    if (meta?.maxInputTokens !== undefined) {
      item.max_input_tokens = meta.maxInputTokens;
    }
    if (meta?.maxOutputTokens !== undefined) {
      item.max_output_tokens = meta.maxOutputTokens;
    }
    return item;
  });
  return JSON.stringify({ data, object: "list" });
}

export function serializeAnthropicModels(
  catalog: CatalogSnapshot,
  metadata: ReadonlyMap<string, ModelMetadata>,
  created = DEFAULT_MODEL_CREATED_AT_TIME,
): string {
  const createdAt = new Date(created * 1000).toISOString().replace(/\.\d+Z$/u, "Z");
  const data = catalog.models.map((model) => {
    const meta = metadata.get(model.id);
    return {
      type: "model",
      id: model.id,
      display_name: model.id,
      created_at: createdAt,
      max_input_tokens: meta?.maxInputTokens ?? null,
      max_tokens: meta?.maxOutputTokens ?? null,
    };
  });
  const first = catalog.models[0]?.id ?? null;
  const last = catalog.models[catalog.models.length - 1]?.id ?? null;
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
