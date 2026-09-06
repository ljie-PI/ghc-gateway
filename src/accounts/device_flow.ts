import { randomUUID } from "node:crypto";
import { resolveGitHubEnvironment, type GitHubEnvironment } from "./github_environment.js";
import {
  AccountDirectoryError,
  AccountDirectoryPostCommitError,
  type AccountDirectory,
} from "./account_directory.js";
import type { SecretCredential } from "./credential_store.js";

export const MAX_DEVICE_FLOWS = 8;
export const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
export const DEVICE_FLOW_TERMINAL_TTL_MS = 60_000;

export interface DeviceOAuthClient {
  requestDeviceCode(environment: GitHubEnvironment, signal?: AbortSignal): Promise<{
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly intervalSec: number;
    readonly expiresInSec: number;
  }>;
  exchangeDeviceCode(
    environment: GitHubEnvironment,
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "pending" }
    | { readonly status: "slow_down"; readonly pollIntervalSeconds?: number }
    | { readonly status: "expired" }
    | { readonly status: "denied" }
    | { readonly status: "failed" }
    | {
        readonly status: "complete";
        readonly accessToken: string;
        readonly user: { readonly id: string | number; readonly login: string; readonly name?: string };
      }
    | { readonly status: "authorized"; readonly accessToken: string }
  >;
  fetchUser?(
    environment: GitHubEnvironment,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<{ readonly id: string | number; readonly login: string; readonly name?: string }>;
}

export interface DeviceFlowSnapshot {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAtMs: number;
  readonly pollIntervalSeconds: number;
  readonly nextPollAtMs: number;
}

export class DeviceFlowError extends Error {
  readonly code: "capacity" | "not_found" | "expired";

