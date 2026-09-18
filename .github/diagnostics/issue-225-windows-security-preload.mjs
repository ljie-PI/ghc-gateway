import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { threadId } from "node:worker_threads";

const INSTALL_SYMBOL = Symbol.for("ghcg.issue225.windowsSecurityTrace");
const MAX_RECORDS = 4096;
const MAX_RECORD_BYTES = 2048;
const RUN_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const COMMANDS = new Set(["powershell", "whoami", "icacls"]);
const PURPOSES = new Set([
  "directory_create",
  "current_identity",
  "reparse_inspection",
  "owner_inspection",
  "process_identity",
  "process_terminate",
  "acl_inspection",
  "acl_mutation",
  "acl_restore",
  "powershell_other",
]);
const OUTCOMES = new Set(["success", "timeout", "failure"]);
const APIS = new Set(["execFile", "execFileSync"]);
const ERROR_CODES = new Set(["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ABORT_ERR"]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"]);
const TRACE_KEYS = new Set([
  "version", "event", "run", "pid", "ppid", "threadId", "workerId", "role",
  "availableParallelism", "sequence", "invocation", "api", "command", "purpose",
  "atUnixMs", "timeoutMs", "elapsedMs", "outcome", "errorCode", "exitCode", "signal", "childPid",
]);
const COMMON_KEYS = [
  "version", "event", "run", "pid", "ppid", "threadId", "workerId", "role",
  "availableParallelism", "sequence", "atUnixMs",
];
const EVENT_KEYS = new Map([
  ["process_start", new Set(COMMON_KEYS)],
  ["process_exit", new Set([...COMMON_KEYS, "exitCode"])],
  ["truncated", new Set(COMMON_KEYS)],
  ["command_start", new Set([
    ...COMMON_KEYS, "invocation", "api", "command", "purpose", "timeoutMs",
  ])],
  ["command_finish", new Set([
    ...COMMON_KEYS, "invocation", "api", "command", "purpose", "timeoutMs",
    "elapsedMs", "outcome", "errorCode", "exitCode", "signal", "childPid",
  ])],
]);

const invokedAsMain = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsMain) {
  verifyFromCommandLine(process.argv.slice(2));
} else {
  installTrace();
}

