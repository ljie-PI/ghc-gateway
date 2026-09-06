import { describe, expect, it, vi } from "vitest";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import {
  DeviceOAuthError,
  HttpDeviceOAuthClient,
} from "../../src/accounts/device_oauth.js";

const environment = resolveGitHubEnvironment("ghe.example.com");

describe("HTTP device OAuth client", () => {
  it("uses URL-derived endpoints and accepts bounded JSON objects", async () => {
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = input.toString();
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "test-access-token" });
      }
      return jsonResponse({ id: 42, login: "octocat", name: "Octo Cat" });
    });
    const client = new HttpDeviceOAuthClient(fetch);

    await expect(client.exchangeDeviceCode(environment, "test-device-code")).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
    await expect(client.fetchUser(environment, "test-access-token")).resolves.toEqual({
      id: 42,
      login: "octocat",
      name: "Octo Cat",
    });
    expect(requests).toEqual([
      { url: "https://ghe.example.com/login/oauth/access_token", authorization: null },
      { url: "https://ghe.example.com/api/v3/user", authorization: "Bearer test-access-token" },
    ]);
  });

  it.each([
    ["HTTP failure", async () => new Response(null, { status: 502 })],
    ["network failure", async () => { throw new TypeError("network failed"); }],
    ["invalid JSON", async () => new Response("not JSON", { status: 200 })],
    ["non-object JSON", async () => jsonResponse(["unexpected"])],
  ])("maps %s to a typed remote error", async (_case, fetchImpl) => {
    const client = new HttpDeviceOAuthClient(fetchImpl);
    await expect(client.requestDeviceCode(environment)).rejects.toMatchObject({
      name: "DeviceOAuthError",
      code: "remote_error",
      message: "remote error",
    });
  });

  it("cancels on the first byte beyond the 1 MiB response limit", async () => {
    let reads = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(reads === 1 ? 1_048_576 : 1));
      },
      cancel() {
        canceled = true;
      },
    }, { highWaterMark: 0 });
    const client = new HttpDeviceOAuthClient(async () => new Response(body, { status: 200 }));

    await expect(client.requestDeviceCode(environment)).rejects.toBeInstanceOf(DeviceOAuthError);
    expect(reads).toBe(2);
    expect(canceled).toBe(true);
  });

  it("maps an invalid GitHub user response to remote_error", async () => {
    let requests = 0;
    const client = new HttpDeviceOAuthClient(async () => {
      requests += 1;
      return requests === 1
        ? jsonResponse({ access_token: "test-access-token" })
        : jsonResponse({ id: null, login: "" });
    });

    await expect(client.exchangeDeviceCode(environment, "test-device-code")).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
    await expect(client.fetchUser(environment, "test-access-token")).rejects.toMatchObject({
      name: "DeviceOAuthError",
      retryable: false,
    });
    expect(requests).toBe(2);
  });

  it("preserves abort failures instead of mapping them to remote_error", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new HttpDeviceOAuthClient(async () => {
      throw new Error("fetch must not run");
    });

    await expect(client.requestDeviceCode(environment, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves pending, slow_down cadence, expiry, and denial results", async () => {
    const responses = [
      { error: "authorization_pending" },
      { error: "slow_down", interval: 12 },
      { error: "expired_token" },
      { error: "access_denied" },
    ];
    const client = new HttpDeviceOAuthClient(async () => jsonResponse(responses.shift()));

    await expect(client.exchangeDeviceCode(environment, "device")).resolves.toEqual({ status: "pending" });
    await expect(client.exchangeDeviceCode(environment, "device")).resolves.toEqual({
      status: "slow_down",
      pollIntervalSeconds: 12,
    });
    await expect(client.exchangeDeviceCode(environment, "device")).resolves.toEqual({ status: "expired" });
    await expect(client.exchangeDeviceCode(environment, "device")).resolves.toEqual({ status: "denied" });
  });

  it("finishes identity lookup after cancellation once a token is issued", async () => {
    let userRequestStarted = (): void => undefined;
    let releaseUser = (): void => undefined;
    const started = new Promise<void>((resolve) => { userRequestStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseUser = resolve; });
    let requests = 0;
    const client = new HttpDeviceOAuthClient(async () => {
      requests += 1;
      if (requests === 1) return jsonResponse({ access_token: "test-access-token" });
      userRequestStarted();
      await release;
      return jsonResponse({ id: 42, login: "octocat" });
    });

    const controller = new AbortController();
    await expect(client.exchangeDeviceCode(environment, "device", controller.signal)).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
    const exchange = client.fetchUser(environment, "test-access-token");
    await started;
    controller.abort();
    releaseUser();

    await expect(exchange).resolves.toEqual({
      id: 42,
      login: "octocat",
    });
  });

  it("classifies GitHub rate-limit 403 responses as retryable", async () => {
    const client = new HttpDeviceOAuthClient(async () => new Response(null, {
      status: 403,
      headers: { "retry-after": "7" },
    }));

    await expect(client.fetchUser(environment, "test-access-token")).rejects.toMatchObject({
      name: "DeviceOAuthError",
      retryable: true,
      retryAfterMs: 7_000,
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
