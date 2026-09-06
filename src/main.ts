import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminStaticModule } from "./admin/static.js";
import { createAdminModule } from "./admin/routes.js";
import type { AccountDirectory } from "./accounts/account_directory.js";
import { DeviceFlowService } from "./accounts/device_flow.js";
import { HttpDeviceOAuthClient } from "./accounts/device_oauth.js";
import { FileCredentialStore, type CredentialStore } from "./accounts/credential_store.js";
import { createCopilotEndpointDiscovery, refreshCopilotToken } from "./copilot/credential_provider.js";
import { HttpCopilotModelsSource } from "./copilot/models_source.js";
import { CopilotModelCatalog, type CopilotModelsSource } from "./copilot/model_catalog.js";
import { productionModelInfoLookup, type NormalizedModelInfo } from "./copilot/model_metadata.js";
import { HttpCopilotBackend } from "./copilot/transport.js";
import type { CopilotBackend } from "./copilot/backend.js";
import { getValidToken } from "./copilot/token_refresh.js";
import { discoverEndpoint, invalidateEndpoint } from "./copilot/endpoint_discovery.js";
import { CommandDispatcher } from "./cli/commands/dispatcher.js";
import { RuntimeConfigStore } from "./config/runtime_config.js";
import { defaultRuntimeConfigSnapshot, parseRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "./config/schema.js";
import { parseStartupConfig, type StartupConfig } from "./config/startup_config.js";
import { createGateway, type GatewayDependencies, type HostedGateway, type RouteRegistration } from "./gateway/create_gateway.js";
import type { DaemonRuntimeComposition } from "./daemon/runtime.js";
import { createLocalControlModule } from "./daemon/local_control.js";
import { closeDatabase, openDatabase } from "./persistence/database.js";
import { MIGRATION_MANIFEST } from "./persistence/generated_migrations.js";
import { AccountDirectory as SqliteAccountDirectory } from "./accounts/account_directory.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import { createModelCatalogRoutes } from "./protocols/model_catalog/routes.js";
import { createOpenAiChatRoute } from "./protocols/openai_chat/endpoint.js";
import { createAnthropicMessagesRoute } from "./protocols/anthropic_messages/endpoint.js";
import { createResponsesRoute } from "./protocols/responses/endpoint.js";
import { PreferredModelManager } from "./protocols/model_catalog/preferred.js";
import { SqliteResponsesHistory, type ResponsesHistory, type ResponsesHistoryAdmin } from "./protocols/responses/history.js";
import { SqliteAdminTelemetry } from "./telemetry/admin.js";
import { TelemetryRuntime } from "./telemetry/runtime.js";
import type { ProtocolPerformanceObserver } from "./telemetry/runtime.js";
import { VERSION } from "./version.js";
import type { SqliteDatabase } from "./persistence/sqlite.js";

export interface BootstrapOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly startup?: StartupConfig;
  readonly routes?: readonly RouteRegistration[];
  readonly dependencies?: Readonly<GatewayDependencies>;
  readonly homedir?: string;
  readonly application?: Readonly<ApplicationContext>;
}

export interface ProductionDaemonCompositionOptions {
  readonly application?: Readonly<ApplicationContext>;
  readonly uptimeMs?: () => number;
}

export interface ApplicationContext {
  readonly database?: SqliteDatabase;
  readonly credentials?: CredentialStore;
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly copilot: CopilotBackend;
  readonly history: ResponsesHistory;
  readonly telemetry?: TelemetryRecorder;
  readonly telemetryRuntime?: TelemetryRuntime;
  readonly performanceObserver?: ProtocolPerformanceObserver;
  readonly nowMs?: () => number;
  readonly createUuid?: () => string;
  readonly modelsSource?: CopilotModelsSource;
  readonly modelMetadata?: ReadonlyMap<string, NormalizedModelInfo>;
  readonly runtime?: RuntimeConfigStore;
  close?(): Promise<void> | void;
  forceClose?(): Promise<void> | void;
}

export async function bootstrapGateway(options: BootstrapOptions = {}): Promise<HostedGateway> {
  const env = options.env ?? {};
  const startup = options.startup ?? parseStartupConfig(
    options.argv ?? [],
    env,
    options.homedir === undefined ? {} : { homedir: options.homedir },
  );
  const context = options.application ?? (options.routes === undefined ? await createProductionApplicationContext(startup, env) : undefined);
  const routes = options.routes ?? (context === undefined ? [] : createPublicRouteRegistrations(context));
  return createGateway(
    {
      startup,
      runtime: context?.runtime?.readSnapshot() ?? defaultRuntimeConfigSnapshot(),
    },
    routes,
    {
      ...options.dependencies,
      onClose: async () => {
        await options.dependencies?.onClose?.();
        await context?.close?.();
      },
      onForceClose: () => {
        try {
          void Promise.resolve(options.dependencies?.onForceClose?.()).catch(() => undefined);
        } catch {
          // Continue forcing application resources closed.
        }
        try {
          void Promise.resolve(context?.forceClose?.()).catch(() => undefined);
        } catch {
          // Gateway shutdown must remain bounded.
        }
      },
    },
  );
}

