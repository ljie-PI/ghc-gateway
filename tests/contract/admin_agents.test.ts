import { describe, expect, it } from "vitest";
import { createAdminModule } from "../../src/admin/routes.js";
import type { AdminModule } from "../../src/gateway/create_gateway.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import {
  AgentError,
  type AgentStatus,
  type AgentsManager,
} from "../../src/agents/types.js";
import { adminDependencies, login, type TestAdminDependencies } from "./admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";

function agentStatus(agent: "claude" | "codex", revision: string, state: AgentStatus["state"] = "not_managed"): AgentStatus {
  return {
    id: agent,
    state,
    revision,
    paths: agent === "claude" ? ["C:/home/.claude/settings.json"] : ["C:/home/.codex/ghcg-models.json", "C:/home/.codex/config.toml"],
    endpoint: agent === "claude" ? ORIGIN : `${ORIGIN}/v1`,
    backupAvailable: state !== "not_managed",
    lastAppliedAt: state === "installed" ? "2027-01-15T08:00:00.000Z" : null,
    mappings: [],
    canRestore: state === "installed",
  };
}

interface AgentStub {
  readonly manager: AgentsManager;
  readonly calls: string[];
  failApply: string | null;
}

function agentStub(): AgentStub {
  const calls: string[] = [];
  const revisions = { claude: "a".repeat(64), codex: "b".repeat(64) };
  const stub: AgentStub = {
    calls,
    failApply: null,
    manager: {
      async inspect(origin) {
        calls.push(`inspect:${origin}`);
        return [agentStatus("claude", revisions.claude), agentStatus("codex", revisions.codex)];
      },
      async apply(request, origin, models, assertCurrent, signal) {
        signal.throwIfAborted();
        calls.push(`apply:${request.agent}:${models.map((model) => model.modelId).join(",")}`);
        if (stub.failApply !== null) throw new AgentError(stub.failApply as never);
        assertCurrent();
        if (request.expectedRevision !== revisions[request.agent]) throw new AgentError("revision_conflict");
        return { ...agentStatus(request.agent, "c".repeat(64), "installed"), mappings: request.mappings };
      },
      async restore(request, _origin, signal) {
        signal.throwIfAborted();
        calls.push(`restore:${request.agent}`);
        if (request.expectedRevision !== revisions[request.agent]) throw new AgentError("revision_conflict");
        return agentStatus(request.agent, "d".repeat(64));
      },
      close() {},
    },
  };
  return stub;
}

async function createHarness(stub: AgentStub | null): Promise<{
  readonly gateway: Gateway;
  readonly admin: AdminModule;
  readonly dependencies: TestAdminDependencies;
  readonly close: () => Promise<void>;
}> {
  const dependencies = adminDependencies();
  let token = 0;
  const admin = createAdminModule({
    ...dependencies,
    ...(stub === null ? {} : { agents: stub.manager }),
    createToken: () => `agent-token-${++token}`,
  });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/admin-agents" }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_agents" });
  return { gateway, admin, dependencies, close: async () => gateway.close() };
}

const claudeMappings = [
  { displayName: "Sonnet", modelId: "gpt-test" },
  { displayName: "Opus", modelId: "gpt-test" },
  { displayName: "Haiku", modelId: "gpt-test" },
];

