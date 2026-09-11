import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DaemonController,
  type DaemonControllerDependencies,
} from "../../src/daemon/controller.js";
import type { DaemonIdentity } from "../../src/daemon/identity_file.js";

const DATA_DIR = path.resolve("stale-data");
const IDENTITY: DaemonIdentity = {
  version: 1,
  managed: true,
  pid: 7_777,
  processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:100",
  instanceNonce: "recorded-nonce",
  controlToken: "recorded-token",
  port: 31_400,
  createdAt: "2026-09-03T12:00:00.000Z",
};

describe("stale PID safety", () => {
  it("reports stale and conditionally removes the complete identity only when the PID is proven dead", async () => {
    const fixture = harness(null);
    await expect(fixture.controller.status(DATA_DIR)).resolves.toMatchObject({
      state: "stale",
      managed: true,
      pid: IDENTITY.pid,
    });
    expect(fixture.remove).toHaveBeenCalledWith(DATA_DIR, IDENTITY);
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("reports conflict for PID reuse and never removes or terminates the unrelated process", async () => {
    const fixture = harness("linux:01234567-89ab-cdef-0123-456789abcdef:999");
    await expect(fixture.controller.status(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.controlRequest).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("requires the complete authenticated response tuple and treats a forged tuple as conflict", async () => {
    const fixture = harness(IDENTITY.processStartIdentity);
    fixture.controlRequest.mockResolvedValue({
      state: "running",
      instance: {
        pid: IDENTITY.pid,
        processStartIdentity: IDENTITY.processStartIdentity,
        instanceNonce: "forged-nonce",
      },
    });
    await expect(fixture.controller.status(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("refuses cleanup when an authenticated stop response has a forged nonce", async () => {
    const fixture = harness(IDENTITY.processStartIdentity);
    fixture.controlRequest.mockImplementation(async (identity, method) => method === "GET"
      ? { state: "running", instance: instanceOf(identity) }
      : { instance: { ...instanceOf(identity), instanceNonce: "forged-nonce" } });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("reports a verified live but unreachable process and never sends stop or terminate", async () => {
    const fixture = harness(IDENTITY.processStartIdentity);
    fixture.controlRequest.mockRejectedValue(new TypeError("connection refused"));
    await expect(fixture.controller.status(DATA_DIR)).resolves.toMatchObject({ state: "unreachable" });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "unreachable" });
    expect(fixture.controlRequest).toHaveBeenCalledTimes(2);
    expect(fixture.controlRequest.mock.calls.every((call) => call[1] === "GET")).toBe(true);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("rechecks process identity after graceful timeout and refuses force-stop if the PID was reused", async () => {
    let reads = 0;
    const fixture = harness(async () => {
      reads += 1;
      return reads <= 99
        ? IDENTITY.processStartIdentity
        : "linux:01234567-89ab-cdef-0123-456789abcdef:999";
    });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.elapsedMs).toBeLessThanOrEqual(10_000);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("refuses force-stop when the post-grace identity probe becomes unknown", async () => {
    let reads = 0;
    const fixture = harness(async () => {
      reads += 1;
      if (reads > 99) throw new Error("identity unavailable after grace");
      return IDENTITY.processStartIdentity;
    });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("fails closed when process identity cannot be established", async () => {
    const fixture = harness(async () => {
      throw new Error("identity unavailable");
    });
    await expect(fixture.controller.status(DATA_DIR)).resolves.toMatchObject({ state: "conflict" });
    expect(fixture.controlRequest).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.terminate).not.toHaveBeenCalled();
  });
});

function harness(
  processIdentity: string | null | ((pid: number) => Promise<string | null>),
) {
  let current: DaemonIdentity | null = IDENTITY;
  let elapsedMs = 0;
  const remove = vi.fn(async (_dataDir: string, expected: Readonly<DaemonIdentity>) => {
    if (current !== null && JSON.stringify(current) === JSON.stringify(expected)) {
      current = null;
      return true;
    }
    return false;
  });
  const controlRequest = vi.fn(async (identity: Readonly<DaemonIdentity>, method: string) => method === "GET"
    ? { state: "running", instance: instanceOf(identity) }
    : { instance: instanceOf(identity) });
  const terminate = vi.fn(async (_identity: Readonly<{ pid: number; processStartIdentity: string }>) => undefined);
  const dependencies: DaemonControllerDependencies = {
    identityFile: { read: async () => current, remove },
    processIdentity: typeof processIdentity === "function" ? processIdentity : async () => processIdentity,
    spawn: async () => ({ pid: IDENTITY.pid, unref() {} }),
    delay: async (ms) => { elapsedMs += ms; },
    nowMs: () => elapsedMs,
    controlRequest,
    terminate,
  };
  return {
    controller: new DaemonController(dependencies),
    remove,
    controlRequest,
    terminate,
    get elapsedMs() { return elapsedMs; },
  };
}

function instanceOf(identity: Readonly<DaemonIdentity>) {
  return {
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    instanceNonce: identity.instanceNonce,
  };
}
