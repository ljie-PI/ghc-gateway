import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DaemonIdentityFile,
  DaemonIdentityFileError,
  decodeDaemonIdentity,
  type DaemonIdentity,
} from "../../src/daemon/identity_file.js";
import {
  ProcessIdentityError,
  captureProcessStartIdentity,
  isCanonicalProcessStartIdentity,
  isSameProcess,
  parseLinuxProcStatStartTicks,
  terminateProcessIfMatching,
  type ProcessIdentityDependencies,
} from "../../src/daemon/process_identity.js";

const identity: DaemonIdentity = {
  version: 1,
  managed: true,
  pid: 4242,
  processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:987654",
  instanceNonce: "instance-nonce",
  controlToken: "control-token",
  port: 31_400,
  createdAt: "2026-09-03T12:34:56.000Z",
};

function otherIdentity(): DaemonIdentity {
  return {
    ...identity,
    processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:987655",
    instanceNonce: "other-nonce",
  };
}

async function temporaryDirectory(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "ghcg-daemon-identity-")), "data");
}

describe("daemon identity schema", () => {
  it("uses the canonical process-start identity formats", () => {
    expect(isCanonicalProcessStartIdentity("linux:01234567-89ab-cdef-0123-456789abcdef:0")).toBe(true);
    expect(isCanonicalProcessStartIdentity("windows:0")).toBe(true);
    expect(isCanonicalProcessStartIdentity("macos:2024-02-29T23:59:59Z")).toBe(true);
    expect(isCanonicalProcessStartIdentity("linux:01234567-89AB-cdef-0123-456789abcdef:1")).toBe(false);
    expect(isCanonicalProcessStartIdentity("linux:01234567-89ab-cdef-0123-456789abcdef:01")).toBe(false);
    expect(isCanonicalProcessStartIdentity("windows:001")).toBe(false);
    expect(isCanonicalProcessStartIdentity("windows:184467440737095516160")).toBe(false);
    expect(isCanonicalProcessStartIdentity("macos:2026-02-30T12:00:00Z")).toBe(false);
  });

  it("accepts only the exact versioned schema", () => {
    expect(decodeDaemonIdentity(JSON.stringify(identity))).toEqual(identity);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, extra: true }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, version: 2 }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, pid: 1.5 }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, port: 65_536 }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, createdAt: "2026-09-03" }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, processStartIdentity: "windows:001" }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity(JSON.stringify({ ...identity, processStartIdentity: "macos:2026-02-30T12:00:00Z" }))).toThrow(DaemonIdentityFileError);
    expect(() => decodeDaemonIdentity("null")).toThrow(DaemonIdentityFileError);
  });
});

describe("daemon identity file", () => {
  it("publishes protected daemon.json while holding an exclusive lease", async () => {
    const directory = await temporaryDirectory();
    const file = new DaemonIdentityFile(directory);
    const lease = await file.acquire(identity);
    try {
      expect(file.read()).toEqual(identity);
      expect(JSON.parse(await readFile(path.join(directory, "daemon.json"), "utf8"))).toEqual(identity);
      await expect(file.acquire(otherIdentity())).rejects.toMatchObject({ code: "lease_conflict" });
    } finally {
      expect(lease.cleanup()).toBe(true);
      lease.release();
    }
    expect(file.read()).toBeNull();
  });

  it("never removes an identity that is no longer owned by its lease", async () => {
    const directory = await temporaryDirectory();
    const file = new DaemonIdentityFile(directory);
    const lease = await file.acquire(identity);
    await writeFile(path.join(directory, "daemon.json"), `${JSON.stringify(otherIdentity())}\n`, { mode: 0o600 });
    expect(lease.cleanup()).toBe(false);
    lease.release();
    expect(file.read()).toEqual(otherIdentity());
  });

  it("does not remove a modified identity with the same process tuple", async () => {
    const directory = await temporaryDirectory();
    const file = new DaemonIdentityFile(directory);
    const lease = await file.acquire(identity);
    const modified = { ...identity, controlToken: "replacement-token" };
    await writeFile(path.join(directory, "daemon.json"), `${JSON.stringify(modified)}\n`, { mode: 0o600 });
    expect(lease.cleanup()).toBe(false);
    lease.release();
    expect(file.read()).toEqual(modified);
  });

  it("recovers an orphan lock only after proving its recorded process is dead", async () => {
    const directory = await temporaryDirectory();
    let ownerAlive = true;
    const file = new DaemonIdentityFile(directory, {
      processIdentity: async (pid) => pid === identity.pid && ownerAlive ? identity.processStartIdentity : null,
    });
    const orphaned = await file.acquire(identity);
    expect(orphaned.cleanup()).toBe(true);

    await expect(file.acquire(otherIdentity())).rejects.toMatchObject({ code: "lease_conflict" });
    ownerAlive = false;
    const recovered = await file.acquire(otherIdentity());
    expect(file.read()).toEqual(otherIdentity());
    expect(recovered.cleanup()).toBe(true);
    recovered.release();
    orphaned.release();
  });

  it.skipIf(process.platform === "win32")("fails closed for symlink identity paths", async () => {
    const directory = await temporaryDirectory();
    await new DaemonIdentityFile(directory).read();
    const outside = path.join(await temporaryDirectory(), "outside.json");
    await new DaemonIdentityFile(path.dirname(outside)).read();
    await writeFile(outside, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    await symlink(outside, path.join(directory, "daemon.json"), "file");
    const file = new DaemonIdentityFile(directory);
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: "unsafe_path" }));
  });

  it.skipIf(process.platform === "win32")("fails closed for weak file permissions", async () => {
    const directory = await temporaryDirectory();
    await new DaemonIdentityFile(directory).read();
    const daemonPath = path.join(directory, "daemon.json");
    await writeFile(daemonPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    await chmod(daemonPath, 0o644);
    const file = new DaemonIdentityFile(directory);
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: "unsafe_permissions" }));
  });

  it.each(["CONTOSO\\current", "S-1-5-21-1000"])(
    "accepts a Windows owner matching the current identity as %s",
    async (owner) => {
      const directory = await temporaryDirectory();
      await mkdir(directory);
      const file = new DaemonIdentityFile(directory, {
        platform: "win32",
        runCommand: (command, args) => windowsSecurityCommand(command, args, directory, owner),
      });
      expect(file.read()).toBeNull();
    },
  );

  it("fails closed when Get-Acl reports a different Windows owner", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory);
    const calls: string[] = [];
    const file = new DaemonIdentityFile(directory, {
      platform: "win32",
      runCommand: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return windowsSecurityCommand(command, args, directory, "CONTOSO\\other");
      },
    });
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: "unsafe_owner" }));
    expect(calls.some((call) => call.includes("Get-Acl"))).toBe(true);
  });
});

