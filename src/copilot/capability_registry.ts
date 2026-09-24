import type { BoundAccount } from "../accounts/account_directory.js";
import type { CatalogSnapshot, CopilotCatalogModel, CopilotModelCatalog } from "./model_catalog.js";
import {
  effectiveField,
  resolveDefaultOutputTokens,
  sameProtocols,
  UNKNOWN_DECLARATIONS,
  type BuiltinModelCapabilityLookup,
  type DeclaredModelCapabilities,
  type EffectiveCapabilityField,
  type EffectiveOutputDefault,
  type ModelCapabilities,
  type ModelCapabilityProfile,
  type NativeModelProtocol,
  type ReasoningEffortDeclaration,
} from "./model_capabilities.js";

export interface EffectiveModelCapabilitySnapshot {
  readonly accountId: string;
  readonly modelId: string;
  readonly name: string;
  readonly vendor: string;
  readonly protocols: EffectiveCapabilityField<readonly NativeModelProtocol[]>;
  readonly maxInputTokens: EffectiveCapabilityField<number>;
  readonly maxOutputTokens: EffectiveCapabilityField<number>;
  readonly defaultOutputTokens: EffectiveOutputDefault;
  readonly capabilities: ModelCapabilities;
  readonly profile: ModelCapabilityProfile;
  readonly revision: {
    readonly credentialGeneration: number;
    readonly catalogGeneration: number;
    readonly builtinRevision: string | null;
  };
}

export interface CapabilityCatalogSnapshot {
  readonly accountId: string;
  readonly credentialGeneration: number;
  readonly catalogGeneration: number;
  readonly fetchedAt: string;
  readonly models: readonly EffectiveModelCapabilitySnapshot[];
}

export function requireModelCapabilityRegistry(
  registry: ModelCapabilityRegistry | undefined,
): ModelCapabilityRegistry {
  if (registry === undefined) {
    throw new Error("model capability registry is unavailable");
  }
  return registry;
}

export class ModelCapabilityRegistry {
  constructor(
    private readonly catalog: CopilotModelCatalog,
    private readonly builtins: BuiltinModelCapabilityLookup,
  ) {}

