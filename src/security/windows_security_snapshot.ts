import path from "node:path";
import { execFile } from "node:child_process";
import { windowsPowerShellPath } from "./windows_acl.js";

export interface WindowsSecuritySnapshotRequest {
  readonly id: string;
  readonly path: string;
  readonly security?: false;
}

export type WindowsSecuritySnapshotFact =
  | { readonly id: string; readonly status: "missing" }
  | { readonly id: string; readonly status: "error" }
  | { readonly id: string; readonly status: "present"; readonly reparse: boolean; readonly owner?: string; readonly sddl?: string };

export interface WindowsSecuritySnapshotCommandOptions {
  readonly encoding: "utf8";
  readonly windowsHide: true;
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface WindowsSecuritySnapshotDependencies {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly runCommand: (
    file: string,
    args: readonly string[],
    options: Readonly<WindowsSecuritySnapshotCommandOptions>,
    input: Buffer,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

interface WindowsSecuritySnapshotCommandInput {
  on(event: "error", listener: (error: unknown) => void): unknown;
  end(input: Buffer): void;
}

type WindowsSecuritySnapshotCommandStarter = (
  file: string,
  args: readonly string[],
  options: Readonly<WindowsSecuritySnapshotCommandOptions>,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { readonly stdin: WindowsSecuritySnapshotCommandInput | null };

export class WindowsSecuritySnapshotError extends Error {
  constructor() {
    super("unable to query Windows security snapshot");
    this.name = "WindowsSecuritySnapshotError";
  }
}

const MAX_REQUESTS = 32;
const MAX_PATH_LENGTH = 4096;
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_FACT_LENGTH = 16 * 1024;
const QUERY_TIMEOUT_MS = 10_000;

const DEFAULT_DEPENDENCIES: WindowsSecuritySnapshotDependencies = {
  platform: process.platform,
  environment: process.env,
  runCommand: runWindowsSecuritySnapshotCommand,
};

export async function runWindowsSecuritySnapshotCommand(
  file: string,
  args: readonly string[],
  options: Readonly<WindowsSecuritySnapshotCommandOptions>,
  input: Buffer,
  start: WindowsSecuritySnapshotCommandStarter = execFile as WindowsSecuritySnapshotCommandStarter,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) { settled = true; reject(error); }
    };
    const child = start(file, args, options, (error, stdout, stderr) => {
      if (error !== null) fail(error);
      else if (!settled) { settled = true; resolve({ stdout, stderr }); }
    });
    if (child.stdin === null) fail(new Error());
    else {
      child.stdin.on("error", fail);
      child.stdin.end(input);
    }
  });
}

const SCRIPT = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1"
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"
$requests=[Console]::In.ReadToEnd() | ConvertFrom-Json
$results=@($requests | ForEach-Object {
  $id=$_.id
  try {
    $item=Get-Item -LiteralPath $_.path -Force -ErrorAction Stop
    $result=[ordered]@{id=$id;status='present';reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)}
    if($_.security -ne $false){$acl=Get-Acl -LiteralPath $_.path -ErrorAction Stop;$result.owner=$acl.Owner;$result.sddl=$acl.Sddl}
    $result
  } catch [Management.Automation.ItemNotFoundException] {
    [ordered]@{id=$id;status='missing'}
  } catch {
    [ordered]@{id=$id;status='error'}
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress -Depth 3))`;

export async function queryWindowsSecuritySnapshot(
  requests: readonly WindowsSecuritySnapshotRequest[],
  dependencies: WindowsSecuritySnapshotDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly WindowsSecuritySnapshotFact[]> {
  try {
    const input = validateRequests(requests, dependencies.platform);
    const executable = windowsPowerShellPath(dependencies.platform, dependencies.environment);
    const { stdout, stderr } = await dependencies.runCommand(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...dependencies.environment },
      },
      input,
    );
    if (stderr.length !== 0) throw new Error();
    return parseFacts(stdout, requests);
  } catch {
    throw new WindowsSecuritySnapshotError();
  }
}

function validateRequests(requests: readonly WindowsSecuritySnapshotRequest[], platform: NodeJS.Platform): Buffer {
  if (platform !== "win32" || requests.length === 0 || requests.length > MAX_REQUESTS) throw new Error();
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const request of requests) {
    const normalized = path.win32.normalize(request.path);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(request.id) || ids.has(request.id)
      || request.path.length === 0 || request.path.length > MAX_PATH_LENGTH
      || [...request.path].some((character) => character.charCodeAt(0) <= 0x1f)
      || !path.win32.isAbsolute(request.path)
      || normalized !== request.path || paths.has(normalized.toLowerCase())) throw new Error();
    ids.add(request.id);
    paths.add(normalized.toLowerCase());
  }
  const input = Buffer.from(JSON.stringify(requests), "utf8");
  if (input.length > MAX_INPUT_BYTES) throw new Error();
  return input;
}

function parseFacts(stdout: string, requests: readonly WindowsSecuritySnapshotRequest[]): readonly WindowsSecuritySnapshotFact[] {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES || !stdout.startsWith("[") || !stdout.endsWith("]")) throw new Error();
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length !== requests.length) throw new Error();
  return value.map((row, index) => parseFact(row, requests[index]!));
}

function parseFact(value: unknown, request: WindowsSecuritySnapshotRequest): WindowsSecuritySnapshotFact {
  if (!isRecord(value) || value.id !== request.id || typeof value.status !== "string") throw new Error();
  if (value.status === "missing" || value.status === "error") {
    if (!hasExactKeys(value, ["id", "status"])) throw new Error();
    return { id: request.id, status: value.status };
  }
  if (value.status !== "present" || typeof value.reparse !== "boolean") throw new Error();
  if (request.security === false) {
    if (!hasExactKeys(value, ["id", "status", "reparse"])) throw new Error();
    return { id: request.id, status: "present", reparse: value.reparse };
  }
  if (!hasExactKeys(value, ["id", "status", "reparse", "owner", "sddl"])
    || !isBoundedFact(value.owner) || !isBoundedFact(value.sddl)) throw new Error();
  return { id: request.id, status: "present", reparse: value.reparse, owner: value.owner, sddl: value.sddl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isBoundedFact(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_FACT_LENGTH;
}
