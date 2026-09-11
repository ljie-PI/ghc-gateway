import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonIdentityFile, type DaemonIdentityLease } from "../../src/daemon/identity_file.js";
import { captureProcessStartIdentity } from "../../src/daemon/process_identity.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }));
  children.clear();
});

describe("daemon lifecycle coordination across CLI processes", () => {
  it("atomically initializes a fresh operation database for simultaneous first acquirers", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghcg-operation-first-acquirers-"));
    const dataDir = path.join(root, "data");
    const gatePath = path.join(root, "gate");
    const eventsPath = path.join(root, "events");
    try {
      const first = runContender(dataDir, gatePath, eventsPath, "first");
      const second = runContender(dataDir, gatePath, eventsPath, "second");
      await Promise.all([first.ready, second.ready]);
      await writeFile(gatePath, "go", "utf8");
      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

      expect(firstResult, firstResult.stderr).toEqual({ code: 0, stdout: "ready\ndone\n", stderr: "" });
      expect(secondResult, secondResult.stderr).toEqual({ code: 0, stdout: "ready\ndone\n", stderr: "" });
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n");
      expect(events).toMatchObject([
        expect.stringMatching(/^start:(first|second)$/u),
        expect.stringMatching(/^end:(first|second)$/u),
        expect.stringMatching(/^start:(first|second)$/u),
        expect.stringMatching(/^end:(first|second)$/u),
      ]);
      expect(events[0]?.slice(6)).toBe(events[1]?.slice(4));
      expect(events[2]?.slice(6)).toBe(events[3]?.slice(4));
      expect(events[0]?.slice(6)).not.toBe(events[2]?.slice(6));
      await expectProtectedValidDatabase(dataDir);
      expect(await operationArtifacts(dataDir)).toEqual([
        "daemon.operation.db",
        "daemon.operation.owner.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes status commands through the production operation lease", { timeout: 120_000 }, async () => {
    const fixture = await processFixture();
    try {
      const first = runStatus(fixture.dataDir);
      await vi.waitFor(() => expect(fixture.requests()).toBe(1), { timeout: 60_000 });
      expect(JSON.parse(await readFile(path.join(fixture.dataDir, "daemon.operation.owner.json"), "utf8")))
        .toMatchObject({ version: 1, state: "held", pid: first.child.pid });

      const second = runStatus(fixture.dataDir);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(fixture.requests()).toBe(1);
      fixture.releaseBlockedResponse();

      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
      expect(firstResult, firstResult.stderr).toMatchObject({ code: 0 });
      expect(secondResult, secondResult.stderr).toMatchObject({ code: 0 });
      expect(JSON.parse(firstResult.stdout)).toEqual(expectedStatus(fixture.dataDir, fixture.port));
      expect(JSON.parse(secondResult.stdout)).toEqual(expectedStatus(fixture.dataDir, fixture.port));
      expect(secondResult.stdout).toBe(firstResult.stdout);
      expect(firstResult.stderr).toBe("");
      expect(secondResult.stderr).toBe("");
      expect(fixture.requests()).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("recovers a crashed CLI owner only after its PID is proven dead", { timeout: 120_000 }, async () => {
    const fixture = await processFixture();
    try {
      const crashed = runStatus(fixture.dataDir);
      await vi.waitFor(() => expect(fixture.requests()).toBe(1), { timeout: 60_000 });
      const crashedPid = crashed.child.pid;
      expect(crashedPid).toBeTypeOf("number");
      crashed.child.kill();
      await crashed.result;
      await vi.waitFor(async () => {
        await expect(captureProcessStartIdentity(crashedPid!)).resolves.toBeNull();
      }, { timeout: 30_000 });

      fixture.releaseBlockedResponse();
      const recovered = runStatus(fixture.dataDir);
      const result = await recovered.result;
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expectedStatus(fixture.dataDir, fixture.port));
      expect(result.stderr).toBe("");
      expect(fixture.requests()).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("recovers real initialization crashes before publication and before temp cleanup", { timeout: 240_000 }, async () => {
    for (const phase of ["database_prepared", "database_published"] as const) {
      const fixture = await processFixture();
      try {
        const crashed = runCrashHolder(fixture.dataDir, phase);
        await expect(crashed.result).resolves.toEqual({ code: 23, stdout: `${phase}\n`, stderr: "" });
        expect((await operationArtifacts(fixture.dataDir)).some((name) =>
          name.startsWith(".daemon.operation.db.init-"))).toBe(true);

        const recovered = runStatus(fixture.dataDir);
        await vi.waitFor(() => expect(fixture.requests()).toBe(1), { timeout: 60_000 });
        fixture.releaseBlockedResponse();
        await expect(recovered.result).resolves.toMatchObject({ code: 0, stderr: "" });
        await expectProtectedValidDatabase(fixture.dataDir);
        expect(await operationArtifacts(fixture.dataDir)).toEqual([
          "daemon.operation.db",
          "daemon.operation.owner.json",
        ]);
      } finally {
        await fixture.close();
      }
    }
  });

  it("survives real process crashes after OS lock and after released publication", { timeout: 240_000 }, async () => {
    const fixture = await processFixture();
    try {
      const initialize = runStatus(fixture.dataDir);
      await vi.waitFor(() => expect(fixture.requests()).toBe(1), { timeout: 60_000 });
      fixture.releaseBlockedResponse();
      await expect(initialize.result).resolves.toMatchObject({ code: 0 });

      for (const phase of ["os_locked", "released_published"] as const) {
        const crashed = runCrashHolder(fixture.dataDir, phase);
        const crashedResult = await crashed.result;
        expect(crashedResult).toMatchObject({ code: 23, stdout: `${phase}\n`, stderr: "" });
        const recovered = runStatus(fixture.dataDir);
        await expect(recovered.result).resolves.toMatchObject({ code: 0, stderr: "" });
      }
      expect(fixture.requests()).toBe(3);
    } finally {
      await fixture.close();
    }
  });
});

async function processFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ghcg-lifecycle-processes-"));
  const dataDir = path.join(root, "data");
  const processStartIdentity = await captureProcessStartIdentity(process.pid);
  if (processStartIdentity === null) throw new Error("test process identity unavailable");
  let requestCount = 0;
  let blockedResponse: ServerResponse | undefined;
  let releaseFirst = false;
  const server = createServer((request, response) => {
    requestCount += 1;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/__ghcg/control/v1/status");
    expect(request.headers["x-ghcg-control-token"]).toBe("control-token");
    expect(request.headers["x-ghcg-instance-nonce"]).toBe("instance-nonce");
    if (requestCount === 1 && !releaseFirst) {
      blockedResponse = response;
      return;
    }
    writeStatus(response, processStartIdentity);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server address unavailable");
  const identityFile = new DaemonIdentityFile(dataDir);
  const identityLease = await identityFile.acquire({
    version: 1,
    managed: true,
    pid: process.pid,
    processStartIdentity,
    instanceNonce: "instance-nonce",
    controlToken: "control-token",
    port: address.port,
    createdAt: "2026-09-03T12:00:00.000Z",
  });
  return {
    dataDir,
    port: address.port,
    requests: () => requestCount,
    releaseBlockedResponse: () => {
      releaseFirst = true;
      if (blockedResponse !== undefined && !blockedResponse.destroyed) {
        writeStatus(blockedResponse, processStartIdentity);
      }
      blockedResponse = undefined;
    },
    close: async () => {
      closeIdentity(identityLease);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function writeStatus(response: ServerResponse, processStartIdentity: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: { state: "running", instance: {
    pid: process.pid,
    processStartIdentity,
    instanceNonce: "instance-nonce",
  } } }));
}

function runStatus(dataDir: string) {
  const child = spawn(process.execPath, [
    "scripts/tooling/bootstrap.mjs",
    "src/cli/main.ts",
    "--json",
    "--data-dir", dataDir,
    "status",
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, result };
}

function runContender(dataDir: string, gatePath: string, eventsPath: string, contender: string) {
  const child = spawn(process.execPath, [
    "scripts/tooling/bootstrap.mjs",
    "tests/fixtures/daemon_operation_contender.ts",
    dataDir,
    gatePath,
    eventsPath,
    contender,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let signalReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) signalReady();
  });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
  return { ready, result };
}

function runCrashHolder(
  dataDir: string,
  phase: "database_prepared" | "database_published" | "os_locked" | "released_published",
) {
  const child = spawn(process.execPath, [
    "scripts/tooling/bootstrap.mjs",
    "tests/fixtures/daemon_operation_crash.ts",
    dataDir,
    phase,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, result };
}

async function expectProtectedValidDatabase(dataDir: string): Promise<void> {
  const databasePath = path.join(dataDir, "daemon.operation.db");
  if (process.platform !== "win32") expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
  } finally {
    database.close();
  }
}

async function operationArtifacts(dataDir: string): Promise<string[]> {
  return (await readdir(dataDir)).filter((name) =>
    name.startsWith("daemon.operation") || name.startsWith(".daemon.operation")).sort();
}

function expectedStatus(dataDir: string, port: number) {
  return {
    ok: true,
    data: {
      state: "running",
      managed: true,
      pid: process.pid,
      startedAt: "2026-09-03T12:00:00.000Z",
      port,
      dataDir: path.resolve(dataDir),
    },
  };
}

function closeIdentity(lease: DaemonIdentityLease): void {
  lease.cleanup();
  lease.release();
}
