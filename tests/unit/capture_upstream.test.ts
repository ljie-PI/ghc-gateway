import { afterEach, describe, expect, it, vi } from "vitest";
import { runCaptureCli } from "../../scripts/tooling/capture_upstream.js";
import type { BoundAccount } from "../../src/accounts/account_directory.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";

const args = ["--execute", "--scenario", "long-text", "--mode", "nonstream", "--total-timeout-ms", "1000"];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function resource() {
  return {
    directory: {
      bindDefault: vi.fn(async (): Promise<BoundAccount> => { throw new Error("synthetic binding failure"); }),
      bindAccount: vi.fn(async (): Promise<BoundAccount> => { throw new Error("synthetic binding failure"); }),
    },
    copilot: { bind: vi.fn(() => { throw new Error("must not bind after cancellation"); }) },
    close: vi.fn(async (): Promise<void> => undefined),
    forceClose: vi.fn(async (): Promise<void> => undefined),
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("capture CLI resource ownership", () => {
  it("plans without creating application resources", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const factory = vi.fn(async () => resource());
    await runCaptureCli([], factory);
    expect(factory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ executed: false, requests: 16 });
  });

  it.each(["timeout", "SIGINT", "SIGTERM"] as const)("closes late-created resources once after %s without delaying cancellation", async (cancel) => {
    vi.useFakeTimers();
    const owned = resource();
    const creation = deferred<typeof owned>();
    const started = deferred<void>();
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const run = runCaptureCli(args, async () => { started.resolve(); return creation.promise; });
    const rejected = expect(run).rejects.toMatchObject({ code: cancel === "timeout" ? "capture_timeout" : "capture_cancelled" });
    await started.promise;
    if (cancel === "timeout") await vi.advanceTimersByTimeAsync(1000);
    else process.emit(cancel);
    // Cancellation must complete before the factory settles.
    await rejected;
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
    expect(owned.close).not.toHaveBeenCalled();
    creation.resolve(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(owned.close).toHaveBeenCalledOnce();
    expect(owned.forceClose).not.toHaveBeenCalled();
    expect(owned.directory.bindDefault).not.toHaveBeenCalled();
    expect(owned.copilot.bind).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)("closes resources once when cancelled account binding later settles: %s", async (settle) => {
    vi.useFakeTimers();
    const owned = resource();
    const binding = deferred<BoundAccount>();
    const started = deferred<void>();
    owned.directory.bindDefault.mockImplementation(async () => { started.resolve(); return binding.promise; });
    const run = runCaptureCli(args, async () => owned);
    const rejected = expect(run).rejects.toMatchObject({ code: "capture_timeout" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(owned.close).toHaveBeenCalledOnce();
    if (settle === "reject") binding.reject(new Error("private late failure"));
    else binding.resolve({
      accountId: "synthetic", environment: resolveGitHubEnvironment("github.com"), userId: "1",
      login: "synthetic", displayName: null, credentialGeneration: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(owned.close).toHaveBeenCalledOnce();
    expect(owned.copilot.bind).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds a stalled graceful/forced close (late creation: %s)", async (late) => {
    vi.useFakeTimers();
    const owned = resource();
    const closing = deferred<void>();
    const closeStarted = deferred<void>();
    const creation = deferred<typeof owned>();
    const started = deferred<void>();
    owned.close.mockImplementation(() => { closeStarted.resolve(); return closing.promise; });
    owned.forceClose.mockImplementation(async () => new Promise(() => undefined));
    const run = runCaptureCli(args, async () => { started.resolve(); return creation.promise; });
    const rejected = expect(run).rejects.toMatchObject({ code: late ? "capture_timeout" : "capture_failed" });
    await started.promise;
    if (late) {
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
    }
    creation.resolve(owned);
    await closeStarted.promise;
    expect(owned.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    if (!late) await rejected;
    expect(owned.forceClose).toHaveBeenCalledOnce();
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(owned.close).toHaveBeenCalledOnce();
    expect(owned.forceClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject"] as const)("observes late cleanup failures and forces closure once: %s", async (failure) => {
    vi.useFakeTimers();
    const owned = resource();
    owned.close.mockImplementation(() => {
      if (failure === "throw") throw new Error("private cleanup failure");
      return Promise.reject(new Error("private cleanup failure"));
    });
    owned.forceClose.mockImplementation(() => { throw new Error("private force failure"); });
    const creation = deferred<typeof owned>();
    const started = deferred<void>();
    const run = runCaptureCli(args, async () => { started.resolve(); return creation.promise; });
    const rejected = expect(run).rejects.toMatchObject({ code: "capture_timeout" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    creation.resolve(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(owned.close).toHaveBeenCalledOnce();
    expect(owned.forceClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a rejected late factory without creating or binding resources", async () => {
    vi.useFakeTimers();
    const creation = deferred<ReturnType<typeof resource>>();
    const started = deferred<void>();
    const run = runCaptureCli(args, async () => { started.resolve(); return creation.promise; });
    const rejected = expect(run).rejects.toMatchObject({ code: "capture_timeout" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    creation.reject(new Error("private composition failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
