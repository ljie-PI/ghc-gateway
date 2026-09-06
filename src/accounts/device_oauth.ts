import type { DeviceOAuthClient } from "./device_flow.js";

const DEVICE_OAUTH_RESPONSE_BYTES = 1_048_576;

export class DeviceOAuthError extends Error {
  readonly code = "remote_error";

  constructor(
    readonly retryable = true,
    readonly retryAfterMs: number | null = null,
  ) {
    super("remote error");
    this.name = "DeviceOAuthError";
  }
}

export class HttpDeviceOAuthClient implements DeviceOAuthClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async requestDeviceCode(environment: Parameters<DeviceOAuthClient["requestDeviceCode"]>[0], signal?: AbortSignal) {
    const response = await this.fetch(environment.deviceCodeUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: environment.clientId }),
      ...(signal === undefined ? {} : { signal }),
    }, signal);
    if (!response.ok) {
      await cancelResponse(response);
      throw new DeviceOAuthError();
    }
    const value = await readJsonObject(response, signal);
    if (!nonemptyString(value.device_code)
      || !nonemptyString(value.user_code)
      || !nonemptyString(value.verification_uri)
      || !positiveNumber(value.interval)
      || !positiveNumber(value.expires_in)) {
      throw new DeviceOAuthError();
    }
    return {
      deviceCode: value.device_code,
      userCode: value.user_code,
      verificationUri: value.verification_uri,
      intervalSec: value.interval,
      expiresInSec: value.expires_in,
    };
  }

  async exchangeDeviceCode(
    environment: Parameters<DeviceOAuthClient["exchangeDeviceCode"]>[0],
    deviceCode: string,
    signal?: AbortSignal,
  ) {
    const response = await this.fetch(environment.accessTokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: environment.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      ...(signal === undefined ? {} : { signal }),
    }, signal);
    if (!response.ok) {
      await cancelResponse(response);
      throw new DeviceOAuthError();
    }
    const value = await readJsonObject(response, signal);
    if (value.error === "authorization_pending") {
      return { status: "pending" } as const;
    }
    if (value.error === "slow_down") {
      return {
        status: "slow_down",
        ...(positiveNumber(value.interval) ? { pollIntervalSeconds: value.interval } : {}),
      } as const;
    }
    if (value.error === "expired_token") {
      return { status: "expired" } as const;
    }
    if (value.error === "access_denied") {
      return { status: "denied" } as const;
    }
    if (typeof value.error === "string") {
      return { status: "failed" } as const;
    }
    if (!nonemptyString(value.access_token)) {
      throw new DeviceOAuthError();
    }
    return { status: "authorized" as const, accessToken: value.access_token };
  }

  async fetchUser(
    environment: Parameters<NonNullable<DeviceOAuthClient["fetchUser"]>>[0],
    accessToken: string,
    signal?: AbortSignal,
  ) {
    const userUrl = new URL(environment.apiBaseUrl);
    userUrl.pathname = `${userUrl.pathname.replace(/\/$/u, "")}/user`;
    const userResponse = await this.fetch(userUrl, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    }, signal);
    if (!userResponse.ok) {
      const retryAfterMs = rateLimitDelayMs(userResponse.headers);
      const retryable = userResponse.status === 429
        || userResponse.status >= 500
        || (userResponse.status === 403 && retryAfterMs !== null);
      await cancelResponse(userResponse);
      throw new DeviceOAuthError(retryable, retryAfterMs);
    }
    const user = await readJsonObject(userResponse, signal);
    if ((typeof user.id !== "string" && typeof user.id !== "number")
      || !nonemptyString(user.login)) {
      throw new DeviceOAuthError(false);
    }
    return {
      id: user.id,
      login: user.login,
      ...(typeof user.name === "string" ? { name: user.name } : {}),
    };
  }

  private async fetch(input: string | URL, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    try {
      signal?.throwIfAborted();
      return await this.fetchImpl(input, init);
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        signal.throwIfAborted();
      }
      if (error instanceof DeviceOAuthError) {
        throw error;
      }
      throw new DeviceOAuthError();
    }
  }
}

async function readJsonObject(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new DeviceOAuthError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > DEVICE_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceOAuthError();
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      signal.throwIfAborted();
    }
    if (error instanceof DeviceOAuthError) {
      throw error;
    }
    throw new DeviceOAuthError();
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new DeviceOAuthError();
  }
  if (!isRecord(value)) {
    throw new DeviceOAuthError();
  }
  return value;
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function rateLimitDelayMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds)) return Math.max(0, resetSeconds * 1000 - Date.now());
  }
  return null;
}
