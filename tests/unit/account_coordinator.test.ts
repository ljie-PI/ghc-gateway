import { describe, expect, it, vi } from "vitest";
import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function turns(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AccountCoordinator", () => {
  it("serializes the same generation key without sharing callback failure", async () => {
    const coordinator = new AccountCoordinator();
    const gate = deferred();
    const order: string[] = [];
    const first = coordinator.withCredentialGeneration("one", async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
      throw new Error("first failed");
    });
    const second = coordinator.withCredentialGeneration("one", async () => {
      order.push("second");
      return 2;
    });
    await turns();
    expect(order).toEqual(["first-start"]);
    gate.resolve();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(coordinator.inspect()).toMatchObject({ generationKeys: 0, generationPending: 0, idle: true });
  });

  it("allows different keys and independent coordinators to run concurrently", async () => {
    const first = new AccountCoordinator();
    const second = new AccountCoordinator();
    const gate = deferred();
    const blocked = first.withCredentialGeneration("same", async () => await gate.promise);
    const results = await Promise.all([
      first.withCredentialGeneration("different", async () => "different"),
      second.withCredentialGeneration("same", async () => "independent"),
    ]);
    expect(results).toEqual(["different", "independent"]);
    gate.resolve();
    await blocked;
  });

  it("removes a canceled middle waiter without damaging active or successor work", async () => {
    const coordinator = new AccountCoordinator();
    const gate = deferred();
    const order: string[] = [];
    const first = coordinator.withCredentialGeneration("one", async () => {
      order.push("first");
      await gate.promise;
    });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const canceled = coordinator.withCredentialGeneration("one", async () => {
      order.push("canceled");
    }, controller.signal);
    const successor = coordinator.withCredentialGeneration("one", async () => {
      order.push("successor");
    });
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await first;
    await successor;
    expect(order).toEqual(["first", "successor"]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(coordinator.inspect()).toMatchObject({ generationKeys: 0, generationPending: 0 });
  });

  it("does not retain entries for work canceled before enqueue", async () => {
    const coordinator = new AccountCoordinator();
    const controller = new AbortController();
    controller.abort();
    await expect(coordinator.withCredentialGeneration("one", async () => undefined, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.inspect()).toMatchObject({ generationKeys: 0, generationPending: 0, idle: true });
  });

  it("serializes lifecycle work and cleans it after failures", async () => {
    const coordinator = new AccountCoordinator();
    const gate = deferred();
    const active = coordinator.withLifecycle(async () => await gate.promise);
    const successor = coordinator.withLifecycle(async () => { throw new Error("failure"); });
    expect(coordinator.inspect().lifecyclePending).toBe(2);
    gate.resolve();
    await active;
    await expect(successor).rejects.toThrow("failure");
    expect(coordinator.inspect()).toMatchObject({ lifecyclePending: 0, idle: true });
  });

  it("stops new work but drains admitted work", async () => {
    const coordinator = new AccountCoordinator();
    const gate = deferred();
    const active = coordinator.withLifecycle(async () => await gate.promise);
    coordinator.stop();
    await expect(coordinator.withLifecycle(async () => undefined)).rejects.toBeInstanceOf(DOMException);
    await expect(coordinator.withCredentialGeneration("one", async () => undefined)).rejects.toBeInstanceOf(DOMException);
    let drained = false;
    const drain = coordinator.drain().then(() => { drained = true; });
    await turns();
    expect(drained).toBe(false);
    gate.resolve();
    await active;
    await drain;
    expect(coordinator.inspect()).toEqual({
      stopped: true,
      idle: true,
      lifecyclePending: 0,
      generationKeys: 0,
      generationPending: 0,
    });
    await coordinator.close();
  });
});
