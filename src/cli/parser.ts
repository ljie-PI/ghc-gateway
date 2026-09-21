import os from "node:os";
import path from "node:path";
import { parseStartupConfig, StartupConfigError, type StartupConfig } from "../config/startup_config.js";
import { CliError, type ControlOperationMap, type LifecycleAction } from "./control_client.js";

export type ParsedCliCommand =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "serve"; readonly startup: StartupConfig }
  | { readonly kind: "lifecycle"; readonly action: LifecycleAction; readonly startup?: StartupConfig }
  | { readonly kind: "control"; readonly operation: keyof ControlOperationMap; readonly args: ControlOperationMap[keyof ControlOperationMap]["args"] };

export interface ParsedCli {
  readonly json: boolean;
  readonly dataDir: string;
  readonly command: ParsedCliCommand;
}

export interface ParseCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
}

const ROOT_COMMANDS = [
  "serve",
  "start",
  "stop",
  "restart",
  "status",
  "auth login [--host <domain>]",
  "auth login poll <flow-id>",
  "auth logout [--account <account-id>]",
  "auth status",
  "accounts list",
  "accounts use <account-id>",
  "accounts remove <account-id>",
  "models list [--account <account-id>]",
  "models current",
  "models set <model-id>",
  "config get [key]",
  "config set <key> <value>",
] as const;

export const ROOT_HELP = [
  "Usage: ghcg [--data-dir <path>] [--json] <command>",
  "",
  "Commands:",
  ...ROOT_COMMANDS.map((command) => `  ${command}`),
  "",
].join("\n");

export function parseCli(argv: readonly string[], options: ParseCliOptions = {}): ParsedCli {
  const env = options.env ?? {};
  const homedir = options.homedir ?? os.homedir();
  const globals = parseGlobal(argv);
  const dataDir = resolveCliDataDir(globals.dataDir, env, homedir);
  const commandContext = {
    env,
    homedir,
    ...(globals.dataDir === undefined ? {} : { cliDataDir: globals.dataDir }),
  };
  const command = parseCommand(globals.rest, commandContext);
  return {
    json: globals.json,
    dataDir: effectiveDataDir(command, dataDir),
    command,
  };
}

export function resolveCliDataDir(cliDataDir: string | undefined, env: NodeJS.ProcessEnv, homedir: string): string {
  const selected = cliDataDir ?? env.GHC_GATEWAY_DATA_DIR ?? path.join(homedir, ".ghc-gateway");
  if (selected.trim() === "") {
    throw new CliError("validation_error");
  }
  return path.resolve(selected);
}

function parseGlobal(argv: readonly string[]): { readonly json: boolean; readonly dataDir?: string; readonly rest: readonly string[] } {
  let json = false;
  let dataDir: string | undefined;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--data-dir") {
      dataDir = readValue(argv, index);
      index += 1;
      continue;
    }
    if (token === "--help") {
      return { json, ...(dataDir === undefined ? {} : { dataDir }), rest: ["--help"] };
    }
    if (token.startsWith("-")) {
      throw new CliError("usage_error");
    }
    break;
  }
  return { json, ...(dataDir === undefined ? {} : { dataDir }), rest: argv.slice(index) };
}