  constructor(code: DeviceFlowError["code"], message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

interface PendingFlow {
  readonly kind: "pending";
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  expiresAtMs: number;
  pollIntervalSeconds: number;
  nextPollAtMs: number;
  readonly environment: GitHubEnvironment;
  readonly deviceCode: string;
  authorized: {
    readonly accessToken: string;
    user?: { readonly id: string | number; readonly login: string; readonly name?: string };
  } | null;
  readonly cancellation: AbortController;
  readonly settlement: AbortController;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface TerminalFlow {
  readonly kind: "terminal";
  readonly flowId: string;
  readonly expiresAtMs: number;
  readonly status: "complete" | "expired" | "denied" | "failed";
  readonly accountId?: string;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

type DeviceFlowState = PendingFlow | TerminalFlow;

export interface DeviceFlowPending {
  readonly status: "pending";
  readonly pollIntervalSeconds: number;
  readonly nextPollAtMs: number;
}

export type DeviceFlowCancelResult =
  | { readonly status: "canceled" | "not_found" }
  | { readonly status: "complete"; readonly accountId: string };

export class DeviceFlowService {
  private readonly flows = new Map<string, DeviceFlowState>();
  private readonly pollingFlows = new Set<string>();
  private readonly settlements = new Map<string, Promise<DeviceFlowCancelResult>>();
  private readonly startingControllers = new Set<AbortController>();
  private readonly forceCloseController = new AbortController();
  private startingFlows = 0;
  private closed = false;
  private forceClosed = false;

  constructor(
    private readonly directory: AccountDirectory,
    private readonly oauth: DeviceOAuthClient,
    private readonly nowMs: () => number = Date.now,
    private readonly timers: {
      readonly setTimeout: typeof setTimeout;
      readonly clearTimeout: typeof clearTimeout;
    } = { setTimeout, clearTimeout },
  ) {}

  async start(host: string, signal?: AbortSignal): Promise<DeviceFlowSnapshot> {
    throwIfClosed(this.closed);
    throwIfAborted(signal);
    this.gc();
    if (this.activeFlowCount() + this.startingFlows >= MAX_DEVICE_FLOWS) {
      throw new DeviceFlowError("capacity", "too many active device flows");
    }
    const environment = resolveGitHubEnvironment(host);
    const startingController = new AbortController();
    const operationSignal = signal === undefined
      ? startingController.signal
      : AbortSignal.any([signal, startingController.signal]);
    this.startingControllers.add(startingController);
    const startTimer = this.timers.setTimeout(
      () => startingController.abort(),
      DEVICE_FLOW_TTL_MS,
    );
    this.startingFlows += 1;
    let requested: Awaited<ReturnType<DeviceOAuthClient["requestDeviceCode"]>>;
    try {
      requested = await this.oauth.requestDeviceCode(environment, operationSignal);
    } finally {
      this.timers.clearTimeout(startTimer);
      this.startingControllers.delete(startingController);
      this.startingFlows -= 1;
    }
    throwIfAborted(operationSignal);
    const flowId = randomUUID();
    const startedAtMs = this.nowMs();
    const pollIntervalSeconds = Math.max(1, requested.intervalSec);
    const expiresAtMs = startedAtMs + Math.min(requested.expiresInSec * 1000, DEVICE_FLOW_TTL_MS);
    const snapshot: PendingFlow = {
      kind: "pending",
      flowId,
      environment,
      deviceCode: requested.deviceCode,
      authorized: null,
      userCode: requested.userCode,
      verificationUri: requested.verificationUri,
      expiresAtMs,
      pollIntervalSeconds,
      nextPollAtMs: Math.min(expiresAtMs, startedAtMs + pollIntervalSeconds * 1000),
      cancellation: new AbortController(),
      settlement: new AbortController(),
      expiryTimer: null,
    };
    this.flows.set(flowId, snapshot);
    snapshot.expiryTimer = this.timers.setTimeout(() => {
      const current = this.flows.get(flowId);
      if (current?.kind === "pending") {
        current.cancellation.abort();
        current.settlement.abort();
        if (!this.pollingFlows.has(flowId)) this.rememberTerminal(flowId, "expired");
      }
    }, Math.max(0, expiresAtMs - this.nowMs()));
    return {
      flowId,
      userCode: snapshot.userCode,
      verificationUri: snapshot.verificationUri,
      expiresAtMs: snapshot.expiresAtMs,
      pollIntervalSeconds: snapshot.pollIntervalSeconds,
      nextPollAtMs: snapshot.nextPollAtMs,
    };
  }

  async poll(flowId: string, signal?: AbortSignal): Promise<
    | DeviceFlowPending
    | { readonly status: "expired" }
    | { readonly status: "denied" }
    | { readonly status: "failed" }
    | { readonly status: "complete"; readonly accountId: string }
  > {
    throwIfClosed(this.closed);
    throwIfAborted(signal);
    const state = this.flows.get(flowId);
    if (state === undefined) {
      throw new DeviceFlowError("not_found", "device flow not found");
    }
    const now = this.nowMs();
    if (state.kind === "terminal") {
      if (state.expiresAtMs <= now) {
        this.removeFlow(flowId, state);
        throw new DeviceFlowError("not_found", "device flow not found");
      }
      return state.status === "complete"
        ? { status: "complete", accountId: requireTerminalAccountId(state) }
        : { status: state.status };
    }
    if (state.expiresAtMs <= now) {
      if (this.pollingFlows.has(flowId)) {
        return pending(state, now + 1_000);
      }
      this.rememberTerminal(flowId, "expired");
      return { status: "expired" };
    }
    const flow = state;
    if (this.pollingFlows.has(flowId)) {
      return pending(flow, Math.max(
        flow.nextPollAtMs,
        now + flow.pollIntervalSeconds * 1000,
      ));
    }
    if (flow.nextPollAtMs > now) {
      return pending(flow);
    }
    const exchangeStartedAtMs = now;
    flow.nextPollAtMs = Math.min(flow.expiresAtMs, exchangeStartedAtMs + flow.pollIntervalSeconds * 1000);
    this.pollingFlows.add(flowId);
    const operationSignal = signal === undefined
      ? flow.cancellation.signal
      : AbortSignal.any([signal, flow.cancellation.signal]);
    let settle = (_result: DeviceFlowCancelResult): void => undefined;
    let settled = false;
    const settlement = new Promise<DeviceFlowCancelResult>((resolve) => { settle = resolve; });
    this.settlements.set(flowId, settlement);
    const settleOnce = (result: DeviceFlowCancelResult): void => {
      if (settled) return;
      settled = true;
      settle(result);
    };
    try {
      let result: Awaited<ReturnType<DeviceOAuthClient["exchangeDeviceCode"]>>;
      if (flow.authorized?.user !== undefined) {
        result = {
          status: "complete",
          accessToken: flow.authorized.accessToken,
          user: flow.authorized.user,
        };
      } else if (flow.authorized !== null) {
        const user = await this.fetchAuthorizedUser(flow);
        flow.authorized.user = user;
        result = { status: "complete", accessToken: flow.authorized.accessToken, user };
      } else {
        result = await this.oauth.exchangeDeviceCode(
          flow.environment,
          flow.deviceCode,
          operationSignal,
        );
        if (result.status === "authorized") {
          flow.authorized = { accessToken: result.accessToken };
          this.extendAuthorizedSettlement(flow);
          const user = await this.fetchAuthorizedUser(flow);
          flow.authorized.user = user;
          result = { status: "complete", accessToken: flow.authorized.accessToken, user };
        }
      }
      if (result.status === "complete" && flow.authorized === null) {
        flow.authorized = { accessToken: result.accessToken, user: result.user };
        this.extendAuthorizedSettlement(flow);
      }
      if (result.status !== "complete") {
        throwIfAborted(operationSignal);
        if (this.flows.get(flowId) !== flow) {
          throw new DeviceFlowError("not_found", "device flow not found");
        }
        if (flow.expiresAtMs <= this.nowMs()) {
          this.rememberTerminal(flowId, "expired");
          return { status: "expired" };
        }
        if (result.status === "pending") {
          return pending(flow);
        }
        if (result.status === "slow_down") {
          flow.pollIntervalSeconds = Math.max(
            flow.pollIntervalSeconds + 5,
            result.pollIntervalSeconds ?? 0,
          );
          flow.nextPollAtMs = Math.min(
            flow.expiresAtMs,
            exchangeStartedAtMs + flow.pollIntervalSeconds * 1000,
          );
          return pending(flow);
        }
        if (result.status === "expired" || result.status === "denied") {
          this.rememberTerminal(flowId, result.status);
          return { status: result.status };
        }
        this.rememberTerminal(flowId, "failed");
        return { status: "failed" };
      }

      if (this.closed && flow.settlement.signal.aborted) throwIfClosed(true);
      for (;;) {
        try {
          const secret: SecretCredential = { generation: 0, githubToken: result.accessToken };
          const bound = await this.directory.upsertAuthenticated({
            host: flow.environment.host,
            userId: result.user.id,
            login: result.user.login,
            ...(result.user.name === undefined ? {} : { displayName: result.user.name }),
            secret,
          }, flow.settlement.signal);
          this.rememberTerminal(flowId, "complete", bound.accountId);
          const complete = { status: "complete" as const, accountId: bound.accountId };
          settleOnce(complete);
          return complete;
        } catch (error: unknown) {
          if (error instanceof AccountDirectoryPostCommitError) {
            await this.retryPostCommitCleanup(error, flow.settlement.signal);
            this.rememberTerminal(flowId, "complete", error.accountId);
            const complete = { status: "complete" as const, accountId: error.accountId };
            settleOnce(complete);
            return complete;
          }
          if (error instanceof AccountDirectoryError) throw error;
          await this.waitForAuthorizedRetry(flow, error);
        }
      }
    } catch (error: unknown) {
      if (isPermanentOAuthError(error)) {
        this.rememberTerminal(flowId, "failed");
        return { status: "failed" };
      }
      if (this.nowMs() >= flow.expiresAtMs && operationSignal.aborted) {
        this.rememberTerminal(flowId, "expired");
        return { status: "expired" };
      }
      throw error;
    } finally {
      settleOnce({ status: "canceled" });
      this.settlements.delete(flowId);
      this.pollingFlows.delete(flowId);
    }
  }

  async cancel(flowId: string): Promise<DeviceFlowCancelResult> {
    const flow = this.flows.get(flowId);
    if (flow === undefined) return { status: "not_found" };
    if (flow.kind === "terminal" && flow.status === "complete") {
      return { status: "complete", accountId: requireTerminalAccountId(flow) };
    }
    const settlement = this.settlements.get(flowId);
    if (settlement !== undefined && flow.kind === "pending") {
      flow.cancellation.abort();
      const result = await settlement;
      if (result.status !== "complete" && this.flows.get(flowId) === flow) {
        this.removeFlow(flowId, flow);
      }
      return result;
    }
    this.removeFlow(flowId, flow);
    return { status: "canceled" };
  }

  has(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.startingControllers) controller.abort();
    this.startingControllers.clear();
    for (const [flowId, flow] of this.flows) {
      if (
        flow.kind === "pending"
        && flow.authorized !== null
        && this.settlements.has(flowId)
      ) {
        flow.cancellation.abort();
        if (flow.expiryTimer !== null) {
          this.timers.clearTimeout(flow.expiryTimer);
          flow.expiryTimer = null;
        }
      } else {
        this.removeFlow(flowId, flow);
      }
    }
    if (this.settlements.size > 0) {
      let onForceClose = (): void => undefined;
      await Promise.race([
        Promise.allSettled(this.settlements.values()),
        new Promise<void>((resolve) => {
          onForceClose = resolve;
          this.forceCloseController.signal.addEventListener("abort", onForceClose, { once: true });
        }),
      ]).finally(() => this.forceCloseController.signal.removeEventListener("abort", onForceClose));
    }
    for (const [flowId, flow] of this.flows) this.removeFlow(flowId, flow);
  }

  forceClose(): void {
    if (this.forceClosed) return;
    this.forceClosed = true;
    this.forceCloseController.abort();
    this.closed = true;
    for (const controller of this.startingControllers) controller.abort();
    this.startingControllers.clear();
    for (const [flowId, flow] of this.flows) {
      this.removeFlow(flowId, flow);
    }
  }

  private gc(): void {
    const now = this.nowMs();
    for (const [flowId, flow] of this.flows) {
      if (flow.kind === "pending" && flow.expiresAtMs <= now) {
        this.rememberTerminal(flowId, "expired");
      } else if (flow.kind === "terminal" && flow.expiresAtMs <= now) {
        this.removeFlow(flowId, flow);
      }
    }
  }

  private activeFlowCount(): number {
    let count = 0;
    for (const flow of this.flows.values()) {
      if (flow.kind === "pending") count += 1;
    }
    return count;
  }

  private async fetchAuthorizedUser(flow: PendingFlow): Promise<{
    readonly id: string | number;
    readonly login: string;
    readonly name?: string;
  }> {
    for (;;) {
      try {
        if (this.oauth.fetchUser === undefined || flow.authorized === null) {
          throw new Error("device OAuth client cannot resolve an authorized user");
        }

        return await this.oauth.fetchUser(
          flow.environment,
          flow.authorized.accessToken,
          flow.settlement.signal,
        );
      } catch (error: unknown) {
        if (isPermanentOAuthError(error)) throw error;
        await this.waitForAuthorizedRetry(flow, error);
      }
    }
  }

  private extendAuthorizedSettlement(flow: PendingFlow): void {
    if (flow.expiryTimer !== null) this.timers.clearTimeout(flow.expiryTimer);
    flow.expiresAtMs += DEVICE_FLOW_TERMINAL_TTL_MS;
    flow.expiryTimer = this.timers.setTimeout(() => {
      flow.cancellation.abort();
      flow.settlement.abort();
    }, Math.max(0, flow.expiresAtMs - this.nowMs()));
  }

  private async waitForAuthorizedRetry(flow: PendingFlow, error: unknown): Promise<void> {
    if (flow.settlement.signal.aborted || this.nowMs() >= flow.expiresAtMs) throw error;
    const delayMs = Math.min(
      Math.max(flow.pollIntervalSeconds * 1000, oauthRetryAfterMs(error)),
      Math.max(1, flow.expiresAtMs - this.nowMs()),
    );
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.timers.clearTimeout(timer);
        flow.settlement.signal.removeEventListener("abort", onAbort);
        reject(flow.settlement.signal.reason);
      };
      const timer = this.timers.setTimeout(() => {
        flow.settlement.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      flow.settlement.signal.addEventListener("abort", onAbort, { once: true });
      if (flow.settlement.signal.aborted) onAbort();
    });
  }

  private async retryPostCommitCleanup(
    error: AccountDirectoryPostCommitError,
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await error.retryCleanup(signal);
        return;
      } catch {
        // The account commit is authoritative; startup reconciliation retries any remaining cleanup.
      }
    }
  }

