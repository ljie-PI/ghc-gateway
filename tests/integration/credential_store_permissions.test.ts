import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureProtectedDirectory,
  FileCredentialStore,
} from "../../src/accounts/credential_store.js";

describe("credential file protection", () => {
  it("uses atomic replace and protected permissions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(filePath);
    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "tok" });
    const stat = lstatSync(filePath);
    expect(stat.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    }
    const read = await store.readGeneration("github.com/1", 1);
    expect(read?.githubToken).toBe("tok");
    await store.removeAccount("github.com/1");
    expect(await store.readGeneration("github.com/1", 1)).toBeNull();
  });

  it.runIf(process.platform === "win32")("trusts inherited Windows credential permissions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    writeFileSync(filePath, `${JSON.stringify({
      version: 1,
      credentials: { "github.com/1": { "1": { generation: 1, githubToken: "tok" } } },
    })}\n`);

    const store = new FileCredentialStore(filePath);
    await expect(store.readGeneration("github.com/1", 1)).resolves.toEqual({
      generation: 1,
      githubToken: "tok",
    });
  });

  it("recovers the exact validated orphan stage and preserves unrelated temp files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const stagePath = `${filePath}.tmp`;
    const unrelatedPath = `${filePath}.123.unrelated.tmp`;
    seedCredentialStage(filePath, "orphan-secret");
    writeFileSync(unrelatedPath, "unrelated-secret", { mode: 0o600 });
    const synced: string[] = [];

    new FileCredentialStore(filePath, {
      syncDirectory: (directory) => synced.push(directory),
    });

    expect(existsSync(stagePath)).toBe(false);
    expect(readFileSync(unrelatedPath, "utf8")).toBe("unrelated-secret");
    expect(synced).toEqual([dir]);
  });

  it("recovers an orphan stage found at write time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const stagePath = `${filePath}.tmp`;
    const synced: string[] = [];
    const store = new FileCredentialStore(filePath, {
      syncDirectory: (directory) => synced.push(directory),
    });
    seedCredentialStage(filePath, "orphan-secret");

    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "replacement-secret" });

    await expect(store.readGeneration("github.com/1", 1)).resolves.toMatchObject({
      githubToken: "replacement-secret",
    });
    expect(existsSync(stagePath)).toBe(false);
    expect(synced).toEqual([dir, dir, dir, dir]);
  });

  it("cleans only exact validated stages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const stagePath = `${filePath}.tmp`;
    writeFileSync(stagePath, "staged secret", { mode: 0o600 });
    writeFileSync(`${filePath}.tmp.prepare`, "preparing secret", { mode: 0o600 });

    new FileCredentialStore(filePath, { syncDirectory: () => undefined });

    expect(existsSync(stagePath)).toBe(false);
    expect(existsSync(`${filePath}.tmp.prepare`)).toBe(false);
  });

  it("fails a writer whose exact stage is recovered by a concurrent store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    let contender: FileCredentialStore | undefined;
    const first = new FileCredentialStore(filePath, {
      syncDirectory: () => {
        contender ??= new FileCredentialStore(filePath, { syncDirectory: () => undefined });
      },
    });

    await expect(first.putGeneration("github.com/1", 1, {
      generation: 1,
      githubToken: "cancelled-secret",
    })).rejects.toThrow();
    expect(contender).toBeDefined();

    await contender!.putGeneration("github.com/2", 1, { generation: 1, githubToken: "published-secret" });
    await expect(contender!.readGeneration("github.com/1", 1)).resolves.toBeNull();
    await expect(contender!.readGeneration("github.com/2", 1)).resolves.toMatchObject({
      githubToken: "published-secret",
    });
  });

  it("durably publishes replacements without losing existing secrets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const synced: string[] = [];
    const store = new FileCredentialStore(filePath, {
      syncDirectory: (directory) => synced.push(directory),
    });

    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "first-secret" });
    const first = lstatSync(filePath, { bigint: true });
    await store.putGeneration("github.com/2", 1, { generation: 1, githubToken: "second-secret" });
    const second = lstatSync(filePath, { bigint: true });

    expect(first.ino).not.toBe(second.ino);
    await expect(store.readGeneration("github.com/1", 1)).resolves.toMatchObject({ githubToken: "first-secret" });
    await expect(store.readGeneration("github.com/2", 1)).resolves.toMatchObject({ githubToken: "second-secret" });
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(synced).toEqual([dir, dir, dir, dir, dir, dir]);
  });

  it("preserves an atomically published secret when the rename directory sync fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    let syncCount = 0;
    const store = new FileCredentialStore(filePath, {
      syncDirectory: () => {
        syncCount += 1;
        if (syncCount === 3) throw new Error("directory sync failed");
      },
    });

    await expect(store.putGeneration("github.com/1", 1, {
      generation: 1,
      githubToken: "published-secret",
    })).rejects.toThrow(/directory sync failed/u);

    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    const recovered = new FileCredentialStore(filePath, { syncDirectory: () => undefined });
    await expect(recovered.readGeneration("github.com/1", 1)).resolves.toMatchObject({
      githubToken: "published-secret",
    });
  });

  it("rejects credential documents beyond the read bound", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(filePath);
    writeFileSync(filePath, `${JSON.stringify({
      version: 1,
      credentials: {
        "github.com/1": {
          "1": { generation: 1, githubToken: "tok", padding: "x".repeat(1024 * 1024) },
        },
      },
    })}\n`, { mode: 0o600 });

    await expect(store.readGeneration("github.com/1", 1)).rejects.toThrow(/too large/u);
  });

  it("rejects a symlink credential directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => ensureProtectedDirectory(link)).toThrow(/symlink/u);
  });

  it("does not persist secrets into sqlite-shaped documents beyond the protected file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(filePath);
    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "tok" });
    const sqliteProbe = path.join(dir, "state.db");
    writeFileSync(sqliteProbe, "not-a-secret-store");
    expect(await store.readGeneration("github.com/1", 1)).toEqual({
      generation: 1,
      githubToken: "tok",
    });
  });
});

function seedCredentialStage(filePath: string, token: string): void {
  writeFileSync(`${filePath}.tmp`, `${JSON.stringify({
    version: 1,
    credentials: { "github.com/1": { "1": { generation: 1, githubToken: token } } },
  })}\n`, { mode: 0o600, flag: "wx" });
}
