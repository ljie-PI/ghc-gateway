import path from "node:path";
import { execFile } from "node:child_process";
import { windowsPowerShellPath } from "./windows_acl.js";

export interface WindowsSecuritySnapshotRequest {
  readonly id: string;
  readonly path: string;
}

export type WindowsSecuritySnapshotFact =
  | { readonly id: string; readonly status: "missing" }
  | { readonly id: string; readonly status: "error" }
  | { readonly id: string; readonly status: "present"; readonly reparse: boolean; readonly owner: string; readonly sddl: string };

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
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export class WindowsSecuritySnapshotError extends Error {
  constructor() {
    super("unable to query Windows security snapshot");
    this.name = "WindowsSecuritySnapshotError";
  }
}

const MAX_REQUESTS = 16;
const MAX_PATH_LENGTH = 4096;
const MAX_INPUT_BYTES = 12 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_FACT_LENGTH = 16 * 1024;
const QUERY_TIMEOUT_MS = 10_000;

const DEFAULT_DEPENDENCIES: WindowsSecuritySnapshotDependencies = {
  platform: process.platform,
  environment: process.env,
  runCommand: async (file, args, options) => await new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error !== null) reject(error);
      else resolve({ stdout, stderr });
    });
  }),
};

const SCRIPT = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1"
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"
$requests=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:GHCG_WINDOWS_SECURITY_REQUEST)) | ConvertFrom-Json
$results=@($requests | ForEach-Object {
  $id=$_.id
  try {
    $item=Get-Item -LiteralPath $_.path -Force -ErrorAction Stop
    $acl=Get-Acl -LiteralPath $_.path -ErrorAction Stop
    [ordered]@{id=$id;status='present';reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0);owner=$acl.Owner;sddl=$acl.Sddl}
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
        env: { ...dependencies.environment, GHCG_WINDOWS_SECURITY_REQUEST: input.toString("base64") },
      },
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
  return value.map((row, index) => parseFact(row, requests[index]!.id));
}

function parseFact(value: unknown, expectedId: string): WindowsSecuritySnapshotFact {
  if (!isRecord(value) || value.id !== expectedId || typeof value.status !== "string") throw new Error();
  if (value.status === "missing" || value.status === "error") {
    if (!hasExactKeys(value, ["id", "status"])) throw new Error();
    return { id: expectedId, status: value.status };
  }
  if (value.status !== "present" || !hasExactKeys(value, ["id", "status", "reparse", "owner", "sddl"])
    || typeof value.reparse !== "boolean" || !isBoundedFact(value.owner) || !isBoundedFact(value.sddl)) throw new Error();
  return { id: expectedId, status: "present", reparse: value.reparse, owner: value.owner, sddl: value.sddl };
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
