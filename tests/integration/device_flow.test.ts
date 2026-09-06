import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import {
  DEVICE_FLOW_TTL_MS,
  DeviceFlowError,
  DeviceFlowService,
  MAX_DEVICE_FLOWS,
  type DeviceOAuthClient,
} from "../../src/accounts/device_flow.js";
import { DeviceOAuthError } from "../../src/accounts/device_oauth.js";
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
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
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
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
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
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
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

  it("allows only one concurrent poll to consume a terminal result", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      let exchanges = 0;
      let release = (): void => undefined;
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode() {
          return { deviceCode: "device", userCode: "CODE", verificationUri: "https://github.com/login/device", intervalSec: 5, expiresInSec: 900 };
        },
        async exchangeDeviceCode() {
          exchanges += 1;
          await new Promise<void>((resolve) => { release = resolve; });
          return { status: "complete", accessToken: "token", user: { id: "42", login: "octo" } };
        },
      }, () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const first = flows.poll(started.flowId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({ status: "pending" });
      now += 10_000;
      await expect(flows.poll(started.flowId)).resolves.toEqual({
        status: "pending",
        pollIntervalSeconds: 5,
        nextPollAtMs: now + 5_000,
      });
      release();
      await expect(first).resolves.toEqual({ status: "complete", accountId: "github.com/42" });
      expect(exchanges).toBe(1);
      await expect(flows.poll(started.flowId)).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
    } finally {
      closeDatabase(database);
    }
  });

  it("cancels and expires scripted flows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode() {
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 5,
            expiresInSec: 1,
          };
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      }, () => now);
      const started = await flows.start("ghe.example.com");
      await flows.cancel(started.flowId);
      await expect(flows.poll(started.flowId)).rejects.toBeInstanceOf(DeviceFlowError);
      const second = await flows.start("ghe.example.com");
      now += 2_000;
      await expect(flows.poll(second.flowId)).resolves.toEqual({ status: "expired" });
      await expect(flows.poll(second.flowId)).resolves.toEqual({ status: "expired" });
    } finally {
      closeDatabase(database);
    }
  });

  it("enforces cadence and propagates slow_down updates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      let exchanges = 0;
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
        async exchangeDeviceCode() {
          exchanges += 1;
          return exchanges === 1
            ? { status: "slow_down", pollIntervalSeconds: 8 }
            : { status: "pending" };
        },
      }, () => now);

      const started = await flows.start("github.com");
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({ status: "pending" });
      expect(exchanges).toBe(0);
      now += 5_000;
      await expect(flows.poll(started.flowId)).resolves.toEqual({
        status: "pending",
        pollIntervalSeconds: 10,
        nextPollAtMs: now + 10_000,
      });
      expect(exchanges).toBe(1);
      now += 9_999;
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({ status: "pending" });
      expect(exchanges).toBe(1);
      now += 1;
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({
        status: "pending",
        pollIntervalSeconds: 10,
      });
      expect(exchanges).toBe(2);
    } finally {
      closeDatabase(database);
    }
  });

  it("keeps network failures cadence-bound and settles an issued token during cancellation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });

    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      let exchanges = 0;
      let release = (): void => undefined;
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
        async exchangeDeviceCode() {
          exchanges += 1;
          if (exchanges === 1) throw new Error("network failure");
          await new Promise<void>((resolve) => { release = resolve; });
          return { status: "complete", accessToken: "token", user: { id: "42", login: "octo" } };
        },
      }, () => now);

      const started = await flows.start("github.com");
      now += 5_000;
      await expect(flows.poll(started.flowId)).rejects.toThrow("network failure");
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({ status: "pending" });
      expect(exchanges).toBe(1);
      now += 5_000;
      const completion = flows.poll(started.flowId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const canceled = flows.cancel(started.flowId);
      release();
      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(canceled).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      expect(accounts.list()).toHaveLength(1);
    } finally {
      closeDatabase(database);
    }
  });

  it("cancels an exchange before a token is issued", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
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

  it("retries identity lookup without re-exchanging an issued token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs());
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: Date.now,
    });

    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), Date.now);
      let exchanges = 0;
      let userRequests = 0;
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
        async exchangeDeviceCode() {
          exchanges += 1;
          return { status: "authorized", accessToken: "token" };
        },
        async fetchUser() {
          userRequests += 1;
          if (userRequests === 1) throw new Error("temporary user lookup failure");
          return { id: "42", login: "octo" };
        },
      }, Date.now);
      const started = await flows.start("github.com");
      await vi.advanceTimersByTimeAsync(5_000);
      const completion = flows.poll(started.flowId);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      expect(exchanges).toBe(1);
      expect(userRequests).toBe(2);
    } finally {
      closeDatabase(database);
      vi.useRealTimers();
    }
  });

  it("fails immediately on a permanent identity lookup error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      let userRequests = 0;
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
        async exchangeDeviceCode() {
          return { status: "authorized", accessToken: "token" };
        },
        async fetchUser() {
          userRequests += 1;
          throw new DeviceOAuthError(false);
        },
      }, () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      await expect(flows.poll(started.flowId)).resolves.toEqual({ status: "failed" });
      expect(userRequests).toBe(1);
    } finally {
      closeDatabase(database);
    }
  });

  it("settles credential persistence after token issuance when a flow is canceled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });

    try {
      const credentials = new MemoryCredentialStore();
      const putGeneration = credentials.putGeneration.bind(credentials);
      let persistenceStarted = (): void => undefined;
      let releasePersistence = (): void => undefined;
      const startedPersisting = new Promise<void>((resolve) => { persistenceStarted = resolve; });
      const persistenceRelease = new Promise<void>((resolve) => { releasePersistence = resolve; });
      credentials.putGeneration = async (...args) => {
        persistenceStarted();
        await persistenceRelease;
        await putGeneration(...args);
      };
      const accounts = new AccountDirectory(database, credentials, () => now);
      const flows = new DeviceFlowService(accounts, scriptedClient(), () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const completion = flows.poll(started.flowId);
      await startedPersisting;
      const canceled = flows.cancel(started.flowId);
      releasePersistence();

      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(canceled).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      expect(accounts.list()).toHaveLength(1);
      await expect(credentials.readGeneration("github.com/42", 1)).resolves.not.toBeNull();
    } finally {
      closeDatabase(database);
    }
  });

  it("replays completion when cancellation arrives after the account commit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });

    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      const upsertAuthenticated = accounts.upsertAuthenticated.bind(accounts);
      let committed = (): void => undefined;
      let release = (): void => undefined;
      const accountCommitted = new Promise<void>((resolve) => { committed = resolve; });
      const commitRelease = new Promise<void>((resolve) => { release = resolve; });
      accounts.upsertAuthenticated = async (...args) => {
        const bound = await upsertAuthenticated(...args);
        committed();
        await commitRelease;
        return bound;
      };
      let exchanges = 0;
      const oauth = scriptedClient();
      const flows = new DeviceFlowService(accounts, {
        ...oauth,
        async exchangeDeviceCode(...args) {
          exchanges += 1;
          return await oauth.exchangeDeviceCode(...args);
        },
      }, () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const completion = flows.poll(started.flowId);
      await accountCommitted;
      const canceled = flows.cancel(started.flowId);
      release();

      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(flows.poll(started.flowId)).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(canceled).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      expect(exchanges).toBe(1);
    } finally {
      closeDatabase(database);
    }
  });

  it("does not publish expiry while an account commit is settling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });

    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      const upsertAuthenticated = accounts.upsertAuthenticated.bind(accounts);
      let committed = (): void => undefined;
      let release = (): void => undefined;
      const accountCommitted = new Promise<void>((resolve) => { committed = resolve; });
      const commitRelease = new Promise<void>((resolve) => { release = resolve; });
      accounts.upsertAuthenticated = async (...args) => {
        const bound = await upsertAuthenticated(...args);
        committed();
        await commitRelease;
        return bound;
      };
      const flows = new DeviceFlowService(accounts, scriptedClient(), () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const completion = flows.poll(started.flowId);
      await accountCommitted;
      now = started.expiresAtMs;
      await expect(flows.poll(started.flowId)).resolves.toMatchObject({ status: "pending" });
      release();

      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(flows.poll(started.flowId)).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
    } finally {
      closeDatabase(database);
    }
  });

  it("reports completion when post-commit credential cleanup fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const credentials = new MemoryCredentialStore();
      let cleanupAttempts = 0;
      let cleanupStarted = (): void => undefined;
      let releaseCleanup = (): void => undefined;
      const startedCleanup = new Promise<void>((resolve) => { cleanupStarted = resolve; });
      const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      credentials.prune = async () => {
        cleanupAttempts += 1;
        cleanupStarted();
        await cleanupRelease;
        if (cleanupAttempts < 3) throw new Error("cleanup failed");
      };
      const accounts = new AccountDirectory(database, credentials, () => now);
      const flows = new DeviceFlowService(accounts, scriptedClient(), () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const completion = flows.poll(started.flowId);
      await startedCleanup;
      const canceled = flows.cancel(started.flowId);
      releaseCleanup();

      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(canceled).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await expect(flows.poll(started.flowId)).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      expect(accounts.list()).toHaveLength(1);
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
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), Date.now);
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

  it("does not count completed replay snapshots against active capacity", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      const flows = new DeviceFlowService(accounts, scriptedClient(), () => now);
      for (let index = 0; index < MAX_DEVICE_FLOWS + 1; index += 1) {
        const started = await flows.start("github.com");
        now += 5_000;
        await expect(flows.poll(started.flowId)).resolves.toMatchObject({ status: "complete" });
      }
    } finally {
      closeDatabase(database);
    }
  });

  it("bounds a hanging device-code request and releases its reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs());
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: Date.now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), Date.now);
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode(_environment, signal) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          throw new Error("unreachable");
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      }, Date.now);
      const start = flows.start("github.com");
      const bounded = expect(start).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(DEVICE_FLOW_TTL_MS);
      await bounded;
      expect(vi.getTimerCount()).toBe(0);
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
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), Date.now);
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

  it("does not recreate state when close races with start or committed completion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      const upsertAuthenticated = accounts.upsertAuthenticated.bind(accounts);
      let committed = (): void => undefined;
      let releaseCommit = (): void => undefined;
      const accountCommitted = new Promise<void>((resolve) => { committed = resolve; });
      const commitRelease = new Promise<void>((resolve) => { releaseCommit = resolve; });
      accounts.upsertAuthenticated = async (...args) => {
        const bound = await upsertAuthenticated(...args);
        committed();
        await commitRelease;
        return bound;
      };
      const flows = new DeviceFlowService(accounts, scriptedClient(), () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const completion = flows.poll(started.flowId);
      await accountCommitted;
      const closing = flows.close();
      releaseCommit();
      await expect(completion).resolves.toEqual({
        status: "complete",
        accountId: "github.com/42",
      });
      await closing;
      expect(flows.has(started.flowId)).toBe(false);

      await expect(flows.start("github.com")).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      closeDatabase(database);
    }
  });

  it("aborts a device-code request when the service closes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
      let requestStarted = (): void => undefined;
      const startedRequest = new Promise<void>((resolve) => { requestStarted = resolve; });
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode(_environment, signal) {
          requestStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          throw new Error("unreachable");
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      }, nowMs);
      const start = flows.start("github.com");
      await startedRequest;
      await flows.close();
      await expect(start).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      closeDatabase(database);
    }
  });

  it("force close interrupts a hanging graceful settlement", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    let now = nowMs();
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs: () => now,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => now);
      let userRequestStarted = (): void => undefined;
      const startedUserRequest = new Promise<void>((resolve) => { userRequestStarted = resolve; });
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
        async exchangeDeviceCode() {
          return { status: "authorized", accessToken: "token" };
        },
        async fetchUser(_environment, _accessToken, signal) {
          userRequestStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { id: "42", login: "octo" };
        },
      }, () => now);
      const started = await flows.start("github.com");
      now += 5_000;
      const poll = flows.poll(started.flowId);
      await startedUserRequest;
      const closing = flows.close();
      flows.forceClose();

      await expect(poll).rejects.toMatchObject({ name: "AbortError" });
      await closing;
      expect(flows.has(started.flowId)).toBe(false);
    } finally {
      closeDatabase(database);
    }
  });
});
