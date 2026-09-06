import type { DeviceFlowCancelResult } from "../accounts/device_flow.js";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { BoundAccount } from "../accounts/account_directory.js";
import type {
  ModelCapabilityOverrideValue,
  NativeModelProtocol,
  CapabilitySource,
  CapabilityFieldState,
  ChatOutputTokenField,
} from "../copilot/model_capabilities.js";
import { RUNTIME_CONFIG_RANGES } from "../config/schema.js";
import type { GatewayActivity } from "../gateway/create_gateway.js";
import type {
  AdminEventPage,
  AdminEventQuery,
  AdminTelemetry,
  AdminUsagePage,
  AdminUsageQuery,
} from "../telemetry/admin.js";
import type { PerformanceSnapshot } from "../telemetry/performance.js";
import { THRESHOLDS } from "../telemetry/performance.js";
import { toIso } from "./auth.js";

export type AdminErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "revision_conflict"
  | "capacity_exceeded"
  | "internal_error";

export class AdminApiError extends Error {
  constructor(readonly code: AdminErrorCode) {
    super(code.replaceAll("_", " "));
    this.name = "AdminApiError";
  }
}

export interface AdminRuntimeStatus {
  snapshot(): Readonly<{
    version: string;
    uptimeMs: number;
    daemon: { readonly managed: boolean; readonly pid?: number; readonly startedAt?: string };
  }>;
}

export interface AdminStatus {
  readonly version: string;
  readonly uptimeMs: number;
  readonly health: "ok";
  readonly performance: "healthy" | "degraded";
  readonly degradedSince?: string;
  readonly performanceMetrics: readonly AdminPerformanceMetric[];
  readonly admission: {
    readonly activeRequests: number;
    readonly activeStreams: number;
    readonly queuedRequests: number;
    readonly activeMax: number;
    readonly queueMax: number;
  };
  readonly storage: { readonly historyCount: number; readonly usageBucketCount: number; readonly eventCount: number };
  readonly telemetry: {
    readonly pendingMutations: number;
    readonly droppedUsageUpdates: number;
    readonly droppedOperationalEvents: number;
  };
  readonly daemon: { readonly managed: boolean; readonly pid?: number; readonly startedAt?: string };
}

export interface AdminPerformanceMetric {
  readonly metric: "buffered_p95_ms" | "stream_event_p95_ms" | "checkpoint_p95_ms" | "event_loop_p95_ms";
  readonly state: "healthy" | "degraded" | "insufficient_data";
  readonly actual: number | null;
  readonly threshold: number;
  readonly samples: number;
  readonly startedAt: string | null;
}

export interface AdminAccount {
  readonly accountId: string;
  readonly host: string;
  readonly numericUserId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly state: "active" | "removing" | "removed";
  readonly revision: number;
  readonly authenticatedAt: string | null;
  readonly preferredModel: AdminPreference | null;
}

export interface AdminPreference {
  readonly revision: number;
  readonly modelId: string;
  readonly validity: "valid" | "invalid";
}

export interface AdminAccounts {
  readonly defaultRevision: number;
  readonly defaultAccountId: string | null;
  readonly items: readonly AdminAccount[];
}

export interface AdminModels {
  readonly accountId: string;
  readonly credentialGeneration: number;
  readonly catalogGeneration: number;
  readonly fetchedAt: string;
  readonly capabilityRevision: number;
  readonly preferredModel: AdminPreference | null;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly discovered: boolean;
    readonly configured: boolean;
    readonly verified: boolean;
    readonly enabled: boolean;
    readonly visible: boolean;
    readonly protocols: readonly NativeModelProtocol[] | null;
    readonly protocolsSource: CapabilitySource;
    readonly protocolsConflict: boolean;
    readonly protocolsLiveState: CapabilityFieldState;
    readonly maxInputTokens: number | null;
    readonly maxInputTokensSource: CapabilitySource;
    readonly maxInputTokensConflict: boolean;
    readonly maxInputTokensLiveState: CapabilityFieldState;
    readonly maxOutputTokens: number | null;
    readonly maxOutputTokensSource: CapabilitySource;
    readonly maxOutputTokensConflict: boolean;
    readonly maxOutputTokensLiveState: CapabilityFieldState;
    readonly defaultOutputTokens: {
      readonly configured: number | null;
      readonly configuredSource: CapabilitySource;
      readonly conflict: boolean;
      readonly liveState: CapabilityFieldState;
      readonly effective: number;
      readonly source: CapabilitySource | "known_ceiling" | "unknown_fallback";
      readonly valid: boolean;
    };
    readonly chatOutputTokenField: ChatOutputTokenField | null;
    readonly chatOutputTokenFieldSource: CapabilitySource;
    readonly chatOutputTokenFieldConflict: boolean;
    readonly chatOutputTokenFieldLiveState: CapabilityFieldState;
    readonly overrideRevision: number;
    readonly builtinRevision: string | null;
    readonly override: ModelCapabilityOverrideValue | null;
  }[];
}

