import type { BoundAccount } from "../accounts/account_directory.js";
import type { CatalogSnapshot, CopilotCatalogModel, CopilotModelCatalog } from "./model_catalog.js";
import {
  effectiveField,
  resolveDefaultOutputTokens,
  sameProtocols,
  UNKNOWN_DECLARATIONS,
  type BuiltinModelCapabilityLookup,
  type EffectiveCapabilityField,
  type EffectiveOutputDefault,
  type ModelCapabilityProfile,
  type NativeModelProtocol,
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
    return snapshot.models.filter((model) => model.protocols.value !== null
      && model.protocols.value.length > 0
      && model.defaultOutputTokens.valid
      && (!model.protocols.value.every((protocol) => protocol === "chat")
        || model.profile.chatOutputTokenField.value !== null));
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
      sameStrings,
    );
    const defaultOutputTokens = effectiveField(
      live.defaultOutputTokens,
      fallback.defaultOutputTokens,
    );
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
      profile: { chatOutputTokenField, supportedParameters, reasoningEfforts },
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
