import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1" as const;
export const DEFAULT_PORT = 31_400;
export const DEFAULT_LOG_LEVEL = "info" as const;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type DataDirSource = "default" | "custom";

export interface StartupConfig {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly dataDir: string;
  readonly dataDirSource: DataDirSource;
  readonly logLevel: LogLevel;
  readonly diagnostics?: boolean;
}

export interface StartupParseOptions {
  readonly homedir?: string;
}

const LOG_LEVELS = new Set<LogLevel>(["trace", "debug", "info", "warn", "error"]);

export class StartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupConfigError";
  }
}

export function assertLoopbackBindHost(host: string): asserts host is typeof LOOPBACK_HOST {
  if (host !== LOOPBACK_HOST) {
    throw new StartupConfigError("listener host must be literal 127.0.0.1");
  }
}

export function parseStartupConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options: StartupParseOptions = {},
): StartupConfig {
  const flags = parseFlags(argv);
  const homedir = options.homedir ?? os.homedir();

  const port = parsePort(firstDefined(flags.port, env.GHC_GATEWAY_PORT, String(DEFAULT_PORT)));
  const logLevel = parseLogLevel(firstDefined(flags.logLevel, env.GHC_GATEWAY_LOG_LEVEL, DEFAULT_LOG_LEVEL));
  const selectedDataDir = flags.dataDir !== undefined
    ? { value: flags.dataDir, source: "custom" as const }
    : env.GHC_GATEWAY_DATA_DIR !== undefined
      ? { value: env.GHC_GATEWAY_DATA_DIR, source: "custom" as const }
      : { value: path.join(homedir, ".ghc-gateway"), source: "default" as const };

  return {
    host: LOOPBACK_HOST,
    port,
    dataDir: resolveDataDir(selectedDataDir.value),
    dataDirSource: selectedDataDir.source,
    logLevel,
    ...(flags.diagnostics === true ? { diagnostics: true } : {}),
  };
}

function parseFlags(argv: readonly string[]): { port?: string; dataDir?: string; logLevel?: string; diagnostics?: boolean } {
  const flags: { port?: string; dataDir?: string; logLevel?: string; diagnostics?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    const next = argv[index + 1];
    if (token === "--diagnostics") {
      flags.diagnostics = true;
      continue;
    }
    if (token === "--port") {
      flags.port = requireValue("--port", next);
      index += 1;
      continue;
    }
    if (token === "--data-dir") {
      flags.dataDir = requireValue("--data-dir", next);
      index += 1;
      continue;
    }
    if (token === "--log-level") {
      flags.logLevel = requireValue("--log-level", next);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new StartupConfigError(`unknown flag ${token}`);
    }
  }
  return flags;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("-")) {
    throw new StartupConfigError(`${flag} requires a value`);
  }
  return value;
}

function parsePort(text: string): number {
  if (!/^[0-9]+$/u.test(text)) {
    throw new StartupConfigError("port must be an integer");
  }
  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new StartupConfigError("port must be in 1..65535");
  }
  return port;
}

function parseLogLevel(text: string): LogLevel {
  if (!LOG_LEVELS.has(text as LogLevel)) {
    throw new StartupConfigError("log level must be trace|debug|info|warn|error");
  }
  return text as LogLevel;
}

function resolveDataDir(text: string): string {
  if (text.trim() === "") {
    throw new StartupConfigError("data directory must be a non-empty path");
  }
  return path.resolve(text);
}

function firstDefined(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  throw new StartupConfigError("missing startup value");
}