function parseCommand(
  tokens: readonly string[],
  context: { readonly env: NodeJS.ProcessEnv; readonly homedir: string; readonly cliDataDir?: string },
): ParsedCliCommand {
  const [command, groupAction, third, fourth, ...extra] = tokens;
  if (command === undefined || command === "--help") {
    return { kind: "help", text: ROOT_HELP };
  }
  if (command === "serve") {
    if (groupAction === "--help") {
      return { kind: "help", text: commandHelp("serve") };
    }
    return { kind: "serve", startup: parseServeStartup(tokens.slice(1), context) };
  }
  if (command === "start") {
    if (groupAction === "--help") {
      return { kind: "help", text: commandHelp("start") };
    }
    return { kind: "lifecycle", action: "start", startup: parseServeStartup(tokens.slice(1), context) };
  }
  if (command === "stop" || command === "restart" || command === "status") {
    if (groupAction === "--help") {
      return { kind: "help", text: commandHelp(command) };
    }
    if (tokens.length !== 1 && (command !== "restart" || tokens.slice(1).some((token) => token !== "--diagnostics"))) {
      throw new CliError("usage_error");
    }
    return {
      kind: "lifecycle",
      action: command,
      ...(command === "restart" ? { startup: parseServeStartup(tokens.slice(1), context) } : {}),
    };
  }
  if (command === "auth") {
    if (groupAction === "--help") {
      return { kind: "help", text: groupHelp("auth") };
    }
    if (groupAction === "login") {
      if (third === "--help") {
        return { kind: "help", text: commandHelp("auth login [--host <domain>]") };
      }
      if (third === "poll") {
        if (fourth === "--help") {
          return { kind: "help", text: commandHelp("auth login poll <flow-id>") };
        }
        if (fourth === undefined || extra.length !== 0) {
          throw new CliError("usage_error");
        }
        return { kind: "control", operation: "auth.login.poll", args: { flowId: fourth } };
      }
      if (third === "--host") {
        if (fourth === undefined || extra.length !== 0) {
          throw new CliError("usage_error");
        }
        return { kind: "control", operation: "auth.login.start", args: { host: fourth } };
      }
      if (third !== undefined) {
        throw new CliError("usage_error");
      }
      return { kind: "control", operation: "auth.login.start", args: {} };
    }
    if (groupAction === "logout") {
      if (third === "--help") {
        return { kind: "help", text: commandHelp("auth logout [--account <account-id>]") };
      }
      if (third === "--account") {
        if (fourth === undefined || extra.length !== 0) {
          throw new CliError("usage_error");
        }
        return { kind: "control", operation: "auth.logout", args: { accountId: fourth } };
      }
      if (third !== undefined) {
        throw new CliError("usage_error");
      }
      return { kind: "control", operation: "auth.logout", args: {} };
    }
    if (groupAction === "status" && third === undefined) {
      return { kind: "control", operation: "auth.status", args: {} };
    }
    if (groupAction === "status" && third === "--help") {
      return { kind: "help", text: commandHelp("auth status") };
    }
    throw new CliError("usage_error");
  }
  if (command === "accounts") {
    if (groupAction === "--help") {
      return { kind: "help", text: groupHelp("accounts") };
    }
    if (groupAction === "list" && third === undefined) {
      return { kind: "control", operation: "accounts.list", args: {} };
    }
    if (groupAction === "list" && third === "--help") {
      return { kind: "help", text: commandHelp("accounts list") };
    }
    if (groupAction === "use" && third === "--help") {
      return { kind: "help", text: commandHelp("accounts use <account-id>") };
    }
    if (groupAction === "use" && third !== undefined && fourth === undefined) {
      return { kind: "control", operation: "accounts.use", args: { accountId: third } };
    }
    if (groupAction === "remove" && third === "--help") {
      return { kind: "help", text: commandHelp("accounts remove <account-id>") };
    }
    if (groupAction === "remove" && third !== undefined && fourth === undefined) {
      return { kind: "control", operation: "accounts.remove", args: { accountId: third } };
    }
    throw new CliError("usage_error");
  }
  if (command === "models") {
    if (groupAction === "--help") {
      return { kind: "help", text: groupHelp("models") };
    }
    if (groupAction === "list") {
      if (third === "--help") {
        return { kind: "help", text: commandHelp("models list [--account <account-id>]") };
      }
      if (third === "--account") {
        if (fourth === undefined || extra.length !== 0) {
          throw new CliError("usage_error");
        }
        return { kind: "control", operation: "models.list", args: { accountId: fourth } };
      }
      if (third !== undefined) {
        throw new CliError("usage_error");
      }
      return { kind: "control", operation: "models.list", args: {} };
    }
    if (groupAction === "current" && third === undefined) {
      return { kind: "control", operation: "models.current", args: {} };
    }
    if (groupAction === "current" && third === "--help") {
      return { kind: "help", text: commandHelp("models current") };
    }
    if (groupAction === "set" && third === "--help") {
      return { kind: "help", text: commandHelp("models set <model-id>") };
    }
    if (groupAction === "set" && third !== undefined && fourth === undefined) {
      return { kind: "control", operation: "models.set", args: { modelId: third } };
    }
    throw new CliError("usage_error");
  }
  if (command === "config") {
    if (groupAction === "--help") {
      return { kind: "help", text: groupHelp("config") };
    }
    if (groupAction === "get") {
      if (third === "--help") {
        return { kind: "help", text: commandHelp("config get [key]") };
      }
      if (fourth !== undefined) {
        throw new CliError("usage_error");
      }
      return { kind: "control", operation: "config.get", args: third === undefined ? {} : { key: third } };
    }
    if (groupAction === "set" && third !== undefined && fourth !== undefined && extra.length === 0) {
      return { kind: "control", operation: "config.set", args: { key: third, value: fourth } };
    }
    if (groupAction === "set" && third === "--help") {
      return { kind: "help", text: commandHelp("config set <key> <value>") };
    }
    throw new CliError("usage_error");
  }
  throw new CliError("usage_error");
}

function parseServeStartup(
  tokens: readonly string[],
  context: { readonly env: NodeJS.ProcessEnv; readonly homedir: string; readonly cliDataDir?: string },
): StartupConfig {
  const argv: string[] = context.cliDataDir === undefined ? [] : ["--data-dir", context.cliDataDir];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--diagnostics") {
      argv.push(token);
      continue;
    }
    if (token === "--port" || token === "--log-level" || token === "--data-dir") {
      argv.push(token, readValue(tokens, index));
      index += 1;
      continue;
    }
    if (token === "--help") {
      return parseStartupOrThrow(argv, context.env, context.homedir);
    }
    throw new CliError("usage_error");
  }
  return parseStartupOrThrow(argv, context.env, context.homedir);
}

function effectiveDataDir(command: ParsedCliCommand, fallback: string): string {
  if (command.kind === "serve") {
    return command.startup.dataDir;
  }
  if (command.kind === "lifecycle" && command.startup !== undefined) {
    return command.startup.dataDir;
  }
  return fallback;
}

function parseStartupOrThrow(argv: readonly string[], env: NodeJS.ProcessEnv, homedir: string): StartupConfig {
  try {
    return parseStartupConfig(argv, env, { homedir });
  } catch (error: unknown) {
    if (error instanceof StartupConfigError) {
      throw new CliError("validation_error");
    }
    throw error;
  }
}

function groupHelp(group: string): string {
  return [
    `Usage: ghcg [--data-dir <path>] [--json] ${group} <command>`,
    "",
    "Commands:",
    ...ROOT_COMMANDS.filter((command) => command.startsWith(`${group} `)).map((command) => `  ${command}`),
    "",
  ].join("\n");
}

function commandHelp(command: string): string {
  return [
    `Usage: ghcg [--data-dir <path>] [--json] ${command}`,
    "",
    ...(["serve", "start", "restart"].includes(command)
      ? ["  --diagnostics  Write bounded, content-free request diagnostics for this invocation.", ""]
      : []),
  ].join("\n");
}

function readValue(tokens: readonly string[], index: number): string {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliError("usage_error");
  }
  return value;
}
