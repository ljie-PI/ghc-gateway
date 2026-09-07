import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { DeviceFlowService, type DeviceOAuthClient } from "../../src/accounts/device_flow.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { createCopilotEndpointDiscovery, refreshCopilotToken } from "../../src/copilot/credential_provider.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import type { TokenRefreshError } from "../../src/copilot/token_refresh.js";
import { isMainModule, runCli } from "../../src/cli/main.js";
import { CliError, HttpControlClient, ScriptedControlClient } from "../../src/cli/control_client.js";
import { CommandDispatcher, DispatcherControlClient } from "../../src/cli/commands/dispatcher.js";
import { exitCodeForError } from "../../src/cli/output.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { RuntimeConfigStore } from "../../src/config/runtime_config.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import { migration as historyMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as continuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { bootstrapGateway, createPublicRouteRegistrations } from "../../src/main.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { windowsCmdCommandLine } from "../../scripts/tooling/windows_cmd.js";

const encoder = new TextEncoder();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class CaptureStream {
  chunks = "";
  write(chunk: string): void {
    this.chunks += chunk;
  }
}

async function runCmd(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", windowsCmdCommandLine(command, args)], {
      cwd,
      env: testProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      void terminateProcessTree(child.pid).then(
        () => reject(new Error(`${path.basename(command)} did not exit before timeout`)),
        (error: unknown) => reject(error),
      );
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} failed with exit code ${String(code)}; stdout=${safeOutput(stdout)}; stderr=${safeOutput(stderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const script = [
      "function Stop-Tree([int]$id) {",
      "  Get-CimInstance Win32_Process -Filter \"ParentProcessId=$id\" | ForEach-Object { Stop-Tree ([int]$_.ProcessId) }",
      "  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue",
      "}",
      `Stop-Tree ${pid}`,
    ].join("; ");
    const killer = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", reject);
    killer.once("close", () => resolve());
  });
}

function testProcessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.NODE_OPTIONS = absoluteNodeOptionsPreloads(env.NODE_OPTIONS);
  for (const key of Object.keys(env)) {
    if (/^(?:GHC_GATEWAY_(?!CI_NETWORK_GUARD))/u.test(key)
      || /(?:token|secret|password|authorization|auth_token)/iu.test(key)) {
      delete env[key];
    }
  }
  return env;
}

function absoluteNodeOptionsPreloads(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const tokens = value.split(/\s+/u);
  return tokens.map((token, index) => {
    if (token.startsWith("--import=./scripts/tooling/")) {
      return `--import=${pathToFileURL(path.join(repoRoot, token.slice("--import=./".length))).href}`;
    }
    if (tokens[index - 1] === "--import" && token.startsWith("./scripts/tooling/")) {
      return pathToFileURL(path.join(repoRoot, token.slice(2))).href;
    }
    return token;
  }).join(" ");
}

function safeOutput(value: string): string {
  return value.trim().replaceAll(/[\r\n]+/gu, " ").slice(0, 512);
}

