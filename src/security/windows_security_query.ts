import path from "node:path";

export type WindowsSecurityRow = readonly [path: string, reparse: boolean | null, value: string | null];

/** Read-only reparse/owner or reparse/SDDL query; execution stays with the caller. */
export function windowsSecurityQuery(paths: readonly string[], field: "Owner" | "Sddl") {
  const requested = [...paths];
  if ((field !== "Owner" && field !== "Sddl") || requested.length === 0 || requested.length > 6
    || requested.some((target) => typeof target !== "string" || (!path.isAbsolute(target)
      && !path.win32.isAbsolute(target)) || /[\0\r\n]/u.test(target))
    || new Set(requested.map((target) => path.win32.normalize(target).toLowerCase())).size !== requested.length) {
    throw new Error("invalid Windows security query");
  }
  const input = Buffer.from(requested.join("\0"), "utf8").toString("base64");
  if (input.length > 24 * 1024) throw new Error("invalid Windows security query");
  // JSON escaping can double path/SDDL bytes; retain the existing 16 KiB value limit.
  const maxBuffer = requested.reduce((size, target) => size + 2 * (Buffer.byteLength(target, "utf8") + 16384) + 128, 0);
  const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
foreach($module in @('Management','Security','Utility')) {
  Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.$module\\Microsoft.PowerShell.$module.psd1"
}
$paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:GHCG_SECURITY_PATHS)).Split([char]0)
foreach($p in $paths) {
  try {
    $reparse=((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    $value=if($reparse){''}else{[string](Get-Acl -LiteralPath $p).${field}}
    $row=@($p,$reparse,$value)
  } catch { $row=@($p,$null,$null) }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $row -Compress))
}`;
  return {
    executable: path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    environment: { GHCG_SECURITY_PATHS: input },
    maxBuffer,
    parse(output: string): readonly WindowsSecurityRow[] {
      const lines = output.replace(/\r?\n$/u, "").split(/\r?\n/u);
      if (Buffer.byteLength(output, "utf8") > maxBuffer || lines.length !== requested.length) {
        throw new Error("invalid Windows security result");
      }
      return lines.map((line, index) => {
        let row: unknown;
        try { row = JSON.parse(line); } catch { throw new Error("invalid Windows security result"); }
        if (!Array.isArray(row) || row.length !== 3 || row[0] !== requested[index]
          || !(row[1] === null && row[2] === null || typeof row[1] === "boolean"
            && typeof row[2] === "string" && Buffer.byteLength(row[2], "utf8") <= 16384
            && !/[\0\r\n]/u.test(row[2]))) {
          throw new Error("invalid Windows security result");
        }
        return row as unknown as WindowsSecurityRow;
      });
    },
  };
}