export interface AdminRuntimeConfig {
  readonly revision: number;
  readonly config: RuntimeConfigSnapshot;
  readonly ranges: Readonly<Record<string, { readonly min: number; readonly max: number; readonly unit: string }>>;
}

export interface AdminHistorySummary {
  readonly revision: number;
  readonly count: number;
  readonly oldestAt: string | null;
  readonly newestAt: string | null;
  readonly ttlDays: number;
  readonly maxResponses: number;
}

export interface AdminAccountDirectory {
  list(): readonly AdminAccountSummary[];
  defaultState(): { readonly defaultRevision: number; readonly defaultAccountId: string | null };
  use(accountId: string, expectedRevision: number, signal?: AbortSignal): number | Promise<number>;
  remove(
    accountId: string,
    expectedRevision: number,
    signal?: AbortSignal,
    onRemoving?: () => void,
  ): Promise<AdminAccountSummary>;
  bindAccount(accountId: string, signal?: AbortSignal): Promise<BoundAccount>;
}

export interface AdminAccountSummary {
  readonly accountId: string;
  readonly revision: number;
  readonly host: string;
  readonly userId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly state: "active" | "removing" | "removed";
  readonly authenticatedAtMs: number | null;
}

export interface AdminDeviceFlows {
  start(host: string, signal?: AbortSignal): Promise<{
    readonly flowId: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAtMs: number;
    readonly pollIntervalSeconds: number;
    readonly nextPollAtMs: number;
  }>;
  poll(flowId: string, signal?: AbortSignal): Promise<
    | {
        readonly status: "pending";
        readonly pollIntervalSeconds: number;
        readonly nextPollAtMs: number;
      }
    | { readonly status: "expired" | "denied" | "failed" }
    | { readonly status: "complete"; readonly accountId: string }
  >;
  cancel(flowId: string): Promise<DeviceFlowCancelResult>;
  has(flowId: string): boolean;
}

export interface AdminDeviceFlow {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
  readonly nextPollAt: string;
}

export type AdminDeviceFlowPoll =
  | {
      readonly state: "pending";
      readonly pollIntervalSeconds: number;
      readonly nextPollAt: string;
    }
  | { readonly state: "expired" | "denied" | "failed" }
  | { readonly state: "complete"; readonly account: AdminAccount };

