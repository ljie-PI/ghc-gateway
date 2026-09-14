import { createRequire, syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { promisify } from "node:util";

const directory = process.env.GHCG_WINDOWS_LIFECYCLE_DIAGNOSTICS_DIR;
if (process.platform === "win32" && typeof directory === "string" && path.isAbsolute(directory)
  && directory.length <= 4096 && !/[\0\r\n]/u.test(directory)) {
  install(directory);
}

function install(directory) {
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process");
  const fs = require("node:fs");
  const startedAtMs = Date.now();
  const outputPath = path.join(directory, `${process.pid}-${startedAtMs}.jsonl`);
  const role = processRole(process.argv, process.env);
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  let sink;
  try {
    fs.mkdirSync(directory, { recursive: true });
    sink = fs.createWriteStream(outputPath, { encoding: "utf8", flags: "a", mode: 0o600 });
  } catch {
    return;
  }
  let sequence = 0;
  let invocation = 0;
  let disabled = false;
  sink.once("error", () => { disabled = true; });

  const serialize = (event) => {
    if (disabled || sequence >= 4096) return null;
    if (sequence === 4095) event = { event: "truncated" };
    const record = JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      monotonicMs: roundMilliseconds(performance.now()),
      processId: safeProcessId(process.pid),
      parentProcessId: safeProcessId(process.ppid),
      processRole: role,
      workerId: boundedInteger(process.env.VITEST_WORKER_ID),
      sequence: sequence++,
      ...event,
    });
    return Buffer.byteLength(record, "utf8") <= 2048 ? `${record}\n` : null;
  };
  const write = (event) => {
    const record = serialize(event);
    if (record !== null) sink.write(record);
  };

  const begin = (api, command, args, options) => {
    const id = ++invocation;
    const evidence = commandEvidence(command, args, options);
    if (evidence === null) return null;
    const began = performance.now();
    write({ event: "command_start", invocation: id, api, ...evidence });
    return { id, began, evidence, finished: false };
  };
  const finish = (active, outcome) => {
    if (active === null || active.finished) return;
    active.finished = true;
    write({
      event: "command_finish",
      invocation: active.id,
      elapsedMs: roundMilliseconds(performance.now() - active.began),
      ...active.evidence,
      ...outcome,
    });
  };

  const execFileSync = function (command, args, options) {
    const active = begin("execFileSync", command, args, options);
    try {
      const result = Reflect.apply(originalExecFileSync, this, arguments);
      finish(active, { outcome: "success" });
      return result;
    } catch (error) {
      finish(active, {
        outcome: "failure",
        ...errorEvidence(error, active?.evidence.timeoutMs, active?.evidence.purpose),
      });
      throw error;
    }
  };

  const execFile = function (command, args, options) {
    const active = begin("execFile", command, args, options);
    const callArguments = [...arguments];
    const callbackIndex = typeof callArguments.at(-1) === "function" ? callArguments.length - 1 : -1;
    if (active !== null && callbackIndex >= 0) {
      const callback = callArguments[callbackIndex];
      callArguments[callbackIndex] = function (error, stdout, stderr) {
        finish(active, error === null
          ? { outcome: "success" }
          : { outcome: "failure", ...errorEvidence(error, active.evidence.timeoutMs) });
        return Reflect.apply(callback, this, [error, stdout, stderr]);
      };
    }
    let child;
    try {
      child = Reflect.apply(originalExecFile, this, callArguments);
    } catch (error) {
      finish(active, { outcome: "failure", ...errorEvidence(error, active?.evidence.timeoutMs) });
      throw error;
    }
    if (active !== null) {
      write({ event: "command_spawned", invocation: active.id, childProcessId: safeProcessId(child.pid), ...active.evidence });
      child.once("error", (error) => finish(active, {
        outcome: "failure", ...errorEvidence(error, active.evidence.timeoutMs),
      }));
      child.once("close", (code, signal) => finish(active, {
        outcome: code === 0 ? "success" : "failure",
        exitCode: safeExitCode(code),
        signal: safeSignal(signal),
      }));
    }
    return child;
  };
  execFile[promisify.custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = execFile(...args, (error, stdout, stderr) => {
        if (error !== null) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
    promise.child = child;
    return promise;
  };

  const spawn = function (command, args, options) {
    const active = begin("spawn", command, args, options);
    let child;
    try {
      child = Reflect.apply(originalSpawn, this, arguments);
    } catch (error) {
      finish(active, { outcome: "failure", ...errorEvidence(error) });
      throw error;
    }
    if (active !== null) {
      write({ event: "command_spawned", invocation: active.id, childProcessId: safeProcessId(child.pid), ...active.evidence });
      child.once("error", (error) => finish(active, { outcome: "failure", ...errorEvidence(error) }));
      child.once("close", (code, signal) => finish(active, {
        outcome: code === 0 ? "success" : "failure",
        exitCode: safeExitCode(code),
        signal: safeSignal(signal),
      }));
    }
    return child;
  };

  const spawnSync = function (command, args, options) {
    const active = begin("spawnSync", command, args, options);
    try {
      const result = Reflect.apply(originalSpawnSync, this, arguments);
      finish(active, {
        outcome: result.error === undefined && result.status === 0 ? "success" : "failure",
        childProcessId: safeProcessId(result.pid),
        exitCode: safeExitCode(result.status),
        signal: safeSignal(result.signal),
        ...(result.error === undefined ? {} : errorEvidence(result.error, active?.evidence.timeoutMs)),
      });
      return result;
    } catch (error) {
      finish(active, { outcome: "failure", ...errorEvidence(error) });
      throw error;
    }
  };

  childProcess.execFileSync = execFileSync;
  childProcess.execFile = execFile;
  childProcess.spawn = spawn;
  childProcess.spawnSync = spawnSync;
  syncBuiltinESMExports();

  globalThis.__ghcgWindowsLifecycleDiagnostic = (event) => {
    const sanitized = lifecycleEvidence(event);
    if (sanitized !== null) write({ event: "lifecycle_decision", ...sanitized });
  };

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options) => {
      const purpose = controlPurpose(input);
      if (purpose === null) return await originalFetch(input, options);
      const id = ++invocation;
      const began = performance.now();
      write({ event: "control_request_start", invocation: id, purpose });
      try {
        const response = await originalFetch(input, options);
        write({
          event: "control_request_finish",
          invocation: id,
          purpose,
          elapsedMs: roundMilliseconds(performance.now() - began),
          outcome: "response",
          httpStatus: response.status,
        });
        return response;
      } catch (error) {
        write({
          event: "control_request_finish",
          invocation: id,
          purpose,
          elapsedMs: roundMilliseconds(performance.now() - began),
          outcome: "failure",
          ...errorEvidence(error),
        });
        throw error;
      }
    };
  }

  write({ event: "process_start" });
  process.once("beforeExit", (exitCode) => {
    write({ event: "process_exit", exitCode: safeExitCode(exitCode) });
    sink.end();
  });
}

