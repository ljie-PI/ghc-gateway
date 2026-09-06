import type { BoundAccount } from "../accounts/account_directory.js";
import type { CatalogSnapshot, CopilotCatalogModel, CopilotModelCatalog } from "./model_catalog.js";
import type { SqliteModelCapabilityOverrides, StoredModelCapabilityOverride } from "./capability_overrides.js";
import { ModelCapabilityOverrideError } from "./capability_overrides.js";
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
  type ModelCapabilityOverrideValue,
} from "./model_capabilities.js";

export interface EffectiveModelCapabilitySnapshot {
  readonly accountId: string;
  readonly modelId: string;
  readonly name: string;
  readonly vendor: string;
  readonly discovered: boolean;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly override: ModelCapabilityOverrideValue | null;
  readonly protocols: EffectiveCapabilityField<readonly NativeModelProtocol[]>;
  readonly maxInputTokens: EffectiveCapabilityField<number>;
  readonly maxOutputTokens: EffectiveCapabilityField<number>;
  readonly defaultOutputTokens: EffectiveOutputDefault;
  readonly profile: ModelCapabilityProfile;
  readonly revision: {
    readonly credentialGeneration: number;
    readonly catalogGeneration: number;
    readonly overrideRevision: number;
    readonly builtinRevision: string | null;
  };
}

export interface CapabilityCatalogSnapshot {
  readonly accountId: string;
  readonly credentialGeneration: number;
  readonly catalogGeneration: number;
  readonly fetchedAt: string;
  readonly models: readonly EffectiveModelCapabilitySnapshot[];
  readonly overrideRevisions: Readonly<Record<string, number>>;
}

export interface CapabilitySnapshotDependencies {
  readonly registry?: ModelCapabilityRegistry;
  readonly catalog?: CopilotModelCatalog;
}

export async function loadCapabilitySnapshot(
  dependencies: Readonly<CapabilitySnapshotDependencies>,
  account: Readonly<BoundAccount>,
  signal: AbortSignal,
): Promise<CapabilityCatalogSnapshot> {
  if (dependencies.registry !== undefined) {
    return await dependencies.registry.get(account, signal);
  }
  if (dependencies.catalog !== undefined) {
    return capabilitySnapshotFromCatalog(
      account,
      await dependencies.catalog.get(account.accountId, signal, account.credentialGeneration),
    );
  }
  throw new Error("model capability registry is unavailable");
}

export class ModelCapabilityRegistry {
  constructor(
    private readonly catalog: CopilotModelCatalog,
    readonly overrides: SqliteModelCapabilityOverrides,
    private readonly builtins: BuiltinModelCapabilityLookup,
  ) {}

