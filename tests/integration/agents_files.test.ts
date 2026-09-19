import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { FileAgentsManager, type AgentManagerOptions } from "../../src/agents/manager.js";
import { AgentError, type AgentId, type AgentMapping, type AgentModel } from "../../src/agents/types.js";
import { AgentStore, type AgentState } from "../../src/agents/store.js";
import { privateDirectory, protect, readImage } from "../../src/agents/files.js";
import { queryWindowsSecuritySnapshot, type WindowsSecuritySnapshotFact, type WindowsSecuritySnapshotRequest } from "../../src/security/windows_security_snapshot.js";
import { projectAgentConfigFixture } from "../../scripts/tooling/fixtures.js";

const homes: string[] = [];
const origin = "http://127.0.0.1:32567";
let windowsAclWarmup: Promise<void> | undefined;
const execFileAsync = promisify(execFile);
const effective = <T>(value: T) => ({ value, source: "live" as const, conflict: false, liveState: "value" as const });
const models: readonly AgentModel[] = ["model-a", "model-b", "model-c"].map((modelId) => ({
  modelId,
  protocols: effective(["responses"] as const),
  capabilities: {
    contextWindowTokens: 32000,
    maxContextWindowTokens: 32000,
    reasoningLevels: [],
    reasoningProtocols: [],
    inputModalities: ["text"],
    toolCalling: false,
    parallelToolCalling: false,
    reasoningSummaries: false,
    verbosity: false,
    search: false,
  },
}));
const mappings = models.map((model) => ({ displayName: `Label ${model.modelId}`, modelId: model.modelId }));
function harness(options: Omit<AgentManagerOptions, "home"> = {}) {
  // Legacy images use the same canonical home anchor as the production manager.
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-")));
  homes.push(home);
  const manager = new FileAgentsManager({ home, now: () => new Date("2026-01-02T03:04:05Z"), ...options });
  const status = async (agent: AgentId) => (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return { home, manager, status };
}
function stateRoot(home: string, dataDir = path.join(home, ".ghc-gateway")): string {
  return path.join(dataDir, "agents");
}
function legacyStateRoot(home: string): string {
  return path.join(home, ".ghc-gateway-agents");
}
async function saveState(root: string, agent: AgentId, state: AgentState): Promise<void> {
  await new AgentStore(root, agent).locked(async (save) => save(state));
}
async function writeMigrationMarker(file: string, target: string, phase: "pending" | "complete" = "pending"): Promise<void> {
  fs.writeFileSync(file, "", { mode: 0o600 });
  protect(file);
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE migration(target TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pending','complete'))); CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
    db.prepare("INSERT INTO migration VALUES(?,?)").run(target, phase);
    db.prepare("INSERT INTO state VALUES(1,?)").run(JSON.stringify({ migratedTo: target }));
  } finally { db.close(); }
}
async function apply(
  manager: FileAgentsManager,
  agent: AgentId,
  rows: readonly AgentMapping[] = mappings,
  available: readonly AgentModel[] = models,
) {
  const status = (await manager.inspect(origin)).find((item) => item.id === agent)!;
  return await manager.apply({ agent, expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings: rows }, origin, available, () => undefined, new AbortController().signal);
}
async function takeover(
  manager: FileAgentsManager,
  rows: readonly AgentMapping[] = mappings,
  available: readonly AgentModel[] = models,
) {
  const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
  if (status.takeover === null) throw new Error("Codex takeover is unavailable");
  return await manager.takeover({
    agent: "codex",
    expectedRevision: status.revision,
    catalogRevision: "a".repeat(64),
    takeoverRevision: status.takeover.revision,
    mappings: rows,
  }, origin, available, () => undefined, new AbortController().signal);
}
function seed(home: string, target: string, bytes: Buffer | string): string {
  const file = path.join(home, target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
async function stableSeed(home: string, target: string, bytes: Buffer | string): Promise<string> {
  const file = seed(home, target, bytes);
  protect(file);
  if (await readImage(file) === null) throw new Error("stable Agent test seed is unavailable");
  return file;
}
async function warmWindowsAgentAcl(): Promise<void> {
  if (process.platform !== "win32") return;
  windowsAclWarmup ??= Promise.resolve().then(() => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Import-Module \"$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\"; Get-Acl -LiteralPath $PSHOME | Out-Null",
      ], { windowsHide: true, timeout: 60_000, stdio: "ignore" });
    } catch {
      throw new Error("Windows Agent ACL test warm-up failed");
    }
  });
  await windowsAclWarmup;
}
beforeAll(warmWindowsAgentAcl, 90_000);
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

