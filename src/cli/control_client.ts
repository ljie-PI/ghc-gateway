import { spawn } from "node:child_process";
import path from "node:path";
import { UNSUPPORTED_RUNTIME_MESSAGE } from "../runtime_support.js";
import type { AccountSummary } from "../accounts/account_directory.js";
import type { ModelPreference } from "../accounts/model_preferences.js";
import type { CapabilityCatalogSnapshot } from "../copilot/capability_registry.js";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { StartupConfig } from "../config/startup_config.js";
import { DaemonIdentityFile, type DaemonIdentity } from "../daemon/identity_file.js";
import { captureProcessStartIdentity } from "../daemon/process_identity.js";

export type CliErrorCode =
  | "internal_error"
  | "usage_error"
  | "unsupported_runtime"
  | "validation_error"
  | "not_found"
  | "revision_conflict"
  | "permission_denied"
  | "security_error"
  | "authorization_expired"
  | "authorization_denied"
  | "authorization_failed"
  | "remote_error"
  | "timeout"
  | "unavailable"
  | "daemon_stale"
  | "daemon_conflict"
  | "daemon_unreachable"
  | "interrupted";

export class CliError extends Error {
  constructor(readonly code: CliErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "CliError";
  }
}

export const CLI_ERROR_EXIT: Readonly<Record<CliErrorCode, number>> = {
  internal_error: 1,
  usage_error: 2,
  unsupported_runtime: 2,
  validation_error: 2,
  not_found: 3,
  revision_conflict: 3,
  permission_denied: 4,
  security_error: 4,
  authorization_expired: 5,
  authorization_denied: 5,
  authorization_failed: 5,
  remote_error: 5,
  timeout: 5,
  unavailable: 5,
  daemon_stale: 5,
  daemon_conflict: 5,
  daemon_unreachable: 5,
  interrupted: 130,
};

export const SAFE_ERROR_MESSAGES: Readonly<Record<CliErrorCode, string>> = {
  internal_error: "internal error",
  usage_error: "usage error",
  unsupported_runtime: UNSUPPORTED_RUNTIME_MESSAGE,
  validation_error: "validation error",
  not_found: "not found",
  revision_conflict: "revision conflict",
  permission_denied: "permission denied",
  security_error: "security error",
  authorization_expired: "authorization expired",
  authorization_denied: "authorization denied",
  authorization_failed: "authorization failed",
  remote_error: "remote error",
  timeout: "timeout",
  unavailable: "gateway unavailable",
  daemon_stale: "daemon stale",
  daemon_conflict: "daemon conflict",
  daemon_unreachable: "daemon unreachable",
  interrupted: "interrupted",
};

export type LifecycleAction = "start" | "stop" | "restart" | "status";

export interface CliLifecycleContext {
  readonly dataDir: string;
  readonly startup?: StartupConfig;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CliLifecycleResult {
  readonly state: "running" | "stopped" | "stale" | "conflict" | "unreachable";
  readonly managed: boolean | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly port: number | null;
  readonly dataDir: string;
}

export interface CliAdminOpenResult {
  readonly opened: true;
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
  readonly preferredModel: {
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
  } | null;
}

export interface AdminAccounts {
  readonly defaultRevision: number;
  readonly defaultAccountId: string | null;
  readonly items: readonly AdminAccount[];
}

export interface AuthStatus {
  readonly defaultAccountId: string | null;
  readonly accounts: readonly AdminAccount[];
}

export interface AdminModels {
  readonly accountId: string;
  readonly catalogGeneration: number;
  readonly fetchedAt: string;
  readonly preferredModel: {
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
  } | null;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly maxInputTokens: number | null;
    readonly maxOutputTokens: number | null;
  }[];
}

export interface AdminRuntimeConfig {
  readonly revision: number;
  readonly config: RuntimeConfigSnapshot;
  readonly ranges: Record<string, { readonly min: number; readonly max: number; readonly unit: string }>;
}

export interface DeviceFlowStartResult {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
  readonly nextPollAt?: string;
}

export type DeviceFlowPollResult =
  | {
      readonly state: "pending";
      readonly pollIntervalSeconds?: number;
      readonly nextPollAt?: string;
    }
  | { readonly state: "complete"; readonly account: AdminAccount }
  | { readonly state: "expired" }
  | { readonly state: "denied" }
  | { readonly state: "failed" };

export type DeviceFlowCancelControlResult =
  | { readonly state: "canceled" | "not_found" }
  | { readonly state: "complete"; readonly accountId: string };