  async get(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<CapabilityCatalogSnapshot> {
    const catalog = await this.catalog.get(account.accountId, signal, account.credentialGeneration);
    return this.compose(account, catalog);
  }

  async validateOverride(
    account: Readonly<BoundAccount>,
    modelId: string,
    candidate: Readonly<ModelCapabilityOverrideValue>,
    signal: AbortSignal,
  ): Promise<void> {
    if (candidate.defaultOutputTokens === undefined) {
      return;
    }
    const catalog = await this.catalog.get(account.accountId, signal, account.credentialGeneration);
    const model = catalog.models.find((item) => item.id === modelId);
    const live = model?.capabilities ?? UNKNOWN_DECLARATIONS;
    const fallback = this.builtins.get(modelId)?.capabilities ?? UNKNOWN_DECLARATIONS;
    const ceiling = effectiveField(
      candidate.maxOutputTokens,
      live.maxOutputTokens,
      fallback.maxOutputTokens,
    ).value;
    if (ceiling !== null && candidate.defaultOutputTokens > ceiling) {
      throw new ModelCapabilityOverrideError("validation_failed");
    }
  }

  invalidate(accountId: string): void {
    this.catalog.invalidate(accountId);
  }

  async close(): Promise<void> {
    await this.catalog.close();
  }

  private compose(
    account: Readonly<BoundAccount>,
    catalog: Readonly<CatalogSnapshot>,
  ): CapabilityCatalogSnapshot {
    const configured = this.overrides.list(account.accountId);
    const overrides = new Map(configured.map((item) => [item.modelId, item]));
    const discoveredIds = new Set(catalog.models.map((model) => model.id));
    const models = catalog.models.map((model) => this.effective(account, catalog, model, overrides.get(model.id)));
    for (const stored of configured) {
      if (!discoveredIds.has(stored.modelId)) {
        models.push(this.effective(account, catalog, undefined, stored));
      }
    }
    return deepFreeze({
      accountId: account.accountId,
      credentialGeneration: account.credentialGeneration,
      catalogGeneration: catalog.generation,
      fetchedAt: catalog.fetchedAt,
      models,
      overrideRevisions: this.overrides.revisions(account.accountId),
    });
  }

  private effective(
    account: Readonly<BoundAccount>,
    catalog: Readonly<CatalogSnapshot>,
    model: Readonly<CopilotCatalogModel> | undefined,
    stored: Readonly<StoredModelCapabilityOverride> | undefined,
  ): EffectiveModelCapabilitySnapshot {
    const override = stored?.value ?? null;
    const live = model?.capabilities ?? UNKNOWN_DECLARATIONS;
    const builtin = this.builtins.get(model?.id ?? stored?.modelId ?? "");
    const fallback = builtin?.capabilities ?? UNKNOWN_DECLARATIONS;
    const protocols = effectiveField(override?.protocols, live.protocols, fallback.protocols, sameProtocols);
    const maxInputTokens = effectiveField(
      override?.maxInputTokens,
      live.maxInputTokens,
      fallback.maxInputTokens,
    );
    const maxOutputTokens = effectiveField(
      override?.maxOutputTokens,
      live.maxOutputTokens,
      fallback.maxOutputTokens,
    );
    const chatOutputTokenField = effectiveField(
      override?.chatOutputTokenField,
      live.chatOutputTokenField,
      fallback.chatOutputTokenField,
    );
    const defaultOutputTokens = effectiveField(
      override?.defaultOutputTokens,
      live.defaultOutputTokens,
      fallback.defaultOutputTokens,
    );
    const discovered = model !== undefined;
    const configured = override !== null;
    const enabled = override?.enabled ?? discovered;
    return deepFreeze({
      accountId: account.accountId,
      modelId: model?.id ?? stored?.modelId ?? "",
      name: model?.name ?? stored?.modelId ?? "",
      vendor: model?.vendor ?? "configured",
      discovered,
      configured,
      verified: discovered,
      enabled,
      visible: enabled && (discovered || configured),
      override,
      protocols,
      maxInputTokens,
      maxOutputTokens,
      defaultOutputTokens: resolveDefaultOutputTokens(
        defaultOutputTokens,
        maxOutputTokens.value,
      ),
      profile: { chatOutputTokenField },
      revision: {
        credentialGeneration: account.credentialGeneration,
        catalogGeneration: catalog.generation,
        overrideRevision: stored?.revision ?? this.overrides.get(account.accountId, model?.id ?? "").revision,
        builtinRevision: builtin?.revision ?? null,
      },
    });
  }
}

export function capabilitySnapshotFromCatalog(
  account: Readonly<BoundAccount>,
  catalog: Readonly<CatalogSnapshot>,
): CapabilityCatalogSnapshot {
  const models = catalog.models.map((model) => {
    const protocols = effectiveField(undefined, model.capabilities.protocols, UNKNOWN_DECLARATIONS.protocols, sameProtocols);
    const maxInputTokens = effectiveField(undefined, model.capabilities.maxInputTokens, UNKNOWN_DECLARATIONS.maxInputTokens);
    const maxOutputTokens = effectiveField(undefined, model.capabilities.maxOutputTokens, UNKNOWN_DECLARATIONS.maxOutputTokens);
    const defaultConfiguration = effectiveField(
      undefined,
      model.capabilities.defaultOutputTokens,
      UNKNOWN_DECLARATIONS.defaultOutputTokens,
    );
    const chatOutputTokenField = effectiveField(
      undefined,
      model.capabilities.chatOutputTokenField,
      UNKNOWN_DECLARATIONS.chatOutputTokenField,
    );
    return deepFreeze({
      accountId: account.accountId,
      modelId: model.id,
      name: model.name,
      vendor: model.vendor,
      discovered: true,
      configured: false,
      verified: true,
      enabled: true,
      visible: true,
      override: null,
      protocols,
      maxInputTokens,
      maxOutputTokens,
      defaultOutputTokens: resolveDefaultOutputTokens(defaultConfiguration, maxOutputTokens.value),
      profile: { chatOutputTokenField },
      revision: {
        credentialGeneration: account.credentialGeneration,
        catalogGeneration: catalog.generation,
        overrideRevision: 0,
        builtinRevision: null,
      },
    });
  });
  return deepFreeze({
    accountId: account.accountId,
    credentialGeneration: account.credentialGeneration,
    catalogGeneration: catalog.generation,
    fetchedAt: catalog.fetchedAt,
    models,
    overrideRevisions: {},
  });
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