describe("private repeatable agent configuration", () => {
  it("stores default and custom Agent state under the selected data directory", async () => {
    const defaults = harness();
    await apply(defaults.manager, "claude");
    expect(fs.existsSync(path.join(stateRoot(defaults.home), "claude", "state.db"))).toBe(true);
    await expect(new AgentStore(legacyStateRoot(defaults.home), "claude").read())
      .rejects.toMatchObject({ code: "agent_recovery_required" });

    const customHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-custom-")));
    homes.push(customHome);
    const customDataDir = path.join(customHome, "custom-data");
    const custom = harness({ dataDir: customDataDir });
    await apply(custom.manager, "codex");
    expect(fs.existsSync(path.join(customDataDir, "agents", "codex", "state.db"))).toBe(true);
    expect(fs.existsSync(path.join(custom.home, ".ghc-gateway", "agents", "codex", "state.db"))).toBe(false);
    await expect(new AgentStore(legacyStateRoot(custom.home), "codex").read())
      .rejects.toMatchObject({ code: "agent_recovery_required" });

    const separatedHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-separated-")));
    homes.push(separatedHome);
    const codexHome = path.join(separatedHome, "separate-codex-home");
    const separated = new FileAgentsManager({
      home: separatedHome,
      dataDir: path.join(separatedHome, "selected-data"),
      env: { CODEX_HOME: codexHome },
    });
    const separatedStatus = (await separated.inspect(origin)).find((item) => item.id === "codex")!;
    expect(separatedStatus.paths).toEqual([path.join(codexHome, "models.json"), path.join(codexHome, "config.toml")]
      .map((target) => process.platform === "win32" ? target.toLowerCase() : target));
    seed(separatedHome, "separate-codex-home/config.toml", "model = \"external\"\n");
    seed(separatedHome, "separate-codex-home/models.json", "native catalog\n");
    expect((await takeover(separated)).state).toBe("installed");
    expect(fs.existsSync(path.join(codexHome, "models.json.ghcg.bak"))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, "config.toml.ghcg.bak"))).toBe(true);
    expect(fs.existsSync(path.join(separatedHome, "selected-data", "agents", "codex", "state.db"))).toBe(true);
  }, 180_000);

  it("migrates complete legacy state and retires its writable authority", async () => {
    const h = harness();
    const config = path.join(h.home, ".codex", "config.toml");
    const catalog = path.join(h.home, ".codex", "models.json");
    const original = { bytes: Buffer.from("original").toString("base64"), mode: 0o600, acl: null };
    const expected = { bytes: Buffer.from("expected").toString("base64"), mode: 0o600, acl: null };
    const state = {
      version: 3 as const,
      revision: 7,
      mappings: [mappings[0]!],
      lastAppliedAt: "2026-01-02T03:04:05.000Z",
      targets: [
        { path: `${config}.ghcg.bak`, original: null, expected: original },
        { path: `${catalog}.ghcg.bak`, original: null, expected: original },
        { path: catalog, original: null, expected },
        { path: config, original, expected },
      ],
      pending: {
        kind: "apply" as const,
        garbage: [path.join(h.home, ".codex", ".ghcg-agents-codex-00000000-0000-4000-8000-000000000002")],
        steps: [{
          target: 3,
          before: original,
          after: expected,
          phase: "planned" as const,
          scratch: path.join(h.home, ".codex", ".ghcg-agents-codex-00000000-0000-4000-8000-000000000001"),
        }],
      },
    };
    await saveState(legacyStateRoot(h.home), "codex", state);

    await h.manager.inspect(origin);
    expect(await new AgentStore(stateRoot(h.home), "codex").read()).toEqual(state);
    expect(fs.existsSync(path.join(legacyStateRoot(h.home), "codex", "state.db.migrated"))).toBe(true);
    const marker = new DatabaseSync(path.join(legacyStateRoot(h.home), "codex", "state.db"), { readOnly: true });
    try {
      expect(marker.prepare("SELECT target FROM migration").get()).toEqual({
        target: path.join(stateRoot(h.home), "codex", "state.db"),
      });
      expect(() => JSON.parse((marker.prepare("SELECT document FROM state WHERE id=1").get() as { document: string }).document))
        .not.toThrow();
    } finally { marker.close(); }
    await expect(new AgentStore(legacyStateRoot(h.home), "codex").read())
      .rejects.toMatchObject({ code: "agent_recovery_required" });
  }, 180_000);

  it("accepts equivalent dual state and fails closed for conflicting dual state", async () => {
    const equivalent = harness();
    const state = { version: 2 as const, revision: 4, mappings: [mappings[0]!], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(equivalent.home), "codex", state);
    await saveState(stateRoot(equivalent.home), "codex", structuredClone(state));
    expect((await equivalent.status("codex")).mappings).toEqual(state.mappings);
    expect(fs.existsSync(path.join(legacyStateRoot(equivalent.home), "codex", "state.db.migrated"))).toBe(true);

    const conflict = harness();
    await saveState(legacyStateRoot(conflict.home), "codex", state);
    await saveState(stateRoot(conflict.home), "codex", { ...state, revision: 5 });
    expect(await conflict.status("codex")).toMatchObject({ state: "recovery_required", mappings: [] });
    expect(fs.existsSync(path.join(legacyStateRoot(conflict.home), "codex", "state.db.migrated"))).toBe(false);
  }, 180_000);

  it("converges concurrent migration and remains restart-safe", async () => {
    const h = harness();
    const state = { version: 2 as const, revision: 9, mappings: [mappings[1]!], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(h.home), "codex", state);
    const one = new FileAgentsManager({ home: h.home });
    const two = new FileAgentsManager({ home: h.home });
    const results = await Promise.allSettled([one.inspect(origin), two.inspect(origin)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const restarted = new FileAgentsManager({ home: h.home });
    expect((await restarted.inspect(origin)).find((item) => item.id === "codex")).toMatchObject({
      state: "not_managed",
      mappings: state.mappings,
    });
    expect(await new AgentStore(stateRoot(h.home), "codex").read()).toEqual(state);
  }, 180_000);

  it("recovers migration interruptions before marker and before new-state publication", async () => {
    for (const phase of ["copied", "retired", "marked", "published"] as const) {
      const h = harness();
      const state = { version: 2 as const, revision: phase === "copied" ? 10 : phase === "retired" ? 11 : phase === "marked" ? 12 : 13, mappings: [mappings[0]!], targets: [], lastAppliedAt: null, pending: null };
      const legacyDirectory = path.join(legacyStateRoot(h.home), "codex");
      const legacyState = path.join(legacyDirectory, "state.db");
      const retired = `${legacyState}.migrated`;
      const current = path.join(stateRoot(h.home), "codex", "state.db");
      await saveState(legacyStateRoot(h.home), "codex", state);
      if (phase === "copied") {
        fs.copyFileSync(legacyState, retired);
        protect(retired);
      } else fs.renameSync(legacyState, retired);
      if (phase !== "retired") await writeMigrationMarker(legacyState, current);
      if (phase === "published") await saveState(stateRoot(h.home), "codex", structuredClone(state));

      const manager = new FileAgentsManager({ home: h.home });
      expect((await manager.inspect(origin)).find((item) => item.id === "codex")?.mappings).toEqual(state.mappings);
      expect(await new AgentStore(stateRoot(h.home), "codex").read()).toEqual(state);
      expect(fs.existsSync(legacyState)).toBe(true);
      expect(fs.existsSync(retired)).toBe(true);
    }
  }, 180_000);

  it("recovers a complete fence before the first current-state save", async () => {
    const h = harness();
    const legacyState = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const current = path.join(stateRoot(h.home), "codex", "state.db");
    await saveState(legacyStateRoot(h.home), "codex", {
      version: 2, revision: 0, mappings: [], targets: [], lastAppliedAt: null, pending: null,
    });
    fs.unlinkSync(legacyState);
    await writeMigrationMarker(legacyState, current, "complete");
    const manager = new FileAgentsManager({ home: h.home });
    expect((await manager.inspect(origin)).find((item) => item.id === "codex")).toMatchObject({ state: "not_managed" });
    await apply(manager, "codex");
    expect(fs.existsSync(current)).toBe(true);
    await expect(new AgentStore(legacyStateRoot(h.home), "codex").read())
      .rejects.toMatchObject({ code: "agent_recovery_required" });
  }, 180_000);

  it("cleans private migration temporaries while recovering", async () => {
    const h = harness();
    const state = { version: 2 as const, revision: 14, mappings: [mappings[1]!], targets: [], lastAppliedAt: null, pending: null };
    const legacyState = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const retired = `${legacyState}.migrated`;
    const current = path.join(stateRoot(h.home), "codex", "state.db");
    await saveState(legacyStateRoot(h.home), "codex", state);
    fs.renameSync(legacyState, retired);
    fs.writeFileSync(`${legacyState}.marker`, "stale", { mode: 0o600 });
    await privateDirectory(path.dirname(stateRoot(h.home)));
    await privateDirectory(stateRoot(h.home));
    await privateDirectory(path.dirname(current));
    fs.writeFileSync(`${current}.migrating`, "stale", { mode: 0o600 });
    protect(`${legacyState}.marker`);
    protect(`${current}.migrating`);

    expect((await new FileAgentsManager({ home: h.home }).inspect(origin)).find((item) => item.id === "codex")?.mappings)
      .toEqual(state.mappings);
    expect(fs.existsSync(`${legacyState}.marker`)).toBe(false);
    expect(fs.existsSync(`${current}.migrating`)).toBe(false);
  }, 180_000);

  it("serializes legacy migration across separate processes", async () => {
    const h = harness();
    const dataDir = path.join(h.home, ".ghc-gateway");
    const state = { version: 2 as const, revision: 13, mappings: [mappings[2]!], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(h.home), "codex", state);
    const run = () => execFileAsync(process.execPath, [
      "scripts/tooling/bootstrap.mjs",
      "tests/fixtures/agent_state_migration_contender.ts",
      h.home,
      dataDir,
    ], { cwd: path.resolve(import.meta.dirname, "../.."), windowsHide: true, timeout: 60_000 });
    const [one, two] = await Promise.all([run(), run()]);
    expect([one.stdout.trim(), two.stdout.trim()]).toEqual(["13", "13"]);
    expect(await new AgentStore(stateRoot(h.home), "codex").read()).toEqual(state);
  }, 180_000);

  it.skipIf(process.platform === "win32")("rejects an unsafe legacy state root", async () => {
    const h = harness();
    const state = { version: 2 as const, revision: 1, mappings: [], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(h.home), "codex", state);
    fs.chmodSync(legacyStateRoot(h.home), 0o755);
    expect(await h.status("codex")).toMatchObject({ state: "unsafe_path", mappings: [] });
  });

  it.skipIf(process.platform === "win32")("rejects a linked legacy state root", async () => {
    const h = harness();
    const real = path.join(h.home, "real-legacy");
    await saveState(real, "codex", { version: 2, revision: 1, mappings: [], targets: [], lastAppliedAt: null, pending: null });
    fs.symlinkSync(real, legacyStateRoot(h.home), "dir");
    expect(await h.status("codex")).toMatchObject({ state: "unsafe_path", mappings: [] });
  });

  it("rejects a hard-linked legacy state database", async () => {
    const h = harness();
    const state = { version: 2 as const, revision: 1, mappings: [], targets: [], lastAppliedAt: null, pending: null };
    await saveState(legacyStateRoot(h.home), "codex", state);
    const legacyState = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const alias = path.join(h.home, "state-alias.db");
    fs.linkSync(legacyState, alias);
    expect(await h.status("codex")).toMatchObject({ state: "unsafe_path", mappings: [] });
    expect(fs.lstatSync(alias).nlink).toBe(2);
  });

  it("rejects hard-linked current state and migration marker databases", async () => {
    for (const target of ["current", "marker"] as const) {
      const h = harness();
      await apply(h.manager, "codex");
      const file = target === "current"
        ? path.join(stateRoot(h.home), "codex", "state.db")
        : path.join(legacyStateRoot(h.home), "codex", "state.db");
      fs.linkSync(file, path.join(h.home, `${target}-alias.db`));
      expect((await new FileAgentsManager({ home: h.home }).inspect(origin)).find((item) => item.id === "codex"), target)
        .toMatchObject({ state: "unsafe_path", mappings: [] });
    }
  }, 180_000);

  it("rejects hard-linked lock, retired, temporary, and sidecar databases", async () => {
    for (const scenario of ["lock", "retired", "marker-temp", "state-temp", "sidecar"] as const) {
      const h = harness();
      const state = { version: 2 as const, revision: 3, mappings: [mappings[0]!], targets: [], lastAppliedAt: null, pending: null };
      const legacyState = path.join(legacyStateRoot(h.home), "codex", "state.db");
      const currentDirectory = path.join(stateRoot(h.home), "codex");
      const currentState = path.join(currentDirectory, "state.db");
      if (scenario === "lock") {
        await saveState(stateRoot(h.home), "codex", state);
        const lock = path.join(currentDirectory, "lock.db");
        fs.linkSync(lock, path.join(h.home, "lock-alias"));
        await expect(new AgentStore(stateRoot(h.home), "codex").locked(async () => undefined))
          .rejects.toMatchObject({ code: "agent_unsafe_path" });
        continue;
      }

      await saveState(legacyStateRoot(h.home), "codex", state);
      if (scenario === "retired") {
        const retired = `${legacyState}.migrated`;
        fs.copyFileSync(legacyState, retired);
        protect(retired);
        fs.linkSync(retired, path.join(h.home, "retired-alias"));
      } else if (scenario === "marker-temp") {
        fs.renameSync(legacyState, `${legacyState}.migrated`);
        const temporary = `${legacyState}.marker`;
        fs.writeFileSync(temporary, "unsafe", { mode: 0o600 });
        protect(temporary);
        fs.linkSync(temporary, path.join(h.home, "marker-temp-alias"));
      } else if (scenario === "state-temp") {
        fs.renameSync(legacyState, `${legacyState}.migrated`);
        await writeMigrationMarker(legacyState, currentState);
        await privateDirectory(path.dirname(stateRoot(h.home)));
        await privateDirectory(stateRoot(h.home));
        await privateDirectory(currentDirectory);
        const temporary = `${currentState}.migrating`;
        fs.writeFileSync(temporary, "unsafe", { mode: 0o600 });
        protect(temporary);
        fs.linkSync(temporary, path.join(h.home, "state-temp-alias"));
      } else {
        await saveState(stateRoot(h.home), "codex", state);
        const sidecar = `${currentState}-journal`;
        fs.writeFileSync(sidecar, "unsafe", { mode: 0o600 });
        protect(sidecar);
        fs.linkSync(sidecar, path.join(h.home, "sidecar-alias"));
        await expect(new AgentStore(stateRoot(h.home), "codex").read())
          .rejects.toMatchObject({ code: "agent_unsafe_path" });
        continue;
      }
      expect((await new FileAgentsManager({ home: h.home }).inspect(origin)).find((item) => item.id === "codex"), scenario)
        .toMatchObject({ state: "unsafe_path", mappings: [] });
    }
  }, 180_000);

  it("rejects a migration marker with a valid old state sentinel", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const markerPath = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const marker = new DatabaseSync(markerPath);
    try {
      marker.prepare("UPDATE state SET document=? WHERE id=1").run(JSON.stringify({
        version: 2, revision: 0, mappings: [], targets: [], lastAppliedAt: null, pending: null,
      }));
    } finally { marker.close(); }
    expect((await new FileAgentsManager({ home: h.home }).inspect(origin)).find((item) => item.id === "codex"))
      .toMatchObject({ state: "recovery_required", mappings: [] });
  }, 180_000);

  it("reports a busy migration marker read as retryable", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const markerPath = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const marker = new DatabaseSync(markerPath, { timeout: 0 });
    marker.exec("BEGIN EXCLUSIVE");
    try {
      const started = performance.now();
      await expect(new AgentStore(stateRoot(h.home), "codex", legacyStateRoot(h.home)).read())
        .rejects.toMatchObject({ code: "agent_busy" });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      marker.exec("ROLLBACK");
      marker.close();
    }
  }, 180_000);

  it.runIf(process.platform === "win32")("accepts case-insensitive Windows marker targets", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const markerPath = path.join(legacyStateRoot(h.home), "codex", "state.db");
    const marker = new DatabaseSync(markerPath);
    try {
      const target = (marker.prepare("SELECT target FROM migration").get() as { target: string }).target;
      const upper = target.toUpperCase();
      marker.exec("BEGIN IMMEDIATE");
      marker.prepare("UPDATE migration SET target=?").run(upper);
      marker.prepare("UPDATE state SET document=? WHERE id=1").run(JSON.stringify({ migratedTo: upper }));
      marker.exec("COMMIT");
    } finally { marker.close(); }
    expect((await new FileAgentsManager({ home: h.home }).inspect(origin)).find((item) => item.id === "codex")?.state)
      .toBe("installed");
  }, 180_000);
  it.runIf(process.platform === "win32")("uses one ordered security batch per Inspect without cross-call reuse", async () => {
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        batches.push(requests);
        return requests.map((request): WindowsSecuritySnapshotFact => fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: "O:SYG:SYD:(A;;FA;;;SY)" }
          : { id: request.id, status: "missing" });
      },
    });

    await expect(h.manager.inspect(origin)).resolves.toMatchObject([
      { id: "claude", state: "not_managed" },
      { id: "codex", state: "not_managed" },
    ]);
    await h.manager.inspect(origin);

    const normalizedHome = h.home.toLowerCase();
    expect(batches).toEqual([1, 2].map((snapshot) => [
      { id: `snapshot-${snapshot}-path-0`, path: normalizedHome, security: false },
      { id: `snapshot-${snapshot}-path-1`, path: path.join(normalizedHome, ".claude", "settings.json") },
      { id: `snapshot-${snapshot}-path-2`, path: path.join(normalizedHome, ".codex", "models.json") },
      { id: `snapshot-${snapshot}-path-3`, path: path.join(normalizedHome, ".codex", "config.toml") },
      { id: `snapshot-${snapshot}-path-4`, path: path.join(normalizedHome, ".codex", "config.toml.ghcg.bak") },
      { id: `snapshot-${snapshot}-path-5`, path: path.join(normalizedHome, ".codex", "models.json.ghcg.bak") },
    ]));
  });

  it.runIf(process.platform === "win32")("isolates a target query error to its consuming agent", async () => {
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => requests.map((request): WindowsSecuritySnapshotFact => {
        if (request.path.endsWith("\\.claude\\settings.json")) return { id: request.id, status: "error" };
        return fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: "O:SYG:SYD:(A;;FA;;;SY)" }
          : { id: request.id, status: "missing" };
      }),
    });

    expect(await h.manager.inspect(origin)).toMatchObject([
      { id: "claude", state: "unsafe_path" },
      { id: "codex", state: "not_managed" },
    ]);
  });

  it.runIf(process.platform === "win32")("keeps a valid backup visible when a later target query fails", async () => {
    const h = harness();
    const config = seed(h.home, ".claude/settings.json", "{}\n");
    await apply(h.manager, "claude");
    const backup = (await readImage(`${config}.ghcg.bak`))!;
    const manager = new FileAgentsManager({
      home: h.home,
      queryWindowsSecuritySnapshot: async (requests) => requests.map((request): WindowsSecuritySnapshotFact => {
        if (request.path.endsWith("\\.claude\\settings.json")) return { id: request.id, status: "error" };
        return fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: backup.acl! }
          : { id: request.id, status: "missing" };
      }),
    });

    expect((await manager.inspect(origin)).find((status) => status.id === "claude")).toMatchObject({
      state: "unsafe_path",
      backupAvailable: true,
    });
  }, 180_000);

  it.runIf(process.platform === "win32")("fails both prepared agents closed on a global query failure", async () => {
    const h = harness({ queryWindowsSecuritySnapshot: async () => { throw new Error("sensitive diagnostic"); } });
    expect(await h.manager.inspect(origin)).toMatchObject([
      { id: "claude", state: "unsafe_path" },
      { id: "codex", state: "unsafe_path" },
    ]);
  });

  it.runIf(process.platform === "win32")("fails both prepared agents closed on a malformed injected result", async () => {
    const h = harness({ queryWindowsSecuritySnapshot: async () => [] });
    expect(await h.manager.inspect(origin)).toMatchObject([
      { id: "claude", state: "unsafe_path" },
      { id: "codex", state: "unsafe_path" },
    ]);
  });

  it.runIf(process.platform === "win32")("uses exact snapshot SDDL in Inspect revisions", async () => {
    let sddl = "O:SYG:SYD:(A;;FA;;;SY)";
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => requests.map((request): WindowsSecuritySnapshotFact => fs.existsSync(request.path)
        ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl }
        : { id: request.id, status: "missing" }),
    });
    seed(h.home, ".claude/settings.json", "{}\n");

    const first = await h.status("claude");
    sddl = "O:SYG:SYD:PAI(A;;FA;;;SY)";
    const second = await h.status("claude");

    expect(first.state).toBe("not_managed");
    expect(second.state).toBe("not_managed");
    expect(second.revision).not.toBe(first.revision);
  });

  it.runIf(process.platform === "win32")("fails closed when target existence changes after the snapshot", async () => {
    let raced = false;
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        const facts = requests.map((request): WindowsSecuritySnapshotFact => fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: "O:SYG:SYD:(A;;FA;;;SY)" }
          : { id: request.id, status: "missing" });
        if (!raced) {
          raced = true;
          seed(h.home, ".claude/settings.json", "raced\n");
        }
        return facts;
      },
    });

    expect(await h.status("claude")).toMatchObject({ state: "unsafe_path", backupAvailable: false });
  });

  it.runIf(process.platform === "win32")("fails closed when a present target disappears after the snapshot", async () => {
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        const facts = requests.map((request): WindowsSecuritySnapshotFact => fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: "O:SYG:SYD:(A;;FA;;;SY)" }
          : { id: request.id, status: "missing" });
        fs.unlinkSync(path.join(h.home, ".claude", "settings.json"));
        return facts;
      },
    });
    seed(h.home, ".claude/settings.json", "present\n");

    expect(await h.status("claude")).toMatchObject({ state: "unsafe_path", backupAvailable: false });
  });

  it.runIf(process.platform === "win32")("fails closed when a present target is replaced during the snapshot", async () => {
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        const facts = requests.map((request): WindowsSecuritySnapshotFact => fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: "O:SYG:SYD:(A;;FA;;;SY)" }
          : { id: request.id, status: "missing" });
        const target = path.join(h.home, ".claude", "settings.json");
        fs.unlinkSync(target);
        fs.writeFileSync(target, "replacement\n");
        return facts;
      },
    });
    seed(h.home, ".claude/settings.json", "original\n");

    expect(await h.status("claude")).toMatchObject({ state: "unsafe_path", backupAvailable: false });
  });

  it.runIf(process.platform === "win32")("does not authorize a linked live target from a replaced staged pathname", async () => {
    const original = seed(homeWithCrash(), ".claude/settings.json", "{}\n");
    const crashed = new FileAgentsManager({
      home: homes.at(-1)!,
      checkpoint: (point, agent, index) => {
        if (point === "linked" && agent === "claude" && index === 1) throw new Error("simulated crash");
      },
    });
    await expect(apply(crashed, "claude")).rejects.toThrow();
    const store = new AgentStore(stateRoot(homes.at(-1)!), "claude");
    const state = await store.read();
    const step = state.pending!.steps.find((candidate) => candidate.target === 1)!;
    const stage = path.join(step.scratch, "next");
    let raced = false;
    const manager = new FileAgentsManager({
      home: homes.at(-1)!,
      queryWindowsSecuritySnapshot: async (requests) => {
        const facts = await queryWindowsSecuritySnapshot(requests);
        if (!raced && requests.some((request) => request.path === stage.toLowerCase())
          && requests.some((request) => request.path === original.toLowerCase())) {
          raced = true;
          fs.unlinkSync(stage);
          fs.writeFileSync(stage, "unrelated stage", { mode: 0o600 });
        }
        return facts;
      },
    });

    expect((await manager.inspect(origin)).find((item) => item.id === "claude")).toMatchObject({
      state: "unsafe_path",
      backupAvailable: true,
    });
    expect(raced).toBe(true);
  }, 180_000);

  it.runIf(process.platform === "win32")("uses distinct deduplicated security snapshots throughout Apply", async () => {
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        batches.push(requests);
        return requests.map((request): WindowsSecuritySnapshotFact => fs.existsSync(request.path)
          ? { id: request.id, status: "present", reparse: false, owner: "owner", sddl: "O:SYG:SYD:(A;;FA;;;SY)" }
          : { id: request.id, status: "missing" });
      },
    });
    const current = await h.status("claude");
    batches.length = 0;

    await h.manager.apply({
      agent: "claude", expectedRevision: current.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => new Set(batch.map((request) => request.path.toLowerCase())).size === batch.length)).toBe(true);
    const prefixes = batches.map((batch) => {
      const match = /^snapshot-(\d+)-path-0$/u.exec(batch[0]!.id);
      expect(match).not.toBeNull();
      expect(batch.map((request) => request.id)).toEqual(batch.map((_, index) => `snapshot-${match![1]}-path-${index}`));
      return match![1];
    });
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(batches.some((batch) => batch.some((request) => request.path.endsWith("\\.claude\\settings.json")))).toBe(true);
  }, 180_000);

  it.runIf(process.platform === "win32")("separates real Apply security boundaries and batches full target sets", async () => {
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const checkpoints = new Map<string, number>();
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        batches.push(requests);
        return await queryWindowsSecuritySnapshot(requests);
      },
      checkpoint: (point, _agent, index) => { checkpoints.set(`${point}/${index}`, batches.length); },
    });
    seed(h.home, ".claude/settings.json", "{}\n");
    const current = await h.status("claude");
    batches.length = 0;

    await h.manager.apply({
      agent: "claude", expectedRevision: current.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal);

    const config = path.join(h.home, ".claude", "settings.json").toLowerCase();
    const backup = `${config}.ghcg.bak`;
    const prefixes = batches.map((batch) => batch[0]!.id.replace(/-path-0$/u, ""));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(batches.every((batch) => new Set(batch.map((request) => request.path)).size === batch.length)).toBe(true);
    expect(batches[0]!.map((request) => request.path)).toContain(config);
    expect(batches[1]!.map((request) => request.path)).toContain(config);
    expect(prefixes[0]).not.toBe(prefixes[1]);

    const staged = checkpoints.get("staged/1")!;
    const displaced = checkpoints.get("displaced/1")!;
    const linked = checkpoints.get("linked/1")!;
    const complete = checkpoints.get("complete/-1")!;
    expect(batches.slice(staged).some((batch) => {
      const paths = batch.map((request) => request.path);
      return paths.includes(backup) && paths.includes(config);
    })).toBe(true);
    expect(batches.slice(staged, displaced).some((batch) => batch.length === 5
      && batch.some((request) => request.path === config)
      && batch.some((request) => request.path.endsWith("\\next"))
      && batch.some((request) => request.path.endsWith("\\previous")))).toBe(true);
    expect(batches.slice(displaced, linked).some((batch) => batch.length === 3
      && batch.some((request) => request.path.endsWith("\\next")))).toBe(true);
    expect(batches.slice(linked, complete).some((batch) => batch.some((request) => request.path.endsWith("\\previous")))).toBe(true);
    expect(batches.slice(complete).some((batch) => {
      const paths = batch.map((request) => request.path);
      return paths.includes(backup) && paths.includes(config);
    })).toBe(true);
  }, 180_000);

  it.runIf(process.platform === "win32")("keeps no-op Apply to three transaction snapshots", async () => {
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        batches.push(requests);
        return await queryWindowsSecuritySnapshot(requests);
      },
    });
    seed(h.home, ".claude/settings.json", "{}\n");
    await apply(h.manager, "claude");
    const current = await h.status("claude");
    batches.length = 0;

    await h.manager.apply({
      agent: "claude", expectedRevision: current.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal);

    expect(batches).toHaveLength(3);
    expect(new Set(batches.map((batch) => batch[0]!.id.replace(/-path-0$/u, ""))).size).toBe(3);
  }, 180_000);

  it.runIf(process.platform === "win32")("keeps exact Codex first, no-op, and reordered snapshot contracts", async () => {
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const h = harness({
      queryWindowsSecuritySnapshot: async (requests) => {
        batches.push(requests);
        return await queryWindowsSecuritySnapshot(requests);
      },
    });
    seed(h.home, ".codex/config.toml", "model = \"old\"\n");
    batches.length = 0;
    await takeover(h.manager);
    const root = ["$HOME\\.codex"];
    const targets = [...root, "$HOME\\.codex\\config.toml.ghcg.bak", "$HOME\\.codex\\models.json.ghcg.bak", "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml"];
    const stage = (index: number, target: string) => [
      `$HOME\\.codex\\$SCRATCH${index}`,
      `$HOME\\.codex\\$SCRATCH${index}\\next`,
      target,
    ];
    expectSnapshotContract(batches, h.home, [
      ["$HOME", "$HOME\\.claude\\settings.json", ...root, "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml",
        "$HOME\\.codex\\config.toml.ghcg.bak", "$HOME\\.codex\\models.json.ghcg.bak"],
      [...root, "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml"],
      targets,
      [...root, "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml"],
      targets,
      targets,
      [...root, "$HOME\\.codex\\config.toml.ghcg.bak"],
      root,
      stage(0, "$HOME\\.codex\\config.toml.ghcg.bak"),
      stage(0, "$HOME\\.codex\\config.toml.ghcg.bak"),
      [...root, "$HOME\\.codex\\models.json"],
      root,
      stage(1, "$HOME\\.codex\\models.json"),
      stage(1, "$HOME\\.codex\\models.json"),
      [...root, "$HOME\\.codex\\config.toml"],
      root,
      stage(2, "$HOME\\.codex\\config.toml"),
      stage(2, "$HOME\\.codex\\config.toml"),
      [...targets, "$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next",
        "$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next",
        "$HOME\\.codex\\$SCRATCH2", "$HOME\\.codex\\$SCRATCH2\\next"],
      stage(0, "$HOME\\.codex\\config.toml.ghcg.bak"),
      stage(1, "$HOME\\.codex\\models.json"),
      ["$HOME\\.codex\\$SCRATCH2", "$HOME\\.codex\\$SCRATCH2\\next", ...root,
        "$HOME\\.codex\\$SCRATCH2\\previous", "$HOME\\.codex\\config.toml"],
      ["$HOME\\.codex\\$SCRATCH2", "$HOME\\.codex\\$SCRATCH2\\previous"],
      stage(2, "$HOME\\.codex\\config.toml"),
      [...targets, "$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next",
        "$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next",
        "$HOME\\.codex\\$SCRATCH2", "$HOME\\.codex\\$SCRATCH2\\next"],
      ["$HOME\\.codex\\$SCRATCH2", "$HOME\\.codex\\$SCRATCH2\\previous"],
      targets,
    ]);
    const installed = await h.status("codex");
    batches.length = 0;
    await h.manager.apply({
      agent: "codex", expectedRevision: installed.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal);
    expectSnapshotContract(batches, h.home, [targets, targets, targets]);
    const repeated = await h.status("codex");
    batches.length = 0;
    await h.manager.apply({
      agent: "codex", expectedRevision: repeated.revision, catalogRevision: "a".repeat(64), mappings: [...mappings].reverse(),
    }, origin, models, () => undefined, new AbortController().signal);
    expectSnapshotContract(batches, h.home, [
      targets,
      targets,
      [...root, "$HOME\\.codex\\models.json"],
      root,
      stage(0, "$HOME\\.codex\\models.json"),
      stage(0, "$HOME\\.codex\\models.json"),
      [...root, "$HOME\\.codex\\config.toml"],
      root,
      stage(1, "$HOME\\.codex\\config.toml"),
      stage(1, "$HOME\\.codex\\config.toml"),
      [...targets, "$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next",
        "$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next"],
      ["$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next", ...root,
        "$HOME\\.codex\\$SCRATCH0\\previous", "$HOME\\.codex\\models.json"],
      ["$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\previous"],
      stage(0, "$HOME\\.codex\\models.json"),
      ["$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next", ...root,
        "$HOME\\.codex\\$SCRATCH1\\previous", "$HOME\\.codex\\config.toml"],
      ["$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\previous"],
      stage(1, "$HOME\\.codex\\config.toml"),
      [...targets, "$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next",
        "$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next"],
      ["$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\previous"],
      ["$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\previous"],
      targets,
    ]);
  }, 300_000);

  it.runIf(process.platform === "win32")("preserves exact Windows descriptors through first and repeat Apply", async () => {
    const h = harness();
    const config = await stableSeed(h.home, ".claude/settings.json", "{}\n");
    const original = (await readImage(config))!;

    await apply(h.manager, "claude");
    const firstConfig = (await readImage(config))!;
    const firstBackup = (await readImage(`${config}.ghcg.bak`))!;
    expect(firstConfig.acl).toBe(original.acl);
    expect(firstBackup.acl).toBe(original.acl);

    fs.writeFileSync(config, JSON.stringify({ env: { OTHER: "external" } }));
    await apply(h.manager, "claude", [...mappings].reverse());
    expect((await readImage(config))!.acl).toBe(firstConfig.acl);
    expect((await readImage(`${config}.ghcg.bak`))!.acl).toBe(firstBackup.acl);
  }, 180_000);

  it.each(["claude", "codex"] as const)("publishes exact %s first and repeat Apply fixture bytes", async (agent) => {
    const h = harness();
    const fixturePath = path.resolve("tests/fixtures/agent-config", `${agent}.input.json`);
    const initial = await projectAgentConfigFixture(fixturePath);
    const config = seed(h.home, agent === "claude" ? ".claude/settings.json" : ".codex/config.toml", initial.source);
    const auth = seed(h.home, agent === "claude" ? ".claude/.credentials.json" : ".codex/auth.json", "login-secret\n");
    const catalogPath = agent === "codex"
      ? (process.platform === "win32" ? path.join(h.home, ".codex", "models.json").toLowerCase() : path.join(h.home, ".codex", "models.json"))
      : undefined;
    const fixture = await projectAgentConfigFixture(fixturePath, catalogPath);

    expect((await (agent === "codex"
      ? takeover(h.manager, fixture.input.firstMappings, fixture.models)
      : apply(h.manager, agent, fixture.input.firstMappings, fixture.models))).state).toBe("installed");
    expect(fs.readFileSync(config)).toEqual(fixture.first.config);
    if (agent === "codex") expect(fs.readFileSync(catalogPath!)).toEqual(fixture.first.catalog);
    expect(fs.readFileSync(`${config}.ghcg.bak`)).toEqual(fixture.source);
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret\n");

    fs.writeFileSync(config, fixture.repeatSource);
    expect((await apply(h.manager, agent, fixture.input.repeatMappings, fixture.models)).state).toBe("installed");
    expect(fs.readFileSync(config)).toEqual(fixture.repeat.config);
    if (agent === "codex") expect(fs.readFileSync(catalogPath!)).toEqual(fixture.repeat.catalog);
    expect(fs.readFileSync(`${config}.ghcg.bak`)).toEqual(fixture.source);
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret\n");
  }, 300_000);

  it.each([
    ["claude", "missing", "conflict"],
    ["claude", "replaced", "conflict"],
    ["claude", "unsafe", "unsafe_path"],
    ["codex", "missing", "conflict"],
    ["codex", "replaced", "conflict"],
    ["codex", "unsafe", "unsafe_path"],
  ] as const)("reports a %s %s first-original sidecar as unavailable", async (agent, change, expectedState) => {
    const h = harness();
    const file = await stableSeed(h.home, agent === "claude" ? ".claude/settings.json" : ".codex/config.toml",
      agent === "claude" ? "{\"theme\":\"original\"}\n" : "# original\nmodel = \"old\"\n");
    const seeded = await h.status(agent);
    expect((await h.status(agent)).revision).toBe(seeded.revision);
    if (agent === "codex") await takeover(h.manager);
    else await h.manager.apply({
      agent, expectedRevision: seeded.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal);
    const backup = `${file}.ghcg.bak`;
    if (change === "missing") fs.unlinkSync(backup);
    else if (change === "replaced") fs.writeFileSync(backup, "unrelated backup");
    else {
      fs.unlinkSync(backup);
      fs.mkdirSync(backup);
    }

    const status = await h.status(agent);
    expect(status).toMatchObject({
      state: expectedState,
      backupAvailable: false,
      paths: agent === "claude"
        ? [process.platform === "win32" ? file.toLowerCase() : file]
        : [
          path.join(path.dirname(file), "models.json"),
          file,
        ].map((target) => process.platform === "win32" ? target.toLowerCase() : target),
    });
    await expect(apply(h.manager, agent)).rejects.toThrow();
  }, 180_000);

  it.each(["claude", "codex"] as const)("reports every changed %s target and reapplies only with intact ownership", async (agent) => {
    const h = harness();
    seed(h.home, agent === "claude" ? ".claude/settings.json" : ".codex/config.toml",
      agent === "claude" ? "{\"theme\":\"original\"}\n" : "# original\nmodel = \"old\"\n");
    if (agent === "codex") await takeover(h.manager); else await apply(h.manager, agent);
    const installed = await h.status(agent);
    const expectedPaths = (agent === "claude"
      ? [path.join(h.home, ".claude", "settings.json")]
      : [path.join(h.home, ".codex", "models.json"), path.join(h.home, ".codex", "config.toml")])
      .map((target) => process.platform === "win32" ? target.toLowerCase() : target);
    expect(installed.paths).toEqual(expectedPaths);

    for (const target of expectedPaths) {
      const managed = fs.readFileSync(target);
      fs.unlinkSync(target);
      expect(await h.status(agent)).toMatchObject({
        state: "conflict",
        backupAvailable: true,
        paths: expectedPaths,
      });
      if (agent === "codex" && target.endsWith("config.toml")) {
        await expect(apply(h.manager, agent)).rejects.toThrow("agent conflict");
        fs.writeFileSync(target, managed, { mode: 0o600 });
      } else {
        expect(await apply(h.manager, agent)).toMatchObject({ state: "installed", backupAvailable: true });
      }

      const replacement = target.endsWith(".json")
        ? agent === "claude" ? "{\"theme\":\"external\"}\n" : "{\"external\":true}\n"
        : "# external\nmodel = \"external\"\n";
      fs.writeFileSync(target, replacement);
      expect(await h.status(agent)).toMatchObject({
        state: "conflict",
        backupAvailable: true,
        paths: expectedPaths,
      });
      if (agent === "codex" && target.endsWith("config.toml")) {
        await expect(apply(h.manager, agent)).rejects.toThrow("agent conflict");
        fs.writeFileSync(target, managed, { mode: 0o600 });
      } else {
        expect(await apply(h.manager, agent)).toMatchObject({ state: "installed", backupAvailable: true });
      }
    }
  }, 300_000);

  it.each(["claude", "codex"] as const)("reports every unsafe %s target without hiding its live backup", async (agent) => {
    const h = harness();
    seed(h.home, agent === "claude" ? ".claude/settings.json" : ".codex/config.toml",
      agent === "claude" ? "{}\n" : "model = \"old\"\n");
    if (agent === "codex") await takeover(h.manager); else await apply(h.manager, agent);
    const installed = await h.status(agent);
    const expectedPaths = (agent === "claude"
      ? [path.join(h.home, ".claude", "settings.json")]
      : [path.join(h.home, ".codex", "models.json"), path.join(h.home, ".codex", "config.toml")])
      .map((target) => process.platform === "win32" ? target.toLowerCase() : target);
    expect(installed.paths).toEqual(expectedPaths);

    for (const target of expectedPaths) {
      const current = fs.readFileSync(target);
      fs.unlinkSync(target);
      fs.mkdirSync(target);
      expect(await h.status(agent)).toMatchObject({
        state: "unsafe_path",
        backupAvailable: true,
        paths: expectedPaths,
      });
      await expect(apply(h.manager, agent)).rejects.toThrow("agent unsafe path");
      fs.rmdirSync(target);
      fs.writeFileSync(target, current, { mode: 0o600 });
      await apply(h.manager, agent);
    }
  }, 300_000);

  it.each(["missing", "replaced"] as const)("reports %s live configuration without disabling a fresh Apply", async (change) => {
    const h = harness();
    const file = seed(h.home, ".claude/settings.json", "{}\n");
    await apply(h.manager, "claude");
    if (change === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.test" } }));
    expect((await h.status("claude")).state).toBe("conflict");
    expect((await apply(h.manager, "claude")).state).toBe("installed");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL).toBe(origin);
  }, 180_000);
  it("drops only the legacy Subagent row while migrating the first Claude original", async () => {
    const h = harness();
    const original = Buffer.from("{\"theme\":\"old\"}\n");
    const file = seed(h.home, ".claude/settings.json", original);
    const baseline = (await readImage(file))!;
    fs.writeFileSync(file, JSON.stringify({ theme: "current", env: { CLAUDE_CODE_SUBAGENT_MODEL: "model-c" } }));
    const store = new AgentStore(path.join(h.home, ".ghc-gateway-agents"), "claude");
    await store.locked(async (save) => save({
      version: 1, revision: 2, mappings: [...mappings, mappings[2]!], lastAppliedAt: null, pending: null,
      targets: [{ path: file, original: baseline, expected: (await readImage(file))! }],
    }));
    expect((await h.status("claude")).mappings).toHaveLength(3);
    await apply(h.manager, "claude");
    expect(fs.readFileSync(`${file}.ghcg.bak`)).toEqual(original);
    const installed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(installed.theme).toBe("current");
    expect(installed.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  }, 180_000);

  it("never overwrites an unrelated preexisting backup or its current config", async () => {
    const h = harness();
    const file = seed(h.home, ".claude/settings.json", "{}\n");
    seed(h.home, ".claude/settings.json.ghcg.bak", "unrelated backup");
    await expect(apply(h.manager, "claude")).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{}\n");
    expect(fs.readFileSync(`${file}.ghcg.bak`, "utf8")).toBe("unrelated backup");
  }, 180_000);

  it("rejects a pre-intent cancellation without creating a backup or config", async () => {
    const h = harness();
    const status = await h.status("codex");
    const controller = new AbortController();
    controller.abort();
    await expect(h.manager.apply({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.readdirSync(h.home)).toEqual([]);
  }, 180_000);
  it("keeps cancellation abortable until the durable intent boundary", async () => {
    const controller = new AbortController();
    let stateDatabaseExistedAtBoundary = false;
    const h = harness({
      checkpoint: (point) => {
        if (point !== "before_intent") return;
        stateDatabaseExistedAtBoundary = fs.existsSync(path.join(h.home, ".ghc-gateway", "agents", "codex", "state.db"));
        controller.abort();
      },
    });
    const status = await h.status("codex");
    await expect(h.manager.apply({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(stateDatabaseExistedAtBoundary).toBe(false);
    expect(fs.existsSync(path.join(h.home, ".ghc-gateway", "agents", "codex", "state.db"))).toBe(false);
    expect(fs.existsSync(path.join(h.home, ".codex"))).toBe(false);
  }, 180_000);

  it("leaves existing state and client files unchanged on a no-op boundary conflict", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const status = await h.status("codex");
    const statePath = path.join(h.home, ".ghc-gateway", "agents", "codex", "state.db");
    const catalogPath = path.join(h.home, ".codex", "models.json");
    const configPath = path.join(h.home, ".codex", "config.toml");
    const before = [statePath, catalogPath, configPath].map((file) => fs.readFileSync(file));
    let assertions = 0;

    await expect(h.manager.apply({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => {
      assertions += 1;
      if (assertions === 3) throw new AgentError("revision_conflict");
    }, new AbortController().signal)).rejects.toMatchObject({ name: "AgentError", code: "revision_conflict" });

    expect(assertions).toBe(3);
    expect([statePath, catalogPath, configPath].map((file) => fs.readFileSync(file))).toEqual(before);
    expect(await h.status("codex")).toEqual(status);
  }, 300_000);

  it("ignores cancellation after durable intent and completes Apply", async () => {
    const controller = new AbortController();
    const h = harness({
      checkpoint: (point) => {
        if (point === "intent") controller.abort();
      },
    });
    const status = await h.status("codex");
    await expect(h.manager.apply({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, controller.signal)).resolves.toMatchObject({ state: "installed" });
    expect(fs.existsSync(path.join(h.home, ".codex", "models.json"))).toBe(true);
    expect(fs.existsSync(path.join(h.home, ".codex", "config.toml"))).toBe(true);
  }, 180_000);

  it("retains a first-original sidecar and reapplies onto current unrelated settings", async () => {
    const h = harness();
    const original = Buffer.from("\ufeff{\r\n \"hooks\": {\"Stop\": []}, \"theme\": \"old\"\r\n}\r\n");
    const file = seed(h.home, ".claude/settings.json", original);
    await apply(h.manager, "claude");
    const backup = `${file}.ghcg.bak`;
    expect(fs.readFileSync(backup)).toEqual(original);
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    current.theme = "new";
    fs.writeFileSync(file, JSON.stringify(current));
    await apply(h.manager, "claude", [...mappings].reverse());
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      theme: "new", hooks: { Stop: [] }, model: "model-c",
    });
    expect(fs.readFileSync(backup)).toEqual(original);
    await apply(new FileAgentsManager({ home: h.home }), "claude", [...mappings].reverse());
    expect(fs.readFileSync(backup)).toEqual(original);
  }, 180_000);
  it("reads without creating any directories and rejects invalid parsing before writes", async () => {
    const h = harness();
    expect((await h.status("codex")).state).toBe("not_managed");
    expect(fs.readdirSync(h.home)).toEqual([]);
    seed(h.home, ".codex/config.toml", "token=\"secret\n");
    await expect(apply(h.manager, "codex")).rejects.toThrow("agent invalid config");
    expect(fs.readdirSync(h.home)).toEqual([".codex"]);
  }, 180_000);

  it("retains exact original Claude bytes through repeated Apply and rejects a stale revision", async () => {
    const h = harness();
    const original = Buffer.from("\ufeff{\r\n  \"hooks\": {\"Stop\": []}, \"env\": {\"OTHER\":\"untouched\"}\r\n}\r\n");
    const file = seed(h.home, ".claude/settings.json", original);
    seed(h.home, ".claude/.credentials.json", "login-secret");
    expect((await apply(h.manager, "claude")).state).toBe("installed");
    const first = await h.status("claude");
    expect(first.lastAppliedAt).toBe("2026-01-02T03:04:05.000Z");
    expect((await apply(h.manager, "claude", [...mappings].reverse())).state).toBe("installed");
    await expect(h.manager.apply({ agent: "claude", expectedRevision: first.revision, catalogRevision: "a".repeat(64), mappings }, origin, models, () => undefined, new AbortController().signal)).rejects.toThrow("revision conflict");
    expect(fs.readFileSync(`${file}.ghcg.bak`)).toEqual(original);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).model).toBe("model-c");
    expect(fs.readFileSync(path.join(h.home, ".claude/.credentials.json"), "utf8")).toBe("login-secret");
  }, 300_000);

  it("retains initial Codex absence without backing up generated config on reapply/restart", async () => {
    const h = harness();
    const auth = seed(h.home, ".codex/auth.json", "login-secret");
    expect((await apply(h.manager, "codex")).state).toBe("installed");
    const restarted = new FileAgentsManager({ home: h.home });
    expect((await apply(restarted, "codex", [...mappings].reverse())).state).toBe("installed");
    const value = JSON.parse(fs.readFileSync(path.join(h.home, ".codex/models.json"), "utf8"));
    expect(value.models.map((row: { slug: string }) => row.slug)).toEqual([...models].reverse().map((row) => row.modelId));
    expect(fs.readdirSync(path.join(h.home, ".codex")).sort()).toEqual(["auth.json", "config.toml", "models.json"]);
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret");
  }, 300_000);

  it("rejects an unmanaged reserved Codex provider before creating intent or files", async () => {
    const h = harness();
    const original = Buffer.from("model = \"external\"\n[model_providers.ghc_gateway]\nbase_url = \"https://external.example/v1\"\nwire_api = \"responses\"\n[model_providers.other]\nname = \"Other\"\n[mcp_servers.local]\ncommand = \"node\"\n");
    const config = seed(h.home, ".codex/config.toml", original);
    const catalog = seed(h.home, ".codex/models.json", "external catalog\n");
    const auth = seed(h.home, ".codex/auth.json", "login-secret\n");
    expect(await h.status("codex")).toMatchObject({ state: "not_managed" });
    await expect(apply(h.manager, "codex")).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(config)).toEqual(original);
    expect(fs.readFileSync(catalog, "utf8")).toBe("external catalog\n");
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret\n");
    expect(fs.existsSync(`${config}.ghcg.bak`)).toBe(false);
    expect(fs.existsSync(path.join(h.home, ".ghc-gateway", "agents"))).toBe(false);
  }, 180_000);

  it("offers explicit Codex takeover while ordinary Apply remains fail closed", async () => {
    const h = harness();
    const config = seed(h.home, ".codex/config.toml", "model = \"external\"\n[mcp_servers.local]\ncommand = \"node\"\n[hooks.Stop]\ncommand = \"notify\"\n");
    const catalog = seed(h.home, ".codex/models.json", "external catalog\n");
    const auth = seed(h.home, ".codex/auth.json", "login-secret\n");
    const status = await h.status("codex");
    expect(status).toMatchObject({ state: "not_managed", takeover: { configPath: config, catalogPath: catalog } });
    await expect(apply(h.manager, "codex")).rejects.toThrow("agent conflict");

    expect((await takeover(h.manager)).state).toBe("installed");
    expect(fs.readFileSync(`${config}.ghcg.bak`, "utf8")).toContain("model = \"external\"");
    expect(fs.readFileSync(`${catalog}.ghcg.bak`, "utf8")).toBe("external catalog\n");
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret\n");
    expect(parse(fs.readFileSync(config, "utf8"))).toMatchObject({
      model_provider: "ghc_gateway",
      mcp_servers: { local: { command: "node" } },
      hooks: { Stop: { command: "notify" } },
    });
    const backups = [fs.readFileSync(`${config}.ghcg.bak`), fs.readFileSync(`${catalog}.ghcg.bak`)];
    await apply(h.manager, "codex", [...mappings].reverse());
    expect([fs.readFileSync(`${config}.ghcg.bak`), fs.readFileSync(`${catalog}.ghcg.bak`)]).toEqual(backups);
  }, 300_000);

  it("invalidates Codex takeover when any bound evidence changes", async () => {
    const h = harness();
    const config = seed(h.home, ".codex/config.toml", "model = \"external\"\n");
    seed(h.home, ".codex/models.json", "external catalog\n");
    const status = await h.status("codex");
    expect(status.takeover).not.toBeNull();
    fs.writeFileSync(config, "model = \"changed\"\n");
    await expect(h.manager.takeover({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64),
      takeoverRevision: status.takeover!.revision, mappings,
    }, origin, models, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fs.existsSync(`${config}.ghcg.bak`)).toBe(false);
  }, 180_000);

  it("revalidates managed Codex takeover evidence before target preparation", async () => {
    const h = harness();
    seed(h.home, ".codex/config.toml", "model = \"external\"\n");
    seed(h.home, ".codex/models.json", "native catalog\n");
    await takeover(h.manager);
    const config = path.join(h.home, ".codex/config.toml");
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(`${origin}/v1`, "https://external.example/v1"));
    const status = await h.status("codex");
    expect(status.takeover).not.toBeNull();
    const catalog = path.join(h.home, ".codex/models.json");
    const before = [config, catalog].map((target) => fs.readFileSync(target));
    let changed = false;
    const manager = new FileAgentsManager({
      home: h.home,
      checkpoint: (point, agent, index) => {
        if (!changed && point === "staged" && agent === "codex" && index === 3) {
          changed = true;
          fs.writeFileSync(catalog, "changed again\n");
        }
      },
    });
    await expect(manager.takeover({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64),
      takeoverRevision: status.takeover!.revision, mappings,
    }, origin, models, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "agent_conflict" });
    expect(fs.readFileSync(config)).toEqual(before[0]);
    expect(fs.readFileSync(catalog, "utf8")).toBe("changed again\n");
    expect(fs.existsSync(`${catalog}.ghcg.bak`)).toBe(true);
  }, 180_000);

  it.each([
    ["profile routing", "profile = \"work\"\n"],
    ["invalid TOML", "model = \"unterminated\n"],
  ] as const)("does not offer takeover for unsupported %s", async (_name, source) => {
    const h = harness();
    seed(h.home, ".codex/config.toml", source);
    expect((await h.status("codex")).takeover).toBeNull();
  });

  it("rejects takeover when either destination backup already exists", async () => {
    for (const backup of ["config.toml.ghcg.bak", "models.json.ghcg.bak"]) {
      const h = harness();
      seed(h.home, ".codex/config.toml", "model = \"external\"\n");
      seed(h.home, ".codex/models.json", "external catalog\n");
      seed(h.home, `.codex/${backup}`, "unrelated backup\n");
      expect((await h.status("codex")).takeover).toBeNull();
    }
  });

  it("publishes models.json before config points Codex at it", async () => {
    const h = harness();
    seed(h.home, ".codex/config.toml", "model = \"external\"\n");
    seed(h.home, ".codex/models.json", "external catalog\n");
    const config = path.join(h.home, ".codex/config.toml");
    const catalog = path.join(h.home, ".codex/models.json");
    const observed: string[] = [];
    const manager = new FileAgentsManager({
      home: h.home,
      checkpoint: (point, agent, index) => {
        if (point !== "published" || agent !== "codex") return;
        observed.push(`${index}:${fs.readFileSync(config, "utf8").includes("model_catalog_json")}:${fs.readFileSync(catalog, "utf8").startsWith("{")}`);
      },
    });
    await takeover(manager);
    expect(observed).toEqual([
      "0:false:false",
      "1:false:false",
      "2:false:true",
      "3:true:true",
    ]);
  }, 180_000);

  it("serializes four-target Codex takeover across separate processes", async () => {
    const h = harness();
    seed(h.home, ".codex/config.toml", "model = \"external\"\n");
    seed(h.home, ".codex/models.json", "external catalog\n");
    const run = (modelId: string) => execFileAsync(process.execPath, [
      "scripts/tooling/bootstrap.mjs",
      "tests/fixtures/agent_takeover_contender.ts",
      h.home,
      origin,
      modelId,
    ], { cwd: path.resolve(import.meta.dirname, "../.."), windowsHide: true, timeout: 120_000 });
    const results = await Promise.all([run("model-a"), run("model-b")]);
    expect(results.map((result) => result.stdout.trim()).sort()).toEqual(["busy", "installed"]);
    expect((await h.status("codex")).state).toBe("installed");
    expect(fs.existsSync(path.join(h.home, ".codex/models.json.ghcg.bak"))).toBe(true);
  }, 300_000);

  it("rejects pre-v3 Codex durable state before client mutation", async () => {
    const h = harness();
    const baseline = Buffer.from("model = \"old\"\n");
    const config = seed(h.home, ".codex/config.toml", baseline);
    const baselineImage = (await readImage(config))!;
    const catalog = path.join(h.home, ".codex/models.json");
    const root = stateRoot(h.home);
    await privateDirectory(path.dirname(root));
    await privateDirectory(root);
    await privateDirectory(path.join(root, "codex"));
    const statePath = path.join(root, "codex", "state.db");
    fs.writeFileSync(statePath, "", { mode: 0o600 });
    protect(statePath);
    const db = new DatabaseSync(statePath);
    try {
      db.exec("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
      db.prepare("INSERT INTO state VALUES(1,?)").run(JSON.stringify({
        version: 2, revision: 1, mappings, lastAppliedAt: null, pending: null,
        targets: [
          { path: `${config}.ghcg.bak`, original: null, expected: null },
          { path: catalog, original: null, expected: null },
          { path: config, original: baselineImage, expected: baselineImage },
        ],
      }));
    } finally { db.close(); }
    const external = Buffer.from("model = \"external\"\n[model_providers.ghc_gateway]\nbase_url = \"https://external.example/v1\"\n");
    fs.writeFileSync(config, external);
    expect(await h.status("codex")).toMatchObject({ state: "recovery_required", mappings: [] });
    await expect(apply(h.manager, "codex")).rejects.toThrow("agent recovery required");
    expect(fs.readFileSync(config)).toEqual(external);
    expect(fs.existsSync(catalog)).toBe(false);
    expect(fs.existsSync(`${config}.ghcg.bak`)).toBe(false);
  }, 180_000);

  it("updates a Gateway-owned Codex provider from durable state and preserves unrelated settings", async () => {
    const h = harness();
    const file = seed(h.home, ".codex/config.toml", "[model_providers.other]\nname = \"Other\"\n[mcp_servers.local]\ncommand = \"node\"\n[hooks.Stop]\ncommand = \"notify\"\n");
    const auth = seed(h.home, ".codex/auth.json", "login-secret\n");
    await takeover(h.manager);
    const nextOrigin = "http://127.0.0.1:32568";
    const current = (await h.manager.inspect(nextOrigin)).find((item) => item.id === "codex")!;
    await h.manager.apply({
      agent: "codex", expectedRevision: current.revision, catalogRevision: "a".repeat(64), mappings: [...mappings].reverse(),
    }, nextOrigin, models, () => undefined, new AbortController().signal);
    expect(parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      model: "model-c",
      model_providers: {
        ghc_gateway: { base_url: `${nextOrigin}/v1` },
        other: { name: "Other" },
      },
      mcp_servers: { local: { command: "node" } },
      hooks: { Stop: { command: "notify" } },
    });
    expect(fs.readFileSync(auth, "utf8")).toBe("login-secret\n");
  }, 300_000);

  it("rejects an external provider change after Codex management begins", async () => {
    const h = harness();
    const config = seed(h.home, ".codex/config.toml", "[mcp_servers.local]\ncommand = \"node\"\n");
    await takeover(h.manager);
    const catalog = path.join(h.home, ".codex/models.json");
    const backup = `${config}.ghcg.bak`;
    const catalogBefore = fs.readFileSync(catalog);
    const backupBefore = fs.readFileSync(backup);
    const external = Buffer.from(fs.readFileSync(config, "utf8").replace(`${origin}/v1`, "https://external.example/v1"));
    fs.writeFileSync(config, external);
    await expect(apply(h.manager, "codex", [...mappings].reverse())).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(config)).toEqual(external);
    expect(fs.readFileSync(catalog)).toEqual(catalogBefore);
    expect(fs.readFileSync(backup)).toEqual(backupBefore);
    expect(parse(fs.readFileSync(config, "utf8")).mcp_servers).toEqual({ local: { command: "node" } });
  }, 300_000);

  it("preserves outside unrelated edits when a refreshed Apply patches owned fields", async () => {
    const h = harness();
    const original = seed(h.home, ".claude/settings.json", JSON.stringify({ env: { OTHER: "keep" } }));
    await apply(h.manager, "claude");
    const external = Buffer.from(JSON.stringify({ env: { OTHER: "external-edit" } }));
    fs.writeFileSync(original, external);
    expect((await h.status("claude")).state).toBe("conflict");
    await apply(h.manager, "claude");
    expect(JSON.parse(fs.readFileSync(original, "utf8")).env.OTHER).toBe("external-edit");
  }, 180_000);

  it("revalidates the live file after staging and before rename", async () => {
    const home = homeWithCrash();
    const original = seed(home, ".claude/settings.json", JSON.stringify({ env: { OTHER: "keep" } }));
    const external = Buffer.from(JSON.stringify({ env: { OTHER: "raced" } }));
    const manager = new FileAgentsManager({
      home,
      checkpoint: (point, agent, index) => {
        if (point === "staged" && agent === "claude" && index === 1) fs.writeFileSync(original, external);
      },
    });
    await expect(apply(manager, "claude")).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(original)).toEqual(external);
  }, 180_000);

  it.runIf(process.platform === "win32")("requires the staged image in the immediate pre-rename snapshot", async () => {
    const original = seed(homeWithCrash(), ".claude/settings.json", JSON.stringify({ env: { OTHER: "keep" } }));
    let removed = false;
    const manager = new FileAgentsManager({
      home: homes.at(-1)!,
      queryWindowsSecuritySnapshot: async (requests) => {
        const facts = await queryWindowsSecuritySnapshot(requests);
        if (!removed && requests.some((request) => request.path.endsWith("\\next"))
          && requests.some((request) => request.path.endsWith("\\previous"))
          && requests.some((request) => request.path === original.toLowerCase())) {
          removed = true;
          const stage = requests.find((request) => request.path.endsWith("\\next"))!.path;
          fs.unlinkSync(stage);
        }
        return facts;
      },
    });

    await expect(apply(manager, "claude")).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_recovery_required",
    });
    expect(removed).toBe(true);
    expect(fs.readFileSync(original, "utf8")).toBe(JSON.stringify({ env: { OTHER: "keep" } }));
  }, 180_000);

  it.runIf(process.platform === "win32")("rejects an unexpected scratch child before renaming the live target", async () => {
    const original = seed(homeWithCrash(), ".claude/settings.json", "{}\n");
    let inserted = false;
    const manager = new FileAgentsManager({
      home: homes.at(-1)!,
      queryWindowsSecuritySnapshot: async (requests) => {
        const facts = await queryWindowsSecuritySnapshot(requests);
        const scratch = requests.find((request) => request.path.endsWith("\\previous"));
        if (!inserted && scratch !== undefined && requests.some((request) => request.path === original.toLowerCase())) {
          inserted = true;
          fs.writeFileSync(path.join(path.dirname(scratch.path), "unexpected"), "unrelated");
        }
        return facts;
      },
    });

    await expect(apply(manager, "claude")).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_recovery_required",
    });
    expect(inserted).toBe(true);
    expect(fs.readFileSync(original, "utf8")).toBe("{}\n");
  }, 180_000);

  it("rejects a changed-target race before publishing another changed target", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const catalog = path.join(h.home, ".codex/models.json");
    const config = path.join(h.home, ".codex/config.toml");
    const beforeCatalog = fs.readFileSync(catalog);
    const external = Buffer.from("model = \"external\"\n");
    const raceBatches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const manager = new FileAgentsManager({
      home: h.home,
      queryWindowsSecuritySnapshot: async (requests) => {
        raceBatches.push(requests);
        return await queryWindowsSecuritySnapshot(requests);
      },
      checkpoint: (point, agent, index) => {
        if (point === "staged" && agent === "codex" && index === 3) fs.writeFileSync(config, external);
      },
    });

    await expect(apply(manager, "codex", [...mappings].reverse())).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_conflict",
    });
    expect(fs.readFileSync(catalog)).toEqual(beforeCatalog);
    expect(fs.readFileSync(config)).toEqual(external);
    if (process.platform === "win32") {
      expectSnapshotContract(raceBatches, h.home, [
        ["$HOME", "$HOME\\.claude\\settings.json", "$HOME\\.codex", "$HOME\\.codex\\config.toml.ghcg.bak",
          "$HOME\\.codex\\models.json.ghcg.bak", "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml"],
        ["$HOME\\.codex", "$HOME\\.codex\\config.toml.ghcg.bak", "$HOME\\.codex\\models.json.ghcg.bak", "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml"],
        ["$HOME\\.codex", "$HOME\\.codex\\config.toml.ghcg.bak", "$HOME\\.codex\\models.json.ghcg.bak", "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml"],
        ["$HOME\\.codex", "$HOME\\.codex\\models.json"],
        ["$HOME\\.codex"],
        ["$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next", "$HOME\\.codex\\models.json"],
        ["$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next", "$HOME\\.codex\\models.json"],
        ["$HOME\\.codex", "$HOME\\.codex\\config.toml"],
        ["$HOME\\.codex"],
        ["$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next", "$HOME\\.codex\\config.toml"],
        ["$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next", "$HOME\\.codex\\config.toml"],
        ["$HOME\\.codex", "$HOME\\.codex\\config.toml.ghcg.bak", "$HOME\\.codex\\models.json.ghcg.bak", "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml",
          "$HOME\\.codex\\$SCRATCH0", "$HOME\\.codex\\$SCRATCH0\\next", "$HOME\\.codex\\$SCRATCH1", "$HOME\\.codex\\$SCRATCH1\\next"],
      ]);
    }
  }, 180_000);

  it("rejects a separate-process backup race before publishing repeat Apply", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const backup = path.join(h.home, ".codex/config.toml.ghcg.bak");
    const catalog = path.join(h.home, ".codex/models.json");
    const config = path.join(h.home, ".codex/config.toml");
    const beforeCatalog = fs.readFileSync(catalog);
    const beforeConfig = fs.readFileSync(config);
    const external = Buffer.from("external backup");
    const manager = new FileAgentsManager({
      home: h.home,
      checkpoint: (point, agent, index) => {
        if (point !== "staged" || agent !== "codex" || index !== 2) return;
        execFileSync(process.execPath, [
          "--input-type=commonjs",
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'), { mode: 0o600 })",
          backup,
          external.toString("base64"),
        ]);
      },
    });

    await expect(apply(manager, "codex", [...mappings].reverse())).rejects.toMatchObject({
      name: "AgentError",
      code: process.platform === "win32" ? "agent_unsafe_path" : "agent_conflict",
    });
    expect(fs.readFileSync(backup)).toEqual(external);
    expect(fs.readFileSync(catalog)).toEqual(beforeCatalog);
    expect(fs.readFileSync(config)).toEqual(beforeConfig);
    expect((await manager.inspect(origin)).find((item) => item.id === "codex")!.state)
      .toBe(process.platform === "win32" ? "unsafe_path" : "recovery_required");
  }, 180_000);

  it("rejects an unchanged catalog race before publishing current config changes", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const catalog = path.join(h.home, ".codex/models.json");
    const config = path.join(h.home, ".codex/config.toml");
    const externalConfig = Buffer.from(`${fs.readFileSync(config, "utf8")}# external setting\n`);
    const externalCatalog = Buffer.from("external catalog");
    fs.writeFileSync(config, externalConfig);
    const manager = new FileAgentsManager({
      home: h.home,
      checkpoint: (point, agent, index) => {
        if (point === "staged" && agent === "codex" && index === 3) fs.writeFileSync(catalog, externalCatalog);
      },
    });

    await expect(apply(manager, "codex")).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(catalog)).toEqual(externalCatalog);
    expect(fs.readFileSync(config)).toEqual(externalConfig);
  }, 180_000);

  it("rejects an unchanged config race before publishing catalog changes", async () => {
    const h = harness();
    await apply(h.manager, "codex");
    const catalog = path.join(h.home, ".codex/models.json");
    const config = path.join(h.home, ".codex/config.toml");
    const beforeCatalog = fs.readFileSync(catalog);
    const externalConfig = Buffer.from("model = \"external\"\n");
    const manager = new FileAgentsManager({
      home: h.home,
      checkpoint: (point, agent, index) => {
        if (point === "staged" && agent === "codex" && index === 2) fs.writeFileSync(config, externalConfig);
      },
    });
    const reordered = [mappings[0]!, mappings[2]!, mappings[1]!];

    await expect(apply(manager, "codex", reordered)).rejects.toThrow("agent conflict");
    expect(fs.readFileSync(catalog)).toEqual(beforeCatalog);
    expect(fs.readFileSync(config)).toEqual(externalConfig);
  }, 180_000);

  it("serializes concurrent applies from two Gateway instances sharing a home", async () => {
    const firstBatches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const secondBatches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const h = harness({ queryWindowsSecuritySnapshot: async (requests) => {
      firstBatches.push(requests);
      return await queryWindowsSecuritySnapshot(requests);
    } });
    const second = new FileAgentsManager({ home: h.home, queryWindowsSecuritySnapshot: async (requests) => {
      secondBatches.push(requests);
      return await queryWindowsSecuritySnapshot(requests);
    } });
    const reversed = [...mappings].reverse();
    const firstStatus = await h.status("claude");
    firstBatches.length = 0;
    secondBatches.length = 0;
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
    if (process.platform === "win32") {
      const target = "$HOME\\.claude\\settings.json";
      const backup = `${target}.ghcg.bak`;
      const scratch = "$HOME\\.claude\\$SCRATCH0";
      const winning = [
        ["$HOME", target],
        ["$HOME", target],
        ["$HOME", backup, target],
        ["$HOME", target],
        ["$HOME"],
        ["$HOME\\.claude"],
        [scratch, `${scratch}\\next`, target],
        [scratch, `${scratch}\\next`, target],
        ["$HOME\\.claude", backup, target, scratch, `${scratch}\\next`],
        [scratch, `${scratch}\\next`, target],
        ["$HOME\\.claude", backup, target, scratch, `${scratch}\\next`],
        ["$HOME\\.claude", backup, target],
      ];
      const contracts = [firstBatches, secondBatches]
        .map((batches) => snapshotContract(batches, h.home).map((snapshot) => snapshot.paths));
      expect(contracts).toContainEqual(winning);
      const losing = contracts.find((contract) => contract.length !== winning.length)!;
      // Lock scheduling determines whether the loser reaches its post-lock snapshot.
      expect([[ ["$HOME", target] ], [["$HOME", target], ["$HOME", target]]]).toContainEqual(losing);
      expectDistinctSnapshotIds(firstBatches, h.home);
      expectDistinctSnapshotIds(secondBatches, h.home);
    }
    expect((await h.status("claude")).state).toBe("installed");
  }, 300_000);

  it.runIf(process.platform === "win32")("refreshes pending status images after displaced validation rejects", async () => {
    const original = seed(homeWithCrash(), ".claude/settings.json", "{}\n");
    const crashed = new FileAgentsManager({
      home: homes.at(-1)!,
      checkpoint: (point, agent, index) => {
        if (point === "displaced" && agent === "claude" && index === 1) throw new Error("simulated crash");
      },
    });
    await expect(apply(crashed, "claude")).rejects.toThrow();
    const store = new AgentStore(stateRoot(homes.at(-1)!), "claude");
    const state = await store.read();
    const step = state.pending!.steps.find((candidate) => candidate.target === 1)!;
    fs.writeFileSync(path.join(step.scratch, "previous"), "invalid displaced bytes");
    let mutated = false;
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const manager = new FileAgentsManager({
      home: homes.at(-1)!,
      queryWindowsSecuritySnapshot: async (requests) => {
        batches.push(requests);
        const facts = await queryWindowsSecuritySnapshot(requests);
        if (!mutated && requests.some((request) => request.path.endsWith("\\previous"))) {
          mutated = true;
          fs.unlinkSync(`${original}.ghcg.bak`);
        }
        return facts;
      },
    });

    const status = (await manager.inspect(origin)).find((item) => item.id === "claude")!;

    expect(status).toMatchObject({ state: "recovery_required", backupAvailable: false });
    const displacedBatch = batches.findIndex((batch) => batch.some((request) => request.path.endsWith("\\previous")));
    const refresh = batches.slice(displacedBatch + 1).find((batch) => {
      const paths = batch.map((request) => request.path);
      return paths.includes(`${original}.ghcg.bak`.toLowerCase()) && paths.includes(original.toLowerCase());
    });
    expect(refresh).toBeDefined();
    expectSnapshotContract(batches, homes.at(-1)!, [
      ["$HOME\\.claude", "$HOME\\.claude\\settings.json.ghcg.bak", "$HOME\\.claude\\settings.json",
        "$HOME\\.claude\\$SCRATCH0", "$HOME\\.claude\\$SCRATCH0\\next",
        "$HOME\\.claude\\$SCRATCH1", "$HOME\\.claude\\$SCRATCH1\\next",
        "$HOME", "$HOME\\.codex\\models.json", "$HOME\\.codex\\config.toml",
        "$HOME\\.codex\\config.toml.ghcg.bak", "$HOME\\.codex\\models.json.ghcg.bak"],
      ["$HOME\\.claude\\$SCRATCH1", "$HOME\\.claude\\$SCRATCH1\\previous"],
      ["$HOME\\.claude", "$HOME\\.claude\\settings.json.ghcg.bak", "$HOME\\.claude\\settings.json",
        "$HOME\\.claude\\$SCRATCH0", "$HOME\\.claude\\$SCRATCH0\\next",
        "$HOME\\.claude\\$SCRATCH1", "$HOME\\.claude\\$SCRATCH1\\next"],
    ]);
  }, 180_000);

  it.runIf(process.platform === "win32")("keeps the exact linked-crash recovery snapshot contract", async () => {
    const home = homeWithCrash();
    seed(home, ".claude/settings.json", "{}\n");
    const crashed = new FileAgentsManager({
      home,
      checkpoint: (point, agent, index) => {
        if (point === "linked" && agent === "claude" && index === 1) throw new Error("simulated crash");
      },
    });
    await expect(apply(crashed, "claude")).rejects.toThrow();
    const batches: (readonly WindowsSecuritySnapshotRequest[])[] = [];
    const restarted = new FileAgentsManager({ home, queryWindowsSecuritySnapshot: async (requests) => {
      batches.push(requests);
      return await queryWindowsSecuritySnapshot(requests);
    } });
    const pending = (await restarted.inspect(origin)).find((item) => item.id === "claude")!;
    batches.length = 0;

    await restarted.apply({
      agent: "claude", expectedRevision: pending.revision, catalogRevision: "a".repeat(64), mappings,
    }, origin, models, () => undefined, new AbortController().signal);

    const target = "$HOME\\.claude\\settings.json";
    const backup = `${target}.ghcg.bak`;
    const scratch0 = "$HOME\\.claude\\$SCRATCH0";
    const scratch1 = "$HOME\\.claude\\$SCRATCH1";
    const full = ["$HOME\\.claude", backup, target,
      scratch0, `${scratch0}\\next`, scratch1, `${scratch1}\\next`];
    expectSnapshotContract(batches, home, [
      full,
      full,
      [scratch1, `${scratch1}\\previous`],
      full,
      ["$HOME\\.claude", backup, scratch0, `${scratch0}\\next`],
      [scratch1, `${scratch1}\\previous`],
      ["$HOME\\.claude", target, scratch1, `${scratch1}\\next`],
      full,
      [scratch1, `${scratch1}\\previous`],
      full,
      full,
      [scratch1, `${scratch1}\\previous`],
      [scratch1, `${scratch1}\\next`, target],
      ["$HOME\\.claude", backup, target],
      ["$HOME\\.claude", backup, target],
    ]);
  }, 180_000);

  it.each([
    ["intent", -1],
    ["stage_written", 0],
    ["staged", 0],
    ["linked", 0],
    ["published", 0],
    ["linked", 1],
    ["published", 1],
    ["linked", 2],
    ["published", 2],
    ["displaced", 3],
    ["published", 3],
  ] as const)("finishes Codex Apply after a crash at %s/%s without Restore", async (point, index) => {
    const original = Buffer.from("model = \"old\"\n# comment survives\n");
    const file = seed(homeWithCrash(), ".codex/config.toml", original);
    const nativeCatalog = index === 1 ? Buffer.from("native catalog\n") : null;
    if (nativeCatalog !== null) seed(homes.at(-1)!, ".codex/models.json", nativeCatalog);
    const crashed = new FileAgentsManager({
      home: homes.at(-1)!,
      now: () => new Date("2026-01-02T03:04:05Z"),
      checkpoint: (hitPoint, _agent, hitIndex) => {
        if (hitPoint === point && hitIndex === index) throw new Error("simulated crash");
      },
    });
    await expect(takeover(crashed)).rejects.toThrow();
    const restarted = new FileAgentsManager({ home: homes.at(-1)! });
    expect((await restarted.inspect(origin)).find((item) => item.id === "codex")).toMatchObject({
      state: "recovery_required",
      backupAvailable: !(new Set<string>(["intent", "stage_written", "staged"]).has(point)),
    });
    expect((await apply(restarted, "codex")).state).toBe("installed");
    expect(fs.readFileSync(`${file}.ghcg.bak`)).toEqual(original);
    if (nativeCatalog !== null) {
      expect(fs.readFileSync(path.join(homes.at(-1)!, ".codex/models.json.ghcg.bak"))).toEqual(nativeCatalog);
    }
    expect(fs.readFileSync(file, "utf8")).toContain("model = \"model-a\"");
    expect(fs.readdirSync(path.join(homes.at(-1)!, ".codex")).sort()).toEqual([
      "config.toml", "config.toml.ghcg.bak", "models.json", ...(nativeCatalog === null ? [] : ["models.json.ghcg.bak"]),
    ]);
  }, 300_000);

  for (const agent of ["claude", "codex"] as const) {
    it(`retains truthful ${agent} client paths when the managed directory becomes a reparse point`, async () => {
      const h = harness();
      const directory = path.join(h.home, agent === "claude" ? ".claude" : ".codex");
      seed(h.home, agent === "claude" ? ".claude/settings.json" : ".codex/config.toml",
        agent === "claude" ? "{}\n" : "model = \"old\"\n");
      if (agent === "codex") await takeover(h.manager); else await apply(h.manager, agent);
      const expectedPaths = agent === "claude"
        ? [path.join(directory, "settings.json")]
        : [path.join(directory, "models.json"), path.join(directory, "config.toml")];
      const displaced = `${directory}-displaced`;
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-elsewhere-"));
      homes.push(elsewhere);
      fs.renameSync(directory, displaced);
      fs.symlinkSync(elsewhere, directory, process.platform === "win32" ? "junction" : "dir");

      expect(await h.status(agent)).toMatchObject({
        state: "unsafe_path",
        backupAvailable: false,
        paths: expectedPaths.map((target) => process.platform === "win32" ? target.toLowerCase() : target),
      });
      await expect(apply(h.manager, agent)).rejects.toThrow("agent unsafe path");
    }, 180_000);

    it.skipIf(process.platform === "win32")(`retains truthful ${agent} client paths when each managed target becomes a symlink`, async () => {
      const h = harness();
      seed(h.home, agent === "claude" ? ".claude/settings.json" : ".codex/config.toml",
        agent === "claude" ? "{}\n" : "model = \"old\"\n");
      await apply(h.manager, agent);
      const expectedPaths = agent === "claude"
        ? [path.join(h.home, ".claude", "settings.json")]
        : [path.join(h.home, ".codex", "models.json"), path.join(h.home, ".codex", "config.toml")];
      const elsewhere = seed(h.home, `${agent}-replacement`, "untrusted replacement");
      for (const target of expectedPaths) {
        const current = fs.readFileSync(target);
        fs.unlinkSync(target);
        fs.symlinkSync(elsewhere, target, "file");

        expect(await h.status(agent)).toMatchObject({
          state: "unsafe_path",
          backupAvailable: true,
          paths: expectedPaths,
        });
        await expect(apply(h.manager, agent)).rejects.toThrow("agent unsafe path");
        fs.unlinkSync(target);
        fs.writeFileSync(target, current, { mode: 0o600 });
      }
    }, 180_000);
  }

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
    fs.chmodSync(path.join(h.home, ".ghc-gateway/agents/claude/state.db"), 0o644);
    expect((await h.status("claude")).state).toBe("unsafe_path");
  }, 180_000);
});

