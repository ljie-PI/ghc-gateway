import type { BoundAccount } from "../../src/accounts/account_directory.js";
import {
  ModelCapabilityRegistry,
  type CapabilityCatalogSnapshot,
} from "../../src/copilot/capability_registry.js";
import type { BuiltinModelCapabilityLookup } from "../../src/copilot/model_capabilities.js";
import type { CatalogSnapshot, CopilotModelCatalog } from "../../src/copilot/model_catalog.js";

export const noBuiltinModelCapabilities: BuiltinModelCapabilityLookup = {
  get: () => null,
};

export function testModelCapabilityRegistry(
  catalog: CopilotModelCatalog,
  builtins: BuiltinModelCapabilityLookup = noBuiltinModelCapabilities,
): ModelCapabilityRegistry {
  return new ModelCapabilityRegistry(catalog, builtins);
}

export async function registrySnapshotFromDiscovery(
  account: Readonly<BoundAccount>,
  snapshot: Readonly<CatalogSnapshot>,
  builtins: BuiltinModelCapabilityLookup = noBuiltinModelCapabilities,
): Promise<CapabilityCatalogSnapshot> {
  const catalog = {
    get: async () => snapshot,
    invalidate: () => undefined,
    isCurrent: () => true,
    close: async () => undefined,
  } as unknown as CopilotModelCatalog;
  return await new ModelCapabilityRegistry(catalog, builtins).get(
    account,
    new AbortController().signal,
  );
}
