import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_CONCURRENCY = 64;
const MAX_OUTPUT_BYTES = 16 * 1024;
const PHASES = [
  "script_ready",
  "sid_begin",
  "sid_end",
  "security_begin",
  "security_end",
  "create_begin",
  "create_end",
  "script_complete",
];
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"]);
const SCRIPT = `$ErrorActionPreference='Stop'
$clock=[Diagnostics.Stopwatch]::StartNew()
function Trace([string]$phase) {
  [Console]::Out.WriteLine("GHCG_PHASE:$($phase):$($script:clock.ElapsedTicks)")
  [Console]::Out.Flush()
}
[Console]::Out.WriteLine("GHCG_FREQUENCY:$([Diagnostics.Stopwatch]::Frequency)")
[Console]::Out.Flush()
Trace('script_ready')
try {
  Trace('sid_begin')
  $sid=[Security.Principal.SecurityIdentifier]::new($env:GHCG_DIRECTORY_SID)
  Trace('sid_end')
  Trace('security_begin')
  $security=[Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true,$false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ObjectInherit,ContainerInherit','None','Allow'))
  Trace('security_end')
  Trace('create_begin')
  [void][IO.Directory]::CreateDirectory($env:GHCG_DIRECTORY_PATH,$security)
  Trace('create_end')
  Trace('script_complete')
  [Console]::Out.WriteLine('GHCG_RESULT:0')
} catch {
  [Console]::Out.WriteLine("GHCG_RESULT:$($_.Exception.GetBaseException().HResult)")
}
[Console]::Out.Flush()`;

await main();

async function main() {
  if (process.platform !== "win32") {
    process.stderr.write("issue #225 directory probe requires Windows\n");
    process.exitCode = 2;
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const parallelism = availableParallelism();
  const concurrency = options.concurrency ?? parallelism;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("probe concurrency is outside the supported range");
  }

  const writer = createWriter(options.output);
  const deadline = performance.now() + COMMAND_TIMEOUT_MS;
  const powershell = path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const whoami = path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32", "whoami.exe");
  writer.write({
    event: "probe_start",
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    availableParallelism: parallelism,
    concurrency,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });

  let root;
  let operationResults = [];
  let setupFailure = null;
  let cleanupOutcome = "not_needed";
  try {
    const identityStarted = performance.now();
    const sid = await currentSid(whoami, deadline);
    writer.write({
      event: "identity_finish",
      elapsedMs: roundedMilliseconds(performance.now() - identityStarted),
      outcome: "success",
    });
    root = mkdtempSync(path.join(tmpdir(), "ghcg-issue-225-"));
    operationResults = await runWave(powershell, sid, root, concurrency, deadline);
    for (const result of operationResults) writer.write(result);
  } catch (error) {
    setupFailure = safeErrorKind(error);
    writer.write({ event: "setup_failure", errorKind: setupFailure });
  } finally {
    if (root !== undefined && operationResults.every((result) => result.childClosed !== false)) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        cleanupOutcome = "success";
      } catch {
        cleanupOutcome = "failure";
      }
    } else if (root !== undefined) {
      cleanupOutcome = "skipped_active";
    }
  }

  const failures = operationResults.filter((result) => result.outcome !== "success").length;
  const timeouts = operationResults.filter((result) => result.outcome === "timeout").length;
  const failed = setupFailure !== null || failures > 0 || cleanupOutcome === "failure"
    || operationResults.length !== concurrency;
  writer.write({
    event: "probe_finish",
    outcome: failed ? "failure" : "success",
    operations: operationResults.length,
    failures,
    timeouts,
    cleanupOutcome,
  });
  writer.close();
  process.stdout.write(`${JSON.stringify({ concurrency, operations: operationResults.length, failures, timeouts, cleanupOutcome })}\n`);
  if (failed) process.exitCode = 1;
}

function parseOptions(args) {
  let output;
  let concurrency;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output" && args[index + 1] !== undefined) {
      output = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index] === "--concurrency" && args[index + 1] !== undefined) {
      concurrency = Number(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("invalid probe arguments");
  }
  if (output === undefined || output.length > 4096 || /[\0\r\n]/u.test(output)) {
    throw new Error("a bounded output path is required");
  }
  return { output, concurrency };
}

function createWriter(output) {
  mkdirSync(path.dirname(output), { recursive: true });
  const descriptor = openSync(output, "wx", 0o600);
  let sequence = 0;
  return {
    write(event) {
      const record = JSON.stringify({ version: 1, sequence: sequence++, ...event });
      if (Buffer.byteLength(record, "utf8") > 2048) throw new Error("probe record exceeded its size bound");
      writeSync(descriptor, `${record}\n`, undefined, "utf8");
    },
    close() {
      closeSync(descriptor);
    },
  };
}

