import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import { PreferenceRevisionError } from "../../accounts/model_preferences.js";
import type { CapabilityCatalogSnapshot } from "../../copilot/capability_registry.js";
import {
  isCapabilitySnapshotCurrent,
  type CapabilitySnapshotDependencies,
} from "../../copilot/capability_registry.js";
import { AccountDirectoryError, type AccountDirectory, type BoundAccount } from "../../accounts/account_directory.js";

export class PreferredModelManager {
  constructor(private readonly preferences: AccountModelPreferences) {}

  setPreferred(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    catalog: CapabilityCatalogSnapshot,
  ): ModelPreference {
    if (!catalog.models.some((model) => model.modelId === modelId)) {
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
      new Set(catalog.models.map((model) => model.modelId)),
      catalog.catalogGeneration,
      expectedRevision,
    );
  }
}

export function reconcilePreferredModel(
  preferences: AccountModelPreferences,
  accountId: string,
  catalog: CapabilityCatalogSnapshot,
  observed: ModelPreference | null,
): ModelPreference | null {
  try {
    return preferences.markInvalidIfMissing(
      accountId,
      new Set(catalog.models.map((model) => model.modelId)),
      catalog.catalogGeneration,
      observed?.revision ?? null,
    );
  } catch (error: unknown) {
    if (error instanceof PreferenceRevisionError) {
      return preferences.get(accountId);
    }

    throw error;
  }
}

export async function reconcilePreferredModelIfCurrent(
  preferences: AccountModelPreferences,
  directory: AccountDirectory,
  capabilities: Readonly<CapabilitySnapshotDependencies>,
  boundAccount: Readonly<BoundAccount>,
  catalog: CapabilityCatalogSnapshot,
  observed: ModelPreference | null,
  signal: AbortSignal,
): Promise<ModelPreference | null> {
  let current: BoundAccount;
  try {
    current = await directory.bindAccount(boundAccount.accountId, signal);
  } catch (error: unknown) {
    if (error instanceof AccountDirectoryError && error.code === "not_found") {
      return preferences.get(boundAccount.accountId);
    }
    throw error;
  }
  if (current.credentialGeneration !== boundAccount.credentialGeneration
    || !isCapabilitySnapshotCurrent(capabilities, catalog)) {
    return preferences.get(boundAccount.accountId);
  }
  return reconcilePreferredModel(preferences, boundAccount.accountId, catalog, observed);
}
