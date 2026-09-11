import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { authenticatedControlRequest } from "../../src/cli/control_client.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { runDaemonRuntime, spawnDaemonProcess } from "../../src/daemon/runtime.js";

describe("daemon runtime listener", () => {
  it("rejects unsupported Node.js runtimes before publishing daemon identity", async () => {
    const events: string[] = [];
    await expect(runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-unsupported"], {}),
      env: {},
      managed: true,
      shutdownSignal: new AbortController().signal,
      stderr: { write: () => undefined },
      composeGateway: async () => { throw new Error("must not compose"); },
      dependencies: {
        nodeVersion: "24.0.0",
        pid: 123,
        captureProcessIdentity: async () => {
          events.push("process-identity");
          return "windows:1";
        },
        acquireIdentity: () => {
          events.push("acquire");
          throw new Error("must not acquire");
        },
        createLogger: () => {
          events.push("logger");
          return { write() {} };
        },
      },
    })).rejects.toThrow("Node.js 24.20.0 or newer is required");
    expect(events).toEqual([]);
  });

  it("holds the identity lease before composition and cleans only its lease after shutdown", async () => {
    const events: string[] = [];
    const shutdown = new AbortController();
    await runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-data", "--port", "31406"], {}),
      env: {},
      managed: true,
      shutdownSignal: shutdown.signal,
      stderr: { write: () => undefined },
      composeGateway: async (context) => {
        events.push(`compose:${context.identity.managed}:${context.identity.port}`);
        return {
          fetch: async () => new Response(null),
          listen: async () => {
            events.push("listen");
            return { host: "127.0.0.1", port: 31_406 };
          },
          close: async () => { events.push("close"); },
        };
      },
      onListening: () => shutdown.abort(),
      dependencies: {
        pid: 123,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        createSecret: (() => {
          const values = ["nonce", "token"];
          return () => values.shift() ?? "unexpected";
        })(),
        captureProcessIdentity: async () => "windows:133852868960001234",
        acquireIdentity: (_dataDir, identity) => {
          events.push(`acquire:${identity.instanceNonce}:${identity.controlToken}`);
          return {
            identity,
            cleanup: () => { events.push("cleanup"); return true; },
            release: () => { events.push("release"); },
          };
        },
        createLogger: () => ({ write: () => undefined }),
      },
    });
    expect(events).toEqual([
      "acquire:nonce:token",
      "compose:true:31406",
      "listen",
      "close",
      "cleanup",
      "release",
    ]);
  });

  it("cleans and releases its published identity when composition fails", async () => {
    const events: string[] = [];
    await expect(runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-failure"], {}),
      env: {},
      managed: false,
      shutdownSignal: new AbortController().signal,
      stderr: { write: () => undefined },
      composeGateway: async () => { throw new Error("store failed"); },
      dependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => { events.push("cleanup"); return true; },
          release: () => { events.push("release"); },
        }),
        createLogger: () => ({ write() {} }),
      },
    })).rejects.toThrow("store failed");
    expect(events).toEqual(["cleanup", "release"]);
  });

  it("cleans and releases its published identity when logger construction fails", async () => {
    const events: string[] = [];
    await expect(runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-logger-failure"], {}),
      env: {},
      managed: true,
      shutdownSignal: new AbortController().signal,
      stderr: { write: () => undefined },
      composeGateway: async () => { throw new Error("must not compose"); },
      dependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => { events.push("cleanup"); return true; },
          release: () => { events.push("release"); },
        }),
        createLogger: () => { throw new Error("logger failed"); },
      },
    })).rejects.toThrow("logger failed");
    expect(events).toEqual(["cleanup", "release"]);
  });

  it("does not report listening until the server emits listening", async () => {
    const server = fakeServer();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", "31407"], {}),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [], { listen: () => server });

    let settled = false;
    const listening = gateway.listen().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    server.emit("listening");
    await expect(listening).resolves.toEqual({ host: "127.0.0.1", port: 31_407 });
    await gateway.close();
  });

  it("rejects the listener error instead of publishing readiness", async () => {
    const server = fakeServer();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", "31408"], {}),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [], { listen: () => server });

    const listening = gateway.listen();
    const error = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
    server.emit("error", error);
    await expect(listening).rejects.toBe(error);
    await gateway.close();
  });

  it("releases the daemon lease after a gateway close exceeds 10 seconds", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const shutdown = new AbortController();
    const running = runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-timeout"], {}),
      env: {},
      managed: true,
      shutdownSignal: shutdown.signal,
      stderr: { write: () => undefined },
      composeGateway: async () => ({
        fetch: async () => new Response(null),
        listen: async () => ({ host: "127.0.0.1", port: 31_400 }),
        close: async () => await new Promise<void>(() => undefined),
      }),
      onListening: () => shutdown.abort(),
      dependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => { events.push("cleanup"); return true; },
          release: () => events.push("release"),
        }),
        createLogger: () => ({ write: (record) => events.push(String(record.category)) }),
      },
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events).not.toContain("cleanup");
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(events).toContain("shutdown_timeout");
    expect(events.slice(-2)).toEqual(["cleanup", "release"]);
    vi.useRealTimers();
  });
});

