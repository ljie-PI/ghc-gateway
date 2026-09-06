#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { CliError, HttpControlClient, type CliLifecycleResult, type ControlClient } from "./control_client.js";
import { parseCli } from "./parser.js";
import { exitCodeForError, writeError, writeSuccess, type WritableCliStream } from "./output.js";
import type { HostedGateway } from "../gateway/create_gateway.js";
import { parseStartupConfig, type StartupConfig } from "../config/startup_config.js";
import { isSupportedNodeVersion } from "../runtime_support.js";
import type { DaemonController } from "../daemon/controller.js";
import {
  createProductionDaemonController,
  daemonRuntimeCliError,
  runDaemonRuntime,
  type ComposeDaemonGateway,
  type DaemonRuntimeDependencies,
  type RunDaemonRuntimeOptions,
} from "../daemon/runtime.js";
import { composeLazyProductionDaemonGateway } from "../daemon/production_gateway.js";

const INTERACTIVE_LOGIN_CLEANUP_TIMEOUT_MS = 1_000;

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
  readonly stdout?: WritableCliStream;
  readonly stderr?: WritableCliStream;
  readonly controlClient?: ControlClient;
  readonly createGateway?: (startup: StartupConfig, env: NodeJS.ProcessEnv) => Promise<HostedGateway>;
  readonly composeGateway?: ComposeDaemonGateway;
  readonly daemonController?: Pick<DaemonController, "start" | "stop" | "restart" | "status">;
  readonly runDaemonRuntime?: (options: Readonly<RunDaemonRuntimeOptions>) => Promise<void>;
  readonly daemonRuntimeDependencies?: Readonly<DaemonRuntimeDependencies>;
  readonly shutdownSignal?: AbortSignal;
  readonly pollDelayMs?: number;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly nodeVersion?: string;
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const argv = options.argv ?? process.argv.slice(2);
  let json = argv.includes("--json");
  let client: ControlClient | undefined;
  try {
    const env = options.env ?? process.env;
    if (!isSupportedNodeVersion(options.nodeVersion ?? process.versions.node)) {
      throw new CliError("unsupported_runtime");
    }
    const parsed = parseCli(argv, { env, ...(options.homedir === undefined ? {} : { homedir: options.homedir }) });
    json = parsed.json;
    const command = parsed.command;
    if (command.kind === "help") {
      if (parsed.json) {
        writeSuccess(stdout, true, { help: command.text });
      } else {
        stdout.write(command.text);
      }
      return 0;
    }
    client = options.controlClient ?? new HttpControlClient();
    if (command.kind === "serve") {
      return await runServe(command.startup, parsed.json, stdout, stderr, options);
    }
    if (command.kind === "lifecycle") {
      const controller = options.daemonController
        ?? (options.controlClient === undefined ? createProductionDaemonController({ env }) : undefined);
      const context = options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal };
      const result = controller === undefined
        ? await client.lifecycle(command.action, {
          dataDir: parsed.dataDir,
          ...(command.startup === undefined ? {} : { startup: command.startup }),
          ...context,
        })
        : command.action === "start"
          ? await controller.start(requireStartup(command.startup), context)
          : command.action === "restart"
            ? await controller.restart(restartStartup(parsed.dataDir, env), context)
            : command.action === "stop"
              ? await controller.stop(parsed.dataDir, context)
              : await controller.status(parsed.dataDir, context);
      if ((command.action === "stop" || command.action === "restart") && result.state === "conflict") {
        throw new CliError("daemon_conflict");
      }
      writeSuccess(stdout, parsed.json, result);
      return lifecycleExitCode(command.action, result);
    }
    if (command.kind === "admin.open") {
      writeSuccess(stdout, parsed.json, await client.adminOpen({
        dataDir: parsed.dataDir,
        ...(options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal }),
      }));
      return 0;
    }
    if (command.operation === "auth.login.start" && !parsed.json) {
      return await runInteractiveLogin(client, command.args as { readonly host?: string }, { dataDir: parsed.dataDir }, stdout, options);
    }
    writeSuccess(stdout, parsed.json, await client.request(command.operation, command.args, {
      dataDir: parsed.dataDir,
      ...(options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal }),
    }));
    return 0;
  } catch (error: unknown) {
    const cliError = error instanceof CliError ? error : new CliError("internal_error");
    writeError(stderr, json, cliError.code);
    return exitCodeForError(cliError.code);
  } finally {
    await client?.close?.();
  }
}

