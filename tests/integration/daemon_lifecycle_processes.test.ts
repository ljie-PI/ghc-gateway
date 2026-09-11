import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it("serializes status commands through the production operation lease", { timeout: 120_000 }, async () => {
    const fixture = await processFixture();
    try {
      const first = runStatus(fixture.dataDir);
      await vi.waitFor(() => expect(fixture.requests()).toBe(1), { timeout: 60_000 });
      expect(JSON.parse(await readFile(path.join(fixture.dataDir, "daemon.operation.lock"), "utf8")))
        .toMatchObject({ version: 1, pid: first.child.pid });

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
