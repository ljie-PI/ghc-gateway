import path from "node:path";
import { CliError, type CliLifecycleResult } from "../cli/control_client.js";
import type { StartupConfig } from "../config/startup_config.js";
import type { DaemonIdentity } from "./identity_file.js";

const POLL_INTERVAL_MS = 100;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const FORCE_STOP_TIMEOUT_MS = 10_000;
const FORCE_SETTLE_TIMEOUT_MS = 10_000;
const RESTART_SETTLE_TIMEOUT_MS = 5_000;
const STATUS_PATH = "/__ghcg/control/v1/status";
const STOP_PATH = "/__ghcg/control/v1/stop";

export interface DaemonIdentityFileAccess {
  read(dataDir: string): Promise<DaemonIdentity | null>;
  remove(dataDir: string, expected: Readonly<DaemonIdentity>): Promise<boolean>;
}

export interface SpawnedDaemon {
  readonly pid: number;
  unref(): void;
}

export interface DaemonControlRequestContext {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type DaemonControlRequest = (
  identity: Readonly<DaemonIdentity>,
  method: "GET" | "POST",
  path: string,
  context?: Readonly<DaemonControlRequestContext>,
) => Promise<unknown>;

export interface DaemonControllerDependencies {
  readonly identityFile: DaemonIdentityFileAccess;
  readonly processIdentity: (pid: number) => Promise<string | null>;
  readonly spawn: (startup: Readonly<StartupConfig>) => Promise<SpawnedDaemon>;
  readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly nowMs: () => number;
  readonly controlRequest: DaemonControlRequest;
  readonly terminate: (identity: Readonly<ProcessIdentityReference>) => Promise<void>;
}

export interface ProcessIdentityReference {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface DaemonLifecycleContext {
  readonly signal?: AbortSignal;
}

interface DaemonInspection {
  readonly result: CliLifecycleResult;
  readonly identity: DaemonIdentity | null;
}

interface InspectionContext extends DaemonLifecycleContext {
  readonly deadlineMs?: number;
}

export class DaemonController {
  private readonly starts = new Map<string, Promise<CliLifecycleResult>>();

  constructor(private readonly dependencies: Readonly<DaemonControllerDependencies>) {}

  async status(dataDir: string, context: Readonly<DaemonLifecycleContext> = {}): Promise<CliLifecycleResult> {
    return (await this.inspect(dataDir, context)).result;
  }

  private async inspect(
    dataDir: string,
    context: Readonly<InspectionContext>,
  ): Promise<DaemonInspection> {
    const resolvedDataDir = path.resolve(dataDir);
    context.signal?.throwIfAborted();
    let identity: DaemonIdentity | null;
    try {
      identity = await this.runBeforeDeadline(
        () => this.dependencies.identityFile.read(resolvedDataDir),
        context.deadlineMs,
        context.signal,
      );
    } catch (error: unknown) {
      rethrowCancellation(error, context.signal);
      throw new CliError("security_error");
    }
    if (identity === null) {
      return { result: emptyResult("stopped", resolvedDataDir), identity };
    }

    const processState = await this.readProcessIdentity(identity, context.signal, context.deadlineMs);
    if (processState.kind === "unknown" || processState.kind === "different") {
      return { result: identityResult("conflict", identity, resolvedDataDir), identity };
    }
    if (processState.kind === "dead") {
      const removed = await this.runBeforeDeadline(
        () => this.dependencies.identityFile.remove(resolvedDataDir, identity),
        context.deadlineMs,
        context.signal,
      );
      return {
        result: identityResult(removed ? "stale" : "conflict", identity, resolvedDataDir),
        identity,
      };
    }

    try {
      const response = await this.runBeforeDeadline(
        () => this.dependencies.controlRequest(identity, "GET", STATUS_PATH, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(context.deadlineMs === undefined
            ? {}
            : { timeoutMs: remainingMs(context.deadlineMs, this.dependencies.nowMs()) }),
        }),
        context.deadlineMs,
        context.signal,
      );
      return {
        result: identityResult(validControlResponse(response, identity, true) ? "running" : "conflict", identity, resolvedDataDir),
        identity,
      };
    } catch (error: unknown) {
      rethrowCancellation(error, context.signal);
      if (error instanceof CliError && (error.code === "security_error" || error.code === "daemon_conflict")) {
        return { result: identityResult("conflict", identity, resolvedDataDir), identity };
      }
      return { result: identityResult("unreachable", identity, resolvedDataDir), identity };
    }
  }

