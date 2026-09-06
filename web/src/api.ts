import type {
  AdminAccount,
  AdminAccounts,
  AdminEventPage,
  AdminHistorySummary,
  AdminModels,
  AdminRuntimeConfig,
  AdminSessionMetadata,
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
  private csrfToken: string | null = null;

  constructor(private readonly onUnauthorized: () => void) {}

  clear(): void { this.csrfToken = null; }

  async bootstrap(token: string): Promise<AdminSessionMetadata> {
    const session = await this.request<AdminSessionMetadata>("/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    this.csrfToken = session.csrfToken;
    return session;
  }

  async session(): Promise<AdminSessionMetadata> {
    const session = await this.request<AdminSessionMetadata>("/auth/session");
    this.csrfToken = session.csrfToken;
    return session;
  }

  status(): Promise<AdminStatus> { return this.request("/status"); }
  usage(): Promise<AdminUsagePage> { return this.request("/usage?limit=100"); }
  accounts(): Promise<AdminAccounts> { return this.request("/accounts"); }
  models(accountId?: string): Promise<AdminModels> {
    return this.request(`/models${accountId === undefined ? "" : `?accountId=${encodeURIComponent(accountId)}`}`);
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
    | { readonly state: "canceled" | "not_found" }
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
  refreshModels(accountId: string): Promise<AdminModels> {
    return this.mutate("/models/refresh", "POST", { accountId });
  }
  preferModel(accountId: string, modelId: string, expectedRevision: number): Promise<unknown> {
    return this.mutate("/models/preferred", "PUT", { accountId, modelId, expectedRevision });
  }
  setModelCapabilities(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    expectedCredentialGeneration: number,
    expectedCatalogGeneration: number,
    capabilities: NonNullable<AdminModels["items"][number]["override"]>,
  ): Promise<AdminModels> {
    return this.mutate("/models/capabilities", "PUT", {
      accountId,
      modelId,
      expectedRevision,
      expectedCredentialGeneration,
      expectedCatalogGeneration,
      capabilities,
    });
  }
  resetModelCapabilities(
    accountId: string,
    modelId: string,
    expectedRevision: number,
    expectedCredentialGeneration: number,
    expectedCatalogGeneration: number,
  ): Promise<AdminModels> {
    return this.mutate("/models/capabilities", "DELETE", {
      accountId,
      modelId,
      expectedRevision,
      expectedCredentialGeneration,
      expectedCatalogGeneration,
    });
  }
  saveConfig(value: AdminRuntimeConfig): Promise<AdminRuntimeConfig> {
    return this.mutate("/config", "PUT", { expectedRevision: value.revision, config: value.config });
  }
  clearHistory(expectedRevision: number): Promise<AdminHistorySummary> {
    return this.mutate("/history", "DELETE", { expectedRevision });
  }
  async logout(): Promise<void> { await this.mutate("/auth/logout", "POST"); }

  private mutate<T>(
    path: string,
    method: "POST" | "PUT" | "DELETE",
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.csrfToken === null) {
      return Promise.reject(new ApiError(401, "unauthenticated", null));
    }
    const headers: Record<string, string> = { "X-GHCG-CSRF": this.csrfToken };
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
      response = await fetch(`/admin/api/v1${path}`, { ...init, cache: "no-store", credentials: "same-origin" });
    } catch (error: unknown) {
      throw new ApiError(0, error instanceof Error ? "network_failure" : "request_failed", null);
    }
    if (response.status === 401) {
      this.clear();
      this.onUnauthorized();
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

export function takeBootstrapToken(): string | null {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("bootstrap_token");
  if (location.hash !== "") history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "This data changed elsewhere. Refresh before trying again.";
    if (error.status === 403) return "The security check rejected this change.";
    if (error.status === 0) return "The gateway is unreachable. Check that it is still running.";
    return error.message;
  }
  return "The operation could not be completed.";
}
