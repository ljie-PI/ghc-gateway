import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticatedControlRequest } from "../cli/control_client.js";
import type { StartupConfig } from "../config/startup_config.js";
import type { HostedGateway } from "../gateway/create_gateway.js";
import { GRACEFUL_SHUTDOWN_MS } from "../gateway/create_gateway.js";
import { assertSupportedRuntime } from "../runtime_support.js";
import { DaemonController, type LifecycleDependencyContext, type SpawnedDaemon } from "./controller.js";
import {
  DaemonIdentityFile,
  DaemonIdentityFileError,
  type DaemonIdentity,
  type DaemonIdentityLease,
} from "./identity_file.js";
import { LifecycleCoordinator } from "./lifecycle_coordinator.js";
import { JsonlLogger, StderrLogger, type DaemonLogger } from "./logger.js";
import { DaemonOperationLeaseFile } from "./operation_lease.js";
import { captureProcessStartIdentity, terminateProcessIfMatching } from "./process_identity.js";

const productionLifecycleCoordinator = new LifecycleCoordinator(new DaemonOperationLeaseFile());

export interface DaemonRuntimeComposition {
  readonly startup: StartupConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly identity: DaemonIdentity;
  readonly logger: DaemonLogger;
  requestStop(): void;
}

export type ComposeDaemonGateway = (
  context: Readonly<DaemonRuntimeComposition>,
) => Promise<HostedGateway>;

export interface DaemonRuntimeDependencies {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly createSecret?: () => string;
  readonly captureProcessIdentity?: (pid: number) => Promise<string | null>;
  readonly acquireIdentity?: (
    dataDir: string,
    identity: DaemonIdentity,
  ) => DaemonIdentityLease | Promise<DaemonIdentityLease>;
  readonly createLogger?: (managed: boolean, startup: StartupConfig) => DaemonLogger;
  readonly scheduleStop?: (stop: () => void) => void;
  readonly nodeVersion?: string;
}

export interface ProductionDaemonControllerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly childEntry?: string;
  readonly execPath?: string;
}

export function createProductionDaemonController(
  options: Readonly<ProductionDaemonControllerOptions> = {},
): DaemonController {
  const env = options.env ?? process.env;
  const childEntry = options.childEntry ?? fileURLToPath(new URL("./child.js", import.meta.url));
  const execPath = options.execPath ?? process.execPath;
  return new DaemonController({
    lifecycleCoordinator: productionLifecycleCoordinator,
    identityFile: {
      read: async (dataDir, context) => {
        context?.signal.throwIfAborted();
        const identity = new DaemonIdentityFile(dataDir).read();
        context?.signal.throwIfAborted();
        return identity;
      },
      remove: async (dataDir, expected, context) => {
        context?.signal.throwIfAborted();
        const removed = await new DaemonIdentityFile(dataDir).remove(expected, context);
        context?.signal.throwIfAborted();
        return removed;
      },
    },
    processIdentity: async (pid, context) => await captureProcessStartIdentity(pid, undefined, context),
    spawn: async (startup, context) => await spawnDaemonProcess(
      execPath,
      childEntry,
      env,
      startup,
      context,
    ),
    delay,
    nowMs: Date.now,
    controlRequest: async (identity, method, requestPath, context = {}) => await authenticatedControlRequest(
      identity,
      method,
      requestPath,
      undefined,
      context,
    ),
    terminate: async (identity, context) => {
      await terminateProcessIfMatching(identity.pid, identity.processStartIdentity, undefined, context);
    },
  });
}

type SpawnDaemonChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export async function spawnDaemonProcess(
  execPath: string,
  childEntry: string,
  env: NodeJS.ProcessEnv,
  startup: Readonly<StartupConfig>,
  context: Readonly<LifecycleDependencyContext>,
  spawnChild: SpawnDaemonChild = spawn,
): Promise<SpawnedDaemon> {
  context.signal.throwIfAborted();
  const child = spawnChild(execPath, [
    childEntry,
    "--data-dir", startup.dataDir,
    "--port", String(startup.port),
    "--log-level", startup.logLevel,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
    signal: context.signal,
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
    };
    const onError = (error: Error): void => {
      cleanup();
      // Once a PID exists, ownership must return to the controller even if
      // AbortSignal caused child_process to report an error.
      if (child.pid === undefined) reject(error);
      else resolve();
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  if (child.pid === undefined) throw new Error("daemon child has no process id");
  return { pid: child.pid, unref: () => child.unref() };
}

export interface RunDaemonRuntimeOptions {
  readonly startup: StartupConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly managed: boolean;
  readonly composeGateway: ComposeDaemonGateway;
  readonly shutdownSignal: AbortSignal;
  readonly stderr: { write(chunk: string): unknown };
  readonly onListening?: (identity: Readonly<DaemonIdentity>) => Promise<void> | void;
  readonly dependencies?: Readonly<DaemonRuntimeDependencies>;
}

export async function runDaemonRuntime(options: Readonly<RunDaemonRuntimeOptions>): Promise<void> {
  const dependencies = options.dependencies ?? {};
  assertSupportedRuntime(dependencies.nodeVersion ?? process.versions.node);
  const pid = dependencies.pid ?? process.pid;
  const processStartIdentity = await (dependencies.captureProcessIdentity ?? captureProcessStartIdentity)(pid);
  if (processStartIdentity === null) {
    throw new Error("unable to capture current process identity");
  }
  const now = dependencies.now ?? (() => new Date());
  const secret = dependencies.createSecret ?? (() => randomBytes(32).toString("base64url"));
  const identity: DaemonIdentity = Object.freeze({
    version: 1,
    managed: options.managed,
    pid,
    processStartIdentity,
    instanceNonce: secret(),
    controlToken: secret(),
    port: options.startup.port,
    createdAt: now().toISOString(),
  });
  const acquire = dependencies.acquireIdentity
    ?? ((dataDir: string, value: DaemonIdentity) => new DaemonIdentityFile(dataDir).acquire(value));
  const lease = await acquire(options.startup.dataDir, identity);
  try {
    const stopping = new AbortController();
    const scheduleStop = dependencies.scheduleStop ?? ((stop: () => void) => setImmediate(stop));
    const logger = dependencies.createLogger?.(options.managed, options.startup)
      ?? (options.managed
        ? new JsonlLogger(path.join(options.startup.dataDir, "logs"), Date.now, undefined, options.startup.logLevel)
        : new StderrLogger(options.stderr, Date.now, options.startup.logLevel));
    let gateway: HostedGateway | undefined;
    try {
      gateway = await options.composeGateway({
        startup: options.startup,
        env: options.env,
        identity,
        logger,
        requestStop: () => scheduleStop(() => stopping.abort()),
      });
      await gateway.listen();
      logger.write({ level: "info", category: "gateway_started", managed: options.managed, pid });
      await options.onListening?.(identity);
      await waitForAbort(AbortSignal.any([options.shutdownSignal, stopping.signal]));
      const closingGateway = gateway;
      gateway = undefined;
      await closeGatewayBounded(closingGateway, logger);
      logger.write({ level: "info", category: "gateway_stopped", managed: options.managed, pid });
    } finally {
      if (gateway !== undefined) {
        await closeGatewayBounded(gateway, logger);
      }
    }
  } finally {
    lease.cleanup();
    lease.release();
  }
}

async function closeGatewayBounded(gateway: HostedGateway, logger: DaemonLogger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    gateway.close().then(
      () => ({ timedOut: false as const }),
      (error: unknown) => ({ timedOut: false as const, error }),
    ),
    new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), GRACEFUL_SHUTDOWN_MS);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if ("error" in result) {
    throw result.error;
  }
  if (result.timedOut) {
    logger.write({ level: "error", category: "shutdown_timeout" });
  }
}

export function daemonRuntimeCliError(error: unknown): "daemon_conflict" | "security_error" | "permission_denied" | "internal_error" {
  if (error instanceof DaemonIdentityFileError) {
    if (error.code === "lease_conflict") {
      return "daemon_conflict";
    }
    if (error.code === "invalid_identity" || error.code === "unsafe_owner"
      || error.code === "unsafe_path" || error.code === "unsafe_permissions") {
      return "security_error";
    }
  }
  if (typeof error === "object" && error !== null && "code" in error
    && (error.code === "EACCES" || error.code === "EPERM")) {
    return "permission_denied";
  }
  return "internal_error";
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