export interface ControlOperationMap {
  readonly "auth.login.start": {
    readonly args: { readonly host?: string };
    readonly result: DeviceFlowStartResult;
  };
  readonly "auth.login.poll": {
    readonly args: { readonly flowId: string };
    readonly result: DeviceFlowPollResult;
  };
  readonly "auth.login.cancel": {
    readonly args: { readonly flowId: string };
    readonly result: DeviceFlowCancelControlResult;
  };
  readonly "auth.logout": {
    readonly args: { readonly accountId?: string };
    readonly result: AdminAccount;
  };
  readonly "auth.status": {
    readonly args: Record<string, never>;
    readonly result: AuthStatus;
  };
  readonly "accounts.list": {
    readonly args: Record<string, never>;
    readonly result: AdminAccounts;
  };
  readonly "accounts.use": {
    readonly args: { readonly accountId: string };
    readonly result: AdminAccounts;
  };
  readonly "accounts.remove": {
    readonly args: { readonly accountId: string };
    readonly result: AdminAccount;
  };
  readonly "models.list": {
    readonly args: { readonly accountId?: string };
    readonly result: AdminModels;
  };
  readonly "models.current": {
    readonly args: Record<string, never>;
    readonly result: { readonly accountId: string | null; readonly preferredModel: ModelPreference | null };
  };
  readonly "models.set": {
    readonly args: { readonly modelId: string };
    readonly result: ModelPreference;
  };
  readonly "config.get": {
    readonly args: { readonly key?: string };
    readonly result: AdminRuntimeConfig | { readonly key: string; readonly value: number; readonly range: { readonly min: number; readonly max: number; readonly unit: string } };
  };
  readonly "config.set": {
    readonly args: { readonly key: string; readonly value: string };
    readonly result: AdminRuntimeConfig;
  };
}

export type ControlOperation = keyof ControlOperationMap;

export interface ControlClient {
  lifecycle(action: LifecycleAction, context: CliLifecycleContext): Promise<CliLifecycleResult>;
  request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    context: CliLifecycleContext,
  ): Promise<ControlOperationMap[Operation]["result"]>;
  adminOpen(context: CliLifecycleContext): Promise<CliAdminOpenResult>;
  close?(): Promise<void> | void;
}

export interface ControlEndpoint {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly port: number;
  readonly controlToken: string;
  readonly instanceNonce: string;
  readonly managed: boolean;
}

export type AuthenticatedControlIdentity = DaemonIdentity;

export class ScriptedControlClient implements ControlClient {
  readonly calls: Array<{
    readonly kind: "lifecycle" | "control" | "admin.open";
    readonly operation: string;
    readonly args: unknown;
    readonly dataDir?: string;
  }> = [];

  private readonly script = new Map<string, unknown[]>();

  constructor(entries: Readonly<Record<string, readonly unknown[]>> = {}) {
    for (const [key, values] of Object.entries(entries)) {
      this.script.set(key, [...values]);
    }
  }

  enqueue(key: string, value: unknown): void {
    const values = this.script.get(key) ?? [];
    values.push(value);
    this.script.set(key, values);
  }

  async lifecycle(action: LifecycleAction, context: CliLifecycleContext): Promise<CliLifecycleResult> {
    this.calls.push({ kind: "lifecycle", operation: action, args: {}, dataDir: context.dataDir });
    return this.pop(`lifecycle.${action}`) as CliLifecycleResult;
  }

  async request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    context: CliLifecycleContext,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    this.calls.push({ kind: "control", operation, args, dataDir: context.dataDir });
    return this.pop(operation) as ControlOperationMap[Operation]["result"];
  }

  async adminOpen(context: CliLifecycleContext): Promise<CliAdminOpenResult> {
    this.calls.push({ kind: "admin.open", operation: "admin.open", args: {}, dataDir: context.dataDir });
    return this.pop("admin.open") as CliAdminOpenResult;
  }

  private pop(key: string): unknown {
    const values = this.script.get(key);
    if (values === undefined || values.length === 0) {
      throw new CliError("internal_error");
    }
    const value = values.shift();
    if (value instanceof CliError) {
      throw value;
    }
    return value;
  }
}

