import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import type { CapabilityCatalogSnapshot } from "../../copilot/capability_registry.js";

export class PreferredModelManager {
  constructor(private readonly preferences: AccountModelPreferences) {}

  setPreferred(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    catalog: CapabilityCatalogSnapshot,
  ): ModelPreference {
    if (!catalog.models.some((model) => model.modelId === modelId && model.visible)) {
      throw new Error("model not in catalog");
    }
    return this.preferences.set(accountId, {
      modelId,
      catalogGeneration: catalog.catalogGeneration,
    }, expectedRevision);
  }

  markInvalidIfMissing(
    accountId: string,
    catalog: CapabilityCatalogSnapshot,
    expectedRevision: number | null,
  ): ModelPreference | null {
    return this.preferences.markInvalidIfMissing(
      accountId,
      new Set(catalog.models.filter((model) => model.visible).map((model) => model.modelId)),
      catalog.catalogGeneration,
      expectedRevision,
    );
  }
}