  async get(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<CapabilityCatalogSnapshot> {
    const catalog = await this.catalog.get(account.accountId, signal, account.credentialGeneration);
    return this.compose(account, catalog);
  }

  invalidate(accountId: string): void {
    this.catalog.invalidate(accountId);
  }

  isCurrent(snapshot: Readonly<CapabilityCatalogSnapshot>): boolean {
    return this.catalog.isCurrent(
      snapshot.accountId,
      snapshot.catalogGeneration,
      snapshot.credentialGeneration,
    );
  }

  modelsUsableForAgentMapping(
    snapshot: Readonly<CapabilityCatalogSnapshot>,
  ): readonly EffectiveModelCapabilitySnapshot[] {
    // Chat-only models need no declared token field: resolveChatOutputTokenField always has one.
    return snapshot.models.filter((model) => model.protocols.value !== null
      && model.protocols.value.length > 0
      && model.defaultOutputTokens.valid);
  }

  async close(): Promise<void> {
    await this.catalog.close();
  }

  private compose(
    account: Readonly<BoundAccount>,
    catalog: Readonly<CatalogSnapshot>,
  ): CapabilityCatalogSnapshot {
    return deepFreeze({
      accountId: account.accountId,
      credentialGeneration: account.credentialGeneration,
      catalogGeneration: catalog.generation,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models.map((model) => this.effective(account, catalog, model)),
    });
  }

  private effective(
    account: Readonly<BoundAccount>,
    catalog: Readonly<CatalogSnapshot>,
    model: Readonly<CopilotCatalogModel>,
  ): EffectiveModelCapabilitySnapshot {
    const live = model.capabilities;
    const builtin = this.builtins.get(model.id);
    const fallback = builtin?.capabilities ?? UNKNOWN_DECLARATIONS;
    const protocols = effectiveField(live.protocols, fallback.protocols, sameProtocols);
    const maxInputTokens = effectiveField(
      live.maxInputTokens,
      fallback.maxInputTokens,
    );
    const maxOutputTokens = effectiveField(
      live.maxOutputTokens,
      fallback.maxOutputTokens,
    );
    const chatOutputTokenField = effectiveField(
      live.chatOutputTokenField,
      fallback.chatOutputTokenField,
    );
    const supportedParameters = effectiveField(
      live.supportedParameters,
      fallback.supportedParameters,
      sameStrings,
    );
    const reasoningEfforts = effectiveField(
      live.reasoningEfforts,
      fallback.reasoningEfforts,
      sameReasoningDeclarations,
    );
    const recognizedReasoningEfforts = mapEffectiveField(
      reasoningEfforts,
      (declaration) => declaration.recognized,
    );
    const unrecognizedReasoningEfforts = mapEffectiveField(
      reasoningEfforts,
      (declaration) => declaration.unrecognized,
    );
    const defaultOutputTokens = effectiveField(
      live.defaultOutputTokens,
      fallback.defaultOutputTokens,
    );
    const contextWindowTokens = effectiveField(live.contextWindowTokens, fallback.contextWindowTokens);
    const effectiveProtocols = protocols.value ?? [];
    const reasoningProtocols = reasoningEfforts.value === null
      ? []
      : reasoningEfforts.value.recognized.length === 0
        ? []
        : effectiveReasoningProtocols(
          effectiveProtocols,
          supportedParameters,
          effectiveField(live.reasoningEffort, fallback.reasoningEffort),
        );
    const reasoningLevels = reasoningProtocols.length === 0
      ? []
      : reasoningEfforts.value?.recognized ?? [];
    const reasoningSummaries = supportsReasoningSummaries(
      live.reasoningSummaries,
      fallback.reasoningSummaries,
      reasoningProtocols,
    );
    const toolCalling = supportedBoolean(live.toolCalls, fallback.toolCalls);
    const parallelToolCalling = toolCalling
      && supportedBoolean(live.parallelToolCalls, fallback.parallelToolCalls);
    const contextLimit = maxInputTokens.value === null
      ? null
      : contextWindowTokens.value === null
        ? maxInputTokens.value
        : Math.min(maxInputTokens.value, contextWindowTokens.value);
    return deepFreeze({
      accountId: account.accountId,
      modelId: model.id,
      name: model.name,
      vendor: model.vendor,
      protocols,
      maxInputTokens,
      maxOutputTokens,
      defaultOutputTokens: resolveDefaultOutputTokens(
        defaultOutputTokens,
        maxOutputTokens.value,
      ),
      capabilities: {
        contextWindowTokens: contextLimit,
        maxContextWindowTokens: contextWindowTokens.value ?? contextLimit,
        reasoningLevels,
        reasoningProtocols,
        inputModalities: supportedBoolean(live.vision, fallback.vision)
          ? ["text", "image"]
          : ["text"],
        toolCalling,
        parallelToolCalling,
        reasoningSummaries,
        verbosity: supportedBoolean(live.verbosity, fallback.verbosity),
        search: supportedBoolean(live.search, fallback.search),
      },
      profile: {
        chatOutputTokenField,
        supportedParameters,
        reasoningEfforts: recognizedReasoningEfforts,
        unrecognizedReasoningEfforts,
        contextWindowTokens,
      },
      revision: {
        credentialGeneration: account.credentialGeneration,
        catalogGeneration: catalog.generation,
        builtinRevision: builtin?.revision ?? null,
      },
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }

    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function supportsReasoningSummaries(
  live: DeclaredModelCapabilities["reasoningSummaries"],
  builtin: DeclaredModelCapabilities["reasoningSummaries"],
  reasoningProtocols: readonly NativeModelProtocol[],
): boolean {
  const declaration = effectiveField(live, builtin);
  if (declaration.conflict || declaration.liveState === "malformed") {
    return false;
  }
  return declaration.value ?? reasoningProtocols.includes("responses");
}

function sameReasoningDeclarations(
  left: ReasoningEffortDeclaration,
  right: ReasoningEffortDeclaration,
): boolean {
  return sameStrings(left.recognized, right.recognized)
    && sameStrings(left.unrecognized, right.unrecognized);
}

function mapEffectiveField<T, U>(
  field: EffectiveCapabilityField<T>,
  map: (value: T) => U,
): EffectiveCapabilityField<U> {
  return Object.freeze({
    value: field.value === null ? null : map(field.value),
    source: field.source,
    conflict: field.conflict,
    liveState: field.liveState,
  });
}

const REASONING_PARAMETERS: Readonly<Record<NativeModelProtocol, readonly string[]>> = {
  chat: ["reasoning_effort"],
  messages: ["output_config.effort", "output_config"],
  responses: ["reasoning", "reasoning.effort"],
};

function effectiveReasoningProtocols(
  protocols: readonly NativeModelProtocol[],
  supportedParameters: EffectiveCapabilityField<readonly string[]>,
  declaredSupport: EffectiveCapabilityField<boolean>,
): readonly NativeModelProtocol[] {
  if (declaredSupport.liveState === "malformed" || declaredSupport.value === false) {
    return [];
  }
  if (declaredSupport.value === true) {
    return protocols;
  }
  return protocols.filter((protocol) => REASONING_PARAMETERS[protocol]
    .some((parameter) => supportedParameters.value?.includes(parameter) === true));
}

function supportedBoolean(
  live: DeclaredModelCapabilities["toolCalls"],
  builtin: DeclaredModelCapabilities["toolCalls"],
): boolean {
  return effectiveField(live, builtin).value === true;
}
