import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentsManager, type AgentManagerOptions } from "../../src/agents/manager.js";
import type { AgentId, AgentMapping } from "../../src/agents/types.js";

const homes: string[] = [];
const origin = "http://127.0.0.1:32567";
const models = ["model-a", "model-b", "model-c"].map((modelId) => ({ modelId, maxInputTokens: 32000 }));
const mappings = models.map((model) => ({ displayName: `Label ${model.modelId}`, modelId: model.modelId }));
function harness(options: Omit<AgentManagerOptions, "home"> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-"));
  homes.push(home);
  const manager = new FileAgentsManager({ home, now: () => new Date("2026-01-02T03:04:05Z"), ...options });
  const status = async (agent: AgentId) => (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return { home, manager, status };
}
async function apply(manager: FileAgentsManager, agent: AgentId, rows: readonly AgentMapping[] = mappings) {
  const status = (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return await manager.apply({ agent, expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings: rows }, origin, models, () => undefined, new AbortController().signal);
}
async function restore(manager: FileAgentsManager, agent: AgentId) {
  const status = (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return await manager.restore({ agent, expectedRevision: status.revision }, origin, new AbortController().signal);
}
function seed(home: string, target: string, bytes: Buffer | string): string {
  const file = path.join(home, target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

describe("private reversible agent configuration", () => {
  it("queries shared external inspect paths once without writing client or recovery files", async () => {
    const home = fs.realpathSync.native(homeWithCrash());
    const parent = path.join(home, ".clients");
    const files = [
      seed(home, ".clients/settings.json", "{}"),
      seed(home, ".clients/ghcg-models.json", "{}"),
      seed(home, ".clients/config.toml", "model = \"old\"\n"),
    ];
    const calls: string[][] = [];
    const manager = new FileAgentsManager({
      home, env: { CLAUDE_CONFIG_DIR: parent, CODEX_HOME: parent },
      inspectCommand: async (_file, _args, options) => {
        const targets = Buffer.from(options.env!.GHCG_SECURITY_PATHS!, "base64").toString("utf8").split("\0");
        calls.push(targets);
        expect(options).toMatchObject({ timeout: 10000, shell: false });
        return { stdout: targets.map((target) => JSON.stringify([target, false, "O:SYG:SYD:PAI(A;;FA;;;SY)"])).join("\r\n") };
      },
    });
    const statuses = await manager.inspect(origin);
    const expected = [parent, ...files].map((target) => process.platform === "win32" ? target.toLowerCase() : target);
    expect(calls).toEqual([expected]);
    expect(statuses.map(({ id, state }) => [id, state])).toEqual([["claude", "not_managed"], ["codex", "not_managed"]]);
    expect(fs.readdirSync(home)).toEqual([".clients"]);
    expect(files.map((target) => fs.readFileSync(target, "utf8"))).toEqual(["{}", "{}", "model = \"old\"\n"]);
  });

  it.each(["reparse", "query failure", "replacement"] as const)("isolates %s during inspect to the affected client", async (failure) => {
    const home = fs.realpathSync.native(homeWithCrash());
    const claude = seed(home, ".claude/settings.json", "{}");
    seed(home, ".codex/config.toml", "model = \"old\"\n");
    let commands = 0;
    const manager = new FileAgentsManager({ home, inspectCommand: async (_file, _args, options) => {
      commands += 1;
      const targets = Buffer.from(options.env!.GHCG_SECURITY_PATHS!, "base64").toString("utf8").split("\0");
      if (failure === "replacement") {
        fs.renameSync(claude, claude + ".saved");
        fs.writeFileSync(claude, "replacement", { mode: 0o600 });
      }
      return { stdout: targets.map((target) => {
        if (target.toLowerCase() === claude.toLowerCase()) {
          if (failure === "query failure") return JSON.stringify([target, null, null]);
          if (failure === "reparse") return JSON.stringify([target, true, ""]);
        }
        return JSON.stringify([target, false, "O:SYG:SYD:PAI(A;;FA;;;SY)"]);
      }).join("\n") };
    } });
    const statuses = await manager.inspect(origin);
    expect(commands).toBe(1);
    expect(statuses[0]).toMatchObject({ id: "claude", state: failure === "replacement" ? "recovery_required" : "unsafe_path", revision: "0".repeat(64) });
    expect(statuses[1]).toMatchObject({ id: "codex", state: "not_managed" });
  });

  it("does not accept newly appearing targets or reuse a previous inspect result", async () => {
    const home = fs.realpathSync.native(homeWithCrash());
    let commands = 0;
    const manager = new FileAgentsManager({ home, inspectCommand: async (_file, _args, options) => {
      commands += 1;
      const targets = Buffer.from(options.env!.GHCG_SECURITY_PATHS!, "base64").toString("utf8").split("\0");
      if (commands === 1) seed(home, ".claude/settings.json", "{}");
      return { stdout: targets.map((target) => JSON.stringify([target, false, "O:SYG:SYD:PAI(A;;FA;;;SY)"])).join("\n") };
    } });
    expect((await manager.inspect(origin))[0]!.revision).toBe("0".repeat(64));
    expect((await manager.inspect(origin))[0]).toMatchObject({ state: "not_managed" });
    expect(commands).toBe(2);
  });

  it("reads without creating any directories and rejects invalid parsing before writes", async () => {
    const h = harness();
    expect((await h.status("codex")).state).toBe("not_managed");
    expect(fs.readdirSync(h.home)).toEqual([]);
    seed(h.home, ".codex/config.toml", "token=\"secret\n");
    await expect(apply(h.manager, "codex")).rejects.toThrow("agent invalid config");
    expect(fs.readdirSync(h.home)).toEqual([".codex"]);
  }, 180_000);

  it("round-trips exact original Claude bytes through A -> B -> C -> Restore A", async () => {
    const h = harness();
    const original = Buffer.from("\ufeff{\r\n  \"hooks\": {\"Stop\": []}, \"env\": {\"OTHER\":\"untouched\"}\r\n}\r\n");
    const file = seed(h.home, ".claude/settings.json", original);
    seed(h.home, ".claude/.credentials.json", "login-secret");
    expect((await apply(h.manager, "claude")).state).toBe("installed");
    const first = await h.status("claude");
    expect(first.lastAppliedAt).toBe("2026-01-02T03:04:05.000Z");
    expect((await apply(h.manager, "claude", [...mappings].reverse())).state).toBe("installed");
    await expect(h.manager.restore({ agent: "claude", expectedRevision: first.revision }, origin, new AbortController().signal)).rejects.toThrow("revision conflict");
    expect((await restore(h.manager, "claude")).state).toBe("not_managed");
    expect(fs.readFileSync(file)).toEqual(original);
    expect(fs.readFileSync(path.join(h.home, ".claude/.credentials.json"), "utf8")).toBe("login-secret");
  }, 300_000);

  it("restores absent Codex config/catalog and retains auth.json; first baseline survives reapply/restart", async () => {
    const h = harness();
    const auth = seed(h.home, ".codex/auth.json", "login-secret");
    expect((await apply(h.manager, "codex")).state).toBe("installed");
    const restarted = new FileAgentsManager({ home: h.home });
    expect((await apply(restarted, "codex", [...mappings].reverse())).state).toBe("installed");
    const value = JSON.parse(fs.readFileSync(path.join(h.home, ".codex/ghcg-models.json"), "utf8"));
    expect(value.models.map((row: { slug: string }) => row.slug)).toEqual([...models].reverse().map((row) => row.modelId));
    expect((await restore(restarted, "codex")).state).toBe("not_managed");
    expect(fs.readdirSync(path.join(h.home, ".codex"))).toEqual(["auth.json"]);
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret");
  }, 300_000);

  it("reports outside edits as conflict and never overwrites them", async () => {
    const h = harness();
    const original = seed(h.home, ".claude/settings.json", JSON.stringify({ env: { OTHER: "keep" } }));
    await apply(h.manager, "claude");
    const external = Buffer.from(JSON.stringify({ env: { OTHER: "external-edit" } }));
    fs.writeFileSync(original, external);
    expect((await h.status("claude")).state).toBe("conflict");
    await expect(apply(h.manager, "claude")).rejects.toThrow("agent conflict");
    await expect(restore(h.manager, "claude")).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(original)).toEqual(external);
  }, 180_000);

  it("revalidates the live file after staging and before rename", async () => {
    const home = homeWithCrash();
    const original = seed(home, ".claude/settings.json", JSON.stringify({ env: { OTHER: "keep" } }));
    const external = Buffer.from(JSON.stringify({ env: { OTHER: "raced" } }));
    const manager = new FileAgentsManager({
      home,
      checkpoint: (point, agent, index) => {
        if (point === "staged" && agent === "claude" && index === 0) fs.writeFileSync(original, external);
      },
    });
    await expect(apply(manager, "claude")).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(original)).toEqual(external);
  }, 180_000);

  it("serializes concurrent applies from two Gateway instances sharing a home", async () => {
    const h = harness();
    const second = new FileAgentsManager({ home: h.home });
    const reversed = [...mappings].reverse();
    const firstStatus = await h.status("claude");
    const [one, two] = await Promise.allSettled([
      h.manager.apply({ agent: "claude", expectedRevision: firstStatus.revision, catalogRevision: "a".repeat(64), mappings }, origin, models, () => undefined, new AbortController().signal),
      second.apply({ agent: "claude", expectedRevision: firstStatus.revision, catalogRevision: "a".repeat(64), mappings: reversed }, origin, models, () => undefined, new AbortController().signal),
    ]);
    const outcomes = [one, two];
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ name: "AgentError" });
    const live = JSON.parse(fs.readFileSync(path.join(h.home, ".claude/settings.json"), "utf8"));
    const winner = one.status === "fulfilled" ? mappings : reversed;
    expect(live.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(winner[0]!.modelId);
    expect((await restore(h.manager, "claude")).state).toBe("not_managed");
  }, 300_000);

  it.each([
    ["intent", -1],
    ["linked", 0],
    ["published", 0],
    ["displaced", 1],
  ] as const)("recovers original Codex bytes after a crash at %s", async (point, index) => {
    const original = Buffer.from("model = \"old\"\n# comment survives\n");
    const file = seed(homeWithCrash(), ".codex/config.toml", original);
    const crashed = new FileAgentsManager({
      home: homes.at(-1)!,
      now: () => new Date("2026-01-02T03:04:05Z"),
      checkpoint: (hitPoint, _agent, hitIndex) => {
        if (hitPoint === point && hitIndex === index) throw new Error("simulated crash");
      },
    });
    await expect(apply(crashed, "codex")).rejects.toThrow();
    const restarted = new FileAgentsManager({ home: homes.at(-1)! });
    expect((await restarted.inspect(origin)).find((item) => item.id === "codex")!.state).toBe("recovery_required");
    const status = await restarted.inspect(origin);
    await expect(restarted.apply({ agent: "codex", expectedRevision: status.find((item) => item.id === "codex")!.revision,
      catalogRevision: "a".repeat(64), mappings }, origin, models, () => undefined, new AbortController().signal)).rejects.toThrow("recovery required");
    const restored = await restarted.restore({ agent: "codex", expectedRevision: status.find((item) => item.id === "codex")!.revision }, origin, new AbortController().signal);
    expect(restored.state).toBe("not_managed");
    expect(fs.readFileSync(file)).toEqual(original);
    expect(fs.readdirSync(path.join(homes.at(-1)!, ".codex"))).toEqual(["config.toml"]);
  }, 300_000);

  it("rejects symlinked configuration directories without writing", async () => {
    const h = harness();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-elsewhere-"));
    homes.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(h.home, ".claude"), process.platform === "win32" ? "junction" : "dir");
    await expect(apply(h.manager, "claude")).rejects.toThrow("agent unsafe path");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  }, 180_000);

  it.skipIf(process.platform === "win32")("accepts a canonicalized home alias but still rejects links below it", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-alias-"));
    homes.push(parent);
    const realHome = path.join(parent, "real-home");
    const aliasHome = path.join(parent, "alias-home");
    const elsewhere = path.join(parent, "elsewhere");
    fs.mkdirSync(realHome, { mode: 0o700 });
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(realHome, aliasHome, "dir");
    const manager = new FileAgentsManager({ home: aliasHome });
    expect((await manager.inspect(origin)).find((item) => item.id === "claude")!.state).toBe("not_managed");
    fs.symlinkSync(elsewhere, path.join(realHome, ".claude"), "dir");
    await expect(apply(manager, "claude")).rejects.toThrow("agent unsafe path");
  }, 180_000);

  it.skipIf(process.platform === "win32")("rejects world-readable recovery state", async () => {
    const h = harness();
    await apply(h.manager, "claude");
    fs.chmodSync(path.join(h.home, ".ghc-gateway-agents/claude/state.db"), 0o644);
    expect((await h.status("claude")).state).toBe("unsafe_path");
  }, 180_000);
});

function homeWithCrash(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-"));
  homes.push(home);
  return home;
}