export class HttpControlClient implements ControlClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly locateEndpoint: (dataDir: string) => Promise<ControlEndpoint | null> = readControlEndpoint,
    private readonly openBrowser: (url: string) => Promise<void> | void = defaultOpenBrowser,
    private readonly processIdentity: (pid: number) => Promise<string | null> = captureProcessStartIdentity,
  ) {}

  async lifecycle(action: LifecycleAction, context: CliLifecycleContext): Promise<CliLifecycleResult> {
    if (action === "start") {
      throw new CliError("unavailable");
    }
    const endpoint = await this.locateEndpoint(context.dataDir);
    if (endpoint === null) {
      if (action === "restart") {
        throw new CliError("unavailable");
      }
      return stoppedLifecycle(context.dataDir);
    }
    if ((action === "stop" || action === "restart") && !endpoint.managed) {
      throw new CliError("daemon_conflict");
    }
    await this.verifyEndpoint(endpoint);
    if (action === "restart") {
      throw new CliError("unavailable");
    }
    if (action === "status") {
      const data = await this.controlRequest(endpoint, "GET", "/__ghcg/control/v1/status", undefined, context);
      return lifecycleFromControlStatus(data, context.dataDir);
    }
    const data = await this.controlRequest(endpoint, "POST", "/__ghcg/control/v1/stop", undefined, context);
    return lifecycleFromControlStatus(data, context.dataDir, "stopped");
  }

  async request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    context: CliLifecycleContext,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    const request = async (): Promise<ControlOperationMap[Operation]["result"]> => {
      const endpoint = await this.requireEndpoint(context.dataDir);
      await this.verifyEndpoint(endpoint);
      const data = await this.controlRequest(endpoint, "POST", "/__ghcg/control/v1/command", {
        operation,
        arguments: args,
      }, context);
      return data as ControlOperationMap[Operation]["result"];
    };
    return context.timeoutMs === undefined
      ? await request()
      : await withCliTimeout(request(), context.timeoutMs);
  }

  async adminOpen(context: CliLifecycleContext): Promise<CliAdminOpenResult> {
    const endpoint = await this.requireEndpoint(context.dataDir);
    await this.verifyEndpoint(endpoint);
    const data = await this.controlRequest(endpoint, "POST", "/__ghcg/control/v1/admin-bootstrap", undefined, context);
    const token = isObject(data) && typeof data.token === "string" ? data.token : null;
    if (token === null) {
      throw new CliError("remote_error");
    }
    await this.openBrowser(`http://127.0.0.1:${endpoint.port}/admin/#bootstrap_token=${encodeURIComponent(token)}`);
    return { opened: true };
  }

  private async requireEndpoint(dataDir: string): Promise<ControlEndpoint> {
    const endpoint = await this.locateEndpoint(dataDir);
    if (endpoint === null) {
      throw new CliError("unavailable");
    }
    return endpoint;
  }

  private async verifyEndpoint(endpoint: Readonly<ControlEndpoint>): Promise<void> {
    let actual: string | null;
    try {
      actual = await this.processIdentity(endpoint.pid);
    } catch (_error: unknown) {
      throw new CliError("daemon_conflict");
    }
    if (actual === null) {
      throw new CliError("daemon_stale");
    }
    if (actual !== endpoint.processStartIdentity) {
      throw new CliError("daemon_conflict");
    }
  }

  private async controlRequest(
    endpoint: ControlEndpoint,
    method: "GET" | "POST",
    pathPart: string,
    body?: unknown,
    context: Pick<CliLifecycleContext, "signal" | "timeoutMs"> = {},
  ): Promise<unknown> {
    try {
      return await authenticatedControlRequest(endpoint, method, pathPart, body, context, this.fetchImpl);
    } catch (error: unknown) {
      if (pathPart.endsWith("/status") && error instanceof CliError && error.code === "daemon_unreachable") {
        return { state: "unreachable" };
      }
      throw error;
    }
  }
}