export interface AdminCapabilityRegistry {
  get(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<{
    readonly accountId: string;
    readonly credentialGeneration: number;
    readonly catalogGeneration: number;
    readonly fetchedAt: string;
    readonly capabilityRevision: number;
    readonly models: readonly {
      readonly modelId: string;
      readonly name: string;
      readonly vendor: string;
      readonly discovered: boolean;
      readonly configured: boolean;
      readonly verified: boolean;
      readonly enabled: boolean;
      readonly visible: boolean;
      readonly protocols: {
        readonly value: readonly NativeModelProtocol[] | null;
        readonly source: CapabilitySource;
        readonly conflict: boolean;
        readonly liveState: CapabilityFieldState;
      };
      readonly maxInputTokens: {
        readonly value: number | null;
        readonly source: CapabilitySource;
        readonly conflict: boolean;
        readonly liveState: CapabilityFieldState;
      };
      readonly maxOutputTokens: {
        readonly value: number | null;
        readonly source: CapabilitySource;
        readonly conflict: boolean;
        readonly liveState: CapabilityFieldState;
      };
      readonly defaultOutputTokens: {
        readonly configuration: {
          readonly value: number | null;
          readonly source: CapabilitySource;
          readonly conflict: boolean;
          readonly liveState: CapabilityFieldState;
        };
        readonly effective: number;
        readonly source: CapabilitySource | "known_ceiling" | "unknown_fallback";
        readonly valid: boolean;
      };
      readonly profile: {
        readonly chatOutputTokenField: {
          readonly value: ChatOutputTokenField | null;
          readonly source: CapabilitySource;
          readonly conflict: boolean;
          readonly liveState: CapabilityFieldState;
        };
      };
      readonly revision: {
        readonly overrideRevision: number;
        readonly builtinRevision: string | null;
      };
      readonly override: ModelCapabilityOverrideValue | null;
    }[];
  }>;
  invalidate(accountId: string): void;
  previewOverride(
    account: Readonly<BoundAccount>,
    modelId: string,
    candidate: Readonly<ModelCapabilityOverrideValue> | null,
    expectedRevision: number,
    signal: AbortSignal,
  ): ReturnType<AdminCapabilityRegistry["get"]>;
}

export interface AdminAccountCaches {
  invalidate(accountId: string): void;
}

export interface AdminPreferences {
  get(accountId: string): AdminStoredPreference | null;
}

export interface AdminPreferredModels {
  setPreferred(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    catalog: Awaited<ReturnType<AdminCapabilityRegistry["get"]>>,
  ): AdminStoredPreference;
  markInvalidIfMissing(
    accountId: string,
    catalog: Awaited<ReturnType<AdminCapabilityRegistry["get"]>>,
    expectedRevision: number | null,
  ): AdminStoredPreference | null;
}

export interface AdminCapabilityOverrides {
  set(
    accountId: string,
    modelId: string,
    candidate: Readonly<ModelCapabilityOverrideValue>,
    expectedRevision: number,
    afterWrite?: () => void,
  ): unknown;
  reset(accountId: string, modelId: string, expectedRevision: number, afterWrite?: () => void): unknown;
}

export interface AdminStoredPreference extends AdminPreference {
  readonly accountId: string;
  readonly catalogGeneration: number;
}

export interface AdminRuntimeConfigManager {
  read(): Readonly<{ revision: number; config: RuntimeConfigSnapshot }>;
  updateAndApply(
    candidate: RuntimeConfigSnapshot,
    expectedRevision: number,
    signal: AbortSignal,
  ): Readonly<{ revision: number; config: RuntimeConfigSnapshot }>;
}

export interface AdminHistory {
  inspect(): {
    readonly revision: number;
    readonly count: number;
    readonly oldestAt: number | null;
    readonly newestAt: number | null;
    readonly ttlDays: number;
    readonly maxResponses: number;
  };
  clear(expectedRevision: number, signal?: AbortSignal): void;
}

export interface AdminApiDependencies {
  readonly accounts: AdminAccountDirectory;
  readonly deviceFlows: AdminDeviceFlows;
  readonly registry: AdminCapabilityRegistry;
  readonly preferences: AdminPreferences;
  readonly preferredModels: AdminPreferredModels;
  readonly capabilityOverrides: AdminCapabilityOverrides;
  readonly runtimeConfig: AdminRuntimeConfigManager;
  readonly history: AdminHistory;
  readonly telemetry: AdminTelemetry;
  readonly runtimeStatus: AdminRuntimeStatus;
  readonly accountCaches: AdminAccountCaches;
}

export class AdminManagementApi {
  private readonly modelMutations = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: Readonly<AdminApiDependencies>) {}

