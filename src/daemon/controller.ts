import path from "node:path";
import { CliError, type CliLifecycleResult } from "../cli/control_client.js";
import type { StartupConfig } from "../config/startup_config.js";
import type { DaemonIdentity } from "./identity_file.js";
import {
  sharedInProcessLifecycleCoordinator,
  type LifecycleCoordinatorAccess,
} from "./lifecycle_coordinator.js";

const POLL_INTERVAL_MS = 100;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const FORCE_STOP_TIMEOUT_MS = 10_000;
const FORCE_SETTLE_TIMEOUT_MS = 10_000;
const RESTART_SETTLE_TIMEOUT_MS = 5_000;
const DEPENDENCY_TIMEOUT_MS = 30_000;
const STATUS_PATH = "/__ghcg/control/v1/status";
const STOP_PATH = "/__ghcg/control/v1/stop";

/**
 * A lifecycle dependency must acknowledge abort before settling: after signal
 * abort, it may settle only once its side effect is quiescent or ownership of
 * every created resource has been returned to the controller for reconciliation.
 * Rejecting while an unowned side effect can still commit violates this contract.
 */
export interface LifecycleDependencyContext {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface DaemonIdentityFileAccess {
  read(dataDir: string, context: Readonly<LifecycleDependencyContext>): Promise<DaemonIdentity | null>;
  remove(
    dataDir: string,
    expected: Readonly<DaemonIdentity>,
    context: Readonly<LifecycleDependencyContext>,
  ): Promise<boolean>;
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
  readonly processIdentity: (
    pid: number,
    context: Readonly<LifecycleDependencyContext>,
  ) => Promise<string | null>;
  readonly spawn: (
    startup: Readonly<StartupConfig>,
    context: Readonly<LifecycleDependencyContext>,
  ) => Promise<SpawnedDaemon>;
  readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly nowMs: () => number;
  readonly controlRequest: DaemonControlRequest;
  readonly terminate: (
    identity: Readonly<ProcessIdentityReference>,
    context: Readonly<LifecycleDependencyContext>,
  ) => Promise<void>;
  readonly lifecycleCoordinator?: LifecycleCoordinatorAccess;
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
  private readonly coordinator: LifecycleCoordinatorAccess;

  constructor(private readonly dependencies: Readonly<DaemonControllerDependencies>) {
    this.coordinator = dependencies.lifecycleCoordinator ?? sharedInProcessLifecycleCoordinator;
  }

  async status(dataDir: string, context: Readonly<DaemonLifecycleContext> = {}): Promise<CliLifecycleResult> {
    return await this.coordinator.run(dataDir, context, async (signal) => (
      await this.inspectWithinLane(dataDir, { ...(signal === undefined ? {} : { signal }) })
    ).result);
  }

  private async inspectWithinLane(
    dataDir: string,
    context: Readonly<InspectionContext>,
  ): Promise<DaemonInspection> {
    const resolvedDataDir = path.resolve(dataDir);
    context.signal?.throwIfAborted();
    let identity: DaemonIdentity | null;
    try {
      identity = await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.identityFile.read(resolvedDataDir, dependencyContext),
        context.deadlineMs,
        context.signal,
      );
    } catch (error: unknown) {
      emitWindowsLifecycleDiagnostic("inspection", "identity_read_error");
      rethrowCancellation(error, context.signal);
      throw new CliError("security_error");
    }
    if (identity === null) {
      emitWindowsLifecycleDiagnostic("inspection", "identity_missing");
      return { result: emptyResult("stopped", resolvedDataDir), identity };
    }

    const processState = await this.readProcessIdentity(identity, context.signal, context.deadlineMs);
    if (processState.kind === "unknown" || processState.kind === "different") {
      return { result: identityResult("conflict", identity, resolvedDataDir), identity };
    }
    if (processState.kind === "dead") {
      context.signal?.throwIfAborted();
      const removed = await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.identityFile.remove(
          resolvedDataDir,
          identity,
          dependencyContext,
        ),
        context.deadlineMs,
        context.signal,
      );
      emitWindowsLifecycleDiagnostic("inspection", removed ? "stale_removed" : "stale_remove_failed");
      return {
        result: identityResult(removed ? "stale" : "conflict", identity, resolvedDataDir),
        identity,
      };
    }

