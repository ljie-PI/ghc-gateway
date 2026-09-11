import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export type ProcessStartIdentity = string;

export function isCanonicalProcessStartIdentity(value: unknown): value is ProcessStartIdentity {
  if (typeof value !== "string") return false;
  if (/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9]\d*)$/u.test(value)
    || /^windows:(0|[1-9]\d{0,19})$/u.test(value)) return true;
  const macOs = /^macos:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/u.exec(value);
  if (macOs?.[1] === undefined) return false;
  const milliseconds = Date.parse(macOs[1]);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().replace(".000Z", "Z") === macOs[1];
}

export interface ProcessIdentityContext {
  readonly signal?: AbortSignal;
}

export interface ProcessIdentityDependencies {
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string, context?: Readonly<ProcessIdentityContext>) => Promise<string>;
  readonly runCommand: (
    file: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    context?: Readonly<ProcessIdentityContext>,
  ) => Promise<string>;
}

export class ProcessIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessIdentityError";
  }
}

const DEFAULT_DEPENDENCIES: ProcessIdentityDependencies = {
  platform: process.platform,
  readFile: async (filePath, context) => await readFile(filePath, {
    encoding: "utf8",
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
  }),
  runCommand: runCommand,
};
const PROCESS_IDENTITY_TIMEOUT_MS = 5_000;

export async function captureProcessStartIdentity(
  pid: number,
  dependencies: ProcessIdentityDependencies = DEFAULT_DEPENDENCIES,
  context: Readonly<ProcessIdentityContext> = {},
): Promise<ProcessStartIdentity | null> {
  assertPid(pid);
  switch (dependencies.platform) {
  case "linux":
    return await captureLinuxIdentity(pid, dependencies, context);
  case "win32":
    return await captureWindowsIdentity(pid, dependencies, context);
  case "darwin":
    return await captureMacOsIdentity(pid, dependencies, context);
  default:
    throw new ProcessIdentityError("process identity is unsupported on this platform");
  }
}

export async function isSameProcess(
  pid: number,
  expected: ProcessStartIdentity,
  dependencies: ProcessIdentityDependencies = DEFAULT_DEPENDENCIES,
): Promise<boolean> {
  const actual = await captureProcessStartIdentity(pid, dependencies);
  return actual !== null && actual === expected;
}

