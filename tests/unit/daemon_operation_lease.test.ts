import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonOperationLeaseFile } from "../../src/daemon/operation_lease.js";

const START_IDENTITY = "linux:01234567-89ab-cdef-0123-456789abcdef:987654";

async function temporaryDirectory(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "ghcg-operation-lease-")), "data");
}

describe("daemon operation lease", () => {
  it("exclusively owns a protected file separate from daemon lifetime identity", async () => {
    const directory = await temporaryDirectory();
    const leaseFile = new DaemonOperationLeaseFile({
      pid: 4242,
      processStartIdentity: async () => START_IDENTITY,
      processIdentity: async () => START_IDENTITY,
      createToken: () => "operation-token",
    });

    const first = await leaseFile.acquire(directory);
    const operationPath = path.join(directory, "daemon.operation.lock");
    expect(JSON.parse(await readFile(operationPath, "utf8"))).toEqual({
      version: 1,
      pid: 4242,
      processStartIdentity: START_IDENTITY,
      leaseToken: "operation-token",
    });
    if (process.platform !== "win32") {
      expect((await lstat(operationPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    await expect(lstat(path.join(directory, "daemon.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(directory, "daemon.json"))).rejects.toMatchObject({ code: "ENOENT" });

    let secondSettled = false;
    const second = leaseFile.acquire(directory).finally(() => { secondSettled = true; });
    await vi.waitFor(() => expect(secondSettled).toBe(false));
    first.release();
    (await second).release();
    await expect(lstat(operationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases only the unchanged file owned by its token and file identity", async () => {
    const directory = await temporaryDirectory();
    const leaseFile = operationLease({ createToken: () => "original-token" });
    const lease = await leaseFile.acquire(directory);
    const operationPath = path.join(directory, "daemon.operation.lock");
    await writeFile(operationPath, `${JSON.stringify({
      version: 1,
      pid: 4242,
      processStartIdentity: START_IDENTITY,
      leaseToken: "replacement-token",
    })}\n`, { mode: 0o600 });

    lease.release();
    expect(JSON.parse(await readFile(operationPath, "utf8"))).toMatchObject({ leaseToken: "replacement-token" });
    if (process.platform !== "win32") await chmod(operationPath, 0o600);
  });

  it("recovers an orphan only after its owner is proven dead", async () => {
    const directory = await temporaryDirectory();
    const orphan = await operationLease({ createToken: () => "orphan-token" }).acquire(directory);
    const recovered = await operationLease({
      processIdentity: async () => null,
      createToken: () => "recovered-token",
    }).acquire(directory);
    expect(JSON.parse(await readFile(path.join(directory, "daemon.operation.lock"), "utf8")))
      .toMatchObject({ leaseToken: "recovered-token" });
    recovered.release();
    orphan.release();
  });

  it("fails closed for PID reuse and unknown owner identity without removing the lease", async () => {
    const directory = await temporaryDirectory();
    const owner = await operationLease({ createToken: () => "owner-token" }).acquire(directory);
    const operationPath = path.join(directory, "daemon.operation.lock");

    await expect(operationLease({
      processIdentity: async () => "linux:01234567-89ab-cdef-0123-456789abcdef:999999",
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_owner" });
    expect(JSON.parse(await readFile(operationPath, "utf8"))).toMatchObject({ leaseToken: "owner-token" });

    await expect(operationLease({
      processIdentity: async () => { throw new Error("private probe diagnostic"); },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_owner", message: "unable to verify operation lease owner" });
    expect(await readFile(operationPath, "utf8")).not.toContain("private probe diagnostic");
    owner.release();
  });

  it("allows an independently canceled waiter to leave the active owner untouched", async () => {
    const directory = await temporaryDirectory();
    const leaseFile = operationLease();
    const active = await leaseFile.acquire(directory);
    const abort = new AbortController();
    const waiting = leaseFile.acquire(directory, { signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(JSON.parse(await readFile(path.join(directory, "daemon.operation.lock"), "utf8")))
      .toMatchObject({ leaseToken: "test-token" });
    active.release();
    (await leaseFile.acquire(directory)).release();
  });

  it.skipIf(process.platform === "win32")("fails closed for malformed, excessive, and weakly protected owner files", async () => {
    const directory = await temporaryDirectory();
    const bootstrap = await operationLease().acquire(directory);
    bootstrap.release();
    const operationPath = path.join(directory, "daemon.operation.lock");

    await writeFile(operationPath, "{}\n", { mode: 0o600 });
    await expect(operationLease().acquire(directory)).rejects.toMatchObject({ code: "invalid_identity" });
    await writeFile(operationPath, "x".repeat(4097), { mode: 0o600 });
    await expect(operationLease().acquire(directory)).rejects.toMatchObject({ code: "unsafe_path" });
    await writeFile(operationPath, `${JSON.stringify(ownerRecord())}\n`, { mode: 0o600 });
    await chmod(operationPath, 0o644);
    await expect(operationLease().acquire(directory)).rejects.toMatchObject({ code: "unsafe_permissions" });
  });

  it.skipIf(process.platform === "win32")("fails closed for a symlink operation lease", async () => {
    const directory = await temporaryDirectory();
    const bootstrap = await operationLease().acquire(directory);
    bootstrap.release();
    const outside = path.join(await temporaryDirectory(), "outside.lock");
    await operationLease().acquire(path.dirname(outside)).then((lease) => lease.release());
    await writeFile(outside, `${JSON.stringify(ownerRecord())}\n`, { mode: 0o600 });
    await symlink(outside, path.join(directory, "daemon.operation.lock"), "file");
    await expect(operationLease().acquire(directory)).rejects.toMatchObject({ code: "unsafe_path" });
  });
});

function operationLease(overrides: ConstructorParameters<typeof DaemonOperationLeaseFile>[0] = {}) {
  return new DaemonOperationLeaseFile({
    pid: 4242,
    processStartIdentity: async () => START_IDENTITY,
    processIdentity: async () => START_IDENTITY,
    createToken: () => "test-token",
    ...overrides,
  });
}

function ownerRecord() {
  return {
    version: 1,
    pid: 4242,
    processStartIdentity: START_IDENTITY,
    leaseToken: "owner-token",
  };
}
