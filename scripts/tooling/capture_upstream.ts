import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStartupConfig, type StartupConfig } from "../../src/config/startup_config.js";
import type { ApplicationContext } from "../../src/main.js";
import { CaptureError, recordCapture } from "./capture_recorder.js";
import type { CaptureScenario } from "./capture_scenarios.js";

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
      protocol: { type: "string" },
      scenario: { type: "string" },
      mode: { type: "string" },
      "total-timeout-ms": { type: "string" },
    },
    strict: true, allowPositionals: false,
  });
  if (values.help) {
    console.log("Usage: node scripts/tooling/bootstrap.mjs scripts/tooling/capture_upstream.ts [--execute] [--data-dir PATH] [--account ID] [--model gemini-3.5-flash|gpt-5.5|claude-sonnet-4] [--scenario all|long-text|image|parallel-tools|five-turn] [--mode both|nonstream|stream] [--total-timeout-ms 1200000]");
    console.log("Default: plan only, no account access or inference. Execution creates a unique OS-temporary capture directory; never promotes or replaces corpus files.");
    return;
  }
  let context: CaptureContext | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await recordCapture({
      execute: values.execute,
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values.protocol === undefined ? {} : { protocol: values.protocol }),
      ...(values.scenario === undefined ? {} : { scenario: values.scenario as CaptureScenario | "all" }),
      ...(values.mode === undefined ? {} : { mode: values.mode as "nonstream" | "stream" | "both" }),
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
    // The public result contains only finite configuration, counts and digests.
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
    console.error(JSON.stringify(error instanceof CaptureError
      ? { error: error.code, ...(error.status === undefined ? {} : { status: error.status }), ...(error.step === undefined ? {} : { step: error.step }) }
      : { error: "capture_failed" }));
    process.exitCode = 1;
  });
}