  status(activity: GatewayActivity): AdminStatus {
    const runtime = this.dependencies.runtimeStatus.snapshot();
    const config = this.dependencies.runtimeConfig.read().config;
    const telemetry = this.dependencies.telemetry.snapshot();
    const history = this.dependencies.history.inspect();
    const active = activity.snapshot();
    return {
      version: runtime.version,
      uptimeMs: runtime.uptimeMs,
      health: "ok",
      performance: telemetry.performance.status,
      ...(telemetry.performance.startedAtMs === null
        ? {}
        : { degradedSince: toIso(telemetry.performance.startedAtMs) }),
      performanceMetrics: performanceMetrics(telemetry.performance),
      admission: {
        ...active,
        activeMax: config.admission.activeMax,
        queueMax: config.admission.queueMax,
      },
      storage: { historyCount: history.count, ...telemetry.storage },
      telemetry: {
        pendingMutations: telemetry.pendingMutations,
        droppedUsageUpdates: telemetry.droppedUsageUpdates,
        droppedOperationalEvents: telemetry.droppedOperationalEvents,
      },
      daemon: runtime.daemon,
    };
  }

  accounts(): AdminAccounts {
    const state = this.dependencies.accounts.defaultState();
    return {
      defaultRevision: state.defaultRevision,
      defaultAccountId: state.defaultAccountId,
      items: this.dependencies.accounts.list().map((summary) => this.account(summary)),
    };
  }

  async startDeviceFlow(host: string, signal: AbortSignal): Promise<AdminDeviceFlow> {
    const flow = await this.dependencies.deviceFlows.start(host, signal);
    try {
      signal.throwIfAborted();
    } catch (error: unknown) {
      await this.dependencies.deviceFlows.cancel(flow.flowId);
      throw error;
    }
    return {
      flowId: flow.flowId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresAt: toIso(flow.expiresAtMs),
      pollIntervalSeconds: flow.pollIntervalSeconds,
      nextPollAt: toIso(flow.nextPollAtMs),
    };
  }

  async pollDeviceFlow(flowId: string, signal: AbortSignal): Promise<AdminDeviceFlowPoll> {
    const result = await this.dependencies.deviceFlows.poll(flowId, signal);
    signal.throwIfAborted();
    if (result.status === "pending") {
      return {
        state: "pending",
        pollIntervalSeconds: result.pollIntervalSeconds,
        nextPollAt: toIso(result.nextPollAtMs),
      };
    }
    if (result.status !== "complete") {
      return { state: result.status };
    }
    return { state: "complete", account: this.account(this.requireAccount(result.accountId)) };
  }

  async cancelDeviceFlow(flowId: string): Promise<
    | { readonly state: "canceled" | "not_found" }
    | { readonly state: "complete"; readonly account: AdminAccount }
  > {
    const result = await this.dependencies.deviceFlows.cancel(flowId);
    return result.status === "complete"
      ? { state: "complete", account: this.account(this.requireAccount(result.accountId)) }
      : { state: result.status };
  }

  hasDeviceFlow(flowId: string): boolean {
    return this.dependencies.deviceFlows.has(flowId);
  }

  async removeAccount(accountId: string, expectedRevision: number, signal: AbortSignal): Promise<AdminAccount> {
    signal.throwIfAborted();
    const removed = await this.dependencies.accounts.remove(
      accountId,
      expectedRevision,
      signal,
      () => this.dependencies.accountCaches.invalidate(accountId),
    );
    signal.throwIfAborted();
    return this.account(removed);
  }

  async useDefaultAccount(accountId: string, expectedRevision: number, signal: AbortSignal): Promise<{
    readonly defaultAccountId: string;
    readonly defaultRevision: number;
  }> {
    signal.throwIfAborted();
    const defaultRevision = await this.dependencies.accounts.use(accountId, expectedRevision, signal);
    signal.throwIfAborted();
    return { defaultAccountId: accountId, defaultRevision };
  }

  async models(accountId: string | null, signal: AbortSignal): Promise<AdminModels> {
    const resolved = accountId ?? this.dependencies.accounts.defaultState().defaultAccountId;
    if (resolved === null || this.requireAccount(resolved).state !== "active") {
      throw new AdminApiError("not_found");
    }
    const account = await this.dependencies.accounts.bindAccount(resolved, signal);
    const catalog = await this.dependencies.registry.get(account, signal);
    signal.throwIfAborted();
    return this.modelsDto(catalog);
  }

