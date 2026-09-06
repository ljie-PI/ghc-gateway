import type { AccountDirectory } from "../../accounts/account_directory.js";
import { AccountDirectoryError, type AccountSummary } from "../../accounts/account_directory.js";
import { DeviceFlowError, type DeviceFlowService } from "../../accounts/device_flow.js";
import { PreferenceRevisionError } from "../../accounts/model_preferences.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import { capabilitySnapshotFromCatalog, type ModelCapabilityRegistry } from "../../copilot/capability_registry.js";
import type { RuntimeConfigStore } from "../../config/runtime_config.js";
import { isRuntimeConfigKey, readRuntimeConfigNumber, RUNTIME_CONFIG_RANGES, RuntimeConfigError, withRuntimeConfigNumber } from "../../config/runtime_config.js";
import type { RuntimeConfigSnapshot } from "../../config/schema.js";
import { PreferredModelManager } from "../../protocols/model_catalog/preferred.js";
import {
  CliError,
  adminAccountFromSummary,
  adminModelsFromCatalog,
  type AdminAccounts,
  type AdminRuntimeConfig,
  type ControlClient,
  type ControlOperation,
  type ControlOperationMap,
} from "../control_client.js";

export interface CommandDispatcherDependencies {
  readonly directory: AccountDirectory;
  readonly deviceFlows: Pick<DeviceFlowService, "start" | "poll">;
  readonly catalog: CopilotModelCatalog;
  readonly registry?: ModelCapabilityRegistry;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly updateRuntimeConfig?: (
    candidate: RuntimeConfigSnapshot,
    expectedRevision: number,
    signal: AbortSignal,
  ) => Readonly<{ revision: number; config: RuntimeConfigSnapshot }>;
  readonly invalidateAccountCaches?: (accountId: string) => void;
}

export class CommandDispatcher {
  constructor(private readonly dependencies: CommandDispatcherDependencies) {}

