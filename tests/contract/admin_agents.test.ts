import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { adminDependencies, type TestAdminDependencies } from "./admin_test_harness.js";
import { AdminManagementApi } from "../../src/admin/api.js";
import { FileAgentsManager } from "../../src/agents/manager.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";

const ORIGIN = "http://127.0.0.1:31400";

function agentStatus(agent: "claude" | "codex", revision: string, state: AgentStatus["state"] = "not_managed"): AgentStatus {
  return {
    id: agent,
    state,
    revision,
    paths: agent === "claude" ? ["C:/home/.claude/settings.json"] : ["C:/home/.codex/models.json", "C:/home/.codex/config.toml"],
    endpoint: agent === "claude" ? ORIGIN : `${ORIGIN}/v1`,
    backupAvailable: state !== "not_managed",
    lastAppliedAt: state === "installed" ? "2027-01-15T08:00:00.000Z" : null,
    mappings: [],
    takeover: null,
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
      async takeover(request, origin, models, assertCurrent, signal) {
        calls.push(`takeover:${request.agent}:${request.takeoverRevision}`);
        return await this.apply(request, origin, models, assertCurrent, signal);
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
  const admin = createAdminModule({
    ...dependencies,
    ...(stub === null ? {} : { agents: stub.manager }),
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
  it("accepts strict content-free Codex takeover revisions", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const catalogResponse = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/models`));
      const catalog = await catalogResponse.json() as { data: { catalogRevision: string } };
      const body = {
        agent: "codex",
        expectedRevision: "b".repeat(64),
        catalogRevision: catalog.data.catalogRevision,
        takeoverRevision: "d".repeat(64),
        mappings: [{ displayName: "GPT Test", modelId: "gpt-test" }],
      };
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/takeover`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
      expect(stub.calls).toContain(`takeover:codex:${"d".repeat(64)}`);

      const extra = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/takeover`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ ...body, config: "secret" }),
      }));
      expect(extra.status).toBe(400);
      expect(await extra.json()).toMatchObject({ error: { code: "validation_failed" } });
    } finally { await harness.close(); }
  });
  it.each(["default", "fallback", "account", "credentials", "catalog"] as const)(
    "fences a concurrent %s revision change before durable Apply intent",
    async (change) => {
      const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-admin-agents-")));
      const dependencies = adminDependencies();
      const first = dependencies.accounts.list()[0]!;
      const second = { ...first, accountId: "github.com/43", userId: "43" };
      let accounts = change === "default" ? [first, second] : [first];
      let defaultState = change === "fallback"
        ? { defaultRevision: 2, defaultAccountId: null as string | null }
        : { defaultRevision: 2, defaultAccountId: first.accountId as string | null };
      let catalogCurrent = true;
      let stateDatabaseExistedAtBoundary = false;
      dependencies.accounts.list = () => accounts;
      dependencies.accounts.defaultState = () => defaultState;
      dependencies.accounts.bindAccount = async (accountId, signal) => {
        signal?.throwIfAborted();
        const account = accounts.find((candidate) => candidate.accountId === accountId);
        if (account === undefined) throw new Error("account not found");
        return {
          accountId,
          environment: resolveGitHubEnvironment(account.host),
          userId: account.userId,
          login: account.login,
          displayName: account.displayName,
          credentialGeneration: account.credentialGeneration!,
        };
      };
      dependencies.registry.isCurrent = () => catalogCurrent;
      const manager = new FileAgentsManager({
        home,
        checkpoint: (point) => {
          if (point !== "before_intent") return;
          stateDatabaseExistedAtBoundary = fs.existsSync(path.join(home, ".ghc-gateway", "agents", "codex", "state.db"));
          if (change === "default") defaultState = { defaultRevision: 3, defaultAccountId: second.accountId };
          if (change === "fallback") accounts = [first, second];
          if (change === "account") accounts = [{ ...first, revision: first.revision + 1 }];
          if (change === "credentials") accounts = [{ ...first, credentialGeneration: 5 }];
          if (change === "catalog") catalogCurrent = false;
        },
      });
      const api = new AdminManagementApi({ ...dependencies, agents: manager });
      try {
        const status = (await manager.inspect(ORIGIN)).find((item) => item.id === "codex")!;
        const catalog = await api.agentModels(new AbortController().signal);
        await expect(api.applyAgent({
          agent: "codex",
          expectedRevision: status.revision,
          catalogRevision: catalog.catalogRevision,
          mappings: [{ displayName: "GPT Test", modelId: "gpt-test" }],
        }, ORIGIN, new AbortController().signal)).rejects.toMatchObject({ code: "revision_conflict" });

        expect(stateDatabaseExistedAtBoundary).toBe(false);
        expect(fs.existsSync(path.join(home, ".ghc-gateway", "agents", "codex", "state.db"))).toBe(false);
        expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
      } finally {
        manager.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.each(["default", "revision", "ambiguous", "credentials"] as const)("rejects catalog choices after concurrent %s changes", async (change) => {
    const dependencies = adminDependencies();
    const initialAccounts = dependencies.accounts.list();
    const get = dependencies.registry.get;
    const bind = dependencies.accounts.bindAccount;
    let generation = 4;
    dependencies.accounts.bindAccount = async (...args) => ({ ...await bind(...args), credentialGeneration: generation });
    if (change === "ambiguous") dependencies.accounts.defaultState = () => ({ defaultRevision: 2, defaultAccountId: null });
    let release = (): void => undefined;
    let started = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    dependencies.registry.get = async (...args) => { started(); await held; return await get(...args); };
    const api = new AdminManagementApi({ ...dependencies, agents: agentStub().manager });
    const pending = api.agentModels(new AbortController().signal);
    await entered;
    if (change === "default") dependencies.accounts.defaultState = () => ({ defaultRevision: 3, defaultAccountId: "github.com/43" });
    if (change === "revision") dependencies.accounts.list = () => initialAccounts.map((account) => ({ ...account, revision: account.revision + 1 }));
    if (change === "ambiguous") dependencies.accounts.list = () => [...initialAccounts, { ...initialAccounts[0]!, accountId: "github.com/43", userId: "43" }];
    if (change === "credentials") generation = 5;
    const rejected = expect(pending).rejects.toMatchObject({ code: "revision_conflict" });
    release();
    await rejected;
  });

  it("returns local configuration while a model catalog is still pending", async () => {
    const dependencies = adminDependencies();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const get = dependencies.registry.get;
    dependencies.registry.get = async (...args) => { await gate; return await get(...args); };
    let completed = false;
    const pending = new AdminManagementApi({ ...dependencies, agents: agentStub().manager })
      .agents(ORIGIN, new AbortController().signal).then((result) => { completed = true; return result; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(true);
    } finally {
      release();
      await pending;
    }
  });
  it("serves local agent status and shared catalog metadata independently", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`));
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { items: AgentStatus[] } };
      expect(body.data.items.map((item) => item.id)).toEqual(["claude", "codex"]);
      expect(body.data.items[0]).toMatchObject({ state: "not_managed", endpoint: ORIGIN, backupAvailable: false });
      expect(body.data.items[1]).toMatchObject({ endpoint: `${ORIGIN}/v1` });
      expect(stub.calls).toEqual([`inspect:${ORIGIN}`]);
      expect(harness.dependencies.calls.some((call) => call.startsWith("catalog:"))).toBe(false);
      const catalogResponse = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/models`));
      expect(catalogResponse.status).toBe(200);
      expect(await catalogResponse.json()).toMatchObject({ data: {
        catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        usableModelIds: ["gpt-test"],
        items: [{ id: "gpt-test", name: "GPT Test", capabilities: { reasoningLevels: [] } }],
      } });
    } finally {
      await harness.close();
    }
  });

  it("enforces exact Origin and strict request schemas on mutations", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const view = await (await harness.gateway.fetch(new Request(
        `${ORIGIN}/admin/api/v1/agents/models`,
      ))).json() as { data: { catalogRevision: string } };
      const base = { agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: view.data.catalogRevision, mappings: claudeMappings };

      const missingOrigin = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base),
      }));
      expect(missingOrigin.status).toBe(403);

      const wrongOrigin = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify(base),
      }));
      expect(wrongOrigin.status).toBe(403);

      const accepted = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(base),
      }));
      expect(accepted.status).toBe(200);

      const extraField = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ ...base, configDir: "C:/evil" }),
      }));
      expect(extraField.status).toBe(400);
      expect(await extraField.json()).toMatchObject({ error: { code: "validation_failed" } });

      const badModel = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ ...base, mappings: [{ displayName: "X", modelId: "has space" }] }),
      }));
      expect(badModel.status).toBe(400);
      expect(stub.calls.filter((call) => call.startsWith("apply:"))).toEqual(["apply:claude:gpt-test"]);
    } finally {
      await harness.close();
    }
  });

  it("rejects stale catalog and agent revisions with 409 before touching configuration", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const view = await (await harness.gateway.fetch(new Request(
        `${ORIGIN}/admin/api/v1/agents/models`,
      ))).json() as { data: { catalogRevision: string } };
      const send = (body: unknown) => harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
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

  it("applies through the manager, removes Restore and maps errors to sanitized statuses", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      const headers = { "content-type": "application/json", origin: ORIGIN };
      const view = await (await harness.gateway.fetch(new Request(
        `${ORIGIN}/admin/api/v1/agents/models`,
      ))).json() as { data: { catalogRevision: string } };

      const applied = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers, body: JSON.stringify({
          agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: view.data.catalogRevision, mappings: claudeMappings,
        }),
      }));
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({ data: { id: "claude", state: "installed" } });
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
      expect(restored.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("inspection works without an account while catalog and Apply report unavailability", async () => {
    const stub = agentStub();
    const harness = await createHarness(stub);
    try {
      harness.dependencies.accounts.list = () => [];
      harness.dependencies.accounts.defaultState = () => ({ defaultRevision: 2, defaultAccountId: null });
      const headers = { "content-type": "application/json", origin: ORIGIN };

      const view = await (await harness.gateway.fetch(new Request(
        `${ORIGIN}/admin/api/v1/agents`,
      ))).json() as { data: { items: AgentStatus[] } };
      expect(view.data.items).toHaveLength(2);
      const unavailable = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/models`, { headers }));
      expect(unavailable.status).toBe(400);
      expect(await unavailable.json()).toMatchObject({ error: { code: "agent_models_unavailable" } });

      const applied = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents/apply`, {
        method: "POST", headers, body: JSON.stringify({
          agent: "claude", expectedRevision: "a".repeat(64), catalogRevision: "0".repeat(64), mappings: claudeMappings,
        }),
      }));
      expect(applied.status).toBe(400);
      expect(await applied.json()).toMatchObject({ error: { code: "agent_models_unavailable" } });

    } finally {
      await harness.close();
    }
  });

  it("returns not_found when the agents manager is not configured", async () => {
    const harness = await createHarness(null);
    try {
      const response = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/agents`));
      expect(response.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