describe("CLI commands", () => {
  it("recognizes the direct CLI entrypoint only when argv names that module", () => {
    const entry = path.join(repoRoot, "src", "cli", "main.ts");

    expect(isMainModule(pathToFileURL(entry).href, entry)).toBe(true);
    expect(isMainModule(pathToFileURL(entry).href, path.join(repoRoot, "src", "main.ts"))).toBe(false);
    expect(isMainModule(pathToFileURL(entry).href, undefined)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("recognizes a POSIX executable symlink as the CLI main module", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ghcg-bin-link-"));
    const target = path.join(directory, "main.js");
    const link = path.join(directory, "ghcg");
    await writeFile(target, "");
    try {
      await symlink(target, link, "file");
      expect(isMainModule(pathToFileURL(target).href, link)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("dispatches through a Windows command shim and forwards arguments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ghcg-bin-shim-"));
    const shim = path.join(directory, "ghcg.cmd");
    try {
      await writeFile(shim, [
        "@echo off",
        `"${process.execPath}" "${path.join(repoRoot, "scripts", "tooling", "bootstrap.mjs")}" "${path.join(repoRoot, "src", "cli", "main.ts")}" %*`,
        "",
      ].join("\r\n"));

      const result = await runCmd(shim, ["--json", "auth", "login", "--help"], directory);

      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: { help: expect.stringContaining("Usage: ghcg [--data-dir <path>] [--json] auth login [--host <domain>]") },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates human stdout/stderr, JSON envelopes, and exit codes", async () => {
    const client = new ScriptedControlClient({
      "accounts.list": [{ defaultRevision: 1, defaultAccountId: null, items: [] }],
      "lifecycle.status": [{ state: "stopped", managed: null, pid: null, startedAt: null, port: null, dataDir: "wrong" }],
      "models.current": [new CliError("revision_conflict")],
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli({ argv: ["accounts", "list"], homedir: "Q:/tmp/home", stdout, stderr, controlClient: client })).toBe(0);
    expect(stdout.chunks).toBe(`${JSON.stringify({ defaultRevision: 1, defaultAccountId: null, items: [] }, null, 2)}\n`);
    expect(stderr.chunks).toBe("");

    const statusOut = new CaptureStream();
    expect(await runCli({ argv: ["--json", "status"], homedir: "Q:/tmp/home", stdout: statusOut, stderr, controlClient: client })).toBe(3);
    expect(statusOut.chunks).toBe(`${JSON.stringify({ ok: true, data: { state: "stopped", managed: null, pid: null, startedAt: null, port: null, dataDir: "wrong" } })}\n`);

    const errorOut = new CaptureStream();
    const errorErr = new CaptureStream();
    expect(await runCli({ argv: ["--json", "models", "current"], homedir: "Q:/tmp/home", stdout: errorOut, stderr: errorErr, controlClient: client })).toBe(3);
    expect(errorOut.chunks).toBe("");
    expect(errorErr.chunks).toBe(`${JSON.stringify({ ok: false, error: { code: "revision_conflict", message: "revision conflict" } })}\n`);

    const parseErr = new CaptureStream();
    expect(await runCli({ argv: ["--json", "--bogus"], homedir: "Q:/tmp/home", stdout: new CaptureStream(), stderr: parseErr, controlClient: client })).toBe(2);
    expect(parseErr.chunks).toBe(`${JSON.stringify({ ok: false, error: { code: "usage_error", message: "usage error" } })}\n`);

    const helpOut = new CaptureStream();
    expect(await runCli({ argv: ["--json", "auth", "--help"], homedir: "Q:/tmp/home", stdout: helpOut, stderr: new CaptureStream(), controlClient: client })).toBe(0);
    expect(JSON.parse(helpOut.chunks)).toMatchObject({ ok: true, data: { help: expect.stringContaining("Usage: ghcg") } });
  });

  it("sends exact control operations to the selected data directory", async () => {
    const client = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 5, nextPollAt: "2026-09-01T23:45:05.000Z" }],
      "admin.open": [{ opened: true }],
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli({ argv: ["--json", "--data-dir", "selected", "auth", "login", "--host", "ghe.example.com"], homedir: "Q:/tmp/home", stdout, stderr, controlClient: client })).toBe(0);
    expect(JSON.parse(stdout.chunks)).toEqual({ ok: true, data: { flowId: "flow", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 5, nextPollAt: "2026-09-01T23:45:05.000Z" } });
    expect(stderr.chunks).toBe("");
    expect(client.calls[0]).toEqual({ kind: "control", operation: "auth.login.start", args: { host: "ghe.example.com" }, dataDir: expect.stringContaining("selected") });

    const adminOut = new CaptureStream();
    expect(await runCli({ argv: ["--data-dir", "selected", "admin", "open"], homedir: "Q:/tmp/home", stdout: adminOut, stderr, controlClient: client })).toBe(0);
    expect(adminOut.chunks).toBe(`${JSON.stringify({ opened: true }, null, 2)}\n`);
    expect(client.calls[1]).toEqual({ kind: "admin.open", operation: "admin.open", args: {}, dataDir: expect.stringContaining("selected") });
  });

  it("polls interactive login until terminal and handles interruption without leaking tokens", async () => {
    const client = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 1, nextPollAt: "2026-09-01T23:45:01.000Z" }],
      "auth.login.poll": [{ state: "pending", pollIntervalSeconds: 6, nextPollAt: "2026-09-01T23:45:07.000Z" }, { state: "complete", account: accountDto("github.com/42") }],
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli({ argv: ["auth", "login"], homedir: "Q:/tmp/home", stdout, stderr, controlClient: client, pollDelayMs: 0 })).toBe(0);
    expect(stdout.chunks).toBe("Code: ABCD-1234\nOpen: https://github.com/login/device\nAuthenticated: github.com/42\n");
    expect(stdout.chunks).not.toContain("token");
    expect(stderr.chunks).toBe("");

    const abort = new AbortController();
    const interrupted = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "WXYZ-9999", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 30, nextPollAt: "2026-09-01T23:45:30.000Z" }],
      "auth.login.poll": [{ state: "pending", pollIntervalSeconds: 30, nextPollAt: "2026-09-01T23:46:00.000Z" }],
      "auth.login.cancel": [{ state: "canceled" }],
    });
    const interruptedErr = new CaptureStream();
    abort.abort();
    expect(await runCli({ argv: ["auth", "login"], homedir: "Q:/tmp/home", stdout: new CaptureStream(), stderr: interruptedErr, controlClient: interrupted, shutdownSignal: abort.signal })).toBe(130);
    expect(interruptedErr.chunks).toBe("error: interrupted\n");
    expect(interrupted.calls.some((call) => call.operation === "auth.login.cancel")).toBe(true);

    const completedDuringCancel = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "DONE-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 30, nextPollAt: "2026-09-01T23:45:30.000Z" }],
      "auth.login.cancel": [{ state: "complete", accountId: "github.com/42" }],
    });
    const completedOut = new CaptureStream();
    const completedErr = new CaptureStream();
    expect(await runCli({
      argv: ["auth", "login"],
      homedir: "Q:/tmp/home",
      stdout: completedOut,
      stderr: completedErr,
      controlClient: completedDuringCancel,
      shutdownSignal: abort.signal,
    })).toBe(0);
    expect(completedOut.chunks).toContain("Authenticated: github.com/42");
    expect(completedErr.chunks).toBe("");
  });

  it("updates interactive login cadence from pending poll results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T23:45:00.000Z"));
    try {
      const client = new ScriptedControlClient({
        "auth.login.start": [{
          flowId: "flow",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2026-09-02T00:00:00.000Z",
          pollIntervalSeconds: 1,
          nextPollAt: "2026-09-01T23:45:01.000Z",
        }],
        "auth.login.poll": [
          { state: "pending", pollIntervalSeconds: 6, nextPollAt: "2026-09-01T23:45:07.000Z" },
          { state: "complete", account: accountDto("github.com/42") },
        ],
      });

      const login = runCli({
        argv: ["auth", "login"],
        homedir: "Q:/tmp/home",
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        controlClient: client,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(login).resolves.toBe(0);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["expired", "authorization expired"],
    ["denied", "authorization denied"],
    ["failed", "authorization failed"],
  ] as const)("reports interactive login %s distinctly", async (state, message) => {
    const client = new ScriptedControlClient({
      "auth.login.start": [{
        flowId: "flow",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: "2026-09-02T00:00:00.000Z",
        pollIntervalSeconds: 1,
        nextPollAt: "2026-09-01T23:45:01.000Z",
      }],
      "auth.login.poll": [{ state }],
      "auth.login.cancel": [{ state: "canceled" }],
    });
    const stderr = new CaptureStream();
    expect(await runCli({
      argv: ["auth", "login"],
      homedir: "Q:/tmp/home",
      stdout: new CaptureStream(),
      stderr,
      controlClient: client,
      pollDelayMs: 0,
    })).toBe(5);
    expect(stderr.chunks).toBe(`error: ${message}\n`);
  });

  it("falls back to the last interval for an older daemon without scheduling fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T23:45:00.000Z"));
    try {
      const client = new ScriptedControlClient({
        "auth.login.start": [{
          flowId: "flow",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2026-09-02T00:00:00.000Z",
          pollIntervalSeconds: 2,
        }],
        "auth.login.poll": [
          { state: "pending" },
          { state: "complete", account: accountDto("github.com/42") },
        ],
      });
      const login = runCli({
        argv: ["auth", "login"],
        homedir: "Q:/tmp/home",
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        controlClient: client,
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(login).resolves.toBe(0);
      expect(client.calls.filter((call) => call.operation === "auth.login.poll")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches management commands through application modules with one CAS attempt", async () => {
    const harness = await dispatcherHarness();
    try {
      const client = new DispatcherControlClient(harness.dispatcher);
      const login = await client.request("auth.login.start", { host: "github.com" }, { dataDir: "unused" });
      expect(login.pollIntervalSeconds).toBe(5);
      harness.advanceTime(5_000);
      const poll = await client.request("auth.login.poll", { flowId: login.flowId }, { dataDir: "unused" });
      expect(poll).toMatchObject({ state: "complete", account: { accountId: "github.com/42" } });
      expect(await client.request("accounts.list", {}, { dataDir: "unused" })).toMatchObject({ defaultAccountId: "github.com/42", defaultRevision: 1 });
      const originalGet = harness.directory.preferences.get.bind(harness.directory.preferences);
      let forceMissingPreferenceConflict = true;
      harness.directory.preferences.get = (accountId: string) => {
        const current = originalGet(accountId);
        if (accountId === "github.com/42" && forceMissingPreferenceConflict && current === null) {
          forceMissingPreferenceConflict = false;
          harness.directory.preferences.set(accountId, { modelId: "gpt", catalogGeneration: 0 }, 0);
          return null;
        }
        return current;
      };
      await expect(client.request("models.list", {}, { dataDir: "unused" })).resolves.toMatchObject({
        accountId: "github.com/42",
      });
      harness.directory.preferences.get = originalGet;
      expect(await client.request("models.list", {}, { dataDir: "unused" })).toMatchObject({ accountId: "github.com/42", items: [{ id: "gpt" }] });
      expect(await client.request("models.set", { modelId: "gpt" }, { dataDir: "unused" })).toMatchObject({ accountId: "github.com/42", modelId: "gpt", validity: "valid" });
      const isCurrent = harness.catalog.isCurrent.bind(harness.catalog);
      harness.catalog.isCurrent = () => false;
      await expect(client.request("models.set", { modelId: "gpt" }, { dataDir: "unused" }))
        .rejects.toMatchObject({ code: "revision_conflict" });
      await client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(harness.directory.preferences.get("github.com/42")).toMatchObject({
        modelId: "gpt",
        validity: "valid",
      });
      harness.catalog.isCurrent = isCurrent;
      await client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(harness.directory.preferences.get("github.com/42")?.validity).toBe("valid");
      harness.catalog.invalidate("github.com/42");
      harness.capiModels = [];
      await client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(harness.directory.preferences.get("github.com/42")?.validity).toBe("invalid");
      harness.catalog.invalidate("github.com/42");
      harness.capiModels = [{ id: "claude", name: "Claude", vendor: "anthropic", model_picker_enabled: true }];
      expect(await client.request("models.set", { modelId: "claude" }, { dataDir: "unused" })).toMatchObject({ accountId: "github.com/42", modelId: "claude", validity: "valid" });
      harness.catalog.invalidate("github.com/42");
      harness.capiModels = [];
      const getPreference = harness.directory.preferences.get.bind(harness.directory.preferences);
      let forcePreferenceConflict = true;
      harness.directory.preferences.get = (accountId: string) => {
        const current = getPreference(accountId);
        if (accountId === "github.com/42" && forcePreferenceConflict && current !== null) {
          forcePreferenceConflict = false;
          harness.directory.preferences.set(accountId, { modelId: "gpt", catalogGeneration: 99 }, current.revision);
        }
        return current;
      };
      await expect(client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" }))
        .resolves.toMatchObject({ accountId: "github.com/42" });
      expect(await client.request("config.get", { key: "admission.activeMax" }, { dataDir: "unused" })).toMatchObject({ key: "admission.activeMax", value: 4 });
      await expect(client.request("config.get", { key: "toString" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "not_found" });
      expect(await client.request("config.set", { key: "admission.activeMax", value: "2" }, { dataDir: "unused" })).toMatchObject({ config: { admission: { activeMax: 2, queueMax: 16 } } });
      const readSnapshot = harness.runtimeConfig.readSnapshot.bind(harness.runtimeConfig);
      let forceConflict = true;
      harness.runtimeConfig.readSnapshot = () => {
        if (forceConflict) {
          forceConflict = false;
          harness.runtimeConfig.update(defaultRuntimeConfigSnapshot(), harness.runtimeConfig.readRevision());
        }
        return readSnapshot();
      };
      await expect(client.request("config.set", { key: "admission.activeMax", value: "3" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(client.request("config.set", { key: "port", value: "31401" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "validation_error" });
      await expect(client.request("models.set", { modelId: "missing" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "not_found" });
      expect(await client.request("auth.status", {}, { dataDir: "unused" })).toMatchObject({ defaultAccountId: "github.com/42", accounts: [{ accountId: "github.com/42" }] });
      const removed = await client.request("accounts.remove", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(removed.state).toBe("removed");
    } finally {
      harness.close();
    }
  });

  it("returns device-flow expired and failed terminal states without retaining flow state", async () => {
    let nowValue = 1_800_000_000_000;
    const expiredHarness = await dispatcherHarness({ device: expiringDeviceClient(), now: () => nowValue });
    try {
      const client = new DispatcherControlClient(expiredHarness.dispatcher);
      const started = await client.request("auth.login.start", {}, { dataDir: "unused" });
      nowValue += 2_000;
      expect(await client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).toEqual({ state: "expired" });
      expect(await client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).toEqual({ state: "expired" });
    } finally {
      expiredHarness.close();
    }

    const failedHarness = await dispatcherHarness({ device: failedDeviceClient() });
    try {
      const client = new DispatcherControlClient(failedHarness.dispatcher);
      const started = await client.request("auth.login.start", {}, { dataDir: "unused" });
      failedHarness.advanceTime(5_000);
      expect(await client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).toEqual({ state: "failed" });
      expect(await client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).toEqual({ state: "failed" });
    } finally {
      failedHarness.close();
    }
  });

  it("maps device OAuth remote failures to CLI remote_error exit 5", async () => {
    const harness = await dispatcherHarness({ device: {
      async requestDeviceCode() {
        const error = new Error("secret remote response");
        error.name = "DeviceOAuthError";
        throw error;
      },
      async exchangeDeviceCode() {
        return { status: "failed" };
      },
    } });
    try {
      const client = new DispatcherControlClient(harness.dispatcher);
      await expect(client.request("auth.login.start", {}, { dataDir: "unused" }))
        .rejects.toMatchObject({ code: "remote_error" });
      const error = await client.request("auth.login.start", {}, { dataDir: "unused" }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: "remote_error" });
      expect(exitCodeForError((error as CliError).code)).toBe(5);
    } finally {
      harness.close();
    }
  });

  it("uses the protected loopback control transport when an identity exists", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const opened: string[] = [];
    const client = new HttpControlClient(async (url, init) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      const body = init?.body;
      if (typeof body === "string" && body.includes("\"operation\":\"config.set\"")) {
        return new Response(JSON.stringify({ error: { code: "revision_conflict", message: "revision conflict" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/admin-bootstrap")) {
        return new Response(JSON.stringify({ data: { token: "bootstrap-secret", expiresAt: "2026-09-02T00:01:00.000Z" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, async () => ({
      managed: false,
      pid: 123,
      processStartIdentity: "start",
      instanceNonce: "nonce",
      controlToken: "control-token",
      port: 31_400,
    }), async (url) => {
      opened.push(url);
    }, async () => "start");
    await client.request("config.get", {}, { dataDir: "selected" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:31400/__ghcg/control/v1/command");
    expect(calls[0]?.init?.headers).toMatchObject({
      "x-ghcg-control-token": "control-token",
      "x-ghcg-instance-nonce": "nonce",
    });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ operation: "config.get", arguments: {} }));

    await expect(client.request("config.set", { key: "admission.activeMax", value: "2" }, { dataDir: "selected" })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await client.adminOpen({ dataDir: "selected" })).toEqual({ opened: true });
    expect(opened).toEqual(["http://127.0.0.1:31400/admin/#bootstrap_token=bootstrap-secret"]);

    const unavailable = new HttpControlClient(fetch, async () => null);
    await expect(unavailable.request("config.get", {}, { dataDir: "missing" })).rejects.toMatchObject({ code: "unavailable" });

    const foreground = new HttpControlClient(fetch, async () => ({
      managed: false,
      pid: 123,
      processStartIdentity: "start",
      controlToken: "control-token",
      instanceNonce: "nonce",
      port: 31_400,
    }), undefined, async () => "start");
    await expect(foreground.lifecycle("stop", { dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });
    await expect(foreground.lifecycle("restart", { dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });

    const unreachable = new HttpControlClient(async () => {
      throw new TypeError("offline");
    }, async () => ({
      managed: true,
      pid: 123,
      processStartIdentity: "start",
      controlToken: "control-token",
      instanceNonce: "nonce",
      port: 31_400,
    }), undefined, async () => "start");
    await expect(unreachable.lifecycle("status", { dataDir: "selected" })).resolves.toMatchObject({ state: "unreachable" });
  });

  it("maps control timeout and caller abort without leaking as daemon failures", async () => {
    const endpoint = async () => ({
      managed: true,
      pid: 123,
      processStartIdentity: "start",
      controlToken: "control-token",
      instanceNonce: "nonce",
      port: 31_400,
    });
    const never = new HttpControlClient(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }), endpoint, undefined, async () => "start");
    await expect(never.request("config.get", {}, { dataDir: "selected", timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });

    const abort = new AbortController();
    const aborted = new HttpControlClient(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      abort.abort();
    }), endpoint, undefined, async () => "start");
    await expect(aborted.request("config.get", {}, { dataDir: "selected", signal: abort.signal })).rejects.toMatchObject({ code: "interrupted" });
  });

  it("verifies process identity before sending management or admin secrets", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} })));
    const endpoint = async () => ({
      managed: true,
      pid: 123,
      processStartIdentity: "windows:1",
      controlToken: "control-token",
      instanceNonce: "nonce",
      port: 31_400,
    });
    const client = new HttpControlClient(fetchImpl, endpoint, undefined, async () => "windows:2");

    await expect(client.request("config.get", {}, { dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });
    await expect(client.adminOpen({ dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });
    await expect(client.lifecycle("status", { dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("foreground serve emits one running result and closes on shutdown", async () => {
    const abort = new AbortController();
    let listened = false;
    let closed = false;
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const run = runCli({
      argv: ["serve", "--port", "31403"],
      homedir: "Q:/tmp/home",
      stdout,
      stderr,
      pid: 123,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      daemonRuntimeDependencies: {
        pid: 123,
        now: () => new Date("2026-09-02T00:00:00.000Z"),
        createSecret: () => "test-secret",
        captureProcessIdentity: async () => "windows:1",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => true,
          release() {},
        }),
        createLogger: () => ({ write() {} }),
      },
      shutdownSignal: abort.signal,
      createGateway: async (startup) => ({
        fetch: async () => new Response(null, { status: 404 }),
        listen: async () => {
          listened = true;
          return { host: "127.0.0.1", port: startup.port };
        },
        close: async () => {
          closed = true;
        },
      }),
    });
    await Promise.resolve();
    await eventually(() => listened);
    expect(stderr.chunks).toBe("");
    expect(JSON.parse(stdout.chunks)).toEqual({ state: "running", managed: false, pid: 123, startedAt: "2026-09-02T00:00:00.000Z", port: 31_403, dataDir: expect.any(String) });
    abort.abort();
    expect(await run).toBe(0);
    expect(closed).toBe(true);
  });

  it("renders foreground stop/restart conflicts as canonical errors", async () => {
    for (const action of ["stop", "restart"] as const) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const result = await runCli({
        argv: ["--data-dir", "selected", action],
        stdout,
        stderr,
        daemonController: {
          start: async () => { throw new Error("unused"); },
          status: async () => { throw new Error("unused"); },
          stop: async () => ({ state: "conflict", managed: false, pid: 42, startedAt: null, port: 31400, dataDir: "selected" }),
          restart: async () => ({ state: "conflict", managed: false, pid: 42, startedAt: null, port: 31400, dataDir: "selected" }),
        },
      });
      expect(result).toBe(5);
      expect(stdout.chunks).toBe("");
      expect(stderr.chunks).toContain("daemon conflict");
    }
  });

  it("returns 130 when foreground serve closes for SIGINT", async () => {
    const abort = new AbortController();
    const run = runCli({
      argv: ["serve"],
      homedir: "Q:/tmp/home",
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      shutdownSignal: abort.signal,
      daemonRuntimeDependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({ identity, cleanup: () => true, release() {} }),
        createLogger: () => ({ write() {} }),
      },
      createGateway: async () => ({
        fetch: async () => new Response(null),
        listen: async () => {
          abort.abort(new CliError("interrupted"));
          return { host: "127.0.0.1", port: 31_400 };
        },
        close: async () => undefined,
      }),
    });
    expect(await run).toBe(130);
  });

  it("routes lifecycle commands through the injected daemon controller", async () => {
    const controller = {
      start: vi.fn(async (startup) => ({ state: "running", managed: true, pid: 42, startedAt: "2026-09-03T00:00:00.000Z", port: startup.port, dataDir: startup.dataDir } as const)),
      stop: vi.fn(),
      restart: vi.fn(),
      status: vi.fn(),
    };
    const stdout = new CaptureStream();
    expect(await runCli({
      argv: ["--data-dir", "selected", "start", "--port", "31409"],
      homedir: "Q:/tmp/home",
      stdout,
      stderr: new CaptureStream(),
      daemonController: controller,
    })).toBe(0);
    expect(controller.start).toHaveBeenCalledWith(expect.objectContaining({ port: 31_409, dataDir: expect.stringContaining("selected") }), {});
    expect(JSON.parse(stdout.chunks)).toMatchObject({ state: "running", managed: true, pid: 42 });
  });

  it("reports daemon identity security failures with exit code 4", async () => {
    const stderr = new CaptureStream();
    expect(await runCli({
      argv: ["status"],
      homedir: "Q:/tmp/home",
      stdout: new CaptureStream(),
      stderr,
      daemonController: {
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        status: vi.fn(async () => { throw new CliError("security_error"); }),
      },
    })).toBe(4);
    expect(stderr.chunks).toBe("error: security error\n");
  });

  it("foreground composition registers all completed public routes without legacy fallback", async () => {
    const harness = await dispatcherHarness();
    try {
      await harness.directory.upsertAuthenticated({
        host: "github.com",
        userId: "42",
        secret: { generation: 0, githubToken: "gho_scripted" },
      });
      const routes = createPublicRouteRegistrations({
        directory: harness.directory,
        catalog: harness.catalog,
        copilot: harness.backend,
        history: harness.history,
      });
      expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
        "GET /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/messages",
        "POST /v1/responses",
      ]);
      const gateway = await bootstrapGateway({
        startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/home" }),
        routes,
        dependencies: { createRequestId: () => "req_cli_routes" },
      });
      try {
        for (const request of [
          new Request("http://127.0.0.1:31400/api/version"),
          new Request("http://127.0.0.1:31400/api/tags"),
          new Request("http://127.0.0.1:31400/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          new Request("http://127.0.0.1:31400/models"),
        ]) {
          const response = await gateway.fetch(request);
          expect(response.status, `${request.method} ${new URL(request.url).pathname}`).toBe(404);
          expect(await response.text()).toBe("404 Not Found");
        }
      } finally {
        await gateway.close();
      }
    } finally {
      harness.close();
    }
  });

  it("classifies production Copilot token refresh failures without leaking response bodies", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ token: "copilot-token", expires_in: 120 }), { status: 200 }));
    await expect(refreshCopilotToken("gho_secret")).resolves.toMatchObject({ token: "copilot-token" });

    vi.stubGlobal("fetch", async () => new Response("secret upstream body", { status: 401 }));
    await expect(refreshCopilotToken("gho_secret")).rejects.toMatchObject({ code: "unauthorized" } satisfies Partial<TokenRefreshError>);

    vi.stubGlobal("fetch", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(refreshCopilotToken("gho_secret")).rejects.toMatchObject({ name: "AbortError" });

    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const timedOut = expect(refreshCopilotToken("gho_secret")).rejects.toMatchObject({ code: "timeout" } satisfies Partial<TokenRefreshError>);
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
    vi.useRealTimers();

    let cancelled = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 }));
    await expect(refreshCopilotToken("gho_secret")).rejects.toMatchObject({ code: "network" } satisfies Partial<TokenRefreshError>);
    expect(cancelled).toBe(true);
  });

  it("parses Copilot endpoint discovery success and falls back on malformed responses", async () => {
    const store = new MemoryCredentialStore();
    await store.putGeneration("github.com/42", 1, { generation: 1, githubToken: "gho_secret" });
    const account = {
      accountId: "github.com/42",
      environment: {
        kind: "github.com" as const,
        host: "github.com" as const,
        webBaseUrl: "https://github.com" as const,
        apiBaseUrl: "https://api.github.com" as const,
        clientId: "Iv1.b507a08c87ecfe98" as const,
        deviceCodeUrl: "https://github.com/login/device/code" as const,
        accessTokenUrl: "https://github.com/login/oauth/access_token" as const,
      },
      userId: "42",
      login: null,
      displayName: null,
      credentialGeneration: 1,
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      copilot_plan: "individual",
      quota_reset_date: "2026-09-02",
      quota_snapshots: {
        chat: { entitlement: 1, remaining: 1, percent_remaining: 100, unlimited: false },
        completions: { entitlement: 1, remaining: 1, percent_remaining: 100, unlimited: false },
        premium_interactions: { entitlement: 1, remaining: 1, percent_remaining: 100, unlimited: false },
      },
      endpoints: { api: "https://api.githubcopilot.com/custom" },
    }), { status: 200 }));
    await expect(createCopilotEndpointDiscovery(store)(account)).resolves.toBe("https://api.githubcopilot.com/custom");

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ endpoints: {} }), { status: 200 }));
    await expect(createCopilotEndpointDiscovery(store)(account)).resolves.toBeNull();

    vi.stubGlobal("fetch", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(createCopilotEndpointDiscovery(store)(account)).rejects.toMatchObject({ name: "AbortError" });

    let discoveryCancelled = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        discoveryCancelled = true;
      },
    }), { status: 500 }));
    await expect(createCopilotEndpointDiscovery(store)(account)).resolves.toBeNull();
    expect(discoveryCancelled).toBe(true);

    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const discoveryTimedOut = expect(createCopilotEndpointDiscovery(store)(account)).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    await discoveryTimedOut;
    vi.useRealTimers();
  });
});