function currentSid(executable, deadline) {
  return new Promise((resolve, reject) => {
    const remainingMs = remainingMilliseconds(deadline);
    if (remainingMs <= 0) {
      reject(Object.assign(new Error("probe deadline expired"), { code: "ETIMEDOUT" }));
      return;
    }
    let child;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let commandError;
    let settled = false;
    const settle = (error, childClosed) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      if (!childClosed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The hard deadline still completes the probe without waiting.
        }
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (error !== null) {
        reject(error);
        return;
      }
      const match = /^"[^"\r\n]+","(S-\d+(?:-\d+)+)"\r?\n?$/u.exec(stdout);
      if (match?.[1] === undefined) reject(new Error("current identity was unavailable"));
      else resolve(match[1]);
    };
    try {
      child = spawn(executable, ["/user", "/fo", "csv", "/nh"], {
        windowsHide: true,
        timeout: remainingMs,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timeoutError = Object.assign(new Error("probe deadline expired"), { code: "ETIMEDOUT" });
    const killTimer = setTimeout(() => {
      commandError = timeoutError;
      try {
        child.kill("SIGKILL");
      } catch {
        // The absolute deadline below settles even if termination fails.
      }
    }, Math.max(0, remainingMs - 100));
    const hardTimer = setTimeout(() => settle(timeoutError, false), remainingMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) {
        commandError = new Error("current identity output exceeded its bound");
        try { child.kill("SIGKILL"); } catch { /* Closure reports the bounded failure. */ }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        commandError = new Error("current identity error output exceeded its bound");
        try { child.kill("SIGKILL"); } catch { /* Closure reports the bounded failure. */ }
      }
    });
    child.once("error", (error) => {
      commandError = error;
    });
    child.once("close", (exitCode) => {
      if (exitCode !== 0 || stderrBytes !== 0) commandError ??= new Error("current identity command failed");
      settle(commandError ?? null, true);
    });
  });
}

async function runWave(executable, sid, root, concurrency, deadline) {
  const waveStarted = performance.now();
  const operations = Array.from({ length: concurrency }, (_, index) => {
    const target = path.join(root, `directory-${index}`);
    return runCreation(executable, sid, target, index, waveStarted, deadline);
  });
  return await Promise.all(operations);
}

function runCreation(executable, sid, target, index, waveStarted, deadline) {
  return new Promise((resolve) => {
    const started = performance.now();
    const remainingMs = remainingMilliseconds(deadline);
    if (remainingMs <= 0) {
      resolve(deadlineRecord(index, waveStarted, started));
      return;
    }
    const phaseTicks = new Map();
    const phaseReceiptMs = new Map();
    let frequency = null;
    let result = null;
    let expectedPhase = 0;
    let lastTicks = -1;
    let pending = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let malformed = false;
    let spawnError = null;
    let settled = false;
    let timeoutSource = null;
    let child;
    let commandTimer;
    let hardTimer;

    const settle = (exitCode, signal, childClosed) => {
      if (settled) return;
      settled = true;
      if (commandTimer !== undefined) clearTimeout(commandTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (childClosed && pending.length > 0) consumeLine(pending);
      if (!childClosed) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      const directoryPresent = isDirectory(target);
      const complete = expectedPhase === PHASES.length;
      const outcome = timeoutSource === "deadline"
        ? "timeout"
        : spawnError !== null
          ? "spawn_error"
          : malformed || stderrBytes !== 0
            ? "malformed_output"
            : exitCode !== 0
              ? "exit_error"
              : result !== "0"
                ? "powershell_error"
                : !complete
                  ? "incomplete_output"
                  : !directoryPresent
                    ? "missing_directory"
                    : "success";
      resolve({
        event: "directory_create",
        index,
        launchOffsetMs: roundedMilliseconds(started - waveStarted),
        childPid: boundedInteger(child.pid),
        childClosed,
        outcome,
        errorKind: spawnError,
        timeoutSource,
        exitCode: safeExitCode(exitCode),
        signal: typeof signal === "string" && SIGNALS.has(signal) ? signal : null,
        lastPhase: expectedPhase === 0 ? null : PHASES[expectedPhase - 1],
        launchToScriptMs: roundedOptional(phaseReceiptMs.get("script_ready")),
        sidMs: phaseDuration(phaseTicks, frequency, "sid_begin", "sid_end"),
        securityDescriptorMs: phaseDuration(phaseTicks, frequency, "security_begin", "security_end"),
        createDirectoryMs: phaseDuration(phaseTicks, frequency, "create_begin", "create_end"),
        scriptTotalMs: ticksToMilliseconds(phaseTicks.get("script_complete"), frequency),
        nodeTotalMs: roundedMilliseconds(performance.now() - started),
        stdoutBytes,
        stderrBytes,
      });
    };

    const state = {
      terminate(source) {
        if (settled || child === undefined) return;
        timeoutSource ??= source;
        try {
          child.kill("SIGKILL");
        } catch {
          // Closure records the command failure without exposing diagnostics.
        }
      },
    };

    const consumeLine = (rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) return;
      if (line.length > 256) {
        malformed = true;
        state.terminate("output_bound");
        return;
      }
      const frequencyMatch = /^GHCG_FREQUENCY:(\d{1,20})$/u.exec(line);
      if (frequencyMatch?.[1] !== undefined) {
        const value = Number(frequencyMatch[1]);
        if (frequency !== null || expectedPhase !== 0 || !Number.isSafeInteger(value) || value <= 0) malformed = true;
        else frequency = value;
        return;
      }
      const phaseMatch = /^GHCG_PHASE:([a-z_]+):(\d{1,20})$/u.exec(line);
      if (phaseMatch?.[1] !== undefined && phaseMatch[2] !== undefined) {
        const phase = phaseMatch[1];
        const ticks = Number(phaseMatch[2]);
        if (frequency === null || phase !== PHASES[expectedPhase]
          || !Number.isSafeInteger(ticks) || ticks < lastTicks) {
          malformed = true;
          return;
        }
        expectedPhase += 1;
        lastTicks = ticks;
        phaseTicks.set(phase, ticks);
        phaseReceiptMs.set(phase, performance.now() - started);
        return;
      }
      const resultMatch = /^GHCG_RESULT:(-?\d{1,10})$/u.exec(line);
      if (resultMatch?.[1] !== undefined && result === null && frequency !== null && expectedPhase > 0) {
        result = resultMatch[1];
        return;
      }
      malformed = true;
    };

    try {
      child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
        env: {
          ...process.env,
          GHCG_DIRECTORY_PATH: path.toNamespacedPath(target),
          GHCG_DIRECTORY_SID: sid,
        },
        windowsHide: true,
        timeout: remainingMs,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(failedSpawnRecord(index, waveStarted, started, error));
      return;
    }
    commandTimer = setTimeout(() => state.terminate("deadline"), Math.max(0, remainingMs - 100));
    hardTimer = setTimeout(() => {
      state.terminate("deadline");
      settle(null, "SIGKILL", false);
    }, remainingMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        malformed = true;
        state.terminate("output_bound");
        return;
      }
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        malformed = true;
        state.terminate("output_bound");
      }
    });
    child.once("error", (error) => {
      spawnError = safeErrorKind(error);
    });
    child.once("close", (exitCode, signal) => {
      settle(exitCode, signal, true);
    });
  });
}

