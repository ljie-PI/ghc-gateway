import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    if (process.platform === "win32") {
      expect(windowsAclPrincipals(filePath)).toHaveLength(1);
      expect(windowsAclPrincipals(dir)).toHaveLength(1);
    } else {
      expect(stat.mode & 0o777).toBe(0o600);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    }
    const read = await store.readGeneration("github.com/1", 1);
    expect(read?.githubToken).toBe("tok");
    await store.removeAccount("github.com/1");
    expect(await store.readGeneration("github.com/1", 1)).toBeNull();
  });

  it("rejects broad Windows credential ACLs", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(filePath);
    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "tok" });
    execFileSync("icacls", [filePath, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore", windowsHide: true });
    await expect(store.readGeneration("github.com/1", 1)).rejects.toThrow();
  });

  it("rejects a symlink credential directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() => ensureProtectedDirectory(link)).toThrow(/symlink/u);
  });

  function windowsAclPrincipals(target: string): readonly string[] {
    const output = execFileSync("icacls", [target], { encoding: "utf8", windowsHide: true });
    const principals: string[] = [];
    for (const rawLine of output.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("Successfully processed") || line.startsWith("Failed processing")) {
        continue;
      }
      const entry = rawLine.startsWith(target) ? rawLine.slice(target.length).trim() : line;
      const separator = entry.indexOf(":(");
      if (separator > 0) {
        principals.push(entry.slice(0, separator));
      }
    }
    return principals;
  }

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