    try {
      const response = await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.controlRequest(identity, "GET", STATUS_PATH, {
          signal: dependencyContext.signal,
          timeoutMs: remainingMs(dependencyContext.deadlineMs, this.dependencies.nowMs()),
        }),
        context.deadlineMs,
        context.signal,
      );
      const valid = validControlResponse(response, identity, true);
      emitWindowsLifecycleDiagnostic("inspection", valid ? "status_valid" : "status_invalid");
      return {
        result: identityResult(valid ? "running" : "conflict", identity, resolvedDataDir),
        identity,
      };
    } catch (error: unknown) {
      rethrowCancellation(error, context.signal);
      if (error instanceof CliError && (error.code === "security_error" || error.code === "daemon_conflict")) {
        emitWindowsLifecycleDiagnostic("inspection", "status_conflict");
        return { result: identityResult("conflict", identity, resolvedDataDir), identity };
      }
      emitWindowsLifecycleDiagnostic("inspection", "status_unreachable");
      return { result: identityResult("unreachable", identity, resolvedDataDir), identity };
    }
  }

  async start(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    return await this.coordinator.run(startup.dataDir, context, async (signal) => await this.startWithinLane(
      startup,
      { ...(signal === undefined ? {} : { signal }) },
    ));
  }

  private async startWithinLane(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext>,
  ): Promise<CliLifecycleResult> {
    try {
      return await this.performStartWithinLane(startup, context);
    } catch (error: unknown) {
      emitWindowsLifecycleDiagnostic("start", "start_failed");
      throw error;
    }
  }

  private async performStartWithinLane(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext>,
  ): Promise<CliLifecycleResult> {
    const resolvedDataDir = path.resolve(startup.dataDir);
    const deadline = this.dependencies.nowMs() + START_TIMEOUT_MS;
    let existing: CliLifecycleResult;
    try {
      existing = (await this.inspectWithinLane(startup.dataDir, {
        ...context,
        deadlineMs: deadline,
      })).result;
    } catch (error: unknown) {
      if (isDeadlineTimeout(error)) {
        const result = identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), resolvedDataDir);
        emitWindowsLifecycleDiagnostic("start", "start_result", result.state);
        return result;
      }
      throw error;
    }
    emitWindowsLifecycleDiagnostic("start", "start_initial_state", existing.state);
    if (existing.state === "running" || existing.state === "conflict" || existing.state === "unreachable") {
      emitWindowsLifecycleDiagnostic("start", "start_result", existing.state);
      return existing;
    }

    context.signal?.throwIfAborted();
    if (this.dependencies.nowMs() >= deadline) {
      const result = identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), resolvedDataDir);
      emitWindowsLifecycleDiagnostic("start", "start_result", result.state);
      return result;
    }
    let child: SpawnedDaemon;
    try {
      child = await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.spawn(startup, dependencyContext),
        deadline,
        undefined,
        true,
      );
    } catch (error: unknown) {
      emitWindowsLifecycleDiagnostic("start", "start_spawn_failure");
      throw error;
    }
    emitWindowsLifecycleDiagnostic("start", "start_spawned");
    let spawned: ProcessIdentityReference | null = null;
    try {
      spawned = await this.captureSpawnedIdentity(child.pid);
      emitWindowsLifecycleDiagnostic(
        "start",
        spawned === null ? "start_identity_missing" : "start_identity_captured",
      );
      context.signal?.throwIfAborted();
      while (this.dependencies.nowMs() < deadline) {
        try {
          await this.runBeforeDeadline(
            (dependencyContext) => this.dependencies.delay(
              Math.min(POLL_INTERVAL_MS, remainingMs(deadline, this.dependencies.nowMs())),
              dependencyContext.signal,
            ),
            deadline,
            context.signal,
          );
        } catch (error: unknown) {
          if (isDeadlineTimeout(error)) break;
          throw error;
        }
        const timeoutMs = remainingMs(deadline, this.dependencies.nowMs());
        if (timeoutMs === 0) {
          break;
        }
        try {
          const inspection = await this.inspectWithinLane(startup.dataDir, { ...context, deadlineMs: deadline });
          if (inspection.result.state === "running") {
            emitWindowsLifecycleDiagnostic("start", "start_running", inspection.result.state);
            emitWindowsLifecycleDiagnostic("start", "start_result", inspection.result.state);
            return inspection.result;
          }
        } catch (error: unknown) {
          if (isDeadlineTimeout(error)) {
            break;
          }
          throw error;
        }
      }

      emitWindowsLifecycleDiagnostic("start", "start_readiness_expired");
      try {
        await this.cleanupFailedStart(startup.dataDir, child.pid, spawned);
        emitWindowsLifecycleDiagnostic("start", "start_cleanup_complete");
      } catch (error: unknown) {
        emitWindowsLifecycleDiagnostic("start", "start_cleanup_failure");
        throw error;
      }
      const result = identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), resolvedDataDir);
      emitWindowsLifecycleDiagnostic("start", "start_result", result.state);
      return result;
    } catch (error: unknown) {
      emitWindowsLifecycleDiagnostic("start", "start_error_cleanup");
      try {
        await this.cleanupFailedStart(startup.dataDir, child.pid, spawned);
        emitWindowsLifecycleDiagnostic("start", "start_cleanup_complete");
      } catch (cleanupError: unknown) {
        emitWindowsLifecycleDiagnostic("start", "start_cleanup_failure");
        throw cleanupError;
      }
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
    return await this.coordinator.run(dataDir, context, async (signal) => await this.stopWithinLane(
      dataDir,
      { ...(signal === undefined ? {} : { signal }) },
    ));
  }

  private async stopWithinLane(
    dataDir: string,
    context: Readonly<DaemonLifecycleContext>,
  ): Promise<CliLifecycleResult> {
    const resolvedDataDir = path.resolve(dataDir);
    const inspectionDeadline = this.dependencies.nowMs() + STOP_TIMEOUT_MS;
    let inspection: DaemonInspection;
    try {
      inspection = await this.inspectWithinLane(resolvedDataDir, { ...context, deadlineMs: inspectionDeadline });
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
      emitWindowsLifecycleDiagnostic("stop", "stop_identity_missing");
      return identityResult("conflict", identity, resolvedDataDir);
    }
    if (!identity.managed) {
      emitWindowsLifecycleDiagnostic("stop", "stop_unmanaged");
      return identityResult("conflict", identity, resolvedDataDir);
    }

    const stopRequestDeadline = this.dependencies.nowMs() + STOP_TIMEOUT_MS;
    try {
      context.signal?.throwIfAborted();
      const response = await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.controlRequest(identity, "POST", STOP_PATH, {
          signal: dependencyContext.signal,
          timeoutMs: remainingMs(dependencyContext.deadlineMs, this.dependencies.nowMs()),
        }),
        stopRequestDeadline,
        undefined,
      );
      if (this.dependencies.nowMs() > stopRequestDeadline) throw new CliError("timeout");
      if (!validControlResponse(response, identity, false)) {
        emitWindowsLifecycleDiagnostic("stop", "stop_response_invalid");
        return identityResult("conflict", identity, resolvedDataDir);
      }
    } catch (error: unknown) {
      if (!isDeadlineTimeout(error)) {
        rethrowCancellation(error, context.signal);
        emitWindowsLifecycleDiagnostic("stop", "stop_request_unreachable");
        return identityResult("unreachable", identity, resolvedDataDir);
      }
      emitWindowsLifecycleDiagnostic("stop", "stop_request_timeout");
    }

    const graceDeadline = this.dependencies.nowMs() + STOP_TIMEOUT_MS;
    while (this.dependencies.nowMs() < graceDeadline) {
      const remaining = remainingMs(graceDeadline, this.dependencies.nowMs());
      const delayMs = remaining <= POLL_INTERVAL_MS ? 0 : POLL_INTERVAL_MS;
      if (delayMs > 0) {
        await this.runBeforeDeadline(
          (dependencyContext) => this.dependencies.delay(delayMs, dependencyContext.signal),
          graceDeadline,
          undefined,
        );
      }
      let processState: { readonly kind: "same" | "different" | "dead" | "unknown" };
      try {
        processState = await this.readProcessIdentity(identity, undefined, graceDeadline);
      } catch (error: unknown) {
        if (isDeadlineTimeout(error)) {
          break;
        }
        throw error;
      }
      if (processState.kind === "dead") {
        emitWindowsLifecycleDiagnostic("stop", "grace_process_dead");
        await this.removeIdentityBeforeDeadline(resolvedDataDir, identity, graceDeadline);
        return emptyResult("stopped", resolvedDataDir);
      }
      if (processState.kind !== "same") {
        emitWindowsLifecycleDiagnostic(
          "stop",
          processState.kind === "different" ? "grace_process_different" : "grace_process_unknown",
        );
        return identityResult("conflict", identity, resolvedDataDir);
      }
      if (remainingMs(graceDeadline, this.dependencies.nowMs()) <= POLL_INTERVAL_MS) {
        break;
      }
    }

    emitWindowsLifecycleDiagnostic("stop", "grace_expired");
    const forceDeadline = this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS;
    let terminationError: unknown;
    try {
      await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.terminate(identity, dependencyContext),
        forceDeadline,
        undefined,
        true,
      );
      emitWindowsLifecycleDiagnostic("stop", "terminate_success");
    } catch (error: unknown) {
      terminationError = error;
      emitWindowsLifecycleDiagnostic("stop", "terminate_failure");
    }
    let afterTerminate = await this.waitForTermination(
      identity,
      undefined,
      terminationError === undefined
        ? forceDeadline
        : this.dependencies.nowMs() + FORCE_SETTLE_TIMEOUT_MS,
    );
    if (terminationError === undefined && afterTerminate.kind === "same") {
      afterTerminate = await this.waitForTermination(
        identity,
        undefined,
        this.dependencies.nowMs() + FORCE_SETTLE_TIMEOUT_MS,
      );
    }
    if (afterTerminate.kind === "dead") {
      emitWindowsLifecycleDiagnostic("stop", "force_process_dead");
      await this.removeIdentityBeforeDeadline(
        resolvedDataDir,
        identity,
        this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS,
      );
      return emptyResult("stopped", resolvedDataDir);
    }
    if (afterTerminate.kind === "same" && await this.readIdentityOrNull(resolvedDataDir) === null) {
      emitWindowsLifecycleDiagnostic("stop", "force_same_identity_missing");
      return emptyResult("stopped", resolvedDataDir);
    }
    emitWindowsLifecycleDiagnostic(
      "stop",
      afterTerminate.kind === "same"
        ? "force_process_same"
        : afterTerminate.kind === "different" ? "force_process_different" : "force_process_unknown",
    );
    if (terminationError !== undefined && afterTerminate.kind === "same") throw terminationError;
    return identityResult(afterTerminate.kind === "same" ? "unreachable" : "conflict", identity, resolvedDataDir);
  }

  async restart(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    return await this.coordinator.run(startup.dataDir, context, async (signal) => {
      const withinContext = { ...(signal === undefined ? {} : { signal }) };
      const inspection = await this.inspectWithinLane(startup.dataDir, withinContext);
      const effectiveStartup = inspection.identity === null
        ? startup
        : { ...startup, port: inspection.identity.port };
      let stopped = await this.stopWithinLane(startup.dataDir, withinContext);
      if (stopped.state === "unreachable") {
        const deadline = this.dependencies.nowMs() + RESTART_SETTLE_TIMEOUT_MS;
        while (this.dependencies.nowMs() < deadline) {
          await this.runBeforeDeadline(
            (dependencyContext) => this.dependencies.delay(POLL_INTERVAL_MS, dependencyContext.signal),
            deadline,
            signal,
          );
          stopped = (await this.inspectWithinLane(startup.dataDir, { ...withinContext, deadlineMs: deadline })).result;
          if (stopped.state !== "unreachable") break;
        }
      }
      emitWindowsLifecycleDiagnostic("restart", "restart_stop_result", stopped.state);
      if (stopped.state !== "stopped" && stopped.state !== "stale") return stopped;
      emitWindowsLifecycleDiagnostic("restart", "restart_start");
      const restarted = await this.startWithinLane(effectiveStartup, withinContext);
      emitWindowsLifecycleDiagnostic("restart", "restart_start_result", restarted.state);
      return restarted;
    });
  }

  private async captureSpawnedIdentity(
    pid: number,
    retryNull = false,
  ): Promise<ProcessIdentityReference | null> {
    const deadline = this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS;
    for (;;) {
      try {
        const captured = await this.runBeforeDeadline(
          (dependencyContext) => this.dependencies.processIdentity(pid, dependencyContext),
          deadline,
          undefined,
        );
        if (captured !== null) return { pid, processStartIdentity: captured };
        if (!retryNull) return null;
      } catch (_error: unknown) {
        // A transient probe failure is retried within the reconciliation deadline.
      }
      if (this.dependencies.nowMs() >= deadline) return null;
      await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.delay(
          Math.min(POLL_INTERVAL_MS, remainingMs(deadline, this.dependencies.nowMs())),
          dependencyContext.signal,
        ),
        deadline,
        undefined,
      );
    }
  }

  private async cleanupFailedStart(
    dataDir: string,
    pid: number,
    initiallyCaptured: Readonly<ProcessIdentityReference> | null,
  ): Promise<void> {
    const spawned = initiallyCaptured ?? await this.captureSpawnedIdentity(pid, true);
    if (spawned === null) {
      emitWindowsLifecycleDiagnostic("start", "start_cleanup_no_identity");
      return;
    }
    const forceDeadline = this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS;
    const fresh = await this.readProcessIdentity(spawned, undefined, forceDeadline);
    if (fresh.kind !== "same") {
      await this.removeSpawnedIdentityIfOwned(dataDir, spawned);
      emitWindowsLifecycleDiagnostic("start", "start_cleanup_not_same");
      return;
    }
    let terminationFailed = false;
    try {
      await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.terminate(spawned, dependencyContext),
        forceDeadline,
        undefined,
        true,
      );
    } catch (_error: unknown) {
      terminationFailed = true;
    }
    const afterTerminate = await this.waitForTermination(
      spawned,
      undefined,
      terminationFailed ? this.dependencies.nowMs() + FORCE_SETTLE_TIMEOUT_MS : forceDeadline,
    );
    if (afterTerminate.kind === "dead") {
      await this.removeSpawnedIdentityIfOwned(dataDir, spawned);
      emitWindowsLifecycleDiagnostic("start", "start_cleanup_dead");
      return;
    }
    emitWindowsLifecycleDiagnostic("start", "start_cleanup_incomplete");
  }

  private async removeSpawnedIdentityIfOwned(
    dataDir: string,
    spawned: Readonly<ProcessIdentityReference>,
  ): Promise<void> {
    const identity = await this.readIdentityOrNull(dataDir);
    if (identity !== null
      && identity.pid === spawned.pid
      && identity.processStartIdentity === spawned.processStartIdentity) {
      await this.removeIdentityBeforeDeadline(
        path.resolve(dataDir),
        identity,
        this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS,
      );
    }
  }

  private async waitForTermination(
    identity: Readonly<ProcessIdentityReference>,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<{ readonly kind: "same" | "different" | "dead" | "unknown" }> {
    for (;;) {
      const state = await this.readProcessIdentity(
        identity,
        signal,
        this.dependencies.nowMs() >= deadline ? undefined : deadline,
      );
      if (state.kind !== "same") {
        return state;
      }
      const remaining = remainingMs(deadline, this.dependencies.nowMs());
      if (remaining === 0) {
        return state;
      }
      await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.delay(
          Math.min(POLL_INTERVAL_MS, remaining),
          dependencyContext.signal,
        ),
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
      return await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.identityFile.read(path.resolve(dataDir), dependencyContext),
        this.dependencies.nowMs() + FORCE_STOP_TIMEOUT_MS,
        undefined,
      );
    } catch (_error: unknown) {
      throw new CliError("security_error");
    }
  }

  private async removeIdentityBeforeDeadline(
    dataDir: string,
    identity: Readonly<DaemonIdentity>,
    deadline: number,
  ): Promise<boolean> {
    return await this.runBeforeDeadline(
      (dependencyContext) => this.dependencies.identityFile.remove(dataDir, identity, dependencyContext),
      deadline,
      undefined,
    );
  }

  private async readProcessIdentity(
    identity: Readonly<ProcessIdentityReference>,
    signal: AbortSignal | undefined,
    deadline?: number,
  ): Promise<{ readonly kind: "same" | "different" | "dead" | "unknown" }> {
    signal?.throwIfAborted();
    try {
      const actual = await this.runBeforeDeadline(
        (dependencyContext) => this.dependencies.processIdentity(identity.pid, dependencyContext),
        deadline,
        signal,
      );
      if (actual === null) {
        emitWindowsLifecycleDiagnostic("process_identity", "process_dead");
        return { kind: "dead" };
      }
      const kind = actual === identity.processStartIdentity ? "same" : "different";
      emitWindowsLifecycleDiagnostic(
        "process_identity",
        kind === "same" ? "process_same" : "process_different",
      );
      return { kind };
    } catch (error: unknown) {
      emitWindowsLifecycleDiagnostic("process_identity", "process_unknown");
      rethrowCancellation(error, signal);
      return { kind: "unknown" };
    }
  }

  private async runBeforeDeadline<T>(
    work: (context: Readonly<LifecycleDependencyContext>) => Promise<T>,
    deadline: number | undefined,
    signal: AbortSignal | undefined,
    acceptCompletedSideEffect = false,
  ): Promise<T> {
    signal?.throwIfAborted();
    const effectiveDeadline = deadline ?? this.dependencies.nowMs() + DEPENDENCY_TIMEOUT_MS;
    const result = await withCooperativeDeadline(
      work,
      effectiveDeadline,
      remainingMs(effectiveDeadline, this.dependencies.nowMs()),
      signal,
      acceptCompletedSideEffect,
    );
    if (!acceptCompletedSideEffect && this.dependencies.nowMs() > effectiveDeadline) throw new CliError("timeout");
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

type WindowsLifecycleDiagnosticPhase = "inspection" | "start" | "stop" | "restart" | "process_identity";
type WindowsLifecycleDiagnosticDecision =
  | "identity_missing" | "identity_read_error" | "process_same" | "process_different" | "process_dead" | "process_unknown"
  | "stale_removed" | "stale_remove_failed" | "status_valid" | "status_invalid" | "status_conflict" | "status_unreachable"
  | "start_initial_state" | "start_spawn_failure" | "start_spawned" | "start_identity_missing" | "start_identity_captured"
  | "start_running" | "start_readiness_expired" | "start_error_cleanup" | "start_cleanup_no_identity"
  | "start_cleanup_not_same" | "start_cleanup_dead" | "start_cleanup_incomplete" | "start_cleanup_complete"
  | "start_cleanup_failure" | "start_failed" | "start_result"
  | "stop_identity_missing" | "stop_unmanaged" | "stop_response_invalid" | "stop_request_timeout" | "stop_request_unreachable"
  | "grace_process_dead" | "grace_process_different" | "grace_process_unknown" | "grace_expired"
  | "terminate_success" | "terminate_failure" | "force_process_dead" | "force_same_identity_missing" | "force_process_same"
  | "force_process_different" | "force_process_unknown" | "restart_stop_result" | "restart_start" | "restart_start_result";

function emitWindowsLifecycleDiagnostic(
  phase: WindowsLifecycleDiagnosticPhase,
  decision: WindowsLifecycleDiagnosticDecision,
  state?: CliLifecycleResult["state"],
): void {
  if (process.platform !== "win32") return;
  const hook = (globalThis as unknown as {
    __ghcgWindowsLifecycleDiagnostic?: (event: Readonly<Record<string, unknown>>) => void;
  }).__ghcgWindowsLifecycleDiagnostic;
  try {
    hook?.({
      phase,
      decision,
      ...(state === undefined ? {} : { state }),
    });
  } catch {
    // Diagnostics must never affect lifecycle decisions.
  }
}

async function withCooperativeDeadline<T>(
  work: (context: Readonly<LifecycleDependencyContext>) => Promise<T>,
  deadlineMs: number,
  timeoutMs: number,
  parent?: AbortSignal,
  acceptCompletedSideEffect = false,
): Promise<T> {
  if (timeoutMs <= 0) throw new CliError("timeout");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new CliError("timeout")), timeoutMs);
  const signal = parent === undefined ? timeout.signal : AbortSignal.any([parent, timeout.signal]);
  try {
    const result = await work({ signal, deadlineMs });
    if (parent?.aborted === true) parent.throwIfAborted();
    if (!acceptCompletedSideEffect && timeout.signal.aborted) throw new CliError("timeout");
    return result;
  } catch (error: unknown) {
    if (parent?.aborted === true) parent.throwIfAborted();
    if (timeout.signal.aborted) throw new CliError("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
