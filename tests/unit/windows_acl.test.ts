import path from "node:path";
import { describe, expect, it } from "vitest";
import { WindowsAcl, windowsCommandPath, type WindowsCommandRunner } from "../../src/security/windows_acl.js";

describe("Windows ACL helper", () => {
  it("resolves the current identity and parses explicit ACL principals through an injected runner", () => {
    const calls: string[] = [];
    const runCommand: WindowsCommandRunner = (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "whoami") return "\"CONTOSO\\User\",\"S-1-5-21-1000\"\r\n";
      return "C:\\private CONTOSO\\User:(F)\r\n"
        + "             S-1-5-32-544:(I)(F)\r\n"
        + "Successfully processed 1 files; Failed processing 0 files\r\n";
    };
    const acl = new WindowsAcl(runCommand);

    expect(acl.currentIdentity()).toEqual({ name: "contoso\\user", sid: "s-1-5-21-1000" });
    expect(acl.identities("C:\\private")).toEqual(["CONTOSO\\User", "S-1-5-32-544"]);
    expect(acl.isCurrentIdentity("CONTOSO\\USER", { name: "contoso\\user", sid: "s-1-5-21-1000" })).toBe(true);
    expect(calls).toEqual([
      "whoami /user /fo csv /nh",
      "icacls C:\\private",
    ]);
  });

  it("preserves the plain Error shape when the current identity cannot be parsed", () => {
    const acl = new WindowsAcl(() => "unexpected output");

    expect(() => acl.currentIdentity()).toThrow(expect.objectContaining({
      name: "Error",
      message: "unable to resolve current Windows identity",
    }));
  });

  it("restricts a directory to the current SID and removes other explicit grants", () => {
    const calls: Array<{ readonly file: string; readonly args: readonly string[] }> = [];
    const runCommand: WindowsCommandRunner = (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === "whoami") return "\"CONTOSO\\User\",\"S-1-5-21-1000\"\r\n";
      if (args.length === 1) {
        return "C:\\private CONTOSO\\User:(F)\r\n             BUILTIN\\Administrators:(F)\r\n";
      }
      return "";
    };
    const acl = new WindowsAcl(runCommand);

    acl.restrict("C:\\private", true, { setOwner: true });

    expect(calls).toEqual([
      { file: "whoami", args: ["/user", "/fo", "csv", "/nh"] },
      { file: "icacls", args: ["C:\\private", "/setowner", "*s-1-5-21-1000"] },
      { file: "icacls", args: ["C:\\private", "/inheritance:r", "/grant:r", "*s-1-5-21-1000:(OI)(CI)(F)"] },
      { file: "icacls", args: ["C:\\private"] },
      { file: "icacls", args: ["C:\\private", "/remove:g", "BUILTIN\\Administrators"] },
    ]);
  });

  it("optionally caches the current identity for repeated ACL operations", () => {
    let identityCalls = 0;
    const acl = new WindowsAcl((file) => {
      if (file === "whoami") {
        identityCalls += 1;
        return "\"user\",\"S-1-5-21-1000\"";
      }
      return "C:\\private user:(F)";
    }, { cacheIdentity: true });

    expect(acl.currentIdentity()).toEqual({ name: "user", sid: "s-1-5-21-1000" });
    expect(acl.isCurrentUserOnly("C:\\private")).toBe(true);
    acl.restrict("C:\\private", false);

    expect(identityCalls).toBe(1);
  });

  it("can preserve existing explicit grants for consumers that only protect newly-created paths", () => {
    const calls: string[] = [];
    const acl = new WindowsAcl((file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      return file === "whoami" ? "\"user\",\"S-1-5-21-1000\"" : "";
    });

    acl.restrict("C:\\logs", false, { removeOtherIdentities: false });

    expect(calls).toEqual([
      "whoami /user /fo csv /nh",
      "icacls C:\\logs /inheritance:r /grant:r *s-1-5-21-1000:(F)",
    ]);
  });

  it("resolves system commands without relying on the caller PATH", () => {
    expect(windowsCommandPath("icacls", "win32", { SystemRoot: "D:\\Windows" })).toBe(
      path.join("D:\\Windows", "System32", "icacls.exe"),
    );
    expect(windowsCommandPath("icacls", "linux", {})).toBe("icacls");
  });
});
