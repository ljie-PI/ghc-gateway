import { describe, expect, it, vi } from "vitest";
import { createAdminModule } from "../../src/admin/routes.js";
import type { AdminModule } from "../../src/gateway/create_gateway.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { adminDependencies, login, type TestAdminDependencies } from "./admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";

describe("Admin authentication", () => {
  it("exchanges a bootstrap token once with exact Origin and safe cookie flags", async () => {
    const harness = await createHarness();
    try {
      const minted = harness.admin.mintBootstrap();
      expect(minted.kind).toBe("issued");
      if (minted.kind !== "issued") return;

      const wrongOrigin = await exchange(harness.gateway, minted.token, "http://localhost:31400");
      expect(wrongOrigin.status).toBe(403);
      expect(await wrongOrigin.json()).toEqual({
        error: { code: "forbidden", message: "forbidden", requestId: "req_admin_auth" },
      });

      const first = await exchange(harness.gateway, minted.token);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.headers.get("x-request-id")).toBe("req_admin_auth");
      expect(first.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/admin");
      const firstBody = await first.json() as { data: { csrfToken: string; idleExpiresAt: string; absoluteExpiresAt: string } };
      expect(firstBody.data).toEqual({
        csrfToken: "token-3",
        idleExpiresAt: "2027-01-15T08:30:00.000Z",
        absoluteExpiresAt: "2027-01-15T20:00:00.000Z",
      });

      expect((await exchange(harness.gateway, minted.token)).status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("enforces bootstrap expiry, one-use races, session caps, idle/absolute expiry, and close", async () => {
    const now = { value: 1_800_000_000_000 };
    const harness = await createHarness(now);
    try {
      const expired = issued(harness.admin.mintBootstrap());
      now.value += 60_000;
      expect((await exchange(harness.gateway, expired.token)).status).toBe(401);

      const raced = issued(harness.admin.mintBootstrap());
      const race = await Promise.all([exchange(harness.gateway, raced.token), exchange(harness.gateway, raced.token)]);
      expect(race.map((response) => response.status).sort()).toEqual([200, 401]);

      const raceCookie = race.find((response) => response.status === 200)?.headers.get("set-cookie") ?? "";
      now.value += 30 * 60_000;
      expect((await session(harness.gateway, raceCookie)).status).toBe(401);

      for (let index = 0; index < 8; index += 1) {
        expect(harness.admin.mintBootstrap().kind).toBe("issued");
      }
      expect(harness.admin.mintBootstrap()).toEqual({ kind: "capacity" });
    } finally {
      await harness.close();
    }

    const absolute = await createHarness({ value: 1_800_000_000_000 });
    try {
      const loggedIn = await login(absolute.gateway, absolute.admin);
      expect((await mutate(
        absolute.gateway,
        "/admin/api/v1/device-flows",
        loggedIn,
        { host: "github.com" },
      )).status).toBe(201);
      for (let interval = 1; interval < 36; interval += 1) {
        absolute.dependencies.now.value += 20 * 60_000;
        expect((await session(absolute.gateway, loggedIn.cookie)).status).toBe(200);
      }
      absolute.dependencies.now.value += 20 * 60_000;
      expect((await session(absolute.gateway, loggedIn.cookie)).status).toBe(401);
      expect(absolute.dependencies.calls).toContain("device-cancel:flow-1");
      absolute.admin.close();
      absolute.admin.close();
      expect(absolute.admin.mintBootstrap()).toEqual({ kind: "closed" });
    } finally {
      await absolute.close();
    }
  });

  it("requires session, CSRF, and active listener Origin on every non-bootstrap mutation", async () => {
    const harness = await createHarness();
    try {
      const loggedIn = await login(harness.gateway, harness.admin);
      expect((await get(harness.gateway, "/admin/api/v1/status", loggedIn.cookie)).status).toBe(200);

      expect((await mutate(harness.gateway, "/admin/api/v1/device-flows", loggedIn, { host: "github.com" }, {
        csrf: "",
      })).status).toBe(403);
      expect((await mutate(harness.gateway, "/admin/api/v1/device-flows", loggedIn, { host: "github.com" }, {
        origin: "http://127.0.0.1:9999",
      })).status).toBe(403);
      expect((await mutate(harness.gateway, "/admin/api/v1/device-flows", loggedIn, { host: "github.com" })).status).toBe(201);
      const otherSession = await login(harness.gateway, harness.admin);
      expect((await get(
        harness.gateway,
        "/admin/api/v1/device-flows/flow-1",
        otherSession.cookie,
      )).status).toBe(403);
      expect((await securedRequest(
        harness.gateway,
        "DELETE",
        "/admin/api/v1/device-flows/flow-1",
        otherSession,
        undefined,
        {},
      )).status).toBe(403);

      const mutations = [
        ["POST", "/admin/api/v1/auth/logout", undefined],
        ["POST", "/admin/api/v1/device-flows", { host: "github.com" }],
        ["DELETE", "/admin/api/v1/device-flows/flow-1", undefined],
        ["DELETE", "/admin/api/v1/accounts/github.com%2F42", { expectedRevision: 3 }],
        ["PUT", "/admin/api/v1/accounts/default", { accountId: "github.com/42", expectedRevision: 2 }],
        ["POST", "/admin/api/v1/models/refresh", { accountId: "github.com/42" }],
        ["PUT", "/admin/api/v1/models/preferred", { accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0 }],
        ["PUT", "/admin/api/v1/models/capabilities", { accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0, expectedCredentialGeneration: 4, expectedCatalogGeneration: 7, capabilities: { enabled: true } }],
        ["DELETE", "/admin/api/v1/models/capabilities", { accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0, expectedCredentialGeneration: 4, expectedCatalogGeneration: 7 }],
        ["PUT", "/admin/api/v1/config", { expectedRevision: 1, config: defaultRuntimeConfigSnapshot() }],
        ["DELETE", "/admin/api/v1/history", { expectedRevision: 0 }],
      ] as const;
      for (const [method, path, body] of mutations) {
        const missingCsrf = await securedRequest(harness.gateway, method, path, loggedIn, body, { csrf: "" });
        expect(missingCsrf.status, `${method} ${path} without CSRF`).toBe(403);
        const wrongOrigin = await securedRequest(harness.gateway, method, path, loggedIn, body, { origin: "http://127.0.0.1:9999" });
        expect(wrongOrigin.status, `${method} ${path} with wrong Origin`).toBe(403);
      }

      expect((await mutate(harness.gateway, "/admin/api/v1/device-flows", loggedIn, {
        host: "github.com",
      })).status).toBe(201);
      const logout = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/logout`, {
        method: "POST",
        headers: { cookie: loggedIn.cookie, origin: ORIGIN, "x-ghcg-csrf": loggedIn.csrf },
      }));
      expect(logout.status).toBe(204);
      expect(await logout.text()).toBe("");
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(harness.dependencies.calls).toContain("device-cancel:flow-1");
      expect((await session(harness.gateway, loggedIn.cookie)).status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("rejects a ninth live Admin Session", async () => {
    const harness = await createHarness();
    try {
      for (let index = 0; index < 8; index += 1) {
        const token = issued(harness.admin.mintBootstrap());
        expect((await exchange(harness.gateway, token.token)).status).toBe(200);
      }
      const ninth = issued(harness.admin.mintBootstrap());
      expect((await exchange(harness.gateway, ninth.token)).status).toBe(503);
    } finally {
      await harness.close();
    }
  });

  it("cancels and releases an owned flow at its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const harness = await createHarness({ value: 1_800_000_000_000 });
    try {
      const loggedIn = await login(harness.gateway, harness.admin);
      expect((await mutate(harness.gateway, "/admin/api/v1/device-flows", loggedIn, {
        host: "github.com",
      })).status).toBe(201);
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      expect(harness.dependencies.calls).toContain("device-cancel:flow-1");
      expect((await get(
        harness.gateway,
        "/admin/api/v1/device-flows/flow-1",
        loggedIn.cookie,
      )).status).toBe(404);
    } finally {
      await harness.close();
      vi.useRealTimers();
    }
  });
});

async function createHarness(now = { value: 1_800_000_000_000 }): Promise<{
  readonly gateway: Gateway;
  readonly admin: AdminModule;
  readonly dependencies: TestAdminDependencies;
  readonly close: () => Promise<void>;
}> {
  const dependencies = adminDependencies(now);
  let token = 0;
  const admin = createAdminModule({ ...dependencies, createToken: () => `token-${++token}` });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/admin-auth" }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_auth" });
  return { gateway, admin, dependencies, close: async () => gateway.close() };
}

function issued(result: ReturnType<AdminModule["mintBootstrap"]>): Extract<ReturnType<AdminModule["mintBootstrap"]>, { kind: "issued" }> {
  if (result.kind !== "issued") throw new Error("bootstrap was not issued");
  return result;
}

async function exchange(gateway: Gateway, token: string, origin = ORIGIN): Promise<Response> {
  return await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  }));
}

async function session(gateway: Gateway, cookie: string): Promise<Response> {
  return await get(gateway, "/admin/api/v1/auth/session", cookie);
}

async function get(gateway: Gateway, path: string, cookie: string): Promise<Response> {
  return await gateway.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
}

async function mutate(
  gateway: Gateway,
  path: string,
  sessionValue: { readonly cookie: string; readonly csrf: string },
  body: unknown,
  override: { readonly csrf?: string; readonly origin?: string } = {},
): Promise<Response> {
  return await gateway.fetch(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionValue.cookie,
      origin: override.origin ?? ORIGIN,
      "x-ghcg-csrf": override.csrf ?? sessionValue.csrf,
    },
    body: JSON.stringify(body),
  }));
}

async function securedRequest(
  gateway: Gateway,
  method: string,
  path: string,
  sessionValue: { readonly cookie: string; readonly csrf: string },
  body: unknown,
  override: { readonly csrf?: string; readonly origin?: string },
): Promise<Response> {
  return await gateway.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      cookie: sessionValue.cookie,
      origin: override.origin ?? ORIGIN,
      "x-ghcg-csrf": override.csrf ?? sessionValue.csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