function snapshotContract(batches: readonly (readonly WindowsSecuritySnapshotRequest[])[], home: string) {
  const normalizedHome = home.toLowerCase();
  const scratches = new Map<string, string>();
  return batches.filter((batch) => batch[0]!.id.startsWith("snapshot-")).map((batch) => ({
    id: batch[0]!.id.replace(/-path-0$/u, ""),
    paths: batch.map((request) => request.path.replace(normalizedHome, "$HOME").replace(
      /\.ghcg-agents-(?:claude|codex)-[0-9a-f-]+/gu,
      (scratch) => {
        let token = scratches.get(scratch);
        if (token === undefined) {
          token = `$SCRATCH${scratches.size}`;
          scratches.set(scratch, token);
        }
        return token;
      },
    )),
  }));
}

function expectSnapshotContract(
  batches: readonly (readonly WindowsSecuritySnapshotRequest[])[],
  home: string,
  expectedPaths: readonly (readonly string[])[],
): void {
  const contract = snapshotContract(batches, home);
  expect(contract.map((snapshot) => snapshot.paths)).toEqual(expectedPaths);
  expectDistinctSnapshotIds(batches, home);
}

function expectDistinctSnapshotIds(
  batches: readonly (readonly WindowsSecuritySnapshotRequest[])[],
  home: string,
): void {
  const transactionBatches = batches.filter((batch) => batch[0]!.id.startsWith("snapshot-"));
  const contract = snapshotContract(transactionBatches, home);
  expect(new Set(contract.map((snapshot) => snapshot.id)).size).toBe(contract.length);
  for (const [batchIndex, batch] of transactionBatches.entries()) {
    expect(batch.map((request) => request.id)).toEqual(
      batch.map((_, pathIndex) => `${contract[batchIndex]!.id}-path-${pathIndex}`),
    );
  }
}

function homeWithCrash(): string {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ghcg-agents-")));
  homes.push(home);
  return home;
}
