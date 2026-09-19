import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  queryWindowsSecuritySnapshot,
  runWindowsSecuritySnapshotCommand,
  WindowsSecuritySnapshotError,
  type WindowsSecuritySnapshotDependencies,
  type WindowsSecuritySnapshotRequest,
} from "../../src/security/windows_security_snapshot.js";

const invalidRequests: readonly (readonly WindowsSecuritySnapshotRequest[])[] = [
  [],
  [{ id: "same", path: "C:\\one" }, { id: "same", path: "C:\\two" }],
  [{ id: "one", path: "C:\\Users\\Example" }, { id: "two", path: "c:\\users\\example" }],
  [{ id: "relative", path: "relative\\file" }],
  [{ id: "unnormalized", path: "C:\\one\\..\\two" }],
  [{ id: "bad id", path: "C:\\one" }],
  [{ id: "control", path: "C:\\one\nfile" }],
  [{ id: "long", path: `C:\\${"x".repeat(4095)}` }],
  Array.from({ length: 17 }, (_, index) => ({ id: `path-${index}`, path: `C:\\path-${index}` })),
];

describe("Windows security snapshot query", () => {
  it("runs one bounded system PowerShell query and returns exact ordered facts", async () => {
    const calls: Parameters<WindowsSecuritySnapshotDependencies["runCommand"]>[] = [];
    const dependencies: WindowsSecuritySnapshotDependencies = {
      platform: "win32",
      environment: { SystemRoot: "D:\\Windows", SAFE_PARENT_VALUE: "retained" },
      runCommand: async (...args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify([
            { id: "parent", status: "present", reparse: false, owner: "BUILTIN\\Administrators", sddl: "O:BAG:BAD:(A;;FA;;;SY)" },
            { id: "target", status: "missing" },
          ]),
          stderr: "",
        };
      },
    };

    await expect(queryWindowsSecuritySnapshot([
      { id: "parent", path: "C:\\Users\\Example" },
      { id: "target", path: "C:\\Users\\Example\\settings [1].json" },
    ], dependencies)).resolves.toEqual([
      { id: "parent", status: "present", reparse: false, owner: "BUILTIN\\Administrators", sddl: "O:BAG:BAD:(A;;FA;;;SY)" },
      { id: "target", status: "missing" },
    ]);

    expect(calls).toHaveLength(1);
    const [file, args, options, input] = calls[0]!;
    expect(file).toBe(path.win32.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).not.toContain("settings [1].json");
    expect(args[4]).toContain("Microsoft.PowerShell.Utility.psd1");
    expect(args[4]).toContain("Get-Item -LiteralPath $_.path");
    expect(args[4]).toContain("Get-Acl -LiteralPath $_.path");
    expect(options).toMatchObject({ encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
    expect(options.maxBuffer).toBeGreaterThan(0);
    expect(options.env.SAFE_PARENT_VALUE).toBe("retained");
    expect(options.env.GHCG_WINDOWS_SECURITY_REQUEST).toBeUndefined();
    expect(JSON.parse(input.toString("utf8"))).toEqual([
      { id: "parent", path: "C:\\Users\\Example" },
      { id: "target", path: "C:\\Users\\Example\\settings [1].json" },
    ]);
  });

  it("keeps special and Unicode paths as stdin data and accepts the full bounded aggregate", async () => {
    const requests = Array.from({ length: 16 }, (_, index) => ({
      id: `path-${index}`,
      path: index === 0
        ? "C:\\Users\\例 [x] '$&;()\\settings.json"
        : `C:\\${String.fromCharCode(0xd800 + index).repeat(4093)}`,
    }));
    let command: Parameters<WindowsSecuritySnapshotDependencies["runCommand"]> | undefined;
    const dependencies: WindowsSecuritySnapshotDependencies = {
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows", RETAINED: "yes" },
      runCommand: async (...args) => {
        command = args;
        return {
          stdout: JSON.stringify(requests.map((request) => ({ id: request.id, status: "missing" }))),
          stderr: "",
        };
      },
    };

    await expect(queryWindowsSecuritySnapshot(requests, dependencies)).resolves.toHaveLength(16);

    const [file, args, options, input] = command!;
    expect([file, ...args]).not.toContain(expect.stringContaining("settings.json"));
    expect(Object.values(options.env)).not.toContain(expect.stringContaining("settings.json"));
    expect(options.env.RETAINED).toBe("yes");
    expect(JSON.parse(input.toString("utf8"))).toEqual(requests);
  });

  it("preserves valid missing and per-item error facts", async () => {
    const dependencies = fakeDependencies(JSON.stringify([
      { id: "missing", status: "missing" },
      { id: "denied", status: "error" },
    ]));
    await expect(queryWindowsSecuritySnapshot([
      { id: "missing", path: "C:\\missing" },
      { id: "denied", path: "C:\\denied" },
    ], dependencies)).resolves.toEqual([
      { id: "missing", status: "missing" },
      { id: "denied", status: "error" },
    ]);
  });

  it("accepts the maximum bounded aggregate facts", async () => {
    const requests = Array.from({ length: 16 }, (_, index) => ({ id: `path-${index}`, path: `C:\\path-${index}` }));
    const owner = "O".repeat(16 * 1024);
    const sddl = "S".repeat(16 * 1024);
    const output = JSON.stringify(requests.map((request) => ({
      id: request.id, status: "present", reparse: false, owner, sddl,
    })));

    await expect(queryWindowsSecuritySnapshot(requests, fakeDependencies(output))).resolves.toHaveLength(16);
  });

  it("rejects a default-runner stdin EPIPE without waiting for command completion", async () => {
    const input = new EventEmitter() as EventEmitter & { end(data: Buffer): void };
    const failure = Object.assign(new Error("closed stdin"), { code: "EPIPE" });
    input.end = () => { input.emit("error", failure); };

    await expect(runWindowsSecuritySnapshotCommand(
      "powershell.exe",
      [],
      {
        encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000,
        maxBuffer: 1024, env: {},
      },
      Buffer.from("[]"),
      () => ({ stdin: input }),
    )).rejects.toBe(failure);
  });

  it("preserves a one-item response array", async () => {
    await expect(queryWindowsSecuritySnapshot(
      [{ id: "one", path: "C:\\one" }],
      fakeDependencies("[{\"id\":\"one\",\"status\":\"missing\"}]"),
    )).resolves.toEqual([{ id: "one", status: "missing" }]);
  });

  invalidRequests.forEach((requests, index) => {
    it(`rejects invalid bounded request ${index + 1} without invoking PowerShell`, async () => {
      let calls = 0;
      const dependencies = fakeDependencies("[]", () => { calls += 1; });
      await expect(queryWindowsSecuritySnapshot(requests, dependencies)).rejects.toEqual(new WindowsSecuritySnapshotError());
      expect(calls).toBe(0);
    });
  });

  it.each([
    "not json",
    "\ufeff[]",
    "[]\n",
    JSON.stringify([{ id: "other", status: "missing" }]),
    JSON.stringify([{ id: "one", status: "missing" }, { id: "extra", status: "missing" }]),
    JSON.stringify([{ id: "one", status: "missing", owner: "secret" }]),
    JSON.stringify([{ id: "one", status: "present", reparse: "false", owner: "owner", sddl: "sddl" }]),
    JSON.stringify([{ id: "one", status: "present", reparse: false, owner: "", sddl: "sddl" }]),
    JSON.stringify([{ id: "one", status: "present", reparse: false, owner: "owner", sddl: "x".repeat(16 * 1024 + 1) }]),
  ])("fails closed on malformed or non-exact output", async (output) => {
    await expect(queryWindowsSecuritySnapshot(
      [{ id: "one", path: "C:\\one" }],
      fakeDependencies(output),
    )).rejects.toEqual(new WindowsSecuritySnapshotError());
  });

  it("sanitizes command failures", async () => {
    const dependencies = fakeDependencies("", undefined, new Error("C:\\secret ACL SID script stderr"));
    const error = await queryWindowsSecuritySnapshot(
      [{ id: "one", path: "C:\\secret" }], dependencies,
    ).catch((failure: unknown) => failure);
    expect(error).toEqual(new WindowsSecuritySnapshotError());
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  });

  it("fails closed on unexpected stderr", async () => {
    await expect(queryWindowsSecuritySnapshot(
      [{ id: "one", path: "C:\\one" }],
      fakeDependencies("[{\"id\":\"one\",\"status\":\"missing\"}]", undefined, undefined, "diagnostic"),
    )).rejects.toEqual(new WindowsSecuritySnapshotError());
  });

  it("rejects non-Windows execution without invoking the runner", async () => {
    let calls = 0;
    const dependencies = fakeDependencies("[]", () => { calls += 1; });
    await expect(queryWindowsSecuritySnapshot(
      [{ id: "one", path: "C:\\one" }],
      { ...dependencies, platform: "linux" },
    )).rejects.toEqual(new WindowsSecuritySnapshotError());
    expect(calls).toBe(0);
  });
});

function fakeDependencies(output: string, called?: () => void, failure?: Error, stderr = ""): WindowsSecuritySnapshotDependencies {
  return {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    runCommand: async () => {
      called?.();
      if (failure !== undefined) throw failure;
      return { stdout: output, stderr };
    },
  };
}
