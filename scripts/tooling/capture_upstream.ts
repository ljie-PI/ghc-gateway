import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStartupConfig, type StartupConfig } from "../../src/config/startup_config.js";
import type { ApplicationContext } from "../../src/main.js";
import { CaptureError, recordReplayCorpus } from "../../tests/sdk/corpus_recorder.js";

type CaptureContext = Pick<ApplicationContext, "close" | "forceClose"> & {
  readonly directory: Pick<ApplicationContext["directory"], "bindDefault" | "bindAccount">;
  readonly copilot: Pick<ApplicationContext["copilot"], "bind">;
};

async function createContext(startup: StartupConfig): Promise<CaptureContext> {
  // Import and compose production account access only after explicit opt-in.
  const { createProductionApplicationContext } = await import("../../src/main.js");
  return createProductionApplicationContext(startup, {});
}

export async function runCaptureCli(
  args: string[] = process.argv.slice(2),
  factory: (startup: StartupConfig) => Promise<CaptureContext> = createContext,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      account: { type: "string" },
      model: { type: "string" },
      scenario: { type: "string" },
      "total-timeout-ms": { type: "string" },
    },
    strict: true, allowPositionals: false,
  });
  if (values.help) {
    console.log("Usage: node scripts/tooling/bootstrap.mjs scripts/tooling/capture_upstream.ts [--execute] [--data-dir PATH] [--account ID] [--model all|gemini-3.8-flash|gpt-6-astra|claude-opus-5.5] [--scenario all|plain-text|image|weather-roundtrip|parallel-tools|mixed-image-tool|reasoning-effort|coherent-session] [--total-timeout-ms 3600000]");
    console.log("Default: plan only, no account access or inference. Execution sends the official SDK scenarios through the gateway to live Copilot and replaces the selected tests/sdk/corpus cases only after every selected exchange validates.");
    return;
  }
  let context: CaptureContext | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await recordReplayCorpus({
      execute: values.execute,
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values.scenario === undefined ? {} : { scenario: values.scenario }),
      ...(values["total-timeout-ms"] === undefined ? {} : { totalTimeoutMs: Number(values["total-timeout-ms"]) }),
      signal: controller.signal,
    }, {
      async bind(signal) {
        const startup = parseStartupConfig(values["data-dir"] === undefined ? [] : ["--data-dir", values["data-dir"]], {});
        signal.throwIfAborted();
        const owned = await factory(startup);
        // Binding is raced against cancellation; a late factory result still has an owner.
        if (signal.aborted) {
          void closeContext(owned).catch(() => undefined);
          signal.throwIfAborted();
        }
        context = owned;
        const account = values.account === undefined
          ? await owned.directory.bindDefault(signal)
          : await owned.directory.bindAccount(values.account, signal);
        signal.throwIfAborted();
        return owned.copilot.bind(account, signal);
      },
    });
    // The public result contains only finite configuration, case IDs, byte counts and digests.
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    controller.abort();
    if (context !== undefined) await closeContext(context);
  }
}

async function closeContext(context: CaptureContext): Promise<void> {
  const force = (): void => {
    try { void Promise.resolve(context.forceClose?.()).catch(() => undefined); }
    catch { /* Shutdown must stay bounded even when forced cleanup fails. */ }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => context.close?.()),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { force(); resolve(); }, 3_000);
      }),
    ]);
  } catch (error: unknown) {
    force();
    throw error;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCaptureCli().catch((error: unknown) => {
    console.error(JSON.stringify(error instanceof CaptureError ? { error: error.code, ...error.detail } : { error: "capture_failed" }));
    process.exitCode = 1;
  });
}
