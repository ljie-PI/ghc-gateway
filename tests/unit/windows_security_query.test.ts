import { describe, expect, it } from "vitest";
import { windowsSecurityQuery } from "../../src/security/windows_security_query.js";

describe("Windows read-only security query", () => {
  const paths = ["C:\\quote ' 雪 [x] ; $()\\one", "D:\\two"];
  const sddl = "O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FR;;;BA)";

  it("transports literal paths as data and preserves the complete SDDL", () => {
    const query = windowsSecurityQuery(paths, "Sddl");
    expect(Buffer.from(query.environment.GHCG_SECURITY_PATHS, "base64").toString("utf8").split("\0")).toEqual(paths);
    expect(query.args.at(-1)).not.toContain(paths[0]);
    expect(query.args.at(-1)).toContain("Get-Item -LiteralPath $p");
    expect(query.args.at(-1)).toContain("Get-Acl -LiteralPath $p");
    expect(query.args.at(-1)).not.toContain("Set-Acl");
    expect(query.executable).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
    const rows = [[paths[0], false, sddl], [paths[1], true, ""]];
    expect(query.parse(rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n")).toEqual(rows);
  });

  it.each([
    ["missing", [[paths[0], false, sddl]]],
    ["duplicate", [[paths[0], false, sddl], [paths[0], false, sddl]]],
    ["extra", [[paths[0], false, sddl], [paths[1], false, sddl], [paths[1], false, sddl]]],
    ["reordered", [[paths[1], false, sddl], [paths[0], false, sddl]]],
    ["wrong flag", [[paths[0], "false", sddl], [paths[1], false, sddl]]],
    ["extra field", [[paths[0], false, sddl, true], [paths[1], false, sddl]]],
    ["wrong value", [[paths[0], false, {}], [paths[1], false, sddl]]],
    ["partial error", [[paths[0], null, sddl], [paths[1], false, sddl]]],
  ])("rejects %s rows instead of mixing path evidence", (_kind, rows) => {
    const query = windowsSecurityQuery(paths, "Sddl");
    expect(() => query.parse(rows.map((row) => JSON.stringify(row)).join("\n"))).toThrow("invalid Windows security result");
  });

  it("keeps individual query failures separate from protocol failures", () => {
    const query = windowsSecurityQuery(paths, "Owner");
    const rows = [[paths[0], null, null], [paths[1], false, "CONTOSO\\User"]];
    expect(query.parse(rows.map((row) => JSON.stringify(row)).join("\n"))).toEqual(rows);
    for (const invalid of ["", "private diagnostic", JSON.stringify(rows[0]) + "\n[", "x".repeat(query.maxBuffer + 1)]) {
      expect(() => query.parse(invalid)).toThrow("invalid Windows security result");
    }
  });

  it("bounds input and individual values without interpreting SDDL principals", () => {
    for (const invalid of [[], ["relative"], ["C:\\one\0two"], ["C:\\one", "c:/one"],
      Array.from({ length: 7 }, (_, index) => `C:\\${index}`), ["C:\\" + "x".repeat(24000)]]) {
      expect(() => windowsSecurityQuery(invalid, "Owner")).toThrow("invalid Windows security query");
    }
    const query = windowsSecurityQuery([paths[0]!], "Sddl");
    expect(query.parse(JSON.stringify([paths[0], false, "D:NO_ACCESS_CONTROL"]))).toEqual([[paths[0], false, "D:NO_ACCESS_CONTROL"]]);
    expect(() => query.parse(JSON.stringify([paths[0], false, "x".repeat(16385)]))).toThrow("invalid Windows security result");
  });
});
