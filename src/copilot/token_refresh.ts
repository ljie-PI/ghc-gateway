import type { BoundAccount } from "../accounts/account_directory.js";
import type { AccountCoordinator } from "../accounts/account_coordinator.js";
import type { CredentialStore, SecretCredential } from "../accounts/credential_store.js";

export const REFRESH_SKEW_MS = 60_000;

export class TokenRefreshError extends Error {
  readonly code: "missing" | "unauthorized" | "network" | "timeout";

  constructor(code: TokenRefreshError["code"], message: string) {
    super(message);
    this.name = "TokenRefreshError";
    this.code = code;
  }
}

export function needsRefresh(credential: SecretCredential, nowMs: number, environmentKind: "github.com" | "ghes"): boolean {
  if (environmentKind === "ghes") {
    return false;
  }
  if (credential.copilotToken === undefined || credential.copilotExpiresAtMs === undefined) {
    return true;
  }
  return credential.copilotExpiresAtMs - nowMs < REFRESH_SKEW_MS;
}

export async function getValidToken(
  store: CredentialStore,
  coordinator: AccountCoordinator,
  account: BoundAccount,
  nowMs: number,
  refresh: (githubToken: string, signal?: AbortSignal) => Promise<{ token: string; expiresAtMs: number }>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const generation = account.credentialGeneration;
  let current = await store.readGeneration(account.accountId, generation);
  throwIfAborted(signal);
  if (current === null) {
    throw new TokenRefreshError("missing", "credential missing");
  }
  if (account.environment.kind === "ghes") {
    return current.githubToken;
  }
  await coordinator.withCredentialGeneration(account.accountId, async () => {
    throwIfAborted(signal);
    const again = await store.readGeneration(account.accountId, generation);
    throwIfAborted(signal);
    if (again === null) {
      throw new TokenRefreshError("missing", "credential missing");
    }
    current = again;
    if (!needsRefresh(again, nowMs, "github.com")) {
      return;
    }
    const refreshed = await refresh(again.githubToken, signal);
    throwIfAborted(signal);
    current = {
      ...again,
      copilotToken: refreshed.token,
      copilotExpiresAtMs: refreshed.expiresAtMs,
    };
    await store.putGeneration(account.accountId, generation, current);
    throwIfAborted(signal);
  }, signal);
  if (current.copilotToken === undefined) {
    throw new TokenRefreshError("missing", "copilot token missing");
  }
  return current.copilotToken;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}