  private rememberTerminal(
    flowId: string,
    status: TerminalFlow["status"],
    accountId?: string,
  ): void {
    if (this.closed) return;
    const current = this.flows.get(flowId);
    if (current !== undefined) this.removeFlow(flowId, current);
    const terminals = [...this.flows.entries()].filter((entry) => entry[1].kind === "terminal");
    if (terminals.length >= MAX_DEVICE_FLOWS) {
      const oldest = terminals[0];
      if (oldest !== undefined) this.removeFlow(oldest[0], oldest[1]);
    }
    const terminal: TerminalFlow = {
      kind: "terminal",
      flowId,
      expiresAtMs: this.nowMs() + DEVICE_FLOW_TERMINAL_TTL_MS,
      status,
      ...(accountId === undefined ? {} : { accountId }),
      expiryTimer: null,
    };
    this.flows.set(flowId, terminal);
    terminal.expiryTimer = this.timers.setTimeout(() => {
      if (this.flows.get(flowId) === terminal) this.removeFlow(flowId, terminal);
    }, DEVICE_FLOW_TERMINAL_TTL_MS);
  }

  private removeFlow(flowId: string, flow: DeviceFlowState): void {
    this.flows.delete(flowId);
    if (flow.expiryTimer !== null) {
      this.timers.clearTimeout(flow.expiryTimer);
      flow.expiryTimer = null;
    }
    if (flow.kind === "pending") flow.cancellation.abort();
    if (flow.kind === "pending") flow.settlement.abort();
  }
}

function pending(flow: PendingFlow, nextPollAtMs = flow.nextPollAtMs): DeviceFlowPending {
  return {
    status: "pending",
    pollIntervalSeconds: flow.pollIntervalSeconds,
    nextPollAtMs,
  };
}

function requireTerminalAccountId(flow: TerminalFlow): string {
  if (flow.accountId === undefined) {
    throw new Error("completed device flow is missing its account");
  }
  return flow.accountId;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}

function throwIfClosed(closed: boolean): void {
  if (closed) {
    throw new DOMException("closed", "AbortError");
  }
}

function isPermanentOAuthError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "remote_error"
    && "retryable" in error
    && error.retryable === false;
}

function oauthRetryAfterMs(error: unknown): number {
  return error !== null
    && typeof error === "object"
    && "retryAfterMs" in error
    && typeof error.retryAfterMs === "number"
    && Number.isFinite(error.retryAfterMs)
    ? Math.max(0, error.retryAfterMs)
    : 0;
}