function commandEvidence(command, args, options) {
  const commandKind = classifyCommand(command);
  const values = Array.isArray(args) ? args.filter((value) => typeof value === "string") : [];
  const environment = options !== null && typeof options === "object" && !Array.isArray(options)
    ? options.env : undefined;
  const purpose = commandPurpose(commandKind, values, environment);
  if (purpose === null) return null;
  const timeoutMs = options !== null && typeof options === "object" && !Array.isArray(options)
    && Number.isFinite(options.timeout) && options.timeout >= 0 && options.timeout <= 86_400_000
    ? Math.round(options.timeout) : null;
  return { command: commandKind, purpose, asset: assetKind(values, environment), timeoutMs };
}

function classifyCommand(command) {
  const name = path.win32.basename(String(command)).toLowerCase().replace(/\.exe$/u, "");
  if (name === "powershell" || name === "whoami" || name === "icacls" || name === "node") return name;
  return "other";
}

function commandPurpose(command, args, environment) {
  const text = args.join(" ");
  if (command === "powershell") {
    if (environment?.GHCG_DIRECTORY_PATH !== undefined) return "directory_create";
    if (text.includes("Get-Process") && text.includes(".Kill()")) return "process_terminate";
    if (text.includes("Get-Process")) return "process_identity";
    if (text.includes("Get-Item") && text.includes("ReparsePoint")) return "reparse_inspection";
    if (text.includes("Get-Acl")) return text.includes("Set-Acl") ? "acl_restore" : "owner_or_descriptor_inspection";
    return "powershell_other";
  }
  if (command === "whoami") return "current_identity";
  if (command === "icacls") {
    if (args.includes("/setowner")) return "acl_set_owner";
    if (args.includes("/grant:r") || args.includes("/inheritance:r")) return "acl_restrict";
    if (args.includes("/remove:g")) return "acl_remove";
    return "acl_inspection";
  }
  if (command === "node") {
    if (text.includes("daemon/child.js") || text.includes("daemon\\child.js")) return "daemon_child";
    for (const operation of ["start", "status", "restart", "stop"]) {
      if (args.includes(operation)) return `lifecycle_${operation}`;
    }
  }
  return null;
}