  async start(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    const key = path.resolve(startup.dataDir);
    const active = this.starts.get(key);
    if (active !== undefined) {
      return await active;
    }
    const work = this.startOnce(startup, context).finally(() => {
      if (this.starts.get(key) === work) {
        this.starts.delete(key);
      }
    });
    this.starts.set(key, work);
    return await work;
  }

  private async startOnce(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext>,
  ): Promise<CliLifecycleResult> {
    const resolvedDataDir = path.resolve(startup.dataDir);
    const deadline = this.dependencies.nowMs() + START_TIMEOUT_MS;
    let existing: CliLifecycleResult;
    try {
      existing = (await this.inspect(startup.dataDir, {
        ...context,
        deadlineMs: deadline,
      })).result;
    } catch (error: unknown) {
      if (isDeadlineTimeout(error)) {
        return identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), resolvedDataDir);
      }
      throw error;
    }
    if (existing.state === "running" || existing.state === "conflict" || existing.state === "unreachable") {
      return existing;
    }

    context.signal?.throwIfAborted();
    if (this.dependencies.nowMs() >= deadline) {
      return identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), resolvedDataDir);
    }
    const child = await this.runBeforeDeadline(
      () => this.dependencies.spawn(startup),
      deadline,
      context.signal,
    );
    let spawned: ProcessIdentityReference | null = null;
    try {
      while (this.dependencies.nowMs() < deadline) {
        if (spawned === null) {
          try {
            const captured = await this.runBeforeDeadline(
              () => this.dependencies.processIdentity(child.pid),
              deadline,
              context.signal,
            );
            if (captured !== null) {
              spawned = { pid: child.pid, processStartIdentity: captured };
            }
          } catch (error: unknown) {
            if (isDeadlineTimeout(error)) {
              break;
            }
            rethrowCancellation(error, context.signal);
          }
        }
        await this.runBeforeDeadline(
          () => this.dependencies.delay(
            Math.min(POLL_INTERVAL_MS, remainingMs(deadline, this.dependencies.nowMs())),
            context.signal,
          ),
          deadline,
          context.signal,
        );
        const timeoutMs = remainingMs(deadline, this.dependencies.nowMs());
        if (timeoutMs === 0) {
          break;
        }
        try {
          const inspection = await this.inspect(startup.dataDir, { ...context, deadlineMs: deadline });
          if (inspection.result.state === "running") {
            return inspection.result;
          }
        } catch (error: unknown) {
          if (isDeadlineTimeout(error)) {
            break;
          }
          throw error;
        }
      }

      await this.cleanupFailedStart(startup.dataDir, spawned);
      return identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), resolvedDataDir);
    } catch (error: unknown) {
      await this.cleanupFailedStart(startup.dataDir, spawned);
      rethrowCancellation(error, context.signal);
      throw error;
    } finally {
      child.unref();
    }
  }

  async stop(
    dataDir: string,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    const resolvedDataDir = path.resolve(dataDir);
    const inspectionDeadline = this.dependencies.nowMs() + STOP_TIMEOUT_MS;
    let inspection: DaemonInspection;
    try {
      inspection = await this.inspect(resolvedDataDir, { ...context, deadlineMs: inspectionDeadline });
    } catch (error: unknown) {
      if (isDeadlineTimeout(error)) {
        return identityResult("unreachable", await this.readIdentityOrNull(resolvedDataDir), resolvedDataDir);
      }
      throw error;
    }
    const current = inspection.result;
    if (current.state === "stale") {
      return emptyResult("stopped", resolvedDataDir);
    }
    if (current.state !== "running") {
      return current;
    }
    const identity = inspection.identity;
    if (identity === null) {
      return identityResult("conflict", identity, resolvedDataDir);
    }
    if (!identity.managed) {
      return identityResult("conflict", identity, resolvedDataDir);
    }

    const stopRequestDeadline = this.dependencies.nowMs() + STOP_TIMEOUT_MS;
    try {
      const response = await this.runBeforeDeadline(
        () => this.dependencies.controlRequest(identity, "POST", STOP_PATH, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          timeoutMs: remainingMs(stopRequestDeadline, this.dependencies.nowMs()),
        }),
        stopRequestDeadline,
        context.signal,
      );
      if (!validControlResponse(response, identity, false)) {
        return identityResult("conflict", identity, resolvedDataDir);
      }
    } catch (error: unknown) {
      if (!isDeadlineTimeout(error)) {
        rethrowCancellation(error, context.signal);
        return identityResult("unreachable", identity, resolvedDataDir);
      }
    }

    const graceDeadline = this.dependencies.nowMs() + STOP_TIMEOUT_MS;
    while (this.dependencies.nowMs() < graceDeadline) {
      const remaining = remainingMs(graceDeadline, this.dependencies.nowMs());
      const delayMs = remaining <= POLL_INTERVAL_MS ? 0 : POLL_INTERVAL_MS;
      if (delayMs > 0) {
        await this.runBeforeDeadline(
          () => this.dependencies.delay(delayMs, context.signal),
          graceDeadline,
          context.signal,
        );
      }
      let processState: { readonly kind: "same" | "different" | "dead" | "unknown" };
      try {
        processState = await this.readProcessIdentity(identity, context.signal, graceDeadline);
      } catch (error: unknown) {
        if (isDeadlineTimeout(error)) {
          break;
        }
        throw error;
      }
      if (processState.kind === "dead") {
        await this.runBeforeDeadline(
          () => this.dependencies.identityFile.remove(resolvedDataDir, identity),
          graceDeadline,
          context.signal,
        );
        return emptyResult("stopped", resolvedDataDir);
      }
      if (processState.kind !== "same") {
        return identityResult("conflict", identity, resolvedDataDir);
      }
      if (remainingMs(graceDeadline, this.dependencies.nowMs()) <= POLL_INTERVAL_MS) {
        break;
      }
    }

    const forceDeadline = this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS;
    await this.runBeforeDeadline(
      () => this.dependencies.terminate(identity),
      forceDeadline,
      undefined,
    );
    let afterTerminate = await this.waitForTermination(identity, undefined, forceDeadline);
    if (afterTerminate.kind === "same") {
      afterTerminate = await this.waitForTermination(
        identity,
        undefined,
        this.dependencies.nowMs() + FORCE_SETTLE_TIMEOUT_MS,
      );
    }
    if (afterTerminate.kind === "dead") {
      await this.dependencies.identityFile.remove(resolvedDataDir, identity);
      return emptyResult("stopped", resolvedDataDir);
    }
    if (afterTerminate.kind === "same" && await this.readIdentityOrNull(resolvedDataDir) === null) {
      return emptyResult("stopped", resolvedDataDir);
    }
    return identityResult(afterTerminate.kind === "same" ? "unreachable" : "conflict", identity, resolvedDataDir);
  }

  async restart(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    const inspection = await this.inspect(startup.dataDir, context);
    const effectiveStartup = inspection.identity === null
      ? startup
      : { ...startup, port: inspection.identity.port };
    let stopped = await this.stop(startup.dataDir, context);
    if (stopped.state === "unreachable") {
      const deadline = this.dependencies.nowMs() + RESTART_SETTLE_TIMEOUT_MS;
      while (this.dependencies.nowMs() < deadline) {
        await this.dependencies.delay(POLL_INTERVAL_MS, context.signal);
        stopped = await this.status(startup.dataDir, context);
        if (stopped.state !== "unreachable") break;
      }
    }
    if (stopped.state !== "stopped" && stopped.state !== "stale") {
      return stopped;
    }
    return await this.start(effectiveStartup, context);
  }

  private async cleanupFailedStart(
    dataDir: string,
    spawned: Readonly<ProcessIdentityReference> | null,
  ): Promise<void> {
    if (spawned === null) {
      return;
    }
    const forceDeadline = this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS;
    const fresh = await this.readProcessIdentity(spawned, undefined, forceDeadline);
    if (fresh.kind !== "same") {
      await this.removeSpawnedIdentityIfOwned(dataDir, spawned);
      return;
    }
    await this.runBeforeDeadline(
      () => this.dependencies.terminate(spawned),
      forceDeadline,
      undefined,
    );
    const afterTerminate = await this.waitForTermination(spawned, undefined, forceDeadline);
    if (afterTerminate.kind === "dead") {
      await this.removeSpawnedIdentityIfOwned(dataDir, spawned);
    }
  }

  private async removeSpawnedIdentityIfOwned(
    dataDir: string,
    spawned: Readonly<ProcessIdentityReference>,
  ): Promise<void> {
    const identity = await this.readIdentityOrNull(dataDir);
    if (identity !== null
      && identity.pid === spawned.pid
      && identity.processStartIdentity === spawned.processStartIdentity) {
      await this.dependencies.identityFile.remove(path.resolve(dataDir), identity);
    }
  }

  private async waitForTermination(
    identity: Readonly<ProcessIdentityReference>,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<{ readonly kind: "same" | "different" | "dead" | "unknown" }> {
    for (;;) {
      const state = await this.readProcessIdentity(identity, signal, deadline);
      if (state.kind !== "same") {
        return state;
      }
      const remaining = remainingMs(deadline, this.dependencies.nowMs());
      if (remaining === 0) {
        return state;
      }
      await this.runBeforeDeadline(
        () => this.dependencies.delay(Math.min(POLL_INTERVAL_MS, remaining), signal),
        deadline,
        signal,
      );
      if (this.dependencies.nowMs() >= deadline) {
        return state;
      }
    }
  }

  private async readIdentityOrNull(dataDir: string): Promise<DaemonIdentity | null> {
    try {
      return await this.dependencies.identityFile.read(path.resolve(dataDir));
    } catch (_error: unknown) {
      throw new CliError("security_error");
    }
  }

  private async readProcessIdentity(
    identity: Readonly<ProcessIdentityReference>,
    signal: AbortSignal | undefined,
    deadline?: number,
  ): Promise<{ readonly kind: "same" | "different" | "dead" | "unknown" }> {
    signal?.throwIfAborted();
    try {
      const actual = await this.runBeforeDeadline(
        () => this.dependencies.processIdentity(identity.pid),
        deadline,
        signal,
      );
      if (actual === null) {
        return { kind: "dead" };
      }
      return { kind: actual === identity.processStartIdentity ? "same" : "different" };
    } catch (error: unknown) {
      rethrowCancellation(error, signal);
      return { kind: "unknown" };
    }
  }

  private async runBeforeDeadline<T>(
    work: () => Promise<T>,
    deadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (deadline === undefined) {
      return await work();
    }
    const result = await withDeadline(work, remainingMs(deadline, this.dependencies.nowMs()), signal);
    if (this.dependencies.nowMs() > deadline) {
      throw new CliError("timeout");
    }
    return result;
  }
}

