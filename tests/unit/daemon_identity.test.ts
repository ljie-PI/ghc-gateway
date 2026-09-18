import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { daemonRuntimeCliError } from "../../src/daemon/runtime.js";
import { ProtectedFileSystem } from "../../src/daemon/protected_file.js";
import { windowsCommandPath } from "../../src/security/windows_acl.js";
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

const WINDOWS_TEST_COMMAND_TIMEOUT_MS = 15_000;

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
  it.runIf(process.platform === "win32")("publishes a new directory with owner and ACL already valid for another caller", async () => {
    const directory = await temporaryDirectory();
    let observed = false;
    let rejection: unknown;
    const files = new ProtectedFileSystem(directory, {
      runCommand: (command, args, environment, timeoutMs) => {
        // Pause the creator at its first post-creation inspection. A second
        // caller must already accept the visible directory before we continue.
        if (!observed && args.join(" ").includes("Get-Item")) {
          observed = true;
          try { new ProtectedFileSystem(directory).ensureProtectedDirectory(); }
          catch (error: unknown) { rejection = error; }
        }
        return nativeWindowsCommand(command, args, environment, timeoutMs);
      },
    });
    try {
      files.ensureProtectedDirectory();
      expect(observed).toBe(true);
      expect(rejection).toBeUndefined();
    } finally { await rm(path.dirname(directory), { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "win32")("leaves a protected directory when its creator exits before validation", async () => {
    const directory = await temporaryDirectory();
    const source = new URL("../../src/daemon/protected_file.ts", import.meta.url).href;
    const script = `import {execFileSync} from 'node:child_process';
      import path from 'node:path';
      import {ProtectedFileSystem} from ${JSON.stringify(source)};
      new ProtectedFileSystem(process.argv[1], {runCommand(file,args,environment,timeoutMs) {
        if(args.join(' ').includes('Get-Item')) process.exit(23);
        const executable=file==='whoami'||file==='icacls'
          ? path.join(process.env.SystemRoot,'System32',file+'.exe') : file;
        return execFileSync(executable,args,{encoding:'utf8',windowsHide:true,timeout:timeoutMs??${WINDOWS_TEST_COMMAND_TIMEOUT_MS},
          maxBuffer:1048576,env:{...process.env,...environment},stdio:['ignore','pipe','pipe']});
      }}).ensureProtectedDirectory();`;
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script, directory], {
        cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", windowsHide: true, timeout: 30000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(23);
      expect(child.stderr).toBe("");
      expect(() => new ProtectedFileSystem(directory).ensureProtectedDirectory()).not.toThrow();
    } finally { await rm(path.dirname(directory), { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "win32")("does not reset the ACL of an existing directory", async () => {
    const directory = await temporaryDirectory();
    try {
      const files = new ProtectedFileSystem(directory);
      files.ensureProtectedDirectory();
      const before = windowsSddl(directory);
      files.ensureProtectedDirectory();
      expect(windowsSddl(directory) === before).toBe(true);
    } finally { await rm(path.dirname(directory), { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "win32").each(["directory", "junction"] as const)(
    "does not take over a %s created between the existence check and creation", async (kind) => {
      const directory = await temporaryDirectory();
      const outside = path.join(path.dirname(directory), "outside");
      await mkdir(outside);
      let before: string | undefined;
      let raced = false;
      const protectedPath = kind === "junction" ? outside : directory;
      const files = new ProtectedFileSystem(directory, {
        runCommand: (command, args, environment, timeoutMs) => {
          if (environment?.GHCG_DIRECTORY_PATH !== undefined) {
            raced = true;
            if (kind === "junction") symlinkSync(outside, directory, "junction");
            else mkdirSync(directory);
            before = windowsSddl(protectedPath);
          }
          return nativeWindowsCommand(command, args, environment, timeoutMs);
        },
      });
      try {
        expect(() => files.ensureProtectedDirectory()).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^unsafe_/u) }));
        expect(raced).toBe(true);
        expect(windowsSddl(protectedPath) === before).toBe(true);
      } finally { await rm(path.dirname(directory), { recursive: true, force: true }); }
    },
  );

  it.each([
    ["-2147024891", "EACCES", "permission_denied"],
    ["-2147024893", "ENOENT", "internal_error"],
    ["-2147024713", "EEXIST", "internal_error"],
    ["private diagnostic", "EIO", "internal_error"],
  ] as const)("rejects creation result %s without falling back to bare mkdir", async (result, code, publicCode) => {
    const directory = await temporaryDirectory();
    const files = new ProtectedFileSystem(directory, {
      platform: "win32",
      runCommand: (command, _args, environment) => {
        if (command === "whoami") return "\"CONTOSO\\current\",\"S-1-5-21-1000\"";
        expect(environment?.GHCG_DIRECTORY_PATH).toBeDefined();
        return result;
      },
    });
    let caught: unknown;
    try { files.ensureProtectedDirectory(); } catch (error: unknown) { caught = error; }
    expect(caught).toMatchObject({ code, message: "unable to create daemon directory" });
    expect(daemonRuntimeCliError(caught)).toBe(publicCode);
    expect(existsSync(directory)).toBe(false);
  });

  it("propagates a creation-command timeout without creating or deleting a directory", async () => {
    const directory = await temporaryDirectory();
    const failure = Object.assign(new Error("private diagnostic"), { code: "ETIMEDOUT" });
    let creationTimeoutMs: number | undefined;
    const files = new ProtectedFileSystem(directory, {
      platform: "win32",
      runCommand: (command, _args, environment, timeoutMs) => {
        if (command === "whoami") return "\"CONTOSO\\current\",\"S-1-5-21-1000\"";
        expect(environment?.GHCG_DIRECTORY_PATH).toBeDefined();
        creationTimeoutMs = timeoutMs;
        throw failure;
      },
    });
    let caught: unknown;
    try { files.ensureProtectedDirectory(); } catch (error: unknown) { caught = error; }
    expect(caught).toBe(failure);
    expect(creationTimeoutMs).toBe(15_000);
    expect(daemonRuntimeCliError(caught)).toBe("internal_error");
    expect(existsSync(directory)).toBe(false);
  });

  it("leaves a committed directory for a later caller when creation acknowledgement times out", async () => {
    const directory = await temporaryDirectory();
    const failure = Object.assign(new Error("private diagnostic"), { code: "ETIMEDOUT" });
    let creationAttempts = 0;
    let creationTimeoutMs: number | undefined;
    const runCommand = (
      command: string,
      args: readonly string[],
      environment?: Readonly<Record<string, string>>,
      timeoutMs?: number,
    ): string => {
      if (command === "whoami") return "\"CONTOSO\\current\",\"S-1-5-21-1000\"";
      if (environment?.GHCG_DIRECTORY_PATH !== undefined) {
        creationAttempts += 1;
        creationTimeoutMs = timeoutMs;
        mkdirSync(environment.GHCG_DIRECTORY_PATH);
        throw failure;
      }
      return windowsSecurityCommand(command, args, directory, "CONTOSO\\current");
    };
    try {
      let caught: unknown;
      try {
        new ProtectedFileSystem(directory, { platform: "win32", runCommand }).ensureProtectedDirectory();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(creationTimeoutMs).toBe(15_000);
      expect(creationAttempts).toBe(1);
      expect(existsSync(directory)).toBe(true);

      expect(() => new ProtectedFileSystem(directory, { platform: "win32", runCommand }).ensureProtectedDirectory())
        .not.toThrow();
      expect(creationAttempts).toBe(1);
    } finally {
      await rm(path.dirname(directory), { recursive: true, force: true });
    }
  });

  it.each(["preserved", "substituted"] as const)("handles %s Unicode paths in icacls output without repairing permissions", async (outputPath) => {
    const directory = path.join(await temporaryDirectory(), "雪");
    let creations = 0;
    let aclReads = 0;
    const files = new ProtectedFileSystem(directory, {
      platform: "win32",
      runCommand: (command, args, environment) => {
        if (environment?.GHCG_DIRECTORY_PATH !== undefined) {
          creations += 1;
          mkdirSync(environment.GHCG_DIRECTORY_PATH, { recursive: true, mode: 0o700 });
          return "0\r\n";
        }
        if (command === "icacls") {
          expect(args).toEqual([directory]);
          aclReads += 1;
          // Model the captured tool output, not a Unicode ban or a parser bypass.
          const displayed = outputPath === "preserved" ? directory : directory.replaceAll("雪", "?");
          return `${displayed} CONTOSO\\current:(OI)(CI)(F)\r\n`;
        }
        return windowsSecurityCommand(command, args, directory, "CONTOSO\\current");
      },
    });
    try {
      for (const attempt of ["first creation", "existing directory"]) {
        let caught: unknown;
        try { files.ensureProtectedDirectory(); } catch (error: unknown) { caught = error; }
        if (outputPath === "preserved") expect(caught, attempt).toBeUndefined();
        else {
          expect(caught, attempt).toMatchObject({ code: "unsafe_permissions" });
          expect(daemonRuntimeCliError(caught)).toBe("security_error");
        }
      }
      expect(creations).toBe(1);
      expect(aclReads).toBe(2);
    } finally { await rm(path.dirname(path.dirname(directory)), { recursive: true, force: true }); }
  });

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

function windowsSddl(target: string): string {
  return nativeWindowsCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "Import-Module \"$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\"; (Get-Acl -LiteralPath $env:GHCG_TEST_PATH).Sddl",
  ], { GHCG_TEST_PATH: target }).trim();
}

function nativeWindowsCommand(
  command: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
  timeoutMs = WINDOWS_TEST_COMMAND_TIMEOUT_MS,
): string {
  const executable = command === "whoami" || command === "icacls" ? windowsCommandPath(command) : command;
  return execFileSync(executable, [...args], {
    encoding: "utf8", windowsHide: true, timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"],
  });
}

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

  it("forwards abort context through identity probes and verified termination commands", async () => {
    const abort = new AbortController();
    const contexts: Array<AbortSignal | undefined> = [];
    const dependencies: ProcessIdentityDependencies = {
      platform: "win32",
      readFile: async () => "",
      runCommand: async (_file, _args, _env, context) => {
        contexts.push(context?.signal);
        return "133852868960001234\r\n";
      },
    };
    await captureProcessStartIdentity(4242, dependencies, { signal: abort.signal });
    await terminateProcessIfMatching(4242, "windows:133852868960001234", dependencies, { signal: abort.signal });
    expect(contexts).toEqual([abort.signal, abort.signal]);
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
