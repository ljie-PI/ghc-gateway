import type { CapabilityCatalogSnapshot } from "../../copilot/capability_registry.js";
import type { EffectiveCapabilityField } from "../../copilot/model_capabilities.js";
import { DEFAULT_MODEL_CREATED_AT_TIME } from "../../copilot/model_catalog.js";

export function serializeOpenaiModels(
  catalog: CapabilityCatalogSnapshot,
  created = DEFAULT_MODEL_CREATED_AT_TIME,
): string {
  const data = catalog.models.map((model) => {
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
    const reasoningCapabilitiesReliable = reasoningCapabilitiesAreReliable(model);
    item.supported_reasoning_efforts = reasoningCapabilitiesReliable
      ? model.capabilities.reasoningLevels
      : [];
    item.input_modalities = model.capabilities.inputModalities;
    item.supports_tool_calls = model.capabilities.toolCalling;
    item.supports_parallel_tool_calls = model.capabilities.parallelToolCalling;
    item.supports_reasoning_summaries = reasoningCapabilitiesReliable
      && model.capabilities.reasoningSummaries;
    item.supports_verbosity = model.capabilities.verbosity;
    item.supports_search = model.capabilities.search;
    if (contextCapabilitiesAreReliable(model)) {
      if (model.capabilities.contextWindowTokens !== null) {
        item.context_window_tokens = model.capabilities.contextWindowTokens;
      }
      if (model.capabilities.maxContextWindowTokens !== null) {
        item.max_context_window_tokens = model.capabilities.maxContextWindowTokens;
      }
    }
    return item;
  });
  return JSON.stringify({ data, object: "list" });
}

function reasoningCapabilitiesAreReliable(
  model: CapabilityCatalogSnapshot["models"][number],
): boolean {
  return isReliable(model.protocols)
    && isReliable(model.profile.supportedParameters)
    && isReliable(model.profile.reasoningEfforts);
}

function contextCapabilitiesAreReliable(
  model: CapabilityCatalogSnapshot["models"][number],
): boolean {
  return isReliable(model.maxInputTokens)
    && (model.profile.contextWindowTokens === undefined || isReliable(model.profile.contextWindowTokens));
}

function isReliable<T>(field: EffectiveCapabilityField<T>): boolean {
  return !field.conflict && field.liveState !== "malformed";
}

export function serializeAnthropicModels(
  catalog: CapabilityCatalogSnapshot,
  created = DEFAULT_MODEL_CREATED_AT_TIME,
): string {
  const createdAt = new Date(created * 1000).toISOString().replace(/\.\d+Z$/u, "Z");
  const models = catalog.models;
  const data = models.map((model) => {
    return {
      type: "model",
      id: model.modelId,
      display_name: model.modelId,
      created_at: createdAt,
      max_input_tokens: model.maxInputTokens.value,
      max_tokens: model.maxOutputTokens.value,
    };
  });
  const first = models[0]?.modelId ?? null;
  const last = models[models.length - 1]?.modelId ?? null;
  return JSON.stringify({
    data,
    has_more: false,
    first_id: first,
    last_id: last,
  });
}

export function serializeOpenaiModelsError(status: number): string {
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