  async dispatch<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    try {
      return await this.dispatchUnsafe(operation, args, signal);
    } catch (error: unknown) {
      throw mapDispatcherError(error);
    }
  }

  private async dispatchUnsafe<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    signal: AbortSignal,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    switch (operation) {
    case "auth.login.start": {
      const input = args as ControlOperationMap["auth.login.start"]["args"];
      const started = await this.dependencies.deviceFlows.start(input.host ?? "github.com", signal);
      return {
        flowId: started.flowId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresAt: new Date(started.expiresAtMs).toISOString(),
        pollIntervalSeconds: started.pollIntervalSeconds,
      } as ControlOperationMap[Operation]["result"];
    }
    case "auth.login.poll": {
      const input = args as ControlOperationMap["auth.login.poll"]["args"];
      const result = await this.dependencies.deviceFlows.poll(input.flowId, signal);
      if (result.status === "pending") {
        return { state: "pending" } as ControlOperationMap[Operation]["result"];
      }
      if (result.status === "expired") {
        return { state: "expired" } as ControlOperationMap[Operation]["result"];
      }
      if (result.status === "failed") {
        return { state: "failed" } as ControlOperationMap[Operation]["result"];
      }
      const account = this.requireAccount(result.accountId);
      return { state: "complete", account: this.adminAccount(account) } as ControlOperationMap[Operation]["result"];
    }
    case "auth.logout": {
      const input = args as ControlOperationMap["auth.logout"]["args"];
      const account = input.accountId === undefined ? this.defaultAccount() : this.requireAccount(input.accountId);
      const removed = await this.dependencies.directory.remove(
        account.accountId,
        account.revision,
        signal,
        () => this.invalidateAccountCaches(account.accountId),
      );
      return this.adminAccount(removed) as ControlOperationMap[Operation]["result"];
    }
    case "auth.status": {
      const accounts = this.adminAccounts();
      return {
        defaultAccountId: accounts.defaultAccountId,
        accounts: accounts.items,
      } as ControlOperationMap[Operation]["result"];
    }
    case "accounts.list":
      return this.adminAccounts() as ControlOperationMap[Operation]["result"];
    case "accounts.use": {
      const input = args as ControlOperationMap["accounts.use"]["args"];
      this.dependencies.directory.use(input.accountId, this.dependencies.directory.defaultPreference().revision);
      return this.adminAccounts() as ControlOperationMap[Operation]["result"];
    }
    case "accounts.remove": {
      const input = args as ControlOperationMap["accounts.remove"]["args"];
      const account = this.requireAccount(input.accountId);
      const removed = await this.dependencies.directory.remove(
        input.accountId,
        account.revision,
        signal,
        () => this.invalidateAccountCaches(input.accountId),
      );
      return this.adminAccount(removed) as ControlOperationMap[Operation]["result"];
    }
    case "models.list": {
      const input = args as ControlOperationMap["models.list"]["args"];
      const accountId = input.accountId ?? this.defaultAccount().accountId;
      const account = await this.dependencies.directory.bindAccount(accountId, signal);
      const beforePreference = this.dependencies.directory.preferences.get(accountId);
      const catalog = this.dependencies.registry === undefined
        ? capabilitySnapshotFromCatalog(
          account,
          await this.dependencies.catalog.get(accountId, signal, account.credentialGeneration),
        )
        : await this.dependencies.registry.get(account, signal);
      this.dependencies.directory.preferences.markInvalidIfMissing(
        accountId,
        new Set(catalog.models.filter((model) => model.visible).map((model) => model.modelId)),
        catalog.catalogGeneration,
        beforePreference?.revision ?? null,
      );
      return adminModelsFromCatalog(
        accountId,
        catalog,
        this.dependencies.directory.preferences.get(accountId),
      ) as ControlOperationMap[Operation]["result"];
    }
    case "models.current": {
      const account = this.defaultAccount();
      return {
        accountId: account.accountId,
        preferredModel: this.dependencies.directory.preferences.get(account.accountId),
      } as ControlOperationMap[Operation]["result"];
    }
    case "models.set": {
      const input = args as ControlOperationMap["models.set"]["args"];
      const account = this.defaultAccount();
      const bound = await this.dependencies.directory.bindAccount(account.accountId, signal);
      const catalog = this.dependencies.registry === undefined
        ? capabilitySnapshotFromCatalog(
          bound,
          await this.dependencies.catalog.get(account.accountId, signal, bound.credentialGeneration),
        )
        : await this.dependencies.registry.get(bound, signal);
      const current = this.dependencies.directory.preferences.get(account.accountId);
      const manager = new PreferredModelManager(this.dependencies.directory.preferences);
      return manager.setPreferred(account.accountId, input.modelId, current?.revision ?? 0, catalog) as ControlOperationMap[Operation]["result"];
    }
    case "config.get": {
      const input = args as ControlOperationMap["config.get"]["args"];
      const admin = this.adminRuntimeConfig();
      if (input.key === undefined) {
        return admin as ControlOperationMap[Operation]["result"];
      }
      const entry = configEntry(admin.config, input.key);
      return { key: input.key, value: entry.value, range: entry.range } as ControlOperationMap[Operation]["result"];
    }
    case "config.set": {
      const input = args as ControlOperationMap["config.set"]["args"];
      const revision = this.dependencies.runtimeConfig.readRevision();
      const current = this.dependencies.runtimeConfig.readSnapshot();
      const next = setConfigValue(current, input.key, input.value);
      if (this.dependencies.updateRuntimeConfig === undefined) {
        this.dependencies.runtimeConfig.update(next, revision);
      } else {
        this.dependencies.updateRuntimeConfig(next, revision, signal);
      }
      return this.adminRuntimeConfig() as ControlOperationMap[Operation]["result"];
    }
    }
  }

  private adminAccounts(): AdminAccounts {
    const preference = this.dependencies.directory.defaultPreference();
    return {
      defaultRevision: preference.revision,
      defaultAccountId: preference.defaultAccountId,
      items: this.dependencies.directory.list().map((account) => this.adminAccount(account)),
    };
  }

  private invalidateAccountCaches(accountId: string): void {
    if (this.dependencies.invalidateAccountCaches === undefined) {
      this.dependencies.catalog.invalidate(accountId);
      return;
    }
    this.dependencies.invalidateAccountCaches(accountId);
  }

  private adminAccount(summary: AccountSummary) {
    return adminAccountFromSummary(summary, this.dependencies.directory.preferences.get(summary.accountId));
  }

  private defaultAccount(): AccountSummary {
    const accountId = this.dependencies.directory.defaultPreference().defaultAccountId;
    if (accountId === null) {
      throw new CliError("not_found");
    }
    return this.requireAccount(accountId);
  }

  private requireAccount(accountId: string): AccountSummary {
    const account = this.dependencies.directory.list().find((item) => item.accountId === accountId);
    if (account === undefined) {
      throw new CliError("not_found");
    }
    return account;
  }

  private adminRuntimeConfig(): AdminRuntimeConfig {
    return {
      revision: this.dependencies.runtimeConfig.readRevision(),
      config: this.dependencies.runtimeConfig.readSnapshot(),
      ranges: RUNTIME_CONFIG_RANGES,
    };
  }
}

