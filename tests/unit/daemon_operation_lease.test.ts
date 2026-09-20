import { mkdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DaemonOperationLeaseFile,
  decodeOperationOwner,
  type OperationOwner,
} from "../../src/daemon/operation_lease.js";

const START_IDENTITY = "linux:01234567-89ab-cdef-0123-456789abcdef:987654";

async function temporaryDirectory(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "ghcg-operation-lease-")), "data");
}

describe("daemon operation lease", () => {
  it("accepts only the exact held/released owner schema", () => {
    expect(decodeOperationOwner(JSON.stringify(ownerRecord()))).toEqual(ownerRecord());
    for (const invalid of [
      { ...ownerRecord(), extra: true },
      { ...ownerRecord(), state: "waiting" },
      { ...ownerRecord(), processStartIdentity: "windows:001" },
      { ...ownerRecord(), leaseToken: "" },
    ]) expect(() => decodeOperationOwner(JSON.stringify(invalid))).toThrow();
  });

  it("uses a persistent protected SQLite database and publishes held then released metadata", async () => {
    const directory = await temporaryDirectory();
    const phases: string[] = [];
    const leaseFile = operationLease({ onPhase: (phase) => phases.push(phase) });
    const lease = await leaseFile.acquire(directory);
    const databasePath = path.join(directory, "daemon.operation.db");
    const ownerPath = path.join(directory, "daemon.operation.owner.json");

    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual(ownerRecord({ leaseToken: "test-token" }));
    if (process.platform !== "win32") {
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
      expect((await lstat(ownerPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    lease.release();
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual(ownerRecord({
      state: "released",
      leaseToken: "test-token",
    }));
    expect(await lstat(databasePath)).toMatchObject({ isFile: expect.any(Function) });
    expect(phases).toEqual(["os_locked", "held_published", "released_published", "database_closing"]);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      await expect(lstat(databasePath + suffix)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("creates a missing custom Windows root without a filesystem-security subprocess", async () => {
    const directory = await temporaryDirectory();
    const runCommand = vi.fn(() => { throw new Error("filesystem security subprocess must not run"); });
    const lease = await operationLease({ platform: "win32", runCommand }).acquire(directory, {
      dataDirSource: "custom",
    });
    lease.release();
    expect(runCommand).not.toHaveBeenCalled();
    expect(await lstat(path.join(directory, "daemon.operation.db"))).toMatchObject({ isFile: expect.any(Function) });
  });

  it("uses one atomic creation subprocess for a missing default Windows root", async () => {
    const directory = await temporaryDirectory();
    const runCommand = vi.fn((_file: string, args: readonly string[], environment?: Readonly<Record<string, string>>) => {
      expect(args.join(" ")).toContain("WindowsIdentity]::GetCurrent().User");
      mkdirSync(environment?.GHCG_DIRECTORY_PATH ?? "missing", { recursive: true });
      return "0\r\n";
    });
    const lease = await operationLease({ platform: "win32", runCommand }).acquire(directory, {
      dataDirSource: "default",
    });
    lease.release();
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("uses no filesystem-security subprocess for an existing Windows root", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory);
    const runCommand = vi.fn(() => { throw new Error("filesystem security subprocess must not run"); });
    const lease = await operationLease({ platform: "win32", runCommand }).acquire(directory, {
      dataDirSource: "default",
    });
    lease.release();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("returns missing without probing a process or creating artifacts when root creation is disabled", async () => {
    const directory = await temporaryDirectory();
    const processStartIdentity = vi.fn(async () => START_IDENTITY);
    await expect(operationLease({ processStartIdentity }).acquire(directory, { createDataDir: false }))
      .resolves.toBeNull();
    expect(processStartIdentity).not.toHaveBeenCalled();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes short writes while initializing the database", async () => {
    const directory = await temporaryDirectory();
    let writes = 0;
    const lease = await operationLease({
      write: (fd, buffer, offset, length, position) => {
        writes += 1;
        return writeSync(fd, buffer, offset, Math.min(length, 17), position);
      },
    }).acquire(directory);
    lease.release();

    expect(writes).toBeGreaterThan(1);
    expect(await initializationTemps(directory)).toEqual([]);
  });

  it("accepts own published initialization temp already removed by a simultaneous initializer", async () => {
    const directory = await temporaryDirectory();
    const databasePublished = deferred();
    const finishOtherCleanup = deferred();
    const firstAcquire = operationLease({
      createToken: () => "first-token",
      onInitializationPhase: async (phase) => {
        if (phase !== "database_published") return;
        databasePublished.resolve();
        await finishOtherCleanup.promise;
      },
    }).acquire(directory);

    await databasePublished.promise;
    const second = await operationLease({ createToken: () => "second-token" }).acquire(directory);
    expect(await initializationTemps(directory)).toEqual([]);
    second.release();
    finishOtherCleanup.resolve();

    const first = await firstAcquire;
    expect(await initializationTemps(directory)).toEqual([]);
    first.release();
  });

  it("accepts an initialization temp removed after directory enumeration", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await link(path.join(directory, "daemon.operation.db"), tempPath);

    const lease = await operationLease({
      onDatabaseInitTempsEnumerated: async (paths) => {
        expect(paths).toEqual([tempPath]);
        await unlink(tempPath);
      },
    }).acquire(directory);

    lease.release();
    expect(await initializationTemps(directory)).toEqual([]);
  });

  it("leaves an exact live initializer's incomplete temp untouched", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await writeFile(tempPath, "in progress", { mode: 0o600 });

    const lease = await operationLease({
      processIdentity: async (pid) => pid === 9999 ? START_IDENTITY : null,
    }).acquire(directory);

    lease.release();
    expect(await readFile(tempPath, "utf8")).toBe("in progress");
    await unlink(tempPath);
  });

  it.each(["initializer_checked", "before_validation", "before_unlink"] as const)(
    "accepts an initialization temp removed at %s",
    async (removeAt) => {
      const directory = await initializedDirectory();
      const tempPath = path.join(directory, initializationTempName(9999));
      await copyFile(path.join(directory, "daemon.operation.db"), tempPath);

      const lease = await operationLease({
        processIdentity: async () => null,
        onDatabaseInitTempPhase: async (phase, observedPath) => {
          if (phase !== removeAt) return;
          expect(observedPath).toBe(tempPath);
          await unlink(tempPath);
        },
      }).acquire(directory);

      lease.release();
      expect(await initializationTemps(directory)).toEqual([]);
    },
  );

  it("fails closed without deleting an initialization temp replaced before cleanup", async () => {
    const directory = await initializedDirectory();
    const databasePath = path.join(directory, "daemon.operation.db");
    const tempPath = path.join(directory, initializationTempName(9999));
    const replacementPath = path.join(directory, "replacement.db");
    await copyFile(databasePath, tempPath);
    await copyFile(databasePath, replacementPath);
    await expect(operationLease({
      processIdentity: async () => null,
      onDatabaseInitTempPhase: async (phase) => {
        if (phase !== "before_unlink") return;
        await unlink(tempPath);
        await rename(replacementPath, tempPath);
      },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_path" });

    await expect(readFile(tempPath)).resolves.toBeInstanceOf(Buffer);
  });

  it("fails closed when a live initializer's temp is replaced during owner verification", async () => {
    const directory = await initializedDirectory();
    const databasePath = path.join(directory, "daemon.operation.db");
    const tempPath = path.join(directory, initializationTempName(9999));
    const replacementPath = path.join(directory, "replacement.db");
    await writeFile(tempPath, "in progress", { mode: 0o600 });
    await copyFile(databasePath, replacementPath);
    await expect(operationLease({
      processIdentity: async () => START_IDENTITY,
      onDatabaseInitTempPhase: async (phase) => {
        if (phase !== "initializer_checked") return;
        await unlink(tempPath);
        await rename(replacementPath, tempPath);
      },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_path" });

    await expect(readFile(tempPath)).resolves.toBeInstanceOf(Buffer);
  });

  it("accepts an initialization temp removed by a concurrent unlink", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await link(path.join(directory, "daemon.operation.db"), tempPath);

    const lease = await operationLease({ unlink: (target) => {
      unlinkSync(target);
      unlinkSync(target);
    } }).acquire(directory);

    lease.release();
    expect(await initializationTemps(directory)).toEqual([]);
  });

  it("does not accept an unrelated missing-path error from cleanup", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await link(path.join(directory, "daemon.operation.db"), tempPath);
    const unrelated = path.join(directory, "unrelated");

    await expect(operationLease({ unlink: () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT", syscall: "unlink", path: unrelated });
    } }).acquire(directory)).rejects.toMatchObject({ code: "io_error" });
    await expect(readFile(tempPath)).resolves.toBeInstanceOf(Buffer);
  });

  it.skipIf(process.platform === "win32")("rejects an unsafe live initializer temp after owner verification", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await writeFile(tempPath, "in progress", { mode: 0o600 });

    await expect(operationLease({
      processIdentity: async () => START_IDENTITY,
      onDatabaseInitTempPhase: async (phase) => {
        if (phase === "initializer_checked") await chmod(tempPath, 0o644);
      },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_permissions" });
    await expect(readFile(tempPath, "utf8")).resolves.toBe("in progress");
  });

  it.skipIf(process.platform === "win32")("rejects an unsafe stale temp immediately before cleanup", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await copyFile(path.join(directory, "daemon.operation.db"), tempPath);

    await expect(operationLease({
      processIdentity: async () => null,
      onDatabaseInitTempPhase: async (phase) => {
        if (phase === "before_unlink") await chmod(tempPath, 0o644);
      },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_permissions" });
    await expect(readFile(tempPath)).resolves.toBeInstanceOf(Buffer);
  });

  it("validates an enumerated malformed name before accepting its removal", async () => {
    const directory = await initializedDirectory();
    const malformed = path.join(directory, ".daemon.operation.db.init-malformed");
    await writeFile(malformed, "temporary", { mode: 0o600 });

    await expect(operationLease({
      onDatabaseInitTempsEnumerated: async () => { await unlink(malformed); },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("fails closed when an initialization temp owner cannot be verified", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await copyFile(path.join(directory, "daemon.operation.db"), tempPath);

    await expect(operationLease({
      processIdentity: async () => { throw new Error("private process diagnostic"); },
    }).acquire(directory)).rejects.toMatchObject({ code: "unsafe_owner" });
    await expect(readFile(tempPath)).resolves.toBeInstanceOf(Buffer);
  });

  it("retains stable invalid initialization database evidence", async () => {
    const directory = await initializedDirectory();
    const tempPath = path.join(directory, initializationTempName(9999));
    await writeFile(tempPath, "not sqlite", { mode: 0o600 });

    await expect(operationLease({ processIdentity: async () => null }).acquire(directory))
      .rejects.toMatchObject({ code: "unsafe_path" });
    await expect(readFile(tempPath, "utf8")).resolves.toBe("not sqlite");
  });

  it("recovers protected initialization temps left before and after atomic database publication", async () => {
    for (const published of [false, true]) {
      const directory = await initializedDirectory();
      const databasePath = path.join(directory, "daemon.operation.db");
      const tempPath = path.join(directory, initializationTempName(9999));
      await copyFile(databasePath, tempPath);
      if (process.platform !== "win32") await chmod(tempPath, 0o600);
      await unlink(databasePath);
      if (published) await link(tempPath, databasePath);

      const lease = await operationLease({ processIdentity: async () => null }).acquire(directory);
      lease.release();
      expect(await initializationTemps(directory)).toEqual([]);
      expect(await lstat(databasePath)).toMatchObject({ isFile: expect.any(Function) });
    }
  });

  it("fails closed for unsafe or unbounded database initialization temps", async () => {
    const unsafeDirectory = await initializedDirectory();
    await writeFile(path.join(unsafeDirectory, initializationTempName(9999)), "not sqlite", { mode: 0o600 });
    await expect(operationLease({ processIdentity: async () => null }).acquire(unsafeDirectory))
      .rejects.toMatchObject({ code: "unsafe_path" });

    const unboundedDirectory = await initializedDirectory();
    await Promise.all(Array.from({ length: 17 }, async (_, index) => {
      await copyFile(
        path.join(unboundedDirectory, "daemon.operation.db"),
        path.join(unboundedDirectory, initializationTempName(10_000 + index)),
      );
    }));
    await expect(operationLease({ processIdentity: async () => null }).acquire(unboundedDirectory))
      .rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("serializes the same database, allows different directories in parallel, and release is idempotent", async () => {
    const firstDirectory = await temporaryDirectory();
    const otherDirectory = await temporaryDirectory();
    const leaseFile = operationLease({ createToken: (() => {
      let token = 0;
      return () => `token-${++token}`;
    })() });
    const first = await leaseFile.acquire(firstDirectory);
    let secondSettled = false;
    const second = leaseFile.acquire(firstDirectory).finally(() => { secondSettled = true; });
    const other = await leaseFile.acquire(otherDirectory);
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(secondSettled).toBe(false);
    other.release();
    first.release();
    first.release();
    (await second).release();
  });

  it("cancels a busy waiter without disturbing the holder or a later waiter", async () => {
    const directory = await temporaryDirectory();
    const leaseFile = operationLease();
    const active = await leaseFile.acquire(directory);
    const abort = new AbortController();
    const waiting = leaseFile.acquire(directory, { signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(JSON.parse(await readFile(path.join(directory, "daemon.operation.owner.json"), "utf8")))
      .toMatchObject({ state: "held", leaseToken: "test-token" });
    active.release();
    (await leaseFile.acquire(directory)).release();
  });

  it("recovers held metadata only when the previous PID is proven dead", async () => {
    const directory = await initializedDirectory();
    await writeOwner(directory, ownerRecord({ leaseToken: "orphan" }));
    const recovered = await operationLease({
      processIdentity: async () => null,
      createToken: () => "recovered",
    }).acquire(directory);
    expect(await readOwner(directory)).toMatchObject({ state: "held", leaseToken: "recovered" });
    recovered.release();
  });

  it.each([
    ["same live identity", async () => START_IDENTITY],
    ["PID reuse", async () => "linux:01234567-89ab-cdef-0123-456789abcdef:999999"],
    ["unknown identity", async () => { throw new Error("private SQLite/path diagnostic"); }],
  ])("fails closed for previous held metadata with %s", async (_name, processIdentity) => {
    const directory = await initializedDirectory();
    await writeOwner(directory, ownerRecord({ leaseToken: "previous" }));
    const callback = vi.fn();
    await expect(operationLease({ processIdentity }).acquire(directory).then(callback))
      .rejects.toMatchObject({ code: "unsafe_owner" });
    expect(callback).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, "daemon.operation.owner.json"), "utf8"))
      .not.toContain("private SQLite/path diagnostic");
  });

  it("permits released metadata without probing the old PID", async () => {
    const directory = await initializedDirectory();
    const probe = vi.fn(async () => { throw new Error("must not probe"); });
    const acquired = await operationLease({ processIdentity: probe }).acquire(directory);
    expect(probe).not.toHaveBeenCalled();
    acquired.release();
  });

  it("closes the SQLite transaction after crashes before held publication and recovers dead held publication", async () => {
    const directory = await initializedDirectory();
    const beforeHeld = operationLease({
      onPhase: (phase) => { if (phase === "os_locked") throw new Error("crash before held"); },
    });
    await expect(beforeHeld.acquire(directory)).rejects.toMatchObject({ code: "io_error" });
    (await operationLease().acquire(directory)).release();

    const afterHeld = operationLease({
      pid: 5000,
      createToken: () => "crashed-holder",
      onPhase: (phase) => { if (phase === "held_published") throw new Error("crash after held"); },
    });
    await expect(afterHeld.acquire(directory)).rejects.toMatchObject({ code: "io_error" });
    expect(await readOwner(directory)).toMatchObject({ state: "held", leaseToken: "crashed-holder" });
    const recovered = await operationLease({ processIdentity: async (pid) => pid === 5000 ? null : START_IDENTITY })
      .acquire(directory);
    recovered.release();
  });

  it("closes the database but leaves held metadata when released publication fails", async () => {
    const directory = await temporaryDirectory();
    const lease = await operationLease().acquire(directory);
    await mkdir(path.join(directory, ".daemon.operation.owner.json.tmp"));
    expect(() => lease.release()).toThrow();
    expect(await readOwner(directory)).toMatchObject({ state: "held", leaseToken: "test-token" });
    await rmdir(path.join(directory, ".daemon.operation.owner.json.tmp"));
    await expect(operationLease().acquire(directory)).rejects.toMatchObject({ code: "unsafe_owner" });
  });

  it("publishes released before closing the database lock", async () => {
    const directory = await temporaryDirectory();
    const observations: OperationOwner[] = [];
    const lease = await operationLease({
      onPhase: (phase) => {
        if (phase === "database_closing") {
          observations.push(JSON.parse(requireRead(path.join(directory, "daemon.operation.owner.json"))) as OperationOwner);
        }
      },
    }).acquire(directory);
    lease.release();
    expect(observations).toEqual([ownerRecord({ state: "released", leaseToken: "test-token" })]);
  });

  it.skipIf(process.platform === "win32")("fails closed for unsafe database, owner, temp, and sidecar paths", async () => {
    const cases: Array<(directory: string) => Promise<void>> = [
      async (directory) => { await chmod(path.join(directory, "daemon.operation.db"), 0o644); },
      async (directory) => { await chmod(path.join(directory, "daemon.operation.owner.json"), 0o644); },
      async (directory) => { await writeFile(path.join(directory, ".daemon.operation.owner.json.tmp"), "unsafe", { mode: 0o644 }); },
      async (directory) => {
        const initPath = path.join(directory, initializationTempName(9999));
        await copyFile(path.join(directory, "daemon.operation.db"), initPath);
        await chmod(initPath, 0o644);
      },
      async (directory) => { await writeFile(path.join(directory, "daemon.operation.db-journal"), "unexpected", { mode: 0o600 }); },
    ];
    for (const arrange of cases) {
      const directory = await initializedDirectory();
      await arrange(directory);
      await expect(operationLease().acquire(directory)).rejects.toMatchObject({
        code: expect.stringMatching(/^unsafe_/u),
      });
    }
  });

  it.skipIf(process.platform === "win32")("fails closed for symlink database, owner, temp, and sidecar paths", async () => {
    for (const name of [
      "daemon.operation.db",
      "daemon.operation.owner.json",
      ".daemon.operation.owner.json.tmp",
      initializationTempName(9999),
      "daemon.operation.db-wal",
    ]) {
      const directory = await initializedDirectory();
      const target = path.join(await mkdtemp(path.join(tmpdir(), "ghcg-operation-outside-")), "target");
      await writeFile(target, "outside", { mode: 0o600 });
      const victim = path.join(directory, name);
      try { await unlink(victim); } catch { /* absent is expected */ }
      await symlink(target, victim, "file");
      await expect(operationLease().acquire(directory)).rejects.toMatchObject({ code: "unsafe_path" });
    }
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

function ownerRecord(overrides: Partial<OperationOwner> = {}): OperationOwner {
  return {
    version: 1,
    state: "held",
    pid: 4242,
    processStartIdentity: START_IDENTITY,
    leaseToken: "owner-token",
    ...overrides,
  };
}

async function initializedDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  const lease = await operationLease().acquire(directory);
  lease.release();
  return directory;
}

async function writeOwner(directory: string, owner: OperationOwner): Promise<void> {
  await writeFile(path.join(directory, "daemon.operation.owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path.join(directory, "daemon.operation.owner.json"), 0o600);
}

async function readOwner(directory: string): Promise<OperationOwner> {
  return JSON.parse(await readFile(path.join(directory, "daemon.operation.owner.json"), "utf8")) as OperationOwner;
}

function initializationTempName(pid: number): string {
  const identity = Buffer.from(START_IDENTITY, "utf8").toString("base64url");
  return `.daemon.operation.db.init-${pid}-${identity}-01234567-89ab-4def-8123-456789abcdef`;
}

async function initializationTemps(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith(".daemon.operation.db.init-"));
}

function requireRead(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
