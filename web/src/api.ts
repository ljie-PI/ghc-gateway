import type { AgentsView, AgentStatus, AgentApplyRequest, AgentTakeoverRequest } from "../../src/agents/types.js";
import type { AdminAgentModels } from "../../src/admin/api.js";
import type {
  AdminAccount,
  AdminAccounts,
  AdminEventPage,
  AdminHistorySummary,
  AdminModels,
  AdminRuntimeConfig,
  AdminStatus,
  AdminUsagePage,
  DeviceFlow,
  DeviceFlowPoll,
} from "./types.js";

interface Success<T> { readonly data: T }
interface Failure { readonly error: { readonly code: string; readonly message: string; readonly requestId: string } }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId: string | null) {
    super(code.replaceAll("_", " "));
    this.name = "ApiError";
  }
}

export class AdminClient {
  status(signal?: AbortSignal): Promise<AdminStatus> {
    return this.request("/status", signal === undefined ? undefined : { signal });
  }
  usage(window?: "24h" | "7d" | "28d", signal?: AbortSignal): Promise<AdminUsagePage> {
    return this.request(
      window === undefined ? "/usage?limit=100" : `/usage?limit=1&window=${window}`,
      signal === undefined ? undefined : { signal },
    );
  }
  accounts(signal?: AbortSignal): Promise<AdminAccounts> {
    return this.request("/accounts", signal === undefined ? undefined : { signal });
  }
  models(accountId?: string, signal?: AbortSignal): Promise<AdminModels> {
    return this.request(`/models${accountId === undefined ? "" : `?accountId=${encodeURIComponent(accountId)}`}`, signal === undefined ? undefined : { signal });
  }
  agents(signal?: AbortSignal): Promise<AgentsView> {
    return this.request("/agents", signal === undefined ? undefined : { signal });
  }
  applyAgent(value: AgentApplyRequest): Promise<AgentStatus> { return this.mutate("/agents/apply", "POST", value); }
  takeoverAgent(value: AgentTakeoverRequest): Promise<AgentStatus> { return this.mutate("/agents/takeover", "POST", value); }
  agentModels(signal?: AbortSignal): Promise<AdminAgentModels> {
    return this.request("/agents/models", signal === undefined ? undefined : { signal });
  }
  config(): Promise<AdminRuntimeConfig> { return this.request("/config"); }
  history(): Promise<AdminHistorySummary> { return this.request("/history"); }
  events(cursor?: string): Promise<AdminEventPage> {
    return this.request(`/events?limit=500${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
  }
  startDeviceFlow(host: string, signal?: AbortSignal): Promise<DeviceFlow> {
    return this.mutate("/device-flows", "POST", { host }, signal);
  }
  pollDeviceFlow(flowId: string, signal?: AbortSignal): Promise<DeviceFlowPoll> {
    return this.request(`/device-flows/${encodeURIComponent(flowId)}`, signal === undefined ? undefined : { signal });
  }
  cancelDeviceFlow(flowId: string, signal?: AbortSignal): Promise<
    | { readonly state: "canceled" }
    | { readonly state: "complete"; readonly account: AdminAccount }
  > {
    return this.mutate(`/device-flows/${encodeURIComponent(flowId)}`, "DELETE", undefined, signal);
  }
  useAccount(accountId: string, expectedRevision: number): Promise<{ defaultAccountId: string; defaultRevision: number }> {
    return this.mutate("/accounts/default", "PUT", { accountId, expectedRevision });
  }
  removeAccount(accountId: string, expectedRevision: number): Promise<AdminAccount> {
    return this.mutate(`/accounts/${encodeURIComponent(accountId)}`, "DELETE", { expectedRevision });
  }
  refreshModels(accountId: string, signal?: AbortSignal): Promise<AdminModels> {
    return this.mutate("/models/refresh", "POST", { accountId }, signal);
  }
  saveConfig(value: AdminRuntimeConfig): Promise<AdminRuntimeConfig> {
    return this.mutate("/config", "PUT", { expectedRevision: value.revision, config: value.config });
  }
  clearHistory(expectedRevision: number): Promise<AdminHistorySummary> {
    return this.mutate("/history", "DELETE", { expectedRevision });
  }

  private mutate<T>(
    path: string,
    method: "POST" | "PUT" | "DELETE",
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/admin/api/v1${path}`, { ...init, cache: "no-store" });
    } catch (error: unknown) {
      throw new ApiError(0, error instanceof Error ? "network_failure" : "request_failed", null);
    }
    if (!response.ok) {
      let failure: Failure | null = null;
      try { failure = await response.json() as Failure; } catch { /* Low-information fallback. */ }
      throw new ApiError(response.status, failure?.error.code ?? "request_failed", failure?.error.requestId ?? null);
    }
    if (response.status === 204) return undefined as T;
    return ((await response.json()) as Success<T>).data;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "agent_invalid_config") return "Unsupported or invalid client configuration. Check global configuration syntax and remove conflicting profiles before applying.";
    if (error.code === "agent_models_unavailable") return "Use exact enabled Copilot model IDs with usable capabilities from Models, then refresh.";
    if (error.code === "agent_unsafe_path") return "The configuration path has an unsupported type or link, or changed during validation. No forced overwrite is available.";
    if (error.code === "agent_recovery_required") return "A configuration write was interrupted. Refresh and apply again to finish a recoverable write. If it still fails, retain the backup and recovery files and reconcile external changes before retrying.";
    if (error.code === "agent_conflict") return "The configuration or first backup changed. Refresh before applying; preserve the first backup and reconcile any conflicting backup changes.";
    if (error.code === "agent_busy") return "Another agent configuration operation is running. Try again after it finishes.";
    if (error.status === 409) return "This data changed elsewhere. Refresh before trying again.";
    if (error.status === 403) return "The security check rejected this change.";
    if (error.status === 0) return "The gateway is unreachable. Check that it is still running.";
    return error.message;
  }
  return "The operation could not be completed.";
}

export function agentApplyErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Apply failed: request failed.";
  const messages: Readonly<Record<string, string>> = {
    agent_invalid_config: "Apply failed: unsupported client configuration.",
    agent_models_unavailable: "Apply failed: model catalog unavailable.",
    agent_unsafe_path: "Apply failed: unsafe configuration path.",
    agent_recovery_required: "Apply failed: recovery required.",
    agent_conflict: "Apply failed: external changes detected.",
    agent_busy: "Apply failed: another operation is running.",
  };
  const message = messages[error.code];
  if (message !== undefined) return message;
  if (error.status === 409) return "Apply failed: stale configuration revision.";
  if (error.status === 403) return "Apply failed: security check rejected configuration.";
  if (error.status === 0) return "Apply failed: Gateway is unreachable.";
  return "Apply failed: request failed.";
}