  async refreshModels(accountId: string, signal: AbortSignal): Promise<AdminModels> {
    return await this.withModelMutation(accountId, signal, async () => {
      this.requireActiveAccount(accountId);
      const before = this.dependencies.preferences.get(accountId);
      this.dependencies.registry.invalidate(accountId);
      const account = await this.dependencies.accounts.bindAccount(accountId, signal);
      const catalog = await this.dependencies.registry.get(account, signal);
      signal.throwIfAborted();
      await this.requireSameCredentialGeneration(accountId, account, signal);
      this.dependencies.preferredModels.markInvalidIfMissing(
        accountId,
        catalog,
        before?.revision ?? null,
      );
      return this.modelsDto(catalog);
    });
  }

  async setPreferredModel(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<{ readonly accountId: string; readonly preferredModel: AdminPreference }> {
    return await this.withModelMutation(accountId, signal, async () => {
      this.requireActiveAccount(accountId);
      const account = await this.dependencies.accounts.bindAccount(accountId, signal);
      const catalog = await this.dependencies.registry.get(account, signal);
      signal.throwIfAborted();
      await this.requireSameCredentialGeneration(accountId, account, signal);
      let preference: AdminStoredPreference;
      try {
        preference = this.dependencies.preferredModels.setPreferred(
          accountId,
          modelId,
          expectedRevision,
          catalog,
        );
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "model not in catalog") {
          throw new AdminApiError("not_found");
        }
        throw error;
      }
      return { accountId, preferredModel: preferenceDto(preference) };
    });
  }

  async setModelCapabilities(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    candidate: Readonly<ModelCapabilityOverrideValue>,
    signal: AbortSignal,
  ): Promise<AdminModels> {
    return await this.withModelMutation(accountId, signal, async () => {
      this.requireActiveAccount(accountId);
      const before = this.dependencies.preferences.get(accountId);
      const validatedAccount = await this.dependencies.accounts.bindAccount(accountId, signal);
      const preview = await this.dependencies.registry.previewOverride(
        validatedAccount,
        modelId,
        candidate,
        expectedRevision,
        signal,
      );
      signal.throwIfAborted();
      await this.requireSameCredentialGeneration(accountId, validatedAccount, signal);
      if (this.dependencies.preferences.get(accountId)?.revision !== before?.revision) {
        throw new AdminApiError("revision_conflict");
      }
      this.dependencies.capabilityOverrides.set(
        accountId,
        modelId,
        candidate,
        expectedRevision,
        () => this.dependencies.preferredModels.markInvalidIfMissing(
          accountId,
          preview,
          before?.revision ?? null,
        ),
      );
      return this.modelsDto(preview);
    });
  }