export function createPublicRouteRegistrations(context: Readonly<ApplicationContext>): readonly RouteRegistration[] {
  const preferences = context.directory.preferences;
  return [
    ...createModelCatalogRoutes({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      ...(context.modelMetadata === undefined ? {} : { metadata: context.modelMetadata }),
    }),
    createOpenAiChatRoute({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      copilot: context.copilot,
      ...(context.telemetry === undefined ? {} : { usageRecorder: context.telemetry }),
      ...(context.performanceObserver === undefined ? {} : { performanceObserver: context.performanceObserver }),
      ...(context.nowMs === undefined ? {} : { nowMs: context.nowMs }),
    }),
    createAnthropicMessagesRoute({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      copilot: context.copilot,
      ...(context.telemetry === undefined ? {} : { usageRecorder: context.telemetry }),
      ...(context.performanceObserver === undefined ? {} : { performanceObserver: context.performanceObserver }),
      ...(context.nowMs === undefined ? {} : { nowMs: context.nowMs }),
      ...(context.createUuid === undefined ? {} : { createUuid: context.createUuid }),
    }),
    createResponsesRoute({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      copilot: context.copilot,
      history: context.history,
      ...(context.telemetry === undefined ? {} : { usageRecorder: context.telemetry }),
      ...(context.performanceObserver === undefined ? {} : { performanceObserver: context.performanceObserver }),
      ...(context.nowMs === undefined ? {} : { nowMs: context.nowMs }),
      ...(context.createUuid === undefined ? {} : { createUuid: context.createUuid }),
    }),
  ];
}

export async function createProductionApplicationContext(
  startup: StartupConfig,
  env: NodeJS.ProcessEnv = {},
): Promise<ApplicationContext> {
  const credentials = new FileCredentialStore(path.join(startup.dataDir, "credentials.json"));
  const database = openDatabase({
    path: path.join(startup.dataDir, "state.db"),
    migrations: MIGRATION_MANIFEST,
  });
  const runtime = new RuntimeConfigStore(database);
  const snapshot = runtime.seedIfEmpty(env);
  const directory = new SqliteAccountDirectory(database, credentials, Date.now, snapshot.accounts.maxAuthenticated);
  await directory.reconcile();
  const fetchDiscovery = createCopilotEndpointDiscovery(credentials);
  const modelsSource = HttpCopilotModelsSource.production(async (accountId, signal) => {
    const account = await directory.bindAccount(accountId, signal);
    const token = await getValidToken(credentials, account, Date.now(), refreshCopilotToken, signal);
    const { endpoint } = await discoverEndpoint(account, fetchDiscovery, signal);
    return { token, endpoint };
  }, productionModelInfoLookup);
  const catalog = new CopilotModelCatalog(modelsSource);
  const copilot = new HttpCopilotBackend({
    credentials,
    refreshCopilotToken,
    fetchDiscovery,
  });
  const telemetry = new TelemetryRecorder(
    database,
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    snapshot.usage.retentionDays,
    snapshot.events.retentionDays,
  );
  const telemetryRuntime = new TelemetryRuntime(telemetry);
  const history = new SqliteResponsesHistory(database, {
    ttlDays: snapshot.history.ttlDays,
  });
  let databaseClosed = false;
  const closeDatabaseOnce = (): void => {
    if (!databaseClosed) {
      closeDatabase(database);
      databaseClosed = true;
    }
  };
  return {
    database,
    credentials,
    directory,
    catalog,
    copilot,
    history,
    telemetry,
    telemetryRuntime,
    performanceObserver: telemetryRuntime.performance,
    modelsSource,
    modelMetadata: modelsSource.modelMetadata,
    runtime,
    async close() {
      const errors: unknown[] = [];
      for (const close of [
        async () => copilot.close(),
        async () => catalog.close(),
        async () => telemetryRuntime.close(),
        async () => closeDatabaseOnce(),
      ]) {
        try {
          await close();
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "failed to close application resources");
      }
    },
    forceClose() {
      copilot.forceClose();
      modelsSource.forceClose();
      telemetryRuntime.forceClose();
      closeDatabaseOnce();
    },
  };
}