function windowsSecurityCommand(
  command: string,
  args: readonly string[],
  target: string,
  owner: string,
): string {
  if (command === "whoami") {
    return "\"CONTOSO\\current\",\"S-1-5-21-1000\"\r\n";
  }
  if (command === "powershell.exe") {
    return args.join(" ").includes("Get-Acl") ? `${owner}\r\n` : "false\r\n";
  }
  if (command === "icacls") {
    return `${target} CONTOSO\\current:(F)\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  }
  throw new Error(`unexpected command: ${command}`);
}

function processDependencies(
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>> = {},
  commandOutput = "",
): ProcessIdentityDependencies {
  return {
    platform,
    readFile: async (filePath) => {
      const value = files[filePath];
      if (value === undefined) {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    runCommand: async () => commandOutput,
  };
}

describe("process start identity", () => {
  it("extracts Linux start ticks after a parenthesized comm field", async () => {
    const stat = "4242 (worker ) with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20";
    expect(parseLinuxProcStatStartTicks(stat, 4242)).toBe("987654");
    const dependencies = processDependencies("linux", {
      "/proc/sys/kernel/random/boot_id": "01234567-89AB-CDEF-0123-456789ABCDEF\n",
      "/proc/4242/stat": stat,
    });
    await expect(captureProcessStartIdentity(4242, dependencies)).resolves.toBe(
      "linux:01234567-89ab-cdef-0123-456789abcdef:987654",
    );
  });

  it("serializes Windows creation FILETIME without numeric precision loss", async () => {
    const calls: Array<{ readonly file: string; readonly args: readonly string[] }> = [];
    const dependencies: ProcessIdentityDependencies = {
      ...processDependencies("win32", {}, "133852868960001234\r\n"),
      runCommand: async (file, args) => {
        calls.push({ file, args });
        return "133852868960001234\r\n";
      },
    };
    await expect(captureProcessStartIdentity(4242, dependencies)).resolves.toBe("windows:133852868960001234");
    expect(calls[0]?.args.join(" ")).toContain("4242");
  });

  it("runs macOS ps in the C locale and canonicalizes lstart to UTC seconds", async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }> = [];
    const dependencies: ProcessIdentityDependencies = {
      platform: "darwin",
      readFile: async () => "",
      runCommand: async (_file, args, env) => {
        calls.push({ args, env });
        return "Thu Sep  3 12:34:56 2026\n";
      },
    };
    await expect(captureProcessStartIdentity(4242, dependencies)).resolves.toBe("macos:2026-09-03T12:34:56Z");
    expect(calls[0]).toMatchObject({
      args: ["-o", "lstart=", "-p", "4242"],
      env: { LC_ALL: "C", TZ: "UTC" },
    });
  });

  it("performs Linux identity verification and termination in one command", async () => {
    const calls: string[] = [];
    const dependencies: ProcessIdentityDependencies = {
      ...processDependencies("linux"),
      runCommand: async (file, args) => {
        calls.push(`${file} ${args.join(" ")}`);
        return "";
      },
    };
    await expect(terminateProcessIfMatching(4242, identity.processStartIdentity, dependencies)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("kill -KILL");
    expect(calls[0]).toContain("987654");
  });

  it("matches the complete process-start identity and treats absence separately", async () => {
    const files = {
      "/proc/sys/kernel/random/boot_id": "01234567-89ab-cdef-0123-456789abcdef\n",
      "/proc/4242/stat": "4242 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20",
    };
    const dependencies = processDependencies("linux", files);
    await expect(isSameProcess(4242, identity.processStartIdentity, dependencies)).resolves.toBe(true);
    await expect(isSameProcess(4242, otherIdentity().processStartIdentity, dependencies)).resolves.toBe(false);
    await expect(captureProcessStartIdentity(9999, dependencies)).resolves.toBeNull();
  });

  it("fails closed for malformed platform data and unsupported platforms", async () => {
    await expect(captureProcessStartIdentity(4242, processDependencies("linux", {
      "/proc/sys/kernel/random/boot_id": "not-a-boot-id",
      "/proc/4242/stat": "malformed",
    }))).rejects.toBeInstanceOf(ProcessIdentityError);
    await expect(captureProcessStartIdentity(4242, processDependencies("freebsd"))).rejects.toBeInstanceOf(ProcessIdentityError);
  });
});