  async resetModelCapabilities(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<AdminModels> {
    return await this.withModelMutation(accountId, signal, async () => {
      this.requireActiveAccount(accountId);
      const before = this.dependencies.preferences.get(accountId);
      const account = await this.dependencies.accounts.bindAccount(accountId, signal);
      const preview = await this.dependencies.registry.previewOverride(
        account,
        modelId,
        null,
        expectedRevision,
        signal,
      );
      signal.throwIfAborted();
      await this.requireSameCredentialGeneration(accountId, account, signal);
      if (this.dependencies.preferences.get(accountId)?.revision !== before?.revision) {
        throw new AdminApiError("revision_conflict");
      }
      this.dependencies.capabilityOverrides.reset(
        accountId,
        modelId,
        expectedRevision,
        () => this.dependencies.preferredModels.markInvalidIfMissing(
          accountId,
          preview,
          before?.revision ?? null,
        ),
      );
      return this.modelsDto(preview);
    });
  }

  runtimeConfig(): AdminRuntimeConfig {
    return this.runtimeConfigDto(this.dependencies.runtimeConfig.read());
  }

  updateRuntimeConfig(config: RuntimeConfigSnapshot, expectedRevision: number, signal: AbortSignal): AdminRuntimeConfig {
    signal.throwIfAborted();
    const updated = this.dependencies.runtimeConfig.updateAndApply(config, expectedRevision, signal);
    signal.throwIfAborted();
    return this.runtimeConfigDto(updated);
  }

  history(): AdminHistorySummary {
    const history = this.dependencies.history.inspect();
    return {
      revision: history.revision,
      count: history.count,
      oldestAt: nullableIso(history.oldestAt),
      newestAt: nullableIso(history.newestAt),
      ttlDays: history.ttlDays,
      maxResponses: history.maxResponses,
    };
  }

  clearHistory(expectedRevision: number, signal: AbortSignal): AdminHistorySummary {
    signal.throwIfAborted();
    this.dependencies.history.clear(expectedRevision, signal);
    signal.throwIfAborted();
    return this.history();
  }

  async usage(query: AdminUsageQuery, signal: AbortSignal): Promise<AdminUsagePage> {
    return await this.dependencies.telemetry.queryUsage(query, signal);
  }

  async events(query: AdminEventQuery, signal: AbortSignal): Promise<AdminEventPage> {
    return await this.dependencies.telemetry.queryEvents(query, signal);
  }

  private account(summary: AdminAccountSummary): AdminAccount {
    return {
      accountId: summary.accountId,
      host: summary.host,
      numericUserId: summary.userId,
      login: summary.login,
      displayName: summary.displayName,
      state: summary.state,
      revision: summary.revision,
      authenticatedAt: nullableIso(summary.authenticatedAtMs),
      preferredModel: nullablePreference(this.dependencies.preferences.get(summary.accountId)),
    };
  }

  private modelsDto(catalog: Awaited<ReturnType<AdminCapabilityRegistry["get"]>>): AdminModels {
    return {
      accountId: catalog.accountId,
      credentialGeneration: catalog.credentialGeneration,
      catalogGeneration: catalog.catalogGeneration,
      fetchedAt: catalog.fetchedAt,
      capabilityRevision: catalog.capabilityRevision,
      preferredModel: nullablePreference(this.dependencies.preferences.get(catalog.accountId)),
      items: catalog.models.map((model) => ({
        id: model.modelId,
        name: model.name,
        vendor: model.vendor,
        discovered: model.discovered,
        configured: model.configured,
        verified: model.verified,
        enabled: model.enabled,
        visible: model.visible,
        protocols: model.protocols.value,
        protocolsSource: model.protocols.source,
        protocolsConflict: model.protocols.conflict,
        protocolsLiveState: model.protocols.liveState,
        maxInputTokens: model.maxInputTokens.value,
        maxInputTokensSource: model.maxInputTokens.source,
        maxInputTokensConflict: model.maxInputTokens.conflict,
        maxInputTokensLiveState: model.maxInputTokens.liveState,
        maxOutputTokens: model.maxOutputTokens.value,
        maxOutputTokensSource: model.maxOutputTokens.source,
        maxOutputTokensConflict: model.maxOutputTokens.conflict,
        maxOutputTokensLiveState: model.maxOutputTokens.liveState,
        defaultOutputTokens: {
          configured: model.defaultOutputTokens.configuration.value,
          configuredSource: model.defaultOutputTokens.configuration.source,
          conflict: model.defaultOutputTokens.configuration.conflict,
          liveState: model.defaultOutputTokens.configuration.liveState,
          effective: model.defaultOutputTokens.effective,
          source: model.defaultOutputTokens.source,
          valid: model.defaultOutputTokens.valid,
        },
        chatOutputTokenField: model.profile.chatOutputTokenField.value,
        chatOutputTokenFieldSource: model.profile.chatOutputTokenField.source,
        chatOutputTokenFieldConflict: model.profile.chatOutputTokenField.conflict,
        chatOutputTokenFieldLiveState: model.profile.chatOutputTokenField.liveState,
        overrideRevision: model.revision.overrideRevision,
        builtinRevision: model.revision.builtinRevision,
        override: model.override,
      })),
    };
  }

  private requireAccount(accountId: string): AdminAccountSummary {
    const account = this.dependencies.accounts.list().find((candidate) => candidate.accountId === accountId);
    if (account === undefined) {
      throw new AdminApiError("not_found");
    }
    return account;
  }

  private requireActiveAccount(accountId: string): AdminAccountSummary {
    const account = this.requireAccount(accountId);
    if (account.state !== "active") {
      throw new AdminApiError("not_found");
    }
    return account;
  }

  private async requireSameCredentialGeneration(
    accountId: string,
    expected: Readonly<BoundAccount>,
    signal: AbortSignal,
  ): Promise<BoundAccount> {
    signal.throwIfAborted();
    const current = await this.dependencies.accounts.bindAccount(accountId, signal);
    signal.throwIfAborted();
    this.requireActiveAccount(accountId);
    if (current.credentialGeneration !== expected.credentialGeneration) {
      throw new AdminApiError("revision_conflict");
    }
    return current;
  }

  private runtimeConfigDto(
    state: Readonly<{ revision: number; config: RuntimeConfigSnapshot }>,
  ): AdminRuntimeConfig {
    return { ...state, ranges: RUNTIME_CONFIG_RANGES };
  }

  private async withModelMutation<T>(
    accountId: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const previous = this.modelMutations.get(accountId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.modelMutations.set(accountId, queued);
    try {
      await waitFor(previous, signal);
      signal.throwIfAborted();
      return await work();
    } finally {
      release();
      void queued.finally(() => {
        if (this.modelMutations.get(accountId) === queued) {
          this.modelMutations.delete(accountId);
        }
      });
    }
  }
}

async function waitFor(work: Promise<void>, signal: AbortSignal): Promise<void> {
  let removeAbortListener = (): void => undefined;
  await Promise.race([
    work,
    new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }),
  ]).finally(removeAbortListener);
}

