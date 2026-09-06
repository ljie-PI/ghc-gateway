import type { ModelInfoLookup } from "./model_catalog.js";
import { builtinCapabilitiesFromModelInfo, type BuiltinModelCapabilityLookup } from "./model_capabilities.js";

export interface NormalizedModelInfo {
  readonly mode?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportedEndpoints?: readonly string[];
  readonly defaultOutputTokens?: number;
  readonly chatOutputTokenField?: "max_tokens" | "max_completion_tokens";
}

type RawModelInfo = NonNullable<ReturnType<ModelInfoLookup["get"]>>;

export function normalizeModelInfo(value: RawModelInfo | null): NormalizedModelInfo | null {
  if (value === null) {
    return null;
  }
  const mode = typeof value.mode === "string" ? value.mode : undefined;
  const maxInputTokens = coerceTokenLimit(value.max_input_tokens);
  const maxOutputTokens = coerceTokenLimit(value.max_output_tokens);
  const supportedEndpoints = Array.isArray(value.supported_endpoints)
    ? value.supported_endpoints.filter((item): item is string => typeof item === "string")
    : undefined;
  const defaultOutputTokens = coerceTokenLimit(value.default_output_tokens);
  const chatOutputTokenField = value.chat_output_token_field === "max_tokens"
    || value.chat_output_token_field === "max_completion_tokens"
    ? value.chat_output_token_field
    : undefined;
  if (mode === undefined && maxInputTokens === undefined && maxOutputTokens === undefined
    && supportedEndpoints === undefined && defaultOutputTokens === undefined
    && chatOutputTokenField === undefined) {
    return null;
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(supportedEndpoints === undefined ? {} : { supportedEndpoints }),
    ...(defaultOutputTokens === undefined ? {} : { defaultOutputTokens }),
    ...(chatOutputTokenField === undefined ? {} : { chatOutputTokenField }),
  };
}

function coerceTokenLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/u.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

// Pinned LiteLLM getModelInfo data for the GitHub Copilot provider.
const PRODUCTION_MODEL_INFO: Readonly<Record<string, RawModelInfo>> = {
  "claude-haiku-4.5": chatInfo(128_000, 16_000, ["/v1/chat/completions"]),
  "claude-opus-4.5": chatInfo(128_000, 16_000, ["/v1/chat/completions"]),
  "claude-opus-4.6-fast": chatInfo(128_000, 16_000, ["/v1/chat/completions"]),
  "claude-opus-41": chatInfo(80_000, 16_000, ["/v1/chat/completions"]),
  "claude-sonnet-4": chatInfo(128_000, 16_000, ["/v1/chat/completions"]),
  "claude-sonnet-4.5": chatInfo(128_000, 16_000, ["/v1/chat/completions"]),
  "gemini-2.5-pro": chatInfo(128_000, 64_000),
  "gemini-3-pro-preview": chatInfo(128_000, 64_000),
  "gpt-3.5-turbo": chatInfo(16_384, 4_096),
  "gpt-3.5-turbo-0613": chatInfo(16_384, 4_096),
  "gpt-4": chatInfo(32_768, 4_096),
  "gpt-4-0613": chatInfo(32_768, 4_096),
  "gpt-4-o-preview": chatInfo(64_000, 4_096),
  "gpt-4.1": chatInfo(128_000, 16_384),
  "gpt-4.1-2025-04-14": chatInfo(128_000, 16_384),
  "gpt-41-copilot": info("completion"),
  "gpt-4o": chatInfo(64_000, 4_096),
  "gpt-4o-2024-05-13": chatInfo(64_000, 4_096),
  "gpt-4o-2024-08-06": chatInfo(64_000, 16_384),
  "gpt-4o-2024-11-20": chatInfo(64_000, 16_384),
  "gpt-4o-mini": chatInfo(64_000, 4_096),
  "gpt-4o-mini-2024-07-18": chatInfo(64_000, 4_096),
  "gpt-5": chatInfo(128_000, 128_000, ["/v1/chat/completions", "/v1/responses"]),
  "gpt-5-mini": chatInfo(128_000, 64_000),
  "gpt-5.1": chatInfo(128_000, 64_000, ["/v1/chat/completions", "/v1/responses"]),
  "gpt-5.1-codex-max": responsesInfo(128_000, 128_000, ["/v1/responses"]),
  "gpt-5.2": chatInfo(128_000, 64_000, ["/v1/chat/completions", "/v1/responses"]),
  "gpt-5.3-codex": responsesInfo(128_000, 128_000, ["/v1/responses"]),
  "mai-code-1-flash": chatInfo(128_000, 64_000, ["/v1/chat/completions"]),
  "mai-code-1-flash-internal": chatInfo(128_000, 64_000, ["/v1/chat/completions"]),
  "text-embedding-3-small": info("embedding", 8_191),
  "text-embedding-3-small-inference": info("embedding", 8_191),
  "text-embedding-ada-002": info("embedding", 8_191),
};

export const productionModelInfoLookup: ModelInfoLookup = {
  get(modelId) {
    return PRODUCTION_MODEL_INFO[modelId] ?? null;
  },
};

export const BUILTIN_MODEL_CAPABILITIES_REVISION = "litellm-ae7e50f096a8722bad14d63b6a0d4634d59bf475";

export const productionBuiltinModelCapabilities: BuiltinModelCapabilityLookup = {
  get(modelId) {
    return builtinCapabilitiesFromModelInfo(
      productionModelInfoLookup,
      modelId,
      BUILTIN_MODEL_CAPABILITIES_REVISION,
    );
  },
};

function chatInfo(
  maxInputTokens?: number,
  maxOutputTokens?: number,
  supportedEndpoints?: readonly string[],
): RawModelInfo {
  return {
    ...info("chat", maxInputTokens, maxOutputTokens, supportedEndpoints),
    chat_output_token_field: "max_tokens",
  };
}

function responsesInfo(
  maxInputTokens?: number,
  maxOutputTokens?: number,
  supportedEndpoints?: readonly string[],
): RawModelInfo {
  return info("responses", maxInputTokens, maxOutputTokens, supportedEndpoints);
}

function info(
  mode: string,
  maxInputTokens?: number,
  maxOutputTokens?: number,
  supportedEndpoints?: readonly string[],
): RawModelInfo {
  return {
    mode,
    ...(maxInputTokens === undefined ? {} : { max_input_tokens: maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(supportedEndpoints === undefined ? {} : { supported_endpoints: supportedEndpoints }),
  };
}