export async function composeProductionDaemonGateway(
  composition: Readonly<DaemonRuntimeComposition>,
  options: Readonly<ProductionDaemonCompositionOptions> = {},
): Promise<HostedGateway> {
  const application = options.application
    ?? await createProductionApplicationContext(composition.startup, composition.env);
  let supplementalTelemetryRuntime: TelemetryRuntime | undefined;
  let deviceFlows: DeviceFlowService | undefined;
  try {
    const runtime = application.runtime;
    const database = application.database;
    const telemetryRecorder = application.telemetry;
    if (runtime === undefined || database === undefined || telemetryRecorder === undefined
      || !(application.directory instanceof SqliteAccountDirectory)
      || !(application.history instanceof SqliteResponsesHistory)
      || !isResponsesHistoryAdmin(application.history)) {
      throw new Error("production management dependencies are unavailable");
    }

    const adminTelemetry = new SqliteAdminTelemetry(database, { recorder: telemetryRecorder });
    const telemetryRuntime = application.telemetryRuntime ?? new TelemetryRuntime(telemetryRecorder);
    if (application.telemetryRuntime === undefined) {
      supplementalTelemetryRuntime = telemetryRuntime;
    }
    telemetryRuntime.attachAdmin(adminTelemetry);
    const applicationWithTelemetry: ApplicationContext = application.telemetryRuntime === undefined
      ? {
        ...application,
        performanceObserver: application.performanceObserver ?? telemetryRuntime.performance,
        async close() {
          await telemetryRuntime.close();
          await application.close?.();
        },
        forceClose() {
          telemetryRuntime.forceClose();
          return application.forceClose?.();
        },
      }
      : application;
    const updateRuntimeConfig = createRuntimeConfigCoordinator(
      runtime,
      application.directory,
      application.history,
      telemetryRecorder,
    );
    deviceFlows = new DeviceFlowService(application.directory, new HttpDeviceOAuthClient());
    const applicationWithDeviceFlows: ApplicationContext = {
      ...applicationWithTelemetry,
      async close() {
        await deviceFlows?.close();
        await applicationWithTelemetry.close?.();
      },
      forceClose() {
        deviceFlows?.forceClose();
        return applicationWithTelemetry.forceClose?.();
      },
    };
    const accountCaches = {
      invalidate(accountId: string): void {
        application.catalog.invalidate(accountId);
        invalidateEndpoint(accountId);
      },
    };
    const uptimeMs = options.uptimeMs ?? (() => Math.max(0, Math.floor(process.uptime() * 1000)));
    const admin = createAdminModule({
      accounts: application.directory,
      deviceFlows,
      catalog: application.catalog,
      preferences: application.directory.preferences,
      preferredModels: new PreferredModelManager(application.directory.preferences),
      modelMetadata: {
        get: (modelId) => application.modelMetadata?.get(modelId) ?? null,
      },
      runtimeConfig: {
        read: () => ({ revision: runtime.readRevision(), config: runtime.readSnapshot() }),
        updateAndApply: updateRuntimeConfig,
      },
      history: application.history,
      telemetry: adminTelemetry,
      runtimeStatus: {
        snapshot: () => ({
          version: VERSION,
          uptimeMs: uptimeMs(),
          daemon: {
            managed: composition.identity.managed,
            pid: composition.identity.pid,
            startedAt: composition.identity.createdAt,
          },
        }),
      },
      accountCaches,
    });
    const dispatcher = new CommandDispatcher({
      directory: application.directory,
      deviceFlows,
      catalog: application.catalog,
      runtimeConfig: runtime,
      updateRuntimeConfig,
      invalidateAccountCaches: (accountId) => accountCaches.invalidate(accountId),
      ...(application.modelMetadata === undefined ? {} : { modelMetadata: application.modelMetadata }),
    });
    const control = createLocalControlModule({
      identity: composition.identity,
      admin,
      dispatcher,
      requestStop: composition.requestStop,
    });
    const adminStatic = createAdminStaticModule(fileURLToPath(new URL("../admin", import.meta.url)));
    return await bootstrapGateway({
      startup: composition.startup,
      env: composition.env,
      application: applicationWithDeviceFlows,
      dependencies: {
        admin,
        control,
        adminStatic,
        readRuntimeConfig: () => runtime.readSnapshot(),
        onShutdownTimeout: () => composition.logger.write({
          level: "error",
          category: "shutdown_timeout",
          managed: composition.identity.managed,
          pid: composition.identity.pid,
        }),
      },
    });
  } catch (error: unknown) {
    try {
      await deviceFlows?.close();
      await supplementalTelemetryRuntime?.close();
    } finally {
      await application.close?.();
    }
    throw error;
  }
}

function createRuntimeConfigCoordinator(
  runtime: RuntimeConfigStore,
  directory: SqliteAccountDirectory,
  history: SqliteResponsesHistory,
  telemetry: TelemetryRecorder,
): (
  candidate: RuntimeConfigSnapshot,
  expectedRevision: number,
  signal: AbortSignal,
) => Readonly<{ revision: number; config: RuntimeConfigSnapshot }> {
  return (candidate, expectedRevision, signal) => {
    signal.throwIfAborted();
    const validated = parseRuntimeConfigSnapshot(candidate);
    const config = runtime.update(validated, expectedRevision);
    directory.setMaxAuthenticated(config.accounts.maxAuthenticated);
    history.setTtlDays(config.history.ttlDays);
    telemetry.setRetentionDays(config.usage.retentionDays, config.events.retentionDays);
    return { revision: runtime.readRevision(), config };
  };
}

function isResponsesHistoryAdmin(value: ResponsesHistory): value is ResponsesHistory & ResponsesHistoryAdmin {
  return "inspect" in value && typeof value.inspect === "function"
    && "clear" in value && typeof value.clear === "function";
}
