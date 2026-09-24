import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import {
  DeviceFlowError,
  DeviceFlowService,
  MAX_DEVICE_FLOWS,
  type DeviceOAuthClient,
} from "../../src/accounts/device_flow.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";

const nowMs = (): number => 1_700_000_000_000;

function scriptedClient(): DeviceOAuthClient {
  return {
    async requestDeviceCode() {
      return {
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSec: 5,
        expiresInSec: 900,
      };
    },
    async exchangeDeviceCode() {
      return {
        status: "complete",
        accessToken: "gho_scripted",
        user: { id: "42", login: "octo", name: "Octo" },
      };
    },
  };
}

describe("device flow", () => {
  it("completes a scripted login into a bound account", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      let now = nowMs();
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), () => now);
      const flows = new DeviceFlowService(accounts, scriptedClient(), () => now);
      const started = await flows.start("github.com");
      expect(started.userCode).toBe("ABCD-1234");
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({
        status: "pending",
        pollIntervalSeconds: 5,
        nextPollAtMs: now + 5_000,
      });
      now += 5_000;
      const result = await flows.poll(started.flowId);
      expect(result).toEqual({ status: "complete", accountId: "github.com/42" });
      const bound = await accounts.bindDefault();
      expect(bound.login).toBe("octo");
      await expect(flows.poll(started.flowId)).resolves.toEqual(result);
    } finally {
      closeDatabase(database);
    }
  });

  it("rejects a ninth concurrent flow", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), nowMs);
      const pendingClient: DeviceOAuthClient = {
        async requestDeviceCode() {
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 5,
            expiresInSec: 900,
          };
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      };
      const flows = new DeviceFlowService(accounts, pendingClient, nowMs);
      for (let index = 0; index < MAX_DEVICE_FLOWS; index += 1) {
        await flows.start("github.com");
      }
      await expect(flows.start("github.com")).rejects.toBeInstanceOf(DeviceFlowError);
    } finally {
      closeDatabase(database);
    }
  });

  it("reserves capacity while concurrent device-code requests are pending", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), nowMs);
      const releases: Array<() => void> = [];
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode() {
          await new Promise<void>((resolve) => releases.push(resolve));
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 5,
            expiresInSec: 900,
          };
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      }, nowMs);
      const pending = Array.from({ length: MAX_DEVICE_FLOWS }, async () => await flows.start("github.com"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(flows.start("github.com")).rejects.toBeInstanceOf(DeviceFlowError);
      for (const release of releases) release();
      await Promise.all(pending);
    } finally {
      closeDatabase(database);
    }
  });
});

describe("device flow cleanup evidence", () => {
  it("cancels an exchange before a token is issued", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), () => now);
      let exchangeStarted = (): void => undefined;
      const startedExchange = new Promise<void>((resolve) => { exchangeStarted = resolve; });
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode() {
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 5,
            expiresInSec: 900,
          };
        },
        async exchangeDeviceCode(_environment, _deviceCode, signal) {
          exchangeStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { status: "pending" };
        },
      }, () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const poll = flows.poll(started.flowId);
      await startedExchange;
      const canceled = flows.cancel(started.flowId);

      await expect(poll).rejects.toMatchObject({ name: "AbortError" });
      await expect(canceled).resolves.toEqual({ status: "canceled" });
      expect(accounts.list()).toHaveLength(0);
    } finally {
      closeDatabase(database);
    }
  });

  it("expires and aborts a hanging exchange at the flow deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs());
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: Date.now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), Date.now);
      let exchanges = 0;
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode() {
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 1,
            expiresInSec: 2,
          };
        },
        async exchangeDeviceCode(_environment, _deviceCode, signal) {
          exchanges += 1;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { status: "pending" };
        },
      }, Date.now);
      const started = await flows.start("github.com");
      await vi.advanceTimersByTimeAsync(1_000);
      const poll = flows.poll(started.flowId);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(poll).resolves.toEqual({ status: "expired" });
      expect(exchanges).toBe(1);
      await expect(flows.poll(started.flowId)).resolves.toEqual({ status: "expired" });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(flows.poll(started.flowId)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      closeDatabase(database);
      vi.useRealTimers();
    }
  });

  it("clears flow timers when the service closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs());
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: Date.now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), new AccountCoordinator(), Date.now);
      const flows = new DeviceFlowService(accounts, scriptedClient(), Date.now);
      const started = await flows.start("github.com");
      expect(vi.getTimerCount()).toBe(1);
      await flows.close();
      expect(vi.getTimerCount()).toBe(0);
      await expect(flows.poll(started.flowId)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      closeDatabase(database);
      vi.useRealTimers();
    }
  });
});