export class DispatcherControlClient implements Pick<ControlClient, "request"> {
  constructor(private readonly dispatcher: CommandDispatcher) {}

  async request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    context: Parameters<ControlClient["request"]>[2],
  ): Promise<ControlOperationMap[Operation]["result"]> {
    return await this.dispatcher.dispatch(operation, args, context.signal);
  }
}

function configEntry(config: RuntimeConfigSnapshot, key: string): {
  readonly value: number;
  readonly range: { readonly min: number; readonly max: number; readonly unit: string };
} {
  if (!isRuntimeConfigKey(key)) {
    throw new CliError(startupOnlyKeys.has(key) ? "validation_error" : "not_found");
  }
  const range = RUNTIME_CONFIG_RANGES[key];
  const value = readRuntimeConfigNumber(config, key);
  return { value, range };
}

function setConfigValue(config: RuntimeConfigSnapshot, key: string, rawValue: string): RuntimeConfigSnapshot {
  if (!isRuntimeConfigKey(key) || startupOnlyKeys.has(key)) {
    throw new CliError("validation_error");
  }
  const range = RUNTIME_CONFIG_RANGES[key];
  if (!/^[0-9]+$/u.test(rawValue)) {
    throw new CliError("validation_error");
  }
  const value = Number.parseInt(rawValue, 10);
  if (value < range.min || value > range.max) {
    throw new CliError("validation_error");
  }
  return withRuntimeConfigNumber(config, key, value);
}

function mapDispatcherError(error: unknown): CliError {
  if (error instanceof Error && error.name === "DeviceOAuthError") {
    return new CliError("remote_error");
  }
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof AccountDirectoryError) {
    if (error.code === "revision_conflict") {
      return new CliError("revision_conflict");
    }
    if (error.code === "not_found" || error.code === "no_default") {
      return new CliError("not_found");
    }
    return new CliError("unavailable");
  }
  if (error instanceof PreferenceRevisionError) {
    return new CliError("revision_conflict");
  }
  if (error instanceof Error && error.message === "model not in catalog") {
    return new CliError("not_found");
  }
  if (error instanceof RuntimeConfigError) {
    return new CliError(error.code === "revision_conflict" ? "revision_conflict" : "validation_error");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CliError("interrupted");
  }
  if (error instanceof DeviceFlowError) {
    return new CliError(error.code === "not_found" || error.code === "expired" ? "not_found" : "unavailable");
  }
  return new CliError("internal_error");
}

const startupOnlyKeys = new Set(["port", "dataDir", "logLevel"]);