describe("production lifecycle adapter abort acknowledgement", () => {
  it("does not settle a timed-out control POST before the transport acknowledges abort", async () => {
    vi.useFakeTimers();
    try {
      let rejectTransport = (_error: unknown): void => undefined;
      let observedSignal: AbortSignal | undefined;
      const request = authenticatedControlRequest({
        pid: 4242,
        processStartIdentity: "windows:1",
        port: 31_400,
        controlToken: "token",
        instanceNonce: "nonce",
        managed: true,
      }, "POST", "/__ghcg/control/v1/stop", undefined, { timeoutMs: 10 }, async (_url, init) => {
        observedSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => { rejectTransport = reject; });
      });
      let settled = false;
      void request.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(10);
      expect(observedSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      rejectTransport(observedSignal?.reason);
      await expect(request).rejects.toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("production daemon spawn adapter", () => {
  it("passes the abort signal to child_process and waits for a pre-spawn abort acknowledgement", async () => {
    const child = new EventEmitter() as ChildProcess;
    const abort = new AbortController();
    let observedOptions: SpawnOptions | undefined;
    const spawning = spawnDaemonProcess(
      process.execPath,
      "child.js",
      {},
      parseStartupConfig(["--data-dir", "spawn-abort"], {}),
      { signal: abort.signal, deadlineMs: Date.now() + 1_000 },
      (_command, _args, options) => {
        observedOptions = options;
        return child;
      },
    );
    let settled = false;
    void spawning.then(() => { settled = true; }, () => { settled = true; });
    abort.abort();
    await Promise.resolve();
    expect(observedOptions?.signal).toBe(abort.signal);
    expect(settled).toBe(false);
    child.emit("error", new DOMException("aborted", "AbortError"));
    await expect(spawning).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns ownership to the controller when abort acknowledgement arrives after a PID exists", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 4242 });
    child.unref = vi.fn(() => child);
    const abort = new AbortController();
    const spawning = spawnDaemonProcess(
      process.execPath,
      "child.js",
      {},
      parseStartupConfig(["--data-dir", "spawn-owned"], {}),
      { signal: abort.signal, deadlineMs: Date.now() + 1_000 },
      () => child,
    );
    abort.abort();
    child.emit("error", new DOMException("aborted", "AbortError"));
    const owned = await spawning;
    expect(owned.pid).toBe(4242);
    owned.unref();
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

function fakeServer() {
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    close(callback: (error?: Error) => void): void;
  };
  server.listening = false;
  server.on("listening", () => { server.listening = true; });
  server.close = vi.fn((callback) => callback());
  return server;
}