function installTrace() {
  if (process.platform !== "win32" || globalThis[INSTALL_SYMBOL] === true) return;
  const directory = process.env.GHCG_ISSUE_225_TRACE_DIR;
  if (!validAbsolutePath(directory)) return;
  const run = RUN_PATTERN.test(process.env.GHCG_ISSUE_225_RUN ?? "")
    ? process.env.GHCG_ISSUE_225_RUN
    : "unlabeled";

  globalThis[INSTALL_SYMBOL] = true;
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process");
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  let sequence = 0;
  let invocation = 0;
  let disabled = false;
  let truncated = false;
  let descriptor;

  const openTrace = () => {
    if (descriptor !== undefined) return true;
    try {
      mkdirSync(directory, { recursive: true });
      descriptor = openSync(path.join(directory, `trace-${process.pid}-${threadId}-${Date.now()}.jsonl`), "ax", 0o600);
      return true;
    } catch {
      disabled = true;
      return false;
    }
  };

  const append = (event) => {
    if (disabled || !openTrace()) return;
    let boundedEvent = event;
    if (sequence >= MAX_RECORDS - 1) {
      if (truncated) return;
      truncated = true;
      boundedEvent = { event: "truncated" };
    }
    const record = JSON.stringify({
      version: 1,
      run,
      pid: process.pid,
      ppid: process.ppid,
      threadId,
      workerId: boundedInteger(process.env.VITEST_WORKER_ID, 1_000_000),
      role: process.env.VITEST_WORKER_ID === undefined ? "node" : "test_worker",
      availableParallelism: availableParallelism(),
      sequence: sequence++,
      atUnixMs: Date.now(),
      ...boundedEvent,
    });
    if (Buffer.byteLength(record, "utf8") > MAX_RECORD_BYTES) {
      disabled = true;
      return;
    }
    try {
      writeSync(descriptor, `${record}\n`, undefined, "utf8");
    } catch {
      disabled = true;
    }
    if (truncated) disabled = true;
  };

  childProcess.execFileSync = function (file, args, options) {
    const evidence = commandEvidence(file, args, options);
    if (evidence === null) return Reflect.apply(originalExecFileSync, this, arguments);
    if (sequence === 0) append({ event: "process_start" });
    const currentInvocation = ++invocation;
    const started = performance.now();
    append({ event: "command_start", invocation: currentInvocation, api: "execFileSync", ...evidence });
    try {
      const result = Reflect.apply(originalExecFileSync, this, arguments);
      append({
        event: "command_finish",
        invocation: currentInvocation,
        api: "execFileSync",
        ...evidence,
        elapsedMs: roundedMilliseconds(performance.now() - started),
        outcome: "success",
        errorCode: null,
        exitCode: 0,
        signal: null,
        childPid: null,
      });
      return result;
    } catch (error) {
      const elapsed = performance.now() - started;
      append({
        event: "command_finish",
        invocation: currentInvocation,
        api: "execFileSync",
        ...evidence,
        elapsedMs: roundedMilliseconds(elapsed),
        ...safeErrorEvidence(error, evidence.timeoutMs, elapsed),
      });
      throw error;
    }
  };

  const wrappedExecFile = function (file, args, options) {
    const evidence = commandEvidence(file, args, options);
    if (evidence === null) return Reflect.apply(originalExecFile, this, arguments);
    if (sequence === 0) append({ event: "process_start" });
    const currentInvocation = ++invocation;
    const started = performance.now();
    let finished = false;
    let childPid = null;
    const finish = (outcome, elapsed = performance.now() - started) => {
      if (finished) return;
      finished = true;
      append({
        event: "command_finish",
        invocation: currentInvocation,
        api: "execFile",
        ...evidence,
        elapsedMs: roundedMilliseconds(elapsed),
        ...outcome,
        childPid,
      });
    };
    append({ event: "command_start", invocation: currentInvocation, api: "execFile", ...evidence });
    const callArguments = [...arguments];
    const callbackIndex = typeof callArguments.at(-1) === "function" ? callArguments.length - 1 : -1;
    if (callbackIndex >= 0) {
      const callback = callArguments[callbackIndex];
      callArguments[callbackIndex] = function (error, stdout, stderr) {
        const elapsed = performance.now() - started;
        finish(error === null
          ? successEvidence()
          : safeErrorEvidence(error, evidence.timeoutMs, elapsed), elapsed);
        return Reflect.apply(callback, this, [error, stdout, stderr]);
      };
    }
    let child;
    try {
      child = Reflect.apply(originalExecFile, this, callArguments);
      childPid = boundedInteger(child.pid, 0xffff_ffff);
    } catch (error) {
      const elapsed = performance.now() - started;
      finish(safeErrorEvidence(error, evidence.timeoutMs, elapsed), elapsed);
      throw error;
    }
    if (callbackIndex < 0) {
      child.once("error", (error) => {
        const elapsed = performance.now() - started;
        finish(safeErrorEvidence(error, evidence.timeoutMs, elapsed), elapsed);
      });
      child.once("close", (exitCode, signal) => {
        const elapsed = performance.now() - started;
        const timedOut = evidence.timeoutMs !== null && evidence.timeoutMs > 0
          && elapsed >= evidence.timeoutMs && child.killed === true;
        finish({
          outcome: timedOut ? "timeout" : exitCode === 0 ? "success" : "failure",
          errorCode: null,
          exitCode: safeExitCode(exitCode),
          signal: typeof signal === "string" && SIGNALS.has(signal) ? signal : null,
        }, elapsed);
      });
    }
    return child;
  };
  Object.defineProperty(wrappedExecFile, promisify.custom, {
    configurable: false,
    value: (...args) => {
      const { promise, resolve, reject } = Promise.withResolvers();
      const child = wrappedExecFile(...args, (error, stdout, stderr) => {
        if (error !== null) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
      promise.child = child;
      return promise;
    },
  });
  childProcess.execFile = wrappedExecFile;
  syncBuiltinESMExports();

  process.once("exit", (exitCode) => {
    if (descriptor === undefined) return;
    append({ event: "process_exit", exitCode: safeExitCode(exitCode) });
    try {
      closeSync(descriptor);
    } catch {
      // Diagnostics must not affect process termination.
    }
  });
}

function commandEvidence(file, args, options) {
  const command = commandKind(file);
  if (command === null) return null;
  const values = Array.isArray(args) ? args.filter((value) => typeof value === "string") : [];
  const actualOptions = Array.isArray(args) ? options : args;
  const environment = isRecord(actualOptions) && isRecord(actualOptions.env) ? actualOptions.env : undefined;
  const purpose = commandPurpose(command, values, environment);
  const timeoutMs = isRecord(actualOptions) && Number.isFinite(actualOptions.timeout)
    && actualOptions.timeout >= 0 && actualOptions.timeout <= 600_000
    ? Math.round(actualOptions.timeout)
    : null;
  return { command, purpose, timeoutMs };
}

function commandKind(file) {
  const name = path.win32.basename(String(file)).toLowerCase().replace(/\.exe$/u, "");
  return COMMANDS.has(name) ? name : null;
}

function commandPurpose(command, args, environment) {
  if (command === "whoami") return "current_identity";
  if (command === "icacls") {
    return args.some((arg) => arg === "/setowner" || arg === "/grant:r" || arg === "/inheritance:r" || arg === "/remove:g")
      ? "acl_mutation"
      : "acl_inspection";
  }
  if (environment !== undefined && Object.hasOwn(environment, "GHCG_DIRECTORY_PATH")) return "directory_create";
  const script = args.join(" ");
  if (script.includes("Get-Process") && script.includes(".Kill()")) return "process_terminate";
  if (script.includes("Get-Process")) return "process_identity";
  if (script.includes("Get-Item") && script.includes("ReparsePoint")) return "reparse_inspection";
  if (script.includes("Get-Acl") && script.includes("Set-Acl")) return "acl_restore";
  if (script.includes("Get-Acl")) return "owner_inspection";
  if (script.includes("Set-Acl")) return "acl_mutation";
  return "powershell_other";
}

function safeErrorEvidence(error, timeoutMs = null, elapsedMs = 0) {
  const rawCode = isRecord(error) && typeof error.code === "string" ? error.code : null;
  const errorCode = rawCode !== null && ERROR_CODES.has(rawCode) ? rawCode : null;
  const aborted = errorCode === "ABORT_ERR";
  const timedOut = !aborted && (errorCode === "ETIMEDOUT"
    || (timeoutMs !== null && timeoutMs > 0 && elapsedMs >= timeoutMs
      && isRecord(error) && error.killed === true));
  return {
    outcome: timedOut ? "timeout" : "failure",
    errorCode,
    exitCode: isRecord(error) ? safeExitCode(error.status) ?? safeExitCode(error.code) : null,
    signal: isRecord(error) && typeof error.signal === "string" && SIGNALS.has(error.signal) ? error.signal : null,
    childPid: isRecord(error) ? boundedInteger(error.pid, 0xffff_ffff) : null,
  };
}

function successEvidence() {
  return {
    outcome: "success",
    errorCode: null,
    exitCode: 0,
    signal: null,
  };
}

function verifyFromCommandLine(args) {
  if (args[0] !== "--verify" || args[1] === undefined) {
    process.stderr.write("usage: node issue-225-windows-security-preload.mjs --verify <directory> [--minimum-directory-creates <count>] [--minimum-timeouts <count>] [--require-complete]\n");
    process.exitCode = 2;
    return;
  }
  const directory = path.resolve(args[1]);
  let minimumDirectoryCreates = 1;
  let minimumTimeouts = 0;
  let requireComplete = false;
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--require-complete") {
      requireComplete = true;
      continue;
    }
    if (args[index] === "--minimum-directory-creates" && args[index + 1] !== undefined) {
      minimumDirectoryCreates = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index] === "--minimum-timeouts" && args[index + 1] !== undefined) {
      minimumTimeouts = Number(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("invalid trace verification arguments");
  }
  if (!Number.isInteger(minimumDirectoryCreates) || minimumDirectoryCreates < 0 || minimumDirectoryCreates > 10_000) {
    throw new Error("invalid minimum directory-create count");
  }
  if (!Number.isInteger(minimumTimeouts) || minimumTimeouts < 0 || minimumTimeouts > 10_000) {
    throw new Error("invalid minimum timeout count");
  }
  const summary = verifyTraceDirectory(directory, requireComplete);
  if (summary.directoryCreates < minimumDirectoryCreates) throw new Error("insufficient directory-create evidence");
  if (summary.timeouts < minimumTimeouts) throw new Error("insufficient timeout evidence");
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function verifyTraceDirectory(directory, requireComplete) {
  const files = readdirSync(directory).filter((name) => /^trace-\d+-\d+-\d+\.jsonl$/u.test(name)).sort();
  if (files.length === 0) throw new Error("no trace files found");
  let records = 0;
  let directoryCreates = 0;
  let timeouts = 0;
  let failures = 0;
  let incomplete = 0;

  for (const file of files) {
    const pending = new Map();
    const seenInvocations = new Set();
    const contents = readFileSync(path.join(directory, file), "utf8");
    let fileRecords = 0;
    let expectedSequence = 0;
    let expectedInvocation = 1;
    let terminal = false;
    let processMetadata;
    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;
      if (terminal) throw new Error("trace record follows terminal evidence");
      fileRecords += 1;
      if (fileRecords > MAX_RECORDS) throw new Error("too many trace records");
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new Error("oversize trace record");
      const record = JSON.parse(line);
      assertTraceRecord(record);
      if (record.sequence !== expectedSequence) throw new Error("nonsequential trace evidence");
      expectedSequence += 1;
      if (fileRecords === 1 && record.event !== "process_start") throw new Error("trace lacks initial process evidence");
      if (record.event === "process_start") {
        if (fileRecords !== 1) throw new Error("duplicate process start evidence");
        processMetadata = traceProcessMetadata(record);
      } else if (!sameTraceProcess(processMetadata, record)) {
        throw new Error("inconsistent trace process metadata");
      }
      if (record.event === "truncated") throw new Error("trace evidence was truncated");
      if (record.event === "process_exit") terminal = true;
      records += 1;
      if (record.event === "command_start") {
        if (seenInvocations.has(record.invocation) || record.invocation !== expectedInvocation) {
          throw new Error("duplicate or nonsequential command start evidence");
        }
        seenInvocations.add(record.invocation);
        expectedInvocation += 1;
        pending.set(record.invocation, {
          api: record.api,
          command: record.command,
          purpose: record.purpose,
          timeoutMs: record.timeoutMs,
        });
        if (record.purpose === "directory_create") directoryCreates += 1;
      } else if (record.event === "command_finish") {
        const started = pending.get(record.invocation);
        if (started === undefined) throw new Error("command finish lacks matching start evidence");
        if (record.api !== started.api || record.command !== started.command
          || record.purpose !== started.purpose || record.timeoutMs !== started.timeoutMs) {
          throw new Error("command finish does not match start evidence");
        }
        pending.delete(record.invocation);
        if (record.outcome === "timeout") timeouts += 1;
        else if (record.outcome === "failure") failures += 1;
      }
    }
    if (fileRecords === 0) throw new Error("empty trace file");
    incomplete += pending.size;
  }
  if (requireComplete && incomplete !== 0) throw new Error("incomplete command evidence");
  return { files: files.length, records, directoryCreates, timeouts, failures, incomplete };
}

function assertTraceRecord(record) {
  if (!isRecord(record) || Object.keys(record).some((key) => !TRACE_KEYS.has(key))) throw new Error("invalid trace record shape");
  const eventKeys = EVENT_KEYS.get(record.event);
  if (eventKeys === undefined || Object.keys(record).length !== eventKeys.size
    || Object.keys(record).some((key) => !eventKeys.has(key))) {
    throw new Error("invalid event record shape");
  }
  if (record.version !== 1 || !RUN_PATTERN.test(record.run)
    || boundedInteger(record.pid, 0xffff_ffff) === null
    || boundedInteger(record.ppid, 0xffff_ffff) === null
    || boundedInteger(record.threadId, 1_000_000) === null
    || boundedInteger(record.availableParallelism, 1_000_000) === null
    || boundedInteger(record.sequence, MAX_RECORDS - 1) === null
    || !Number.isInteger(record.atUnixMs) || record.atUnixMs < 0
    || !["node", "test_worker"].includes(record.role)) {
    throw new Error("invalid trace record metadata");
  }
  if (record.workerId !== null && boundedInteger(record.workerId, 1_000_000) === null) throw new Error("invalid worker evidence");
  if (["process_start", "process_exit", "truncated"].includes(record.event)) {
    if (record.event === "process_exit" && safeExitCode(record.exitCode) === null) throw new Error("invalid process exit evidence");
    return;
  }
  if (!["command_start", "command_finish"].includes(record.event)
    || boundedInteger(record.invocation, 1_000_000) === null
    || !APIS.has(record.api)
    || !COMMANDS.has(record.command)
    || !PURPOSES.has(record.purpose)
    || (record.timeoutMs !== null && boundedInteger(record.timeoutMs, 600_000) === null)) {
    throw new Error("invalid command evidence");
  }
  if (record.event === "command_finish") {
    if (!Number.isFinite(record.elapsedMs) || record.elapsedMs < 0 || record.elapsedMs > 3_600_000
      || !OUTCOMES.has(record.outcome)
      || (record.errorCode !== null && !ERROR_CODES.has(record.errorCode))
      || (record.exitCode !== null && safeExitCode(record.exitCode) === null)
      || (record.signal !== null && !SIGNALS.has(record.signal))
      || (record.childPid !== null && boundedInteger(record.childPid, 0xffff_ffff) === null)) {
      throw new Error("invalid command result evidence");
    }
  }
}

function traceProcessMetadata(record) {
  return {
    version: record.version,
    run: record.run,
    pid: record.pid,
    ppid: record.ppid,
    threadId: record.threadId,
    workerId: record.workerId,
    role: record.role,
    availableParallelism: record.availableParallelism,
  };
}

function sameTraceProcess(expected, record) {
  if (expected === undefined) return false;
  return Object.entries(expected).every(([key, value]) => record[key] === value);
}

function validAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && path.isAbsolute(value) && !/[\0\r\n]/u.test(value);
}

function safeExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : null;
}

function boundedInteger(value, maximum) {
  if (typeof value === "string" && /^\d{1,10}$/u.test(value)) value = Number(value);
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function roundedMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
