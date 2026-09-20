#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseStartupConfig } from "../config/startup_config.js";
import { composeLazyProductionDaemonGateway } from "./production_gateway.js";
import { runDaemonRuntime } from "./runtime.js";

type RunManagedRuntime = typeof runDaemonRuntime;

export async function runManagedChild(
  argv = process.argv.slice(2),
  env = process.env,
  runRuntime: RunManagedRuntime = runDaemonRuntime,
): Promise<void> {
  const parsed = parseManagedChildArgs(argv);
  const startup = {
    ...parseStartupConfig(parsed.argv, env),
    dataDirSource: parsed.dataDirSource,
  };
  const shutdown = new AbortController();
  const stop = (): void => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runRuntime({
      startup,
      env,
      managed: true,
      composeGateway: composeLazyProductionDaemonGateway,
      shutdownSignal: shutdown.signal,
      stderr: process.stderr,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function parseManagedChildArgs(argv: readonly string[]): {
  readonly argv: readonly string[];
  readonly dataDirSource: "default" | "custom";
} {
  const startupArgv: string[] = [];
  let dataDirSource: "default" | "custom" = "custom";
  let foundSource = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--internal-data-dir-source") {
      if (token !== undefined) startupArgv.push(token);
      continue;
    }
    const value = argv[index + 1];
    if (foundSource || (value !== "default" && value !== "custom")) {
      throw new Error("invalid managed child data directory source");
    }
    foundSource = true;
    dataDirSource = value;
    index += 1;
  }
  return { argv: startupArgv, dataDirSource };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runManagedChild().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