async function withCliTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CliError("timeout")), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function authenticatedControlRequest(
  endpoint: Readonly<ControlEndpoint>,
  method: "GET" | "POST",
  pathPart: string,
  body?: unknown,
  context: Pick<CliLifecycleContext, "signal" | "timeoutMs"> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let response: Response;
  const timeout = controlTimeout(context.signal, context.timeoutMs ?? 30_000);
  try {
    response = await Promise.race([fetchImpl(`http://127.0.0.1:${endpoint.port}${pathPart}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-ghcg-control-token": endpoint.controlToken,
        "x-ghcg-instance-nonce": endpoint.instanceNonce,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timeout.signal,
    }), timeout.promise]);
  } catch (_error: unknown) {
    timeout.clear();
    if (timeout.timedOut()) {
      throw new CliError("timeout");
    }
    if (timeout.parentAborted()) {
      throw new CliError("interrupted");
    }
    throw new CliError("daemon_unreachable");
  }
  let payload: unknown;
  try {
    payload = await Promise.race([response.json(), timeout.promise]).catch(() => null) as unknown;
  } finally {
    timeout.clear();
  }
  if (timeout.timedOut()) {
    throw new CliError("timeout");
  }
  if (timeout.parentAborted()) {
    throw new CliError("interrupted");
  }
  if (response.ok && isObject(payload) && "data" in payload) {
    return payload.data;
  }
  throw cliErrorFromControlResponse(response.status, payload);
}

export async function readDaemonIdentity(dataDir: string): Promise<DaemonIdentity | null> {
  try {
    return new DaemonIdentityFile(dataDir).read();
  } catch (error: unknown) {
    if (isNodeNotFound(error)) {
      return null;
    }
    throw new CliError("security_error");
  }
}

const readControlEndpoint = readDaemonIdentity;

function controlTimeout(parent: AbortSignal | undefined, ms: number): {
  readonly signal: AbortSignal;
  readonly promise: Promise<never>;
  readonly clear: () => void;
  readonly timedOut: () => boolean;
  readonly parentAborted: () => boolean;
} {
  const controller = new AbortController();
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
  let timedOut = false;
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new CliError("timeout"));
  }, ms);
  return {
    signal,
    promise,
    clear: () => clearTimeout(timer),
    timedOut: () => timedOut,
    parentAborted: () => parent?.aborted === true,
  };
}

function lifecycleFromControlStatus(data: unknown, dataDir: string, fallbackState: CliLifecycleResult["state"] = "running"): CliLifecycleResult {
  if (!isObject(data)) {
    throw new CliError("remote_error");
  }
  const state = typeof data.state === "string" ? data.state : fallbackState;
  const instance = isObject(data.instance) ? data.instance : data;
  return {
    state: isLifecycleState(state) ? state : fallbackState,
    managed: typeof instance.managed === "boolean" ? instance.managed : null,
    pid: Number.isInteger(instance.pid) ? numberValue(instance.pid) : null,
    startedAt: typeof instance.createdAt === "string" ? instance.createdAt : null,
    port: Number.isInteger(instance.port) ? numberValue(instance.port) : null,
    dataDir: path.resolve(dataDir),
  };
}

function numberValue(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw new CliError("remote_error");
  }
  return value as number;
}

function cliErrorFromControlResponse(status: number, payload: unknown): CliError {
  const code = isObject(payload) && isObject(payload.error) && typeof payload.error.code === "string"
    ? payload.error.code
    : undefined;
  if (code === "revision_conflict") {
    return new CliError("revision_conflict");
  }
  if (code === "not_found") {
    return new CliError("not_found");
  }
  if (code === "validation_error" || code === "validation_failed" || code === "invalid_command") {
    return new CliError("validation_error");
  }
  if (status === 401 || code === "unauthorized") {
    return new CliError("security_error");
  }
  if (status === 409 || code === "instance_mismatch") {
    return new CliError("daemon_conflict");
  }
  if (status === 503 || code === "not_ready") {
    return new CliError("unavailable");
  }
  if (status === 404) {
    return new CliError("not_found");
  }
  if (status === 400) {
    return new CliError("validation_error");
  }
  return new CliError("remote_error");
}

function isLifecycleState(value: string): value is CliLifecycleResult["state"] {
  return value === "running" || value === "stopped" || value === "stale" || value === "conflict" || value === "unreachable";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = browserCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  }).catch(() => {
    throw new CliError("unavailable");
  });
}

function browserCommand(url: string): { readonly file: string; readonly args: readonly string[] } {
  if (process.platform === "win32") {
    return { file: "cmd", args: ["/c", "start", "", url] };
  }
  if (process.platform === "darwin") {
    return { file: "open", args: [url] };
  }
  return { file: "xdg-open", args: [url] };
}

export function stoppedLifecycle(dataDir: string): CliLifecycleResult {
  return {
    state: "stopped",
    managed: null,
    pid: null,
    startedAt: null,
    port: null,
    dataDir: path.resolve(dataDir),
  };
}

export function adminAccountFromSummary(
  summary: AccountSummary,
  preferredModel: ModelPreference | null,
): AdminAccount {
  return {
    accountId: summary.accountId,
    host: summary.host,
    numericUserId: summary.userId,
    login: summary.login,
    displayName: summary.displayName,
    state: summary.state,
    revision: summary.revision,
    authenticatedAt: summary.authenticatedAtMs === null ? null : new Date(summary.authenticatedAtMs).toISOString(),
    preferredModel: preferredModel === null
      ? null
      : {
        revision: preferredModel.revision,
        modelId: preferredModel.modelId,
        validity: preferredModel.validity,
      },
  };
}

export function adminModelsFromCatalog(
  accountId: string,
  catalog: CapabilityCatalogSnapshot,
  preferredModel: ModelPreference | null,
): AdminModels {
  return {
    accountId,
    catalogGeneration: catalog.catalogGeneration,
    fetchedAt: catalog.fetchedAt,
    preferredModel: preferredModel === null
      ? null
      : {
        revision: preferredModel.revision,
        modelId: preferredModel.modelId,
        validity: preferredModel.validity,
      },
    items: catalog.models.filter((model) => model.visible).map((model) => {
      return {
        id: model.modelId,
        name: model.name,
        vendor: model.vendor,
        maxInputTokens: model.maxInputTokens.value,
        maxOutputTokens: model.maxOutputTokens.value,
      };
    }),
  };
}
