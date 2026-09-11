import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StartupConfig } from "../../src/config/startup_config.js";
import {
  DaemonController,
  type DaemonControllerDependencies,
  type DaemonControlRequest,
  type SpawnedDaemon,
} from "../../src/daemon/controller.js";
import { CliError } from "../../src/cli/control_client.js";
import type { DaemonIdentity } from "../../src/daemon/identity_file.js";

const DATA_DIR = path.resolve("test-data");
const STARTUP: StartupConfig = {
  host: "127.0.0.1",
  port: 31_400,
  dataDir: DATA_DIR,
  logLevel: "info",
};
const FIRST: DaemonIdentity = {
  version: 1,
  managed: true,
  pid: 4_242,
  processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:100",
  instanceNonce: "nonce-1",
  controlToken: "token-1",
  port: 31_400,
  createdAt: "2026-09-03T12:00:00.000Z",
};
const SECOND: DaemonIdentity = {
  ...FIRST,
  pid: 4_243,
  processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:200",
  instanceNonce: "nonce-2",
  controlToken: "token-2",
  createdAt: "2026-09-03T12:01:00.000Z",
};

describe("DaemonController lifecycle", () => {
  it("reports stopped and treats an authenticated existing foreground gateway as start success", async () => {
    const stopped = harness();
    await expect(stopped.controller.status(DATA_DIR)).resolves.toEqual({
      state: "stopped",
      managed: null,
      pid: null,
      startedAt: null,
      port: null,
      dataDir: DATA_DIR,
    });

    const foreground = harness({ identity: { ...FIRST, managed: false } });
    await expect(foreground.controller.start(STARTUP)).resolves.toMatchObject({
      state: "running",
      managed: false,
      pid: FIRST.pid,
    });
    expect(foreground.spawn).not.toHaveBeenCalled();
  });

  it("maps protected identity read failures to a CLI security error", async () => {
    const fixture = harness();
    fixture.identityReadError = new Error("unsafe daemon file");
    await expect(fixture.controller.status(DATA_DIR)).rejects.toMatchObject({ code: "security_error" });
  });

  it("spawns one detached daemon and waits for its authenticated ready identity before unref", async () => {
    const fixture = harness();
    fixture.onDelay = () => {
      fixture.identity = FIRST;
      fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    };

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({
      state: "running",
      managed: true,
      pid: FIRST.pid,
      startedAt: FIRST.createdAt,
      port: FIRST.port,
    });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.spawn).toHaveBeenCalledWith(STARTUP, expect.objectContaining({ deadlineMs: 30_000 }));
    expect(fixture.child.unref).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual(["spawn", "delay:100", "control:GET:status", "unref"]);
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("coalesces concurrent starts into one detached child", async () => {
    const fixture = harness();
    let releaseDelay = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { releaseDelay = resolve; });
    let firstDelay = true;
    fixture.onDelayAsync = async () => {
      if (!firstDelay) {
        return;
      }
      firstDelay = false;
      await blocked;
      fixture.identity = FIRST;
      fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    };

    const first = fixture.controller.start(STARTUP);
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
    const second = fixture.controller.start(STARTUP);
    releaseDelay();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "running", pid: FIRST.pid }),
      expect.objectContaining({ state: "running", pid: FIRST.pid }),
    ]);
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it("finishes verified child cleanup before returning interruption after spawn", async () => {
    const fixture = harness();
    const abort = new AbortController();
    const blocked = deferred();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    fixture.onDelayAsync = async () => await blocked.promise;
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    const starting = fixture.controller.start(STARTUP, { signal: abort.signal });
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
    abort.abort();
    blocked.resolve();
    await expect(starting).rejects.toMatchObject({ code: "interrupted" });
    expect(fixture.terminate).toHaveBeenCalledWith({
      pid: FIRST.pid,
      processStartIdentity: FIRST.processStartIdentity,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fixture.child.unref).toHaveBeenCalledOnce();
  });

  it("terminates only its process-identity-verified child after the 30 second ready deadline", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    fixture.onDelay = () => { fixture.identity = FIRST; };
    fixture.controlRequest = async () => {
      throw new Error("not ready");
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    const result = await fixture.controller.start(STARTUP);
    expect(result.state).toBe("unreachable");
    expect(fixture.elapsedMs).toBe(30_000);
    expect(fixture.terminate).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith({
      pid: FIRST.pid,
      processStartIdentity: FIRST.processStartIdentity,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fixture.removed).toEqual([FIRST]);
    expect(fixture.child.unref).toHaveBeenCalledOnce();
  });

  it("terminates the captured child when readiness fails before daemon.json is published", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({ state: "unreachable" });
    expect(fixture.identity).toBeNull();
    expect(fixture.terminate).toHaveBeenCalledWith({
      pid: FIRST.pid,
      processStartIdentity: FIRST.processStartIdentity,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("retries the spawned child identity probe before failed-start cleanup", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    let reads = 0;
    fixture.processIdentityOverride = async (pid) => {
      reads += 1;
      if (reads === 1) throw new Error("temporary probe failure");
      return fixture.processes.get(pid) ?? null;
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({ state: "unreachable" });
    expect(reads).toBeGreaterThan(1);
    expect(fixture.terminate).toHaveBeenCalledOnce();
  });

  it("retries a null initial child identity probe during failed-start reconciliation", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    let reads = 0;
    fixture.processIdentityOverride = async (pid) => {
      reads += 1;
      if (reads === 1) return null;
      return fixture.processes.get(pid) ?? null;
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({ state: "unreachable" });
    expect(reads).toBeGreaterThan(1);
    expect(fixture.terminate).toHaveBeenCalledWith({
      pid: FIRST.pid,
      processStartIdentity: FIRST.processStartIdentity,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("recaptures a null initial child identity before cleanup after readiness cancellation", async () => {
    const fixture = harness();
    const abort = new AbortController();
    const blocked = deferred();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    let reads = 0;
    fixture.processIdentityOverride = async (pid) => {
      reads += 1;
      if (reads === 1) return null;
      return fixture.processes.get(pid) ?? null;
    };
    fixture.onDelayAsync = async () => await blocked.promise;
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    const starting = fixture.controller.start(STARTUP, { signal: abort.signal });
    await vi.waitFor(() => expect(fixture.events).toContain("delay:100"));
    abort.abort();
    blocked.resolve();
    await expect(starting).rejects.toMatchObject({ code: "interrupted" });
    expect(reads).toBeGreaterThan(1);
    expect(fixture.terminate).toHaveBeenCalledWith({
      pid: FIRST.pid,
      processStartIdentity: FIRST.processStartIdentity,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("bounds each readiness status call by the absolute 30 second deadline", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    fixture.onDelay = () => { fixture.identity = FIRST; };
    fixture.controlRequest = async (_identity, _method, _path, context) => {
      expect(context?.timeoutMs).toBe(29_900);
      fixture.elapsedMs += context?.timeoutMs ?? 0;
      throw new CliError("timeout");
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({ state: "unreachable" });
    expect(fixture.elapsedMs).toBe(30_000);
    expect(fixture.terminate).toHaveBeenCalledOnce();
  });

  it("includes process probes and delays in the absolute readiness deadline", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    let processReads = 0;
    fixture.processIdentityOverride = async (pid) => {
      processReads += 1;
      if (processReads === 1) {
        fixture.elapsedMs += 29_950;
      }
      return fixture.processes.get(pid) ?? null;
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({ state: "unreachable" });
    expect(fixture.elapsedMs).toBe(30_000);
    expect(fixture.terminate).toHaveBeenCalledOnce();
  });

  it("gracefully stops a managed daemon and removes identity only after process death", async () => {
    const fixture = harness({ identity: FIRST });
    fixture.onDelay = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toEqual({
      state: "stopped",
      managed: null,
      pid: null,
      startedAt: null,
      port: null,
      dataDir: DATA_DIR,
    });
    expect(fixture.controlCalls.map((call) => `${call.method}:${call.path}`)).toEqual([
      "GET:/__ghcg/control/v1/status",
      "POST:/__ghcg/control/v1/stop",
    ]);
    expect(fixture.elapsedMs).toBe(100);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("reconciles an authenticated stop before returning interruption", async () => {
    const fixture = harness({ identity: FIRST });
    const abort = new AbortController();
    const response = deferred();
    let stopStarted = false;
    fixture.controlRequest = async (identity, method) => {
      if (method === "GET") return { state: "running", instance: instanceOf(identity) };
      stopStarted = true;
      await response.promise;
      return { instance: instanceOf(identity) };
    };
    fixture.onDelay = () => fixture.processes.delete(FIRST.pid);

    const stopping = fixture.controller.stop(DATA_DIR, { signal: abort.signal });
    await vi.waitFor(() => expect(stopStarted).toBe(true));
    abort.abort();
    response.resolve();
    await expect(stopping).rejects.toMatchObject({ code: "interrupted" });
    expect(fixture.removed).toEqual([FIRST]);
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("waits 10 seconds then uses a fresh process identity before force termination", async () => {
    const fixture = harness({ identity: FIRST });
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped" });
    expect(fixture.elapsedMs).toBeLessThanOrEqual(10_000);
    expect(fixture.processReads.at(-1)).toEqual(FIRST.pid);
    expect(fixture.terminate).toHaveBeenCalledWith(
      FIRST,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("starts the graceful stop window after the initial running inspection", async () => {
    const fixture = harness({ identity: FIRST });
    let stopSentAt: number | undefined;
    fixture.controlRequest = async (identity, method) => {
      if (method === "GET") {
        fixture.elapsedMs += 3_500;
      } else {
        stopSentAt = fixture.elapsedMs;
      }
      return method === "GET"
        ? { state: "running", instance: instanceOf(identity) }
        : { instance: instanceOf(identity) };
    };
    fixture.processIdentityOverride = async (pid) => {
      if (stopSentAt !== undefined && fixture.elapsedMs - stopSentAt >= 6_600) {
        return null;
      }
      return fixture.processes.get(pid) ?? null;
    };

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped" });
    expect(stopSentAt).toBe(3_500);
    expect(fixture.elapsedMs).toBe(10_100);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("continues to verified force cleanup when the final graceful process probe reaches its deadline", async () => {
    const fixture = harness({ identity: FIRST });
    let stopRequested = false;
    fixture.controlRequest = async (identity, method) => {
      if (method === "POST") stopRequested = true;
      return method === "GET"
        ? { state: "running", instance: instanceOf(identity) }
        : { instance: instanceOf(identity) };
    };
    fixture.processIdentityOverride = async (pid) => {
      if (stopRequested) fixture.elapsedMs += 9_950;
      return fixture.processes.get(pid) ?? null;
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped" });
    expect(fixture.terminate).toHaveBeenCalledWith(
      FIRST,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("forces after the post-stop grace window when the process keeps running", async () => {
    const fixture = harness({ identity: FIRST });
    let stopSentAt = 0;
    let terminatedAt = Number.POSITIVE_INFINITY;
    let controlCalls = 0;
    fixture.controlRequest = async (identity, method) => {
      fixture.elapsedMs += controlCalls === 0 ? 2_000 : 3_000;
      if (method === "POST") stopSentAt = fixture.elapsedMs;
      controlCalls += 1;
      return method === "GET"
        ? { state: "running", instance: instanceOf(identity) }
        : { instance: instanceOf(identity) };
    };
    fixture.processIdentityOverride = async (pid) => {
      fixture.elapsedMs += 50;
      return fixture.processes.get(pid) ?? null;
    };
    fixture.onTerminate = () => {
      terminatedAt = fixture.elapsedMs;
      fixture.processes.delete(FIRST.pid);
    };

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped" });
    expect(stopSentAt).toBe(5_050);
    expect(terminatedAt - stopSentAt).toBeGreaterThanOrEqual(9_900);
    expect(terminatedAt - stopSentAt).toBeLessThanOrEqual(10_000);
    expect(fixture.terminate).toHaveBeenCalledOnce();
  });

  it("polls after force termination and rejects a reused PID while waiting", async () => {
    const fixture = harness({ identity: FIRST });
    let postTerminateReads = 0;
    fixture.onTerminate = () => {
      fixture.processIdentityOverride = async () => {
        postTerminateReads += 1;
        return postTerminateReads < 3
          ? FIRST.processStartIdentity
          : "linux:01234567-89ab-cdef-0123-456789abcdef:999";
      };
    };

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.elapsedMs).toBe(10_100);
    expect(fixture.removed).toEqual([]);
  });

  it("treats owned identity cleanup as stopped while the OS process record settles", async () => {
    const fixture = harness({ identity: FIRST });
    fixture.onTerminate = () => { fixture.identity = null; };
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped", pid: null });
  });

  it("rejects stop for foreground serve and leaves the process untouched", async () => {
    const fixture = harness({ identity: { ...FIRST, managed: false } });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({
      state: "conflict",
      managed: false,
      pid: FIRST.pid,
    });
    expect(fixture.controlCalls).toHaveLength(1);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([]);
  });

  it("normalizes a proven stale identity to idempotent stopped", async () => {
    const fixture = harness({ identity: FIRST });
    fixture.processes.delete(FIRST.pid);
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped", pid: null });
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("implements restart as verified stop followed by start with a new start identity and nonce", async () => {
    const fixture = harness({ identity: FIRST, spawnedPid: SECOND.pid });
    let delayCount = 0;
    fixture.onDelay = () => {
      delayCount += 1;
      if (delayCount === 1) {
        fixture.processes.delete(FIRST.pid);
        return;
      }
      fixture.identity = SECOND;
      fixture.processes.set(SECOND.pid, SECOND.processStartIdentity);
    };

    await expect(fixture.controller.restart(STARTUP)).resolves.toMatchObject({
      state: "running",
      pid: SECOND.pid,
      startedAt: SECOND.createdAt,
    });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.controlCalls.at(-1)?.identity).toEqual(SECOND);
  });

  it("restarts on the verified daemon identity port", async () => {
    const identity = { ...FIRST, port: 31_409 };
    const fixture = harness({ identity, spawnedPid: SECOND.pid });
    let delayCount = 0;
    fixture.onDelay = () => {
      delayCount += 1;
      if (delayCount === 1) fixture.processes.delete(identity.pid);
      else {
        fixture.identity = { ...SECOND, port: identity.port };
        fixture.processes.set(SECOND.pid, SECOND.processStartIdentity);
      }
    };
    await fixture.controller.restart(STARTUP);
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ port: 31_409 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

interface HarnessOptions {
  readonly identity?: DaemonIdentity;
  readonly spawnedPid?: number;
}

function harness(options: HarnessOptions = {}) {
  const fixture = {
    identity: options.identity ?? null as DaemonIdentity | null,
    processes: new Map<number, string>(),
    removed: [] as DaemonIdentity[],
    processReads: [] as number[],
    controlCalls: [] as Array<{ readonly identity: DaemonIdentity; readonly method: string; readonly path: string }>,
    events: [] as string[],
    elapsedMs: 0,
    onDelay: undefined as (() => void) | undefined,
    onDelayAsync: undefined as (() => Promise<void>) | undefined,
    onTerminate: undefined as (() => void) | undefined,
    controlRequest: undefined as DaemonControlRequest | undefined,
    processIdentityOverride: undefined as ((pid: number) => Promise<string | null>) | undefined,
    identityReadError: undefined as Error | undefined,
  };
  if (fixture.identity !== null) {
    fixture.processes.set(fixture.identity.pid, fixture.identity.processStartIdentity);
  }
  const child: SpawnedDaemon = {
    pid: options.spawnedPid ?? FIRST.pid,
    unref: vi.fn(() => fixture.events.push("unref")),
  };
  const spawn = vi.fn(async () => {
    fixture.events.push("spawn");
    return child;
  });
  const terminate = vi.fn(async (_identity: Readonly<{ pid: number; processStartIdentity: string }>) => fixture.onTerminate?.());
  const dependencies: DaemonControllerDependencies = {
    identityFile: {
      read: async () => {
        if (fixture.identityReadError !== undefined) {
          throw fixture.identityReadError;
        }
        return fixture.identity;
      },
      remove: async (_dataDir, expected) => {
        if (fixture.identity === null || !sameIdentity(fixture.identity, expected)) {
          return false;
        }
        fixture.removed.push(fixture.identity);
        fixture.identity = null;
        return true;
      },
    },
    processIdentity: async (pid) => {
      fixture.processReads.push(pid);
      if (fixture.processIdentityOverride !== undefined) {
        return await fixture.processIdentityOverride(pid);
      }
      return fixture.processes.get(pid) ?? null;
    },
    spawn,
    delay: async (ms) => {
      fixture.elapsedMs += ms;
      fixture.events.push(`delay:${ms}`);
      fixture.onDelay?.();
      await fixture.onDelayAsync?.();
    },
    nowMs: () => fixture.elapsedMs,
    controlRequest: async (identity, method, requestPath, context) => {
      fixture.controlCalls.push({ identity: { ...identity }, method, path: requestPath });
      fixture.events.push(`control:${method}:${requestPath.split("/").at(-1)}`);
      if (fixture.controlRequest !== undefined) {
        return await fixture.controlRequest(identity, method, requestPath, context);
      }
      return method === "GET"
        ? { state: "running", instance: instanceOf(identity) }
        : { instance: instanceOf(identity) };
    },
    terminate,
  };
  return Object.assign(fixture, {
    child,
    spawn,
    terminate,
    controller: new DaemonController(dependencies),
  });
}

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function instanceOf(identity: Readonly<DaemonIdentity>) {
  return {
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    instanceNonce: identity.instanceNonce,
  };
}

function sameIdentity(left: Readonly<DaemonIdentity>, right: Readonly<DaemonIdentity>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
