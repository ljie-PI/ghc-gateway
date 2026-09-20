import { describe, expect, it } from "vitest";
import { createAdminModule } from "../../src/admin/routes.js";
import type { AdminModule } from "../../src/gateway/create_gateway.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { adminDependencies, type TestAdminDependencies } from "./admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";

describe("direct Admin access", () => {
  it("serves reads directly and leaves removed authentication routes unregistered", async () => {
    const harness = await createHarness();
    try {
      const status = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/status`));
      expect(status.status).toBe(200);
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(status.headers.has("set-cookie")).toBe(false);
      expect(await status.json()).toMatchObject({ data: { health: "ok" } });

      for (const [method, path, body] of [
        ["POST", "/admin/api/v1/auth/bootstrap", { token: "unused" }],
        ["GET", "/admin/api/v1/auth/session", undefined],
        ["POST", "/admin/api/v1/auth/logout", undefined],
      ] as const) {
        const response = await harness.gateway.fetch(new Request(`${ORIGIN}${path}`, {
          method,
          headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }));
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "not_found", message: "not found", requestId: "req_admin_access" },
        });
      }
    } finally {
      await harness.close();
    }
  });

  it("requires only the exact listener Origin for mutations", async () => {
    const harness = await createHarness();
    try {
      const mutations = [
        ["POST", "/admin/api/v1/device-flows", { host: "github.com" }, 201],
        ["DELETE", "/admin/api/v1/device-flows/flow-1", undefined, 200],
        ["DELETE", "/admin/api/v1/accounts/github.com%2F42", { expectedRevision: 3 }, 200],
        ["PUT", "/admin/api/v1/accounts/default", { accountId: "github.com/42", expectedRevision: 2 }, 200],
        ["POST", "/admin/api/v1/models/refresh", { accountId: "github.com/42" }, 200],
        ["PUT", "/admin/api/v1/models/preferred", {
          accountId: "github.com/42", modelId: "gpt-test", expectedRevision: 0,
        }, 200],
        ["POST", "/admin/api/v1/agents/apply", {
          agent: "claude", expectedRevision: "0".repeat(64), catalogRevision: "0".repeat(64),
          mappings: [{ displayName: "GPT Test", modelId: "gpt-test" }],
        }, 409],
        ["POST", "/admin/api/v1/agents/takeover", {
          agent: "codex", expectedRevision: "0".repeat(64), catalogRevision: "0".repeat(64),
          takeoverRevision: "0".repeat(64), mappings: [{ displayName: "GPT Test", modelId: "gpt-test" }],
        }, 409],
        ["PUT", "/admin/api/v1/config", {
          expectedRevision: 1, config: defaultRuntimeConfigSnapshot(),
        }, 200],
        ["DELETE", "/admin/api/v1/history", { expectedRevision: 0 }, 200],
      ] as const;

      for (const [method, path, body, acceptedStatus] of mutations) {
        for (const origin of [undefined, "http://localhost:31400", "http://127.0.0.1:9999"]) {
          const rejected = await mutate(harness.gateway, method, path, body, origin);
          expect(rejected.status, `${method} ${path} with ${origin ?? "missing Origin"}`).toBe(403);
        }
        const accepted = await mutate(harness.gateway, method, path, body, ORIGIN);
        expect(accepted.status, `${method} ${path} with exact Origin`).toBe(acceptedStatus);
        expect(accepted.headers.has("set-cookie")).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it("accepts the browser-canonical listener Origin on default HTTP port", async () => {
    const harness = await createHarness(80);
    try {
      const response = await harness.gateway.fetch(new Request("http://127.0.0.1/admin/api/v1/device-flows", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ host: "github.com" }),
      }));
      expect(response.status).toBe(201);
    } finally {
      await harness.close();
    }
  });

  it("uses each device-flow ID as the capability for direct poll and cancel", async () => {
    const harness = await createHarness();
    try {
      expect((await startFlow(harness.gateway, ORIGIN)).status).toBe(201);

      const poll = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows/flow-1`));
      expect(poll.status).toBe(200);
      expect(await poll.json()).toMatchObject({ data: { state: "pending" } });

      const cancel = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows/flow-1`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }));
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({ data: { state: "canceled" } });

      expect((await harness.gateway.fetch(new Request(
        `${ORIGIN}/admin/api/v1/device-flows/unknown`,
      ))).status).toBe(404);
      expect((await harness.gateway.fetch(new Request(
        `${ORIGIN}/admin/api/v1/device-flows/unknown`,
        { method: "DELETE", headers: { origin: ORIGIN } },
      ))).status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("reports a closed Admin module as not ready", async () => {
    const harness = await createHarness();
    try {
      harness.admin.close();
      harness.admin.close();
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/status`));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: { code: "not_ready", message: "not ready", requestId: "req_admin_access" },
      });
    } finally {
      await harness.close();
    }
  });
});

async function createHarness(port = 31_400): Promise<{
  readonly gateway: Gateway;
  readonly admin: AdminModule;
  readonly dependencies: TestAdminDependencies;
  readonly close: () => Promise<void>;
}> {
  const dependencies = adminDependencies();
  const admin = createAdminModule(dependencies);
  const gateway = await createGateway({
    startup: parseStartupConfig(["--port", String(port)], {}, { homedir: "Q:/tmp/admin-access" }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_access" });
  return { gateway, admin, dependencies, close: async () => gateway.close() };
}

async function startFlow(
  gateway: Gateway,
  origin: string | undefined,
): Promise<Response> {
  return await mutate(gateway, "POST", "/admin/api/v1/device-flows", { host: "github.com" }, origin);
}

async function mutate(
  gateway: Gateway,
  method: string,
  path: string,
  body: unknown,
  origin: string | undefined,
): Promise<Response> {
  return await gateway.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(origin === undefined ? {} : { origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
