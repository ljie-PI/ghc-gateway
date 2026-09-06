import { parseLiveModelCapabilities, type DeclaredModelCapabilities } from "./model_capabilities.js";

export const DEFAULT_MODEL_CREATED_AT_TIME = 1_677_610_602;

export interface CopilotCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly modelPickerEnabled: boolean;
  readonly capabilities: DeclaredModelCapabilities;
}

export interface CatalogSnapshot {
  readonly accountId: string;
  readonly models: readonly CopilotCatalogModel[];
  readonly fetchedAt: string;
  readonly generation: number;
  readonly credentialGeneration: number;
}

export interface CapiModelsResponse {
  readonly data: readonly unknown[];
}

export interface CopilotModelsSource {
  fetch(accountId: string, signal: AbortSignal, credentialGeneration?: number): Promise<CapiModelsResponse>;
  close?(): Promise<void> | void;
}

export interface ModelInfoLookup {
  get(modelId: string): {
    readonly mode?: unknown;
    readonly max_input_tokens?: unknown;
    readonly max_output_tokens?: unknown;
    readonly supported_endpoints?: unknown;
    readonly default_output_tokens?: unknown;
    readonly chat_output_token_field?: unknown;
  } | null;
}

interface CacheEntry {
  catalog: CatalogSnapshot;
  generation: number;
  credentialGeneration: number;
}

interface InflightEntry {
  readonly generation: number;
  readonly credentialGeneration: number;
  readonly promise: Promise<CatalogSnapshot>;
}

export class CopilotModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly generations = new Map<string, number>();
  private readonly credentialGenerations = new Map<string, number>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly activeControllers = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly source: CopilotModelsSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(
    accountId: string,
    signal: AbortSignal,
    credentialGeneration = 0,
  ): Promise<CatalogSnapshot> {
    if (this.closed) {
      throw new DOMException("closed", "AbortError");
    }
    this.credentialGenerations.set(
      accountId,
      Math.max(credentialGeneration, this.credentialGenerations.get(accountId) ?? credentialGeneration),
    );
    const hit = this.cache.get(accountId);
    if (hit !== undefined && hit.credentialGeneration === credentialGeneration) {
      return hit.catalog;
    }
    const generation = this.generations.get(accountId) ?? 0;
    const pending = this.inflight.get(accountId);
    if (pending !== undefined
      && pending.generation === generation
      && pending.credentialGeneration === credentialGeneration) {
      return await waitForCatalog(pending.promise, signal);
    }
    const controller = new AbortController();
    const promise = this.fetchCatalog(accountId, generation, credentialGeneration, controller.signal);
    this.inflight.set(accountId, { generation, credentialGeneration, promise });
    this.activeControllers.add(controller);
    void promise.finally(() => {
      this.activeControllers.delete(controller);
      if (this.inflight.get(accountId)?.promise === promise) {
        this.inflight.delete(accountId);
      }
    }).catch(() => undefined);
    return await waitForCatalog(promise, signal);
  }

  private async fetchCatalog(
    accountId: string,
    generation: number,
    credentialGeneration: number,
    signal: AbortSignal,
  ): Promise<CatalogSnapshot> {
    const raw = await this.source.fetch(accountId, signal, credentialGeneration);
    if (this.closed) {
      throw new DOMException("closed", "AbortError");
    }
    const models = parseCapiModels(raw);
    const fetchedAt = toRfc3339Nano(this.now());
    const catalog: CatalogSnapshot = {
      accountId,
      models,
      fetchedAt,
      generation,
      credentialGeneration,
    };
    if ((this.generations.get(accountId) ?? 0) === generation
      && this.credentialGenerations.get(accountId) === credentialGeneration) {
      this.cache.set(accountId, { catalog, generation, credentialGeneration });
    }
    return catalog;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
  }

  isCurrent(accountId: string, generation: number, credentialGeneration: number): boolean {
    return (this.generations.get(accountId) ?? 0) === generation
      && this.credentialGenerations.get(accountId) === credentialGeneration;
  }

  clear(): void {
    for (const accountId of new Set([...this.cache.keys(), ...this.generations.keys()])) {
      this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
    }
    this.cache.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clear();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.inflight.clear();
    this.activeControllers.clear();
    await this.source.close?.();
  }
}

export function parseCapiModels(raw: CapiModelsResponse | unknown): CopilotCatalogModel[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("data" in raw)) {
    throw new Error("invalid CAPI models response");
  }
  const data = (raw as { data: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("invalid CAPI models response");
  }
  const models: CopilotCatalogModel[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid CAPI model item");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.vendor !== "string" || typeof record.model_picker_enabled !== "boolean") {
      throw new Error("invalid CAPI model item");
    }
    if (record.model_picker_enabled !== true) {
      continue;
    }
    models.push({
      id: record.id,
      name: record.name,
      vendor: record.vendor,
      modelPickerEnabled: true,
      capabilities: parseLiveModelCapabilities(record),
    });
  }
  return models;
}

export function toRfc3339Nano(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/u, "Z");
}

export function capiModelsUrl(endpoint: string): string {
  return `${endpoint}/models`;
}

async function waitForCatalog(
  promise: Promise<CatalogSnapshot>,
  signal: AbortSignal,
): Promise<CatalogSnapshot> {
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  let remove = (): void => undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        remove = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    remove();
  }
}