function failedSpawnRecord(index, waveStarted, started, error) {
  return {
    event: "directory_create",
    index,
    launchOffsetMs: roundedMilliseconds(started - waveStarted),
    childPid: null,
    childClosed: true,
    outcome: "spawn_error",
    errorKind: safeErrorKind(error),
    timeoutSource: null,
    exitCode: null,
    signal: null,
    lastPhase: null,
    launchToScriptMs: null,
    sidMs: null,
    securityDescriptorMs: null,
    createDirectoryMs: null,
    scriptTotalMs: null,
    nodeTotalMs: roundedMilliseconds(performance.now() - started),
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

function deadlineRecord(index, waveStarted, started) {
  return {
    ...failedSpawnRecord(index, waveStarted, started, Object.assign(new Error("probe deadline expired"), { code: "ETIMEDOUT" })),
    outcome: "timeout",
    timeoutSource: "deadline",
  };
}

function phaseDuration(ticks, frequency, start, end) {
  const startTicks = ticks.get(start);
  const endTicks = ticks.get(end);
  if (startTicks === undefined || endTicks === undefined || frequency === null || endTicks < startTicks) return null;
  return roundedMilliseconds((endTicks - startTicks) * 1000 / frequency);
}

function ticksToMilliseconds(ticks, frequency) {
  if (ticks === undefined || frequency === null) return null;
  return roundedMilliseconds(ticks * 1000 / frequency);
}

function roundedOptional(value) {
  return value === undefined ? null : roundedMilliseconds(value);
}

function safeErrorKind(error) {
  if (typeof error !== "object" || error === null || typeof error.code !== "string") return "command_error";
  const known = new Map([
    ["ETIMEDOUT", "timeout"],
    ["ENOENT", "not_found"],
    ["EACCES", "access_denied"],
    ["EPERM", "access_denied"],
    ["ABORT_ERR", "abort"],
  ]);
  return known.get(error.code) ?? "command_error";
}

function isDirectory(target) {
  try {
    return existsSync(target) && lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function boundedInteger(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffff_ffff ? value : null;
}

function safeExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : null;
}

function roundedMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function remainingMilliseconds(deadline) {
  return Math.max(0, Math.floor(deadline - performance.now()));
}