export function mapAdminError(error: unknown): AdminApiError {
  if (error instanceof AdminApiError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    throw error;
  }
  const code = errorCode(error);
  if (code === "validation_failed") {
    return new AdminApiError("validation_failed");
  }
  if (code === "revision_conflict") {
    return new AdminApiError("revision_conflict");
  }
  if (code === "capacity") {
    return new AdminApiError("capacity_exceeded");
  }
  if (code === "not_found" || code === "no_default" || code === "expired") {
    return new AdminApiError("not_found");
  }
  if (code === "invalid_config" || errorName(error) === "GitHubEnvironmentError") {
    return new AdminApiError("validation_failed");
  }
  if (errorName(error) === "PreferenceRevisionError" || errorName(error) === "ResponsesHistoryAdminError") {
    return new AdminApiError("revision_conflict");
  }
  return new AdminApiError("internal_error");
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function nullablePreference(preference: AdminStoredPreference | null): AdminPreference | null {
  return preference === null ? null : preferenceDto(preference);
}

function preferenceDto(preference: AdminStoredPreference): AdminPreference {
  return { revision: preference.revision, modelId: preference.modelId, validity: preference.validity };
}

function performanceMetrics(snapshot: PerformanceSnapshot): readonly AdminPerformanceMetric[] {
  const startedAt = nullableIso(snapshot.startedAtMs);
  return [
    performanceMetric("buffered_p95_ms", snapshot.metrics.bufferedMs, THRESHOLDS.bufferedMs, startedAt),
    performanceMetric("stream_event_p95_ms", snapshot.metrics.eventMs, THRESHOLDS.eventMs, startedAt),
    performanceMetric("checkpoint_p95_ms", snapshot.metrics.checkpointMs, THRESHOLDS.checkpointMs, startedAt),
    performanceMetric("event_loop_p95_ms", snapshot.metrics.eventLoopMs, THRESHOLDS.eventLoopMs, startedAt),
  ];
}

function nullableIso(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

function performanceMetric(
  metric: AdminPerformanceMetric["metric"],
  input: PerformanceSnapshot["metrics"]["bufferedMs"],
  threshold: number,
  startedAt: string | null,
): AdminPerformanceMetric {
  return {
    metric,
    state: input.status === "over" ? "degraded" : input.status,
    actual: input.p95,
    threshold,
    samples: input.samples ?? 0,
    startedAt: input.status === "over" ? startedAt : null,
  };
}
