import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "../../src/cli/control_client.js";
import type { StartupConfig } from "../../src/config/startup_config.js";
import { DaemonController, type DaemonControllerDependencies } from "../../src/daemon/controller.js";
import type { DaemonIdentity } from "../../src/daemon/identity_file.js";
import {
  LifecycleCoordinator,
  MAX_PENDING_LIFECYCLE_OPERATIONS_PER_DIRECTORY,
} from "../../src/daemon/lifecycle_coordinator.js";
import type { DaemonOperationLeaseAccess } from "../../src/daemon/operation_lease.js";

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("daemon lifecycle coordination", () => {
  it("runs one FIFO lane per canonical data directory while different directories proceed independently", async () => {
    const events: string[] = [];
    const leases = scriptedLeases(events);
    const coordinator = new LifecycleCoordinator(leases);
    const releaseFirst = deferred();
    const releaseOther = deferred();

    const first = coordinator.run("same/../same", {}, async () => {
      events.push("first:start");
      await releaseFirst.promise;
      events.push("first:end");
      return "first";
    });
    const second = coordinator.run(path.resolve("same"), {}, async () => {
      events.push("second:start");
      return "second";
    });
    const other = coordinator.run("other", {}, async () => {
      events.push("other:start");
      await releaseOther.promise;
      events.push("other:end");
      return "other";
    });

    await vi.waitFor(() => {
      expect(events).toContain("first:start");
      expect(events).toContain("other:start");
    });
    expect(events).not.toContain("second:start");
    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    releaseOther.resolve();
    await expect(other).resolves.toBe("other");
    const sameLeaseEvents = events.filter((event) => event.endsWith(":same"));
    expect(sameLeaseEvents).toEqual([
      "lease:acquire:same",
      "lease:release:same",
      "lease:acquire:same",
      "lease:release:same",
    ]);
  });

  it("bounds pending callers per directory, immediately reclaims cancellation, and isolates directories", async () => {
    const coordinator = new LifecycleCoordinator(scriptedLeases([]));
    const release = deferred();
    const active = coordinator.run("limited", {}, async () => {
      await release.promise;
      return "active";
    });
    const aborts = Array.from(
      { length: MAX_PENDING_LIFECYCLE_OPERATIONS_PER_DIRECTORY },
      () => new AbortController(),
    );
    const pending = aborts.map((abort, index) => coordinator.run(
      "limited",
      { signal: abort.signal },
      async () => index,
    ));

    await expect(coordinator.run("limited", {}, async () => "overflow"))
      .rejects.toEqual(new CliError("unavailable"));
    await expect(coordinator.run("other", {}, async () => "other"))
      .resolves.toBe("other");

    aborts[0]?.abort();
    await expect(pending[0]).rejects.toEqual(new CliError("interrupted"));
    const replacement = coordinator.run("limited", {}, async () => "replacement");
    release.resolve();
    await expect(active).resolves.toBe("active");
    await expect(Promise.all(pending.slice(1))).resolves.toHaveLength(
      MAX_PENDING_LIFECYCLE_OPERATIONS_PER_DIRECTORY - 1,
    );
    await expect(replacement).resolves.toBe("replacement");
  });

  it("removes a canceled pending caller without affecting active or later work", async () => {
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator(scriptedLeases(events));
    const release = deferred();
    const first = coordinator.run("same", {}, async () => {
      events.push("first");
      await release.promise;
      return 1;
    });
    const abort = new AbortController();
    const secondWork = vi.fn(async () => 2);
    const second = coordinator.run("same", { signal: abort.signal }, secondWork);
    const third = coordinator.run("same", {}, async () => {
      events.push("third");
      return 3;
    });
    abort.abort();
    await expect(second).rejects.toEqual(new CliError("interrupted"));
    release.resolve();
    await expect(first).resolves.toBe(1);
    await expect(third).resolves.toBe(3);
    expect(secondWork).not.toHaveBeenCalled();
  });

  it("serializes start across two controllers and spawns one authenticated daemon", async () => {
    const ready = deferred();
    let identity: DaemonIdentity | null = null;
    const processes = new Map<number, string>();
    const spawn = vi.fn(async () => ({ pid: 4242, unref() {} }));
    let firstDelay = true;
    const coordinator = new LifecycleCoordinator(scriptedLeases([]));
    const dependencies: DaemonControllerDependencies = {
      lifecycleCoordinator: coordinator,
      identityFile: {
        read: async () => identity,
        remove: async () => false,
      },
      processIdentity: async (pid) => processes.get(pid) ?? null,
      spawn,
      delay: async () => {
        if (!firstDelay) return;
        firstDelay = false;
        await ready.promise;
        identity = runningIdentity();
        processes.set(4242, identity.processStartIdentity);
      },
      nowMs: () => 0,
      controlRequest: async (current) => ({ state: "running", instance: {
        pid: current.pid,
        processStartIdentity: current.processStartIdentity,
        instanceNonce: current.instanceNonce,
      } }),
      terminate: async () => undefined,
    };
    const first = new DaemonController(dependencies).start(startup("shared"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const second = new DaemonController(dependencies).start(startup("shared"));
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledOnce();
    ready.resolve();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ state: "running", pid: 4242 }),
      expect.objectContaining({ state: "running", pid: 4242 }),
    ]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("orders start then stop and stop then start by complete lifecycle operations", async () => {
    const startFirst = restartHarness({ initialRunning: false, block: "ready" });
    const starting = startFirst.controller.start(startup("start-stop"));
    await vi.waitFor(() => expect(startFirst.events).toContain("delay:ready:4243"));
    const stoppingAfter = startFirst.controller.stop("start-stop");
    expect(startFirst.events).not.toContain("control:POST:4243");
    startFirst.releaseFirstStop.resolve();
    await expect(starting).resolves.toMatchObject({ state: "running", pid: 4243 });
    await expect(stoppingAfter).resolves.toMatchObject({ state: "stopped", pid: null });

    const stopFirst = restartHarness();
    const stopping = stopFirst.controller.stop("stop-start");
    await vi.waitFor(() => expect(stopFirst.events).toContain("delay:stop:4242"));
    const startingAfter = stopFirst.controller.start(startup("stop-start"));
    expect(stopFirst.spawn).not.toHaveBeenCalled();
    stopFirst.releaseFirstStop.resolve();
    await expect(stopping).resolves.toMatchObject({ state: "stopped", pid: null });
    await expect(startingAfter).resolves.toMatchObject({ state: "running", pid: 4243 });
  });

  it("keeps restart indivisible from queued status and another restart", async () => {
    const fixture = restartHarness();
    const firstRestart = fixture.controller.restart(startup("restart"));
    await vi.waitFor(() => expect(fixture.events).toContain("delay:stop:4242"));
    const status = fixture.controller.status("restart");
    const secondRestart = fixture.controller.restart(startup("restart"));
    await Promise.resolve();
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.events.filter((event) => event.startsWith("control:"))).toHaveLength(3);

    fixture.releaseFirstStop.resolve();
    await expect(firstRestart).resolves.toMatchObject({ state: "running", pid: 4243 });
    await expect(status).resolves.toMatchObject({ state: "running", pid: 4243 });
    await expect(secondRestart).resolves.toMatchObject({ state: "running", pid: 4244 });
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    const controls = fixture.events.filter((event) => event.startsWith("control:"));
    expect(controls.indexOf("control:GET:4243")).toBeLessThan(controls.indexOf("control:POST:4243"));
    expect(controls.at(-1)).toBe("control:GET:4244");
  });

  it("starts lifecycle deadlines only after queued work obtains the lane", async () => {
    const releaseRead = deferred();
    let firstRead = true;
    let elapsedMs = 0;
    let identity: DaemonIdentity | null = null;
    const processes = new Map<number, string>();
    const coordinator = new LifecycleCoordinator(scriptedLeases([]));
    const dependencies: DaemonControllerDependencies = {
      lifecycleCoordinator: coordinator,
      identityFile: {
        read: async () => {
          if (firstRead) {
            firstRead = false;
            await releaseRead.promise;
          }
          return identity;
        },
        remove: async () => false,
      },
      processIdentity: async (pid) => processes.get(pid) ?? null,
      spawn: async () => {
        processes.set(4242, runningIdentity().processStartIdentity);
        return { pid: 4242, unref() {} };
      },
      delay: async (ms) => {
        elapsedMs += ms;
        identity = runningIdentity();
      },
      nowMs: () => elapsedMs,
      controlRequest: async (current) => ({ state: "running", instance: {
        pid: current.pid,
        processStartIdentity: current.processStartIdentity,
        instanceNonce: current.instanceNonce,
      } }),
      terminate: async () => undefined,
    };
    const controller = new DaemonController(dependencies);
    const active = controller.status("queued");
    const queuedStart = controller.start(startup("queued"));
    elapsedMs = 60_000;
    releaseRead.resolve();
    await expect(active).resolves.toMatchObject({ state: "stopped" });
    await expect(queuedStart).resolves.toMatchObject({ state: "running", pid: 4242 });
    expect(elapsedMs).toBe(60_100);
  });

  it("fails closed when a dependency ignores abort until it explicitly becomes quiescent", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const dependency = deferred();
      let reads = 0;
      const coordinator = new LifecycleCoordinator({
        acquire: async () => {
          events.push("lease:acquire");
          return { release: () => events.push("lease:release") };
        },
      });
      const controller = new DaemonController({
        lifecycleCoordinator: coordinator,
        identityFile: {
          read: async (_dataDir, context) => {
            reads += 1;
            if (reads === 1) {
              events.push("dependency:start");
              context.signal.addEventListener("abort", () => events.push("dependency:signaled"), { once: true });
              await dependency.promise;
              events.push("dependency:quiescent");
            }
            return null;
          },
          remove: async () => false,
        },
        processIdentity: async () => null,
        spawn: async () => ({ pid: 4242, unref() {} }),
        delay: async () => undefined,
        nowMs: Date.now,
        controlRequest: async () => undefined,
        terminate: async () => undefined,
      });

      const active = controller.status("nonconforming");
      const next = controller.status("nonconforming");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events).toEqual(["lease:acquire", "dependency:start", "dependency:signaled"]);
      let nextSettled = false;
      void next.finally(() => { nextSettled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(nextSettled).toBe(false);
      expect(events).not.toContain("lease:release");

      dependency.resolve();
      await expect(active).rejects.toMatchObject({ code: "timeout" });
      await expect(next).resolves.toMatchObject({ state: "stopped" });
      expect(events).toEqual([
        "lease:acquire",
        "dependency:start",
        "dependency:signaled",
        "dependency:quiescent",
        "lease:release",
        "lease:acquire",
        "lease:release",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reconciliation owned while initial identity capture acknowledges its deadline", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let processCalls = 0;
      let alive = true;
      const controller = new DaemonController({
        lifecycleCoordinator: recordingCoordinator(events),
        identityFile: { read: async () => null, remove: async () => false },
        processIdentity: async (_pid, context) => {
          processCalls += 1;
          if (processCalls === 1) {
            events.push("identity:start");
            return await rejectOnAbort(context?.signal, () => events.push("identity:abort-acknowledged"));
          }
          return alive ? runningIdentity().processStartIdentity : null;
        },
        spawn: async () => ({ pid: 4242, unref() {} }),
        delay: timedDelay,
        nowMs: Date.now,
        controlRequest: async () => undefined,
        terminate: async () => { alive = false; events.push("terminate"); },
      });

      const starting = controller.start(startup("bounded-identity"));
      const outcome = starting.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toContain("identity:abort-acknowledged");
      expect(events).not.toContain("lease:release");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await outcome).toMatchObject({ state: "unreachable" });
      expect(events.indexOf("identity:abort-acknowledged")).toBeLessThan(events.indexOf("terminate"));
      expect(events.at(-1)).toBe("lease:release");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-settling stop request and completes owned cleanup before release", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let stopTimedOut = false;
      const identity = runningIdentity();
      const controller = new DaemonController({
        lifecycleCoordinator: recordingCoordinator(events),
        identityFile: {
          read: async () => identity,
          remove: async () => { events.push("remove"); return true; },
        },
        processIdentity: async () => stopTimedOut ? null : identity.processStartIdentity,
        spawn: async () => ({ pid: 4243, unref() {} }),
        delay: async () => undefined,
        nowMs: Date.now,
        controlRequest: async (current, method, _requestPath, context) => method === "GET"
          ? { state: "running", instance: instanceOf(current) }
          : await rejectOnAbort(context?.signal, () => {
            stopTimedOut = true;
            events.push("stop:abort-acknowledged");
          }),
        terminate: async () => undefined,
      });

      const stopping = controller.stop("bounded-stop");
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(100);
      await expect(stopping).resolves.toMatchObject({ state: "stopped" });
      expect(events).toEqual([
        "lease:acquire",
        "stop:abort-acknowledged",
        "remove",
        "lease:release",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release while a stale-identity removal is acknowledging its deadline", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const identity = runningIdentity();
      const controller = new DaemonController({
        lifecycleCoordinator: recordingCoordinator(events),
        identityFile: {
          read: async () => identity,
          remove: async (_dataDir, _expected, context) => {
            events.push("remove:start");
            return await rejectOnAbort(context?.signal, () => events.push("remove:abort-acknowledged"));
          },
        },
        processIdentity: async () => null,
        spawn: async () => ({ pid: 4243, unref() {} }),
        delay: async () => undefined,
        nowMs: Date.now,
        controlRequest: async () => undefined,
        terminate: async () => undefined,
      });

      const status = controller.status("bounded-remove");
      const outcome = status.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toMatchObject({ code: "timeout" });
      expect(events).toEqual([
        "lease:acquire",
        "remove:start",
        "remove:abort-acknowledged",
        "lease:release",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["terminate", "post-terminate identity reconciliation"])(
    "bounds never-settling %s before releasing the operation lease",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const events: string[] = [];
        const identity = runningIdentity();
        let terminated = false;
        const controller = new DaemonController({
          lifecycleCoordinator: recordingCoordinator(events),
          identityFile: { read: async () => identity, remove: async () => false },
          processIdentity: async (_pid, context) => {
            if (terminated && stage !== "terminate") {
              events.push("reconcile:start");
              return await rejectOnAbort(
                context?.signal,
                () => events.push("reconcile:abort-acknowledged"),
              );
            }
            return identity.processStartIdentity;
          },
          spawn: async () => ({ pid: 4243, unref() {} }),
          delay: timedDelay,
          nowMs: Date.now,
          controlRequest: async (current, method) => method === "GET"
            ? { state: "running", instance: instanceOf(current) }
            : { instance: instanceOf(current) },
          terminate: async (_current, context) => {
            terminated = true;
            if (stage === "terminate") {
              events.push("terminate:start");
              await rejectOnAbort(
                context?.signal,
                () => events.push("terminate:abort-acknowledged"),
              );
            }
          },
        });

        const stopping = controller.stop(`bounded-${stage}`);
        const outcome = stopping.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(stage === "terminate" ? 30_000 : 20_000);
        expect(await outcome).toMatchObject({ code: "timeout" });
        const acknowledgment = stage === "terminate"
          ? "terminate:abort-acknowledged"
          : "reconcile:abort-acknowledged";
        expect(events).toContain(acknowledgment);
        expect(events.indexOf(acknowledgment)).toBeLessThan(events.indexOf("lease:release"));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not start active work canceled while its lease is being acquired", async () => {
    const acquired = deferred();
    let firstAcquire = true;
    const leases: DaemonOperationLeaseAccess = {
      acquire: async () => {
        if (firstAcquire) {
          firstAcquire = false;
          await acquired.promise;
        }
        return { release() {} };
      },
    };
    const coordinator = new LifecycleCoordinator(leases);
    const abort = new AbortController();
    const canceledWork = vi.fn(async () => "canceled");
    const canceled = coordinator.run("same", { signal: abort.signal }, canceledWork);
    abort.abort();
    acquired.resolve();
    await expect(canceled).rejects.toMatchObject({ code: "interrupted" });
    expect(canceledWork).not.toHaveBeenCalled();
    await expect(coordinator.run("same", {}, async () => "next")).resolves.toBe("next");
  });

  it("releases the lease and advances after active failure", async () => {
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator(scriptedLeases(events));
    const failed = coordinator.run("same", {}, async () => { throw new Error("failed operation"); });
    const next = coordinator.run("same", {}, async () => "next");
    await expect(failed).rejects.toThrow("failed operation");
    await expect(next).resolves.toBe("next");
    expect(events.filter((event) => event === "lease:release:same")).toHaveLength(2);
  });
});

function restartHarness(options: Readonly<{
  initialRunning?: boolean;
  block?: "stop" | "ready";
}> = {}) {
  const releaseFirstStop = deferred();
  const events: string[] = [];
  const initialRunning = options.initialRunning ?? true;
  const block = options.block ?? "stop";
  let identity: DaemonIdentity | null = initialRunning ? runningIdentity() : null;
  const processes = new Map<number, string>(initialRunning
    ? [[4242, runningIdentity().processStartIdentity]]
    : []);
  let stopping: DaemonIdentity | null = null;
  let nextPid = 4243;
  let spawned: DaemonIdentity | null = null;
  let blockFirstStop = true;
  const coordinator = new LifecycleCoordinator(scriptedLeases([]));
  const spawn = vi.fn(async () => {
    const pid = nextPid++;
    spawned = {
      ...runningIdentity(),
      pid,
      processStartIdentity: `linux:01234567-89ab-cdef-0123-456789abcdef:${pid}`,
      instanceNonce: `nonce-${pid}`,
      controlToken: `token-${pid}`,
    };
    processes.set(pid, spawned.processStartIdentity);
    events.push(`spawn:${pid}`);
    return { pid, unref() {} };
  });
  const dependencies: DaemonControllerDependencies = {
    lifecycleCoordinator: coordinator,
    identityFile: {
      read: async () => identity,
      remove: async (_dataDir, expected) => {
        if (identity === null || JSON.stringify(identity) !== JSON.stringify(expected)) return false;
        identity = null;
        return true;
      },
    },
    processIdentity: async (pid) => processes.get(pid) ?? null,
    spawn,
    delay: async () => {
      if (stopping !== null) {
        const current = stopping;
        stopping = null;
        events.push(`delay:stop:${current.pid}`);
        if (blockFirstStop && block === "stop") {
          blockFirstStop = false;
          await releaseFirstStop.promise;
        }
        processes.delete(current.pid);
        return;
      }
      if (spawned !== null) {
        events.push(`delay:ready:${spawned.pid}`);
        if (blockFirstStop && block === "ready") {
          blockFirstStop = false;
          await releaseFirstStop.promise;
        }
        identity = spawned;
        spawned = null;
      }
    },
    nowMs: () => 0,
    controlRequest: async (current, method) => {
      events.push(`control:${method}:${current.pid}`);
      if (method === "POST") stopping = { ...current };
      return method === "GET"
        ? { state: "running", instance: { pid: current.pid, processStartIdentity: current.processStartIdentity, instanceNonce: current.instanceNonce } }
        : { instance: { pid: current.pid, processStartIdentity: current.processStartIdentity, instanceNonce: current.instanceNonce } };
    },
    terminate: async () => undefined,
  };
  return { controller: new DaemonController(dependencies), events, spawn, releaseFirstStop };
}

function startup(dataDir: string): StartupConfig {
  return { host: "127.0.0.1", port: 31_400, dataDir, logLevel: "info" };
}

function runningIdentity(): DaemonIdentity {
  return {
    version: 1,
    managed: true,
    pid: 4242,
    processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:100",
    instanceNonce: "nonce",
    controlToken: "token",
    port: 31_400,
    createdAt: "2026-09-03T12:00:00.000Z",
  };
}

function instanceOf(identity: Readonly<DaemonIdentity>) {
  return {
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    instanceNonce: identity.instanceNonce,
  };
}

async function timedDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

async function rejectOnAbort(signal: AbortSignal | undefined, acknowledge: () => void): Promise<never> {
  if (signal === undefined) throw new Error("missing dependency signal");
  return await new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      acknowledge();
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function recordingCoordinator(events: string[]): LifecycleCoordinator {
  return new LifecycleCoordinator({
    acquire: async () => {
      events.push("lease:acquire");
      return { release: () => events.push("lease:release") };
    },
  });
}

function scriptedLeases(events: string[]): DaemonOperationLeaseAccess {
  return {
    acquire: async (dataDir, context) => {
      context?.signal?.throwIfAborted();
      const name = path.basename(dataDir);
      events.push(`lease:acquire:${name}`);
      return { release: () => events.push(`lease:release:${name}`) };
    },
  };
}