describe("Admin agents API", () => {
  it("serves agent status with the trusted listener origin and model catalog revision", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`, {
        headers: { cookie: session.cookie },
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { items: AgentStatus[]; catalogRevision: string | null; modelsAvailable: boolean } };
      expect(body.data.modelsAvailable).toBe(true);
      expect(body.data.catalogRevision).toMatch(/^[a-f0-9]{64}$/u);
      expect(body.data.items.map((item) => item.id)).toEqual(["claude", "codex"]);
      expect(body.data.items[0]).toMatchObject({ state: "not_managed", endpoint: ORIGIN, backupAvailable: false });
      expect(body.data.items[1]).toMatchObject({ endpoint: `${ORIGIN}/v1` });
      expect(stub.calls).toEqual([`inspect:${ORIGIN}`]);
    } finally {
      await harness.close();
    }
  });

  it("enforces session, Origin, CSRF and strict request schemas on mutations", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const session = await login(harness.gateway, harness.admin);
      const view = await (await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`, {
        headers: { cookie: session.cookie },
      }))).json() as { data: { catalogRevision: string } };
      const base = { agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: view.data.catalogRevision, mappings: claudeMappings };

      const noSession = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(base),
      }));
      expect(noSession.status).toBe(401);

      const noCsrf = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie }, body: JSON.stringify(base),
      }));
      expect(noCsrf.status).toBe(403);

      const wrongOrigin = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example", cookie: session.cookie, "x-ghcg-csrf": session.csrf },
        body: JSON.stringify(base),
      }));
      expect(wrongOrigin.status).toBe(403);

      const extraField = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie, "x-ghcg-csrf": session.csrf },
        body: JSON.stringify({ ...base, configDir: "C:/evil" }),
      }));
      expect(extraField.status).toBe(400);
      expect(await extraField.json()).toMatchObject({ error: { code: "validation_failed" } });

      const badModel = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie, "x-ghcg-csrf": session.csrf },
        body: JSON.stringify({ ...base, mappings: [{ displayName: "X", modelId: "has space" }] }),
      }));
      expect(badModel.status).toBe(400);
      expect(stub.calls.filter((call) => call.startsWith("apply:"))).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects stale catalog and agent revisions with 409 before touching configuration", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const session = await login(harness.gateway, harness.admin);
      const view = await (await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`, {
        headers: { cookie: session.cookie },
      }))).json() as { data: { catalogRevision: string } };
      const send = (body: unknown) => harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie, "x-ghcg-csrf": session.csrf },
        body: JSON.stringify(body),
      }));
      const staleCatalog = await send({ agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: "0".repeat(64), mappings: claudeMappings });
      expect(staleCatalog.status).toBe(409);
      const staleAgent = await send({ agent: "claude", expectedRevision: "9".repeat(64), catalogRevision: view.data.catalogRevision, mappings: claudeMappings });
      expect(staleAgent.status).toBe(409);
      expect(stub.calls.filter((call) => call.startsWith("apply:")).length).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("applies and restores through the manager and maps agent errors to sanitized statuses", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const session = await login(harness.gateway, harness.admin);
      const headers = { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie, "x-ghcg-csrf": session.csrf };
      const view = await (await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`, {
        headers: { cookie: session.cookie },
      }))).json() as { data: { catalogRevision: string } };

      const applied = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers, body: JSON.stringify({
          agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: view.data.catalogRevision, mappings: claudeMappings,
        }),
      }));
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({ data: { id: "claude", state: "installed", canRestore: true } });
      expect(stub.calls).toContain("apply:claude:gpt-test");
      expect(harness.dependencies.calls).toContain("agent-models");

      stub.failApply = "agent_conflict";
      const conflict = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers, body: JSON.stringify({
          agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: view.data.catalogRevision, mappings: claudeMappings,
        }),
      }));
      expect(conflict.status).toBe(409);
      const conflictBody = await conflict.text();
      expect(JSON.parse(conflictBody)).toMatchObject({ error: { code: "agent_conflict" } });
      expect(conflictBody).not.toContain("secret");
      stub.failApply = null;

      const restored = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/restore`, {
        method: "POST", headers, body: JSON.stringify({ agent: "codex", expectedRevision: "b".repeat(64) }),
      }));
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ data: { id: "codex", state: "not_managed" } });
      expect(stub.calls).toContain("restore:codex");

      const staleRestore = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/restore`, {
        method: "POST", headers, body: JSON.stringify({ agent: "codex", expectedRevision: "0".repeat(64) }),
      }));
      expect(staleRestore.status).toBe(409);
    } finally {
      await harness.close();
    }
  });

  it("restore works when the Copilot account is unavailable but apply does not", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const session = await login(harness.gateway, harness.admin);
      harness.dependencies.accounts.list = () => [];
      harness.dependencies.accounts.defaultState = () => ({ defaultRevision: 2, defaultAccountId: null });
      const headers = { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie, "x-ghcg-csrf": session.csrf };

      const view = await (await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`, {
        headers: { cookie: session.cookie },
      }))).json() as { data: { modelsAvailable: boolean; catalogRevision: string | null } };
      expect(view.data).toMatchObject({ modelsAvailable: false, catalogRevision: null });

      const applied = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers, body: JSON.stringify({
          agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: "0".repeat(64), mappings: claudeMappings,
        }),
      }));
      expect(applied.status).toBe(400);
      expect(await applied.json()).toMatchObject({ error: { code: "agent_models_unavailable" } });

      const restored = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/restore`, {
        method: "POST", headers, body: JSON.stringify({ agent: "claude", expectedRevision: "a".repeat(64) }),
      }));
      expect(restored.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("returns not_found when the agents manager is not configured", async () => {
    const harness = await createHarness(null);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`, {
        headers: { cookie: session.cookie },
      }));
      expect(response.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