function assetKind(args, environment) {
  const text = [...args, environment?.GHCG_DIRECTORY_PATH ?? ""].join(" ").toLowerCase();
  if (text.includes("daemon.operation.owner")) return "operation_owner";
  if (text.includes("daemon.operation.db")) return "operation_database";
  if (text.includes("daemon.lock")) return "daemon_lock";
  if (text.includes("daemon.json")) return "daemon_identity";
  if (text.includes("gateway.jsonl") || text.includes("gateway.")) return "daemon_log";
  if (text.includes("logs")) return "log_directory";
  if (environment?.GHCG_DIRECTORY_PATH !== undefined
    || /[\\/](?:data|daemon)(?:['"\s]|$)/u.test(text)) return "data_directory";
  return "protected_path";
}

function controlPurpose(input) {
  try {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/__ghcg/control/v1/")) return null;
    if (url.pathname.endsWith("/status")) return "control_status";
    if (url.pathname.endsWith("/stop")) return "control_stop";
    if (url.pathname.endsWith("/command")) return "control_command";
    if (url.pathname.endsWith("/admin-bootstrap")) return "control_admin_bootstrap";
    return "control_other";
  } catch {
    return null;
  }
}

function lifecycleEvidence(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const allowedPhases = new Set(["inspection", "start", "stop", "restart", "process_identity"]);
  const allowedDecisions = new Set([
    "identity_missing", "identity_read_error", "process_same", "process_different", "process_dead", "process_unknown",
    "stale_removed", "stale_remove_failed", "status_valid", "status_invalid", "status_conflict", "status_unreachable",
    "start_initial_state", "start_spawn_failure", "start_spawned", "start_identity_missing", "start_identity_captured",
    "start_running", "start_readiness_expired", "start_error_cleanup", "start_cleanup_no_identity",
    "start_cleanup_not_same", "start_cleanup_dead", "start_cleanup_incomplete", "start_cleanup_complete",
    "start_cleanup_failure", "start_failed", "start_result",
    "stop_identity_missing", "stop_unmanaged", "stop_response_invalid", "stop_request_timeout", "stop_request_unreachable",
    "grace_process_dead", "grace_process_different", "grace_process_unknown", "grace_expired",
    "terminate_success", "terminate_failure", "force_process_dead", "force_same_identity_missing", "force_process_same",
    "force_process_different", "force_process_unknown", "restart_stop_result", "restart_start", "restart_start_result",
  ]);
  return {
    phase: allowedPhases.has(event.phase) ? event.phase : "other",
    decision: allowedDecisions.has(event.decision) ? event.decision : "other",
    state: typeof event.state === "string" && /^(?:running|stopped|stale|conflict|unreachable)$/u.test(event.state)
      ? event.state : null,
  };
}

function errorEvidence(error, timeoutMs = null, purpose = null) {
  const rawCode = error !== null && typeof error === "object" && typeof error.code === "string"
    ? error.code : null;
  const knownCodes = new Map([
    ["ETIMEDOUT", "timeout"], ["timeout", "timeout"], ["ABORT_ERR", "abort"], ["interrupted", "abort"],
    ["ENOENT", "not_found"], ["EACCES", "access_denied"], ["EPERM", "access_denied"],
    ["EPIPE", "pipe_closed"], ["ECONNREFUSED", "connection_failed"], ["ECONNRESET", "connection_failed"],
  ]);
  const configuredTimeout = timeoutMs !== null && error !== null && typeof error === "object" && error.killed === true;
  const errorKind = configuredTimeout ? "timeout" : knownCodes.get(rawCode)
    ?? (error instanceof DOMException && error.name === "AbortError" ? "abort" : "command_error");
  return {
    errorKind,
    errorCode: knownCodes.has(rawCode) ? rawCode : null,
    exitCode: error !== null && typeof error === "object"
      ? safeExitCode(error.status) ?? safeExitCode(error.code)
      : null,
    childProcessId: error !== null && typeof error === "object" ? safeProcessId(error.pid) : null,
    signal: safeSignal(error !== null && typeof error === "object" ? error.signal : null),
    directoryPhase: purpose === "directory_create" ? safeDirectoryPhase(error) : null,
  };
}

function safeDirectoryPhase(error) {
  const output = error !== null && typeof error === "object" ? error.stdout : undefined;
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : typeof output === "string" ? output : "";
  if (Buffer.byteLength(text, "utf8") > 1024) return null;
  const allowed = new Set(["script_started", "sid_ready", "security_ready", "create_begin", "create_complete"]);
  const phases = text.split(/\r?\n/u).flatMap((line) => {
    const match = /^GHCG_PHASE:(.+)$/u.exec(line);
    return match?.[1] !== undefined && allowed.has(match[1]) ? [match[1]] : [];
  });
  return phases.at(-1) ?? null;
}

function processRole(argv, environment) {
  const text = argv.join(" ").toLowerCase();
  if (environment.VITEST_WORKER_ID !== undefined) return "test_worker";
  if (text.includes("daemon/child") || text.includes("daemon\\child")) return "daemon";
  if (text.includes("scripts/tooling/pack") || text.includes("scripts\\tooling\\pack")) return "package_tool";
  if (text.includes("cli/main") || text.includes("cli\\main")) return "cli";
  if (text.includes("bench")) return "benchmark";
  return "node";
}

function safeExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

function safeProcessId(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : null;
}

function safeSignal(value) {
  return typeof value === "string" && /^(?:SIGTERM|SIGKILL|SIGINT|SIGABRT)$/u.test(value) ? value : null;
}

function boundedInteger(value) {
  if (typeof value !== "string" || !/^\d{1,6}$/u.test(value)) return null;
  return Number(value);
}

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}