async function runInteractiveLogin(
  client: ControlClient,
  args: { readonly host?: string },
  context: { readonly dataDir: string },
  stdout: WritableCliStream,
  options: RunCliOptions,
): Promise<number> {
  const localSignal = options.shutdownSignal === undefined
    ? processSignal()
    : { signal: options.shutdownSignal, dispose: () => undefined };
  const controlContext = {
    dataDir: context.dataDir,
    signal: localSignal.signal,
  };
  let flowId: string | null = null;
  let authenticatedAccountId: string | null = null;
  let failure: unknown = null;
  try {
    const started = await client.request("auth.login.start", args, controlContext);
    flowId = started.flowId;
    stdout.write(`Code: ${started.userCode}\n`);
    stdout.write(`Open: ${started.verificationUri}\n`);
    const expiresAtMs = Date.parse(started.expiresAt);
    let pollIntervalSeconds = started.pollIntervalSeconds;
    let nextPollAtMs = validDate(started.nextPollAt)
      ?? Date.now() + pollIntervalSeconds * 1000;
    for (;;) {
      const delayMs = options.pollDelayMs
        ?? Math.max(0, Math.min(nextPollAtMs, expiresAtMs) - Date.now());
      await sleep(delayMs, localSignal.signal);
      const result = await client.request("auth.login.poll", { flowId: started.flowId }, controlContext);
      if (result.state === "complete") {
        authenticatedAccountId = result.account.accountId;
        break;
      }
      if (result.state !== "pending") {
        throw new CliError(result.state === "expired"
          ? "authorization_expired"
          : result.state === "denied"
            ? "authorization_denied"
            : "authorization_failed");
      }
      pollIntervalSeconds = result.pollIntervalSeconds ?? pollIntervalSeconds;
      nextPollAtMs = validDate(result.nextPollAt)
        ?? Date.now() + pollIntervalSeconds * 1000;
    }

  } catch (error: unknown) {
    failure = error;
  }
  localSignal.dispose();
  if (flowId !== null && authenticatedAccountId === null) {
    try {
      const canceled = await client.request("auth.login.cancel", { flowId }, {
        dataDir: context.dataDir,
        timeoutMs: INTERACTIVE_LOGIN_CLEANUP_TIMEOUT_MS,
      });
      if (canceled.state === "complete") authenticatedAccountId = canceled.accountId;
    } catch (error: unknown) {
      if (failure === null) failure = error;
    }
  }
  if (authenticatedAccountId !== null) {
    stdout.write(`Authenticated: ${authenticatedAccountId}\n`);
    return 0;
  }
  if (failure !== null) throw failure;
  throw new CliError("internal_error");
}

function validDate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function processSignal(): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new CliError("interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

async function runServe(
  startup: StartupConfig,
  json: boolean,
  stdout: WritableCliStream,
  stderr: WritableCliStream,
  options: RunCliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const managed = false;
  const shutdown = options.shutdownSignal === undefined ? processSignal() : null;
  const shutdownSignal = options.shutdownSignal ?? shutdown?.signal ?? new AbortController().signal;
  const composeGateway: ComposeDaemonGateway = options.composeGateway
    ?? (options.createGateway === undefined
      ? composeLazyProductionDaemonGateway
      : async (context) => await options.createGateway?.(context.startup, context.env) as HostedGateway);
  try {
    await (options.runDaemonRuntime ?? runDaemonRuntime)({
      startup,
      env,
      managed,
      composeGateway,
      shutdownSignal,
      stderr,
      ...(options.daemonRuntimeDependencies === undefined
        ? {}
        : { dependencies: options.daemonRuntimeDependencies }),
      ...(!managed
        ? {
          onListening: (identity) => writeSuccess(stdout, json, lifecycleFromIdentity(identity, startup.dataDir)),
        }
        : {}),
    });
    if (shutdownSignal.reason instanceof CliError && shutdownSignal.reason.code === "interrupted") {
      throw shutdownSignal.reason;
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(daemonRuntimeCliError(error));
  } finally {
    shutdown?.dispose();
  }
}

function lifecycleExitCode(action: string, result: CliLifecycleResult): number {
  if (action === "status" && result.state === "stopped") {
    return 3;
  }
  if (result.state === "stale" || result.state === "conflict" || result.state === "unreachable") {
    return 5;
  }
  return 0;
}

function lifecycleFromIdentity(
  identity: Readonly<{
    managed: boolean;
    pid: number;
    createdAt: string;
    port: number;
  }>,
  dataDir: string,
): CliLifecycleResult {
  return {
    state: "running",
    managed: identity.managed,
    pid: identity.pid,
    startedAt: identity.createdAt,
    port: identity.port,
    dataDir,
  };
}

function requireStartup(startup: StartupConfig | undefined): StartupConfig {
  if (startup === undefined) {
    throw new CliError("internal_error");
  }
  return startup;
}

function restartStartup(dataDir: string, env: NodeJS.ProcessEnv): StartupConfig {
  return parseStartupConfig([], { ...env, GHC_GATEWAY_DATA_DIR: dataDir });
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    throw new CliError("interrupted");
  }
  await new Promise<void>((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, Math.max(0, ms));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new CliError("interrupted"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function main(): Promise<void> {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}

export function isMainModule(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  const entryPath = realpathSync(argvEntry);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void main();
}
