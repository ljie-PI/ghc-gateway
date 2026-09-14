import path from "node:path";

export type WindowsDirectoryCommand = (
  file: string, args: readonly string[], environment?: Readonly<Record<string, string>>,
) => string;

/** Create with final security, without modifying a directory another caller created first. */
export function createWindowsPrivateDirectory(directory: string, sid: string, runCommand: WindowsDirectoryCommand): void {
  const executable = path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$ErrorActionPreference='Stop'
function Trace([string]$phase) {
  if($env:GHCG_WINDOWS_DIAGNOSTIC_PHASES -eq '1') {[Console]::Out.WriteLine("GHCG_PHASE:$phase")}
}
Trace('script_started')
try {
  $sid=[Security.Principal.SecurityIdentifier]::new($env:GHCG_DIRECTORY_SID)
  Trace('sid_ready')
  $security=[Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true,$false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ObjectInherit,ContainerInherit','None','Allow'))
  Trace('security_ready')
  Trace('create_begin')
  [void][IO.Directory]::CreateDirectory($env:GHCG_DIRECTORY_PATH,$security)
  Trace('create_complete')
  [Console]::Out.WriteLine('0')
} catch {
  [Console]::Out.WriteLine($_.Exception.GetBaseException().HResult)
}`;
  const result = runCommand(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    GHCG_DIRECTORY_PATH: path.toNamespacedPath(directory),
    GHCG_DIRECTORY_SID: sid,
    GHCG_WINDOWS_DIAGNOSTIC_PHASES: (process.env.GHCG_WINDOWS_LIFECYCLE_DIAGNOSTICS_DIR?.length ?? 0) > 0 ? "1" : "0",
  }).trim();
  const lines = result.split(/\r?\n/u);
  const outcome = lines.at(-1) ?? "";
  if (lines.slice(0, -1).some((line) => !/^GHCG_PHASE:(?:script_started|sid_ready|security_ready|create_begin|create_complete)$/u.test(line))) {
    throw Object.assign(new Error("unable to create daemon directory"), { code: "EIO" });
  }
  if (outcome === "0") return;
  const hresult = Number(outcome);
  const windowsError = /^-\d{1,10}$/u.test(outcome) && hresult >= -2147483648 && (hresult >>> 16) === 0x8007
    ? hresult & 0xffff : 0;
  const codes: Readonly<Record<number, string>> = {
    2: "ENOENT", 3: "ENOENT", 5: "EACCES", 53: "ENOENT", 67: "ENOENT",
    80: "EEXIST", 87: "EINVAL", 112: "ENOSPC", 123: "ENOENT", 183: "EEXIST", 206: "ENAMETOOLONG", 267: "ENOTDIR",
  };
  throw Object.assign(new Error("unable to create daemon directory"), { code: codes[windowsError] ?? "EIO" });
}