export async function terminateProcessIfMatching(
  pid: number,
  expected: ProcessStartIdentity,
  dependencies: ProcessIdentityDependencies = DEFAULT_DEPENDENCIES,
  context: Readonly<ProcessIdentityContext> = {},
): Promise<boolean> {
  assertPid(pid);
  if (!isCanonicalProcessStartIdentity(expected)) return false;
  if (dependencies.platform === "win32") {
    const filetime = /^windows:(\d{1,20})$/u.exec(expected)?.[1];
    if (filetime === undefined) {
      return false;
    }
    const script = [
      `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      "if ($null -eq $process) { exit 3 }",
      `$expected = [Int64]::Parse('${filetime}', [Globalization.CultureInfo]::InvariantCulture)`,
      "if ($process.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $expected) { exit 4 }",
      "$process.Kill()",
      "if (-not $process.WaitForExit(10000)) { exit 5 }",
    ].join("; ");
    try {
      await dependencies.runCommand(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {},
        context,
      );
      return true;
    } catch (error: unknown) {
      if (commandExitCode(error) === 3 || commandExitCode(error) === 4) {
        return false;
      }
      throw new ProcessIdentityError("unable to terminate verified Windows process", { cause: error });
    }
  }
  if (dependencies.platform === "linux") {
    const match = /^linux:([0-9a-f-]{36}):(\d+)$/u.exec(expected);
    if (match?.[1] === undefined || match[2] === undefined) {
      return false;
    }
    const script = [
      `pid='${pid}'`,
      `expected_boot='${match[1]}'`,
      `expected_ticks='${match[2]}'`,
      "boot=$(tr '[:upper:]' '[:lower:]' < /proc/sys/kernel/random/boot_id) || exit 3",
      "stat=$(cat \"/proc/$pid/stat\") || exit 3",
      "rest=${stat##*) }",
      "ticks=$(printf '%s\\n' \"$rest\" | awk '{print $20}')",
      "[ \"$boot\" = \"$expected_boot\" ] && [ \"$ticks\" = \"$expected_ticks\" ] || exit 4",
      "kill -KILL \"$pid\"",
    ].join("; ");
    return await runVerifiedTermination("sh", ["-c", script], dependencies, context);
  }
  if (dependencies.platform === "darwin") {
    const timestamp = /^macos:(.+)$/u.exec(expected)?.[1];
    if (timestamp === undefined) {
      return false;
    }
    const script = [
      `pid='${pid}'`,
      "actual=$(LC_ALL=C TZ=UTC ps -o lstart= -p \"$pid\") || exit 3",
      `expected='${shellLiteral(timestamp)}'`,
      "actual_epoch=$(LC_ALL=C TZ=UTC date -j -f '%a %b %e %T %Y' \"$actual\" '+%Y-%m-%dT%H:%M:%SZ') || exit 3",
      "[ \"$actual_epoch\" = \"$expected\" ] || exit 4",
      "kill -KILL \"$pid\"",
    ].join("; ");
    return await runVerifiedTermination("sh", ["-c", script], dependencies, context);
  }
  return false;
}

async function runVerifiedTermination(
  file: string,
  args: readonly string[],
  dependencies: ProcessIdentityDependencies,
  context: Readonly<ProcessIdentityContext>,
): Promise<boolean> {
  try {
    await dependencies.runCommand(file, args, {}, context);
    return true;
  } catch (error: unknown) {
    if (commandExitCode(error) === 3 || commandExitCode(error) === 4) {
      return false;
    }
    throw new ProcessIdentityError("unable to terminate verified process", { cause: error });
  }
}

function shellLiteral(value: string): string {
  if (!/^[A-Za-z0-9:._+-]+$/u.test(value)) {
    throw new ProcessIdentityError("invalid process identity");
  }
  return value;
}

export function parseLinuxProcStatStartTicks(stat: string, expectedPid: number): string {
  assertPid(expectedPid);
  const closingParenthesis = stat.lastIndexOf(")");
  if (!stat.startsWith(`${expectedPid} (`) || closingParenthesis < String(expectedPid).length + 2) {
    throw new ProcessIdentityError("invalid Linux process stat data");
  }
  const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (fields.length < 20 || startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    throw new ProcessIdentityError("invalid Linux process stat data");
  }
  return canonicalUnsignedInteger(startTicks, "invalid Linux process start ticks");
}

async function captureLinuxIdentity(
  pid: number,
  dependencies: ProcessIdentityDependencies,
  context: Readonly<ProcessIdentityContext>,
): Promise<ProcessStartIdentity | null> {
  let stat: string;
  try {
    stat = await dependencies.readFile(`/proc/${pid}/stat`, context);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw new ProcessIdentityError("unable to read Linux process identity", { cause: error });
  }

  let bootId: string;
  try {
    bootId = (await dependencies.readFile("/proc/sys/kernel/random/boot_id", context)).trim().toLowerCase();
  } catch (error: unknown) {
    throw new ProcessIdentityError("unable to read Linux boot identity", { cause: error });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId)) {
    throw new ProcessIdentityError("invalid Linux boot identity");
  }
  return `linux:${bootId}:${parseLinuxProcStatStartTicks(stat, pid)}`;
}

async function captureWindowsIdentity(
  pid: number,
  dependencies: ProcessIdentityDependencies,
  context: Readonly<ProcessIdentityContext>,
): Promise<ProcessStartIdentity | null> {
  const script = [
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $process) { exit 3 }",
    "$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)",
  ].join("; ");
  let output: string;
  try {
    output = await dependencies.runCommand(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {},
      context,
    );
  } catch (error: unknown) {
    if (commandExitCode(error) === 3) {
      return null;
    }
    throw new ProcessIdentityError("unable to read Windows process identity", { cause: error });
  }
  const filetime = output.trim();
  if (!/^\d{1,20}$/u.test(filetime)) {
    throw new ProcessIdentityError("invalid Windows process creation FILETIME");
  }
  return `windows:${canonicalUnsignedInteger(filetime, "invalid Windows process creation FILETIME")}`;
}

async function captureMacOsIdentity(
  pid: number,
  dependencies: ProcessIdentityDependencies,
  context: Readonly<ProcessIdentityContext>,
): Promise<ProcessStartIdentity | null> {
  let output: string;
  try {
    output = await dependencies.runCommand(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { LC_ALL: "C", TZ: "UTC" },
      context,
    );
  } catch (error: unknown) {
    if (commandExitCode(error) === 1) {
      return null;
    }
    throw new ProcessIdentityError("unable to read macOS process identity", { cause: error });
  }
  const timestamp = parseMacOsStart(output.trim());
  return `macos:${timestamp}`;
}

function parseMacOsStart(value: string): string {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(value);
  if (match === null) {
    throw new ProcessIdentityError("invalid macOS process start time");
  }
  const months: Readonly<Record<string, number>> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const month = match[2] === undefined ? undefined : months[match[2]];
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (month === undefined || hour > 23 || minute > 59 || second > 59) {
    throw new ProcessIdentityError("invalid macOS process start time");
  }
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new ProcessIdentityError("invalid macOS process start time");
  }
  return date.toISOString().replace(".000Z", "Z");
}

async function runCommand(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  context: Readonly<ProcessIdentityContext> = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(file, [...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      windowsHide: true,
      timeout: PROCESS_IDENTITY_TIMEOUT_MS,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function canonicalUnsignedInteger(value: string, message: string): string {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new ProcessIdentityError(message);
    }
    return parsed.toString(10);
  } catch (error: unknown) {
    if (error instanceof ProcessIdentityError) {
      throw error;
    }
    throw new ProcessIdentityError(message, { cause: error });
  }
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new ProcessIdentityError("invalid process id");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function commandExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}