async function dispatcherHarness(options: {
  readonly device?: DeviceOAuthClient;
  readonly now?: () => number;
} = {}): Promise<{
  readonly dispatcher: CommandDispatcher;
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly backend: ScriptedCopilotBackend;
  readonly history: SqliteResponsesHistory;
  readonly runtimeConfig: RuntimeConfigStore;
  capiModels: Array<{ readonly id: string; readonly name: string; readonly vendor: string; readonly model_picker_enabled: boolean }>;
  readonly close: () => void;
  readonly advanceTime: (milliseconds: number) => void;
}> {
  const clock = { value: 1_800_000_000_000 };
  const now = options.now ?? (() => clock.value);
  const database = openDatabase({
    path: ":memory:",
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(historyMigration),
      embedMigration(continuationMigration),
    ],
    nowMs: now,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), now);
  const harness = {
    capiModels: [{ id: "gpt", name: "GPT", vendor: "openai", model_picker_enabled: true }],
  };
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return { data: harness.capiModels };
    },
  });
  const runtimeConfig = new RuntimeConfigStore(database, now);
  runtimeConfig.seedIfEmpty({});
  const history = new SqliteResponsesHistory(database, { nowMs: now });
  const backend = new ScriptedCopilotBackend({
    chat: { status: 200, headers: new Headers(), body: encoder.encode("{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}") },
    responses: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
  });
  const dispatcher = new CommandDispatcher({
    directory,
    deviceFlows: new DeviceFlowService(directory, options.device ?? deviceClient(), now),
    catalog,
    runtimeConfig,
  });
  return {
    dispatcher,
    directory,
    catalog,
    backend,
    history,
    runtimeConfig,
    advanceTime: (milliseconds) => { clock.value += milliseconds; },
    get capiModels() {
      return harness.capiModels;
    },
    set capiModels(value) {
      harness.capiModels = value;
    },
    close: () => closeDatabase(database),
  };
}

function expiringDeviceClient(): DeviceOAuthClient {
  return {
    async requestDeviceCode() {
      return {
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSec: 5,
        expiresInSec: 1,
      };
    },
    async exchangeDeviceCode() {
      return { status: "pending" };
    },
  };
}

function failedDeviceClient(): DeviceOAuthClient {
  return {
    async requestDeviceCode() {
      return {
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSec: 5,
        expiresInSec: 900,
      };
    },
    async exchangeDeviceCode() {
      return { status: "failed" };
    },
  };
}

function deviceClient(): DeviceOAuthClient {
  return {
    async requestDeviceCode() {
      return {
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSec: 5,
        expiresInSec: 900,
      };
    },
    async exchangeDeviceCode() {
      return {
        status: "complete",
        accessToken: "gho_scripted",
        user: { id: "42", login: "octo", name: "Octo" },
      };
    },
  };
}

function accountDto(accountId: string) {
  return {
    accountId,
    host: "github.com",
    numericUserId: "42",
    login: "octo",
    displayName: "Octo",
    state: "active" as const,
    revision: 1,
    authenticatedAt: "2026-09-02T00:00:00.000Z",
    preferredModel: null,
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not met");
}
