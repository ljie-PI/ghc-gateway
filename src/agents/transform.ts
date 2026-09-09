import { parse, stringify, type TomlTable } from "smol-toml";
import { AgentError, validateMappings, type AgentId, type AgentMapping, type AgentModel } from "./types.js";

export interface AgentProjection {
  readonly config: Buffer;
  readonly catalog?: Buffer;
}

// These are client labels, never aliases in Gateway model resolution.
export function projectAgent(
  agent: AgentId,
  original: Buffer | null,
  mappings: readonly AgentMapping[],
  origin: string,
  catalogPath: string,
  models: readonly AgentModel[],
): AgentProjection {
  validateMappings(agent, mappings);
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(origin) || Number(new URL(origin).port) > 65535) {
    throw new AgentError("validation_failed");
  }
  if (mappings.some((mapping) => !models.some((model) => model.modelId === mapping.modelId))) {
    throw new AgentError("agent_models_unavailable");
  }
  try {
    const source = original?.toString("utf8").replace(/^\uFEFF/u, "") ?? "";
    return agent === "claude"
      ? { config: projectClaude(source, mappings, origin) }
      : projectCodex(source, mappings, origin, catalogPath, models);
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    // Parser diagnostics can contain configuration secrets.
    throw new AgentError("agent_invalid_config");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentError("agent_invalid_config");
  return value as Record<string, unknown>;
}

function projectClaude(source: string, mappings: readonly AgentMapping[], origin: string): Buffer {
  const config = source === "" ? {} : object(JSON.parse(source));
  const env = config.env === undefined ? {} : object(config.env);
  if (Object.values(env).some((value) => typeof value !== "string")) throw new AgentError("agent_invalid_config");
  // Replace only the keys that route/authenticate Claude Code or pin models.
  // Stale credentials or a Bedrock/Vertex/Foundry override would bypass the
  // Gateway; unrelated keys (for example ANTHROPIC_CUSTOM_HEADERS) and the
  // original file bytes return unchanged on Restore.
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ]) delete env[key];
  delete config.apiKeyHelper;
  delete config.awsAuthRefresh;
  delete config.awsCredentialExport;
  delete config.forceLoginMethod;
  delete config.forceLoginOrgUUID;
  // Settings-level model takes precedence over startup defaults in some client releases.
  config.model = mappings[0]!.modelId;
  env.ANTHROPIC_BASE_URL = origin;
  env.ANTHROPIC_AUTH_TOKEN = "ghcg-local";
  env.ANTHROPIC_MODEL = mappings[0]!.modelId;
  env.ANTHROPIC_SMALL_FAST_MODEL = mappings[2]!.modelId;
  for (const [index, role] of ["SONNET", "OPUS", "HAIKU"].entries()) {
    env[`ANTHROPIC_DEFAULT_${role}_MODEL`] = mappings[index]!.modelId;
    env[`ANTHROPIC_DEFAULT_${role}_MODEL_NAME`] = mappings[index]!.displayName;
  }
  if (mappings[3]) env.CLAUDE_CODE_SUBAGENT_MODEL = mappings[3].modelId;
  config.env = env;
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function projectCodex(
  source: string, mappings: readonly AgentMapping[], origin: string, catalogPath: string, models: readonly AgentModel[],
): AgentProjection {
  const config = source === "" ? {} as TomlTable : parse(source);
  // Profiles and named subagents can override the provider/catalog. Refuse rather than
  // silently configure only the root while another visible selection bypasses Gateway.
  if (config.profile !== undefined || config.profiles !== undefined || config.agents !== undefined) {
    throw new AgentError("agent_invalid_config");
  }
  const providers = config.model_providers === undefined ? {} : object(config.model_providers);
  const reserved = "ghc_gateway";
  if (providers[reserved] !== undefined) {
    // Reapply is projected from the FIRST baseline, so a collision is always external.
    throw new AgentError("agent_invalid_config");
  }
  providers[reserved] = {
    name: "GHC Gateway", base_url: `${origin}/v1`, wire_api: "responses",
    experimental_bearer_token: "ghcg-local", requires_openai_auth: false,
  };
  config.model_providers = providers as TomlTable;
  config.model_provider = reserved;
  config.model = mappings[0]!.modelId;
  config.model_catalog_json = catalogPath;
  // These global overrides describe the previous provider's model, not this
  // catalog; leaving them would send unsupported reasoning/context directives.
  for (const key of ["model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "model_context_window",
    "model_auto_compact_token_limit", "model_supports_reasoning_summaries", "review_model", "service_tier"]) delete config[key];
  const catalog = { models: mappings.map((mapping, index) => {
    const limit = models.find((model) => model.modelId === mapping.modelId)!.maxInputTokens;
    return {
      slug: mapping.modelId, display_name: mapping.displayName, description: mapping.displayName,
      base_instructions: "You are Codex, a coding agent. Help the user with their coding tasks.",
      supported_reasoning_levels: [], shell_type: "shell_command", visibility: "list", supported_in_api: true,
      priority: index, support_verbosity: false, supports_reasoning_summaries: false,
      supports_reasoning_summary_parameter: false, supports_parallel_tool_calls: false,
      supports_image_detail_original: false, supports_search_tool: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
      experimental_supported_tools: [], input_modalities: ["text"],
      ...(limit === null ? {} : { context_window: limit, max_context_window: limit }),
    };
  }) };
  const result = stringify(config);
  parse(result);
  return { config: Buffer.from(result), catalog: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`) };
}
