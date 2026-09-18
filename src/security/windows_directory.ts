import path from "node:path";

export type WindowsDirectoryCommand = (
  file: string, args: readonly string[], environment?: Readonly<Record<string, string>>,
  timeoutMs?: number,
) => string;

const WINDOWS_PRIVATE_DIRECTORY_CREATION_TIMEOUT_MS = 15_000;

/** Create with final security, without modifying a directory another caller created first. */
export function createWindowsPrivateDirectory(directory: string, sid: string, runCommand: WindowsDirectoryCommand): void {
  const executable = path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$ErrorActionPreference='Stop'
try {
  $sid=[Security.Principal.SecurityIdentifier]::new($env:GHCG_DIRECTORY_SID)
  $security=[Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true,$false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ObjectInherit,ContainerInherit','None','Allow'))
  [void][IO.Directory]::CreateDirectory($env:GHCG_DIRECTORY_PATH,$security)
  [Console]::Out.WriteLine('0')
} catch {
  [Console]::Out.WriteLine($_.Exception.GetBaseException().HResult)
}`;
  const result = runCommand(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    GHCG_DIRECTORY_PATH: path.toNamespacedPath(directory),
    GHCG_DIRECTORY_SID: sid,
  }, WINDOWS_PRIVATE_DIRECTORY_CREATION_TIMEOUT_MS).trim();
  if (result === "0") return;
  const hresult = Number(result);
  const windowsError = /^-\d{1,10}$/u.test(result) && hresult >= -2147483648 && (hresult >>> 16) === 0x8007
    ? hresult & 0xffff : 0;
  const codes: Readonly<Record<number, string>> = {
    2: "ENOENT", 3: "ENOENT", 5: "EACCES", 53: "ENOENT", 67: "ENOENT",
    80: "EEXIST", 87: "EINVAL", 112: "ENOSPC", 123: "ENOENT", 183: "EEXIST", 206: "ENAMETOOLONG", 267: "ENOTDIR",
  };
  throw Object.assign(new Error("unable to create daemon directory"), { code: codes[windowsError] ?? "EIO" });
}