function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

function isDeadlineTimeout(error: unknown): boolean {
  return error instanceof CliError && error.code === "timeout";
}

function validControlResponse(value: unknown, identity: Readonly<DaemonIdentity>, requireRunning: boolean): boolean {
  if (!isRecord(value) || (requireRunning && value.state !== "running") || !isRecord(value.instance)) {
    return false;
  }
  return value.instance.pid === identity.pid
    && value.instance.processStartIdentity === identity.processStartIdentity
    && value.instance.instanceNonce === identity.instanceNonce;
}

function identityResult(
  state: CliLifecycleResult["state"],
  identity: Readonly<DaemonIdentity> | null,
  dataDir: string,
): CliLifecycleResult {
  if (identity === null) {
    return emptyResult(state, dataDir);
  }
  return {
    state,
    managed: identity.managed,
    pid: identity.pid,
    startedAt: identity.createdAt,
    port: identity.port,
    dataDir: path.resolve(dataDir),
  };
}

function emptyResult(state: CliLifecycleResult["state"], dataDir: string): CliLifecycleResult {
  return {
    state,
    managed: null,
    pid: null,
    startedAt: null,
    port: null,
    dataDir: path.resolve(dataDir),
  };
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CliError("interrupted");
  }
  if (error instanceof CliError && (error.code === "interrupted" || error.code === "timeout")) {
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withDeadline<T>(work: () => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (timeoutMs <= 0) {
    throw new CliError("timeout");
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new CliError("timeout")), timeoutMs);
  const signal = parent === undefined ? timeout.signal : AbortSignal.any([parent, timeout.signal]);
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
