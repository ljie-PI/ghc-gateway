import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { runManagedChild } from "../../src/daemon/child.js";
import { runDaemonRuntime, spawnDaemonProcess } from "../../src/daemon/runtime.js";

describe("diagnostic startup ownership", () => {
  it.each([false, true])("writes files only when explicitly enabled (managed=%s)", async (managed) => {
    for (const enabled of [false, true]) {
      const root = await mkdtemp(path.join(tmpdir(), "ghcg-diag-runtime-"));
      const shutdown = new AbortController();
      try {
        await runDaemonRuntime({
          startup: parseStartupConfig(["--data-dir", root, ...(enabled ? ["--diagnostics"] : [])], {}),
          env: {}, managed, shutdownSignal: shutdown.signal, stderr: { write() {} },
          composeGateway: async (context) => {
            expect(context.diagnostics !== undefined).toBe(enabled);
            return {
              fetch: async () => new Response(null),
              listen: async () => ({ host: "127.0.0.1", port: 31400 }),
              close: async () => { context.diagnostics?.begin("req_runtime", "messages").finish(); },
            };
          },
          onListening: () => shutdown.abort(),
          dependencies: {
            captureProcessIdentity: async () => "windows:1",
            acquireIdentity: (_root, identity) => ({ identity, cleanup: () => true, release() {} }),
          },
        });
        const file = path.join(root, "logs", "diagnostics.jsonl");
        expect(existsSync(file)).toBe(enabled);
        if (enabled) {
          const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
          expect(records.map((record) => record.event)).toEqual(["diagnostics_started", "stage", "request_finished"]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("fails before composition and releases the lease when the diagnostic path is unsafe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghcg-diag-unwritable-"));
    const events: string[] = [];
    mkdirSync(path.join(root, "logs", "diagnostics.jsonl"), { recursive: true });
    try {
      await expect(runDaemonRuntime({
        startup: parseStartupConfig(["--data-dir", root, "--diagnostics"], {}),
        env: {}, managed: false, shutdownSignal: new AbortController().signal, stderr: { write() {} },
        composeGateway: async () => { events.push("compose"); throw new Error("must not compose"); },
        onListening: () => { events.push("ready"); },
        dependencies: {
          captureProcessIdentity: async () => "windows:1",
          acquireIdentity: (_root, identity) => ({
            identity, cleanup: () => { events.push("cleanup"); return true; },
            release: () => { events.push("release"); },
          }),
        },
      })).rejects.toThrow();
      expect(events).toEqual(["cleanup", "release"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates the flag through spawned child argv and does not infer it when absent", async () => {
    const captured: boolean[] = [];
    for (const enabled of [false, true]) {
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, "pid", { value: 4242 });
      child.unref = () => child;
      let childArgs: readonly string[] = [];
      const spawning = spawnDaemonProcess(
        process.execPath, "child.js", {},
        parseStartupConfig(["--data-dir", "diagnostic-child", ...(enabled ? ["--diagnostics"] : [])], {}),
        { signal: new AbortController().signal, deadlineMs: Date.now() + 1000 },
        (_command, args) => { childArgs = args.slice(1); return child; },
      );
      child.emit("spawn");
      await spawning;
      await runManagedChild([...childArgs], {}, async (options) => { captured.push(options.startup.diagnostics === true); });
    }
    expect(captured).toEqual([false, true]);
  });
});
