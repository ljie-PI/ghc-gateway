import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactManifest,
  auditRuntimeDependencies,
  cleanupPackTemporaryDirectory,
  inspectAdminBundle,
  type NpmPackEntry,
} from "../../scripts/tooling/pack.js";
import { runSqliteWalSmoke } from "../../scripts/tooling/sqlite_smoke.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const parent = path.resolve("artifacts", "test-data");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("package evidence", () => {
  it("requires the index, Vite manifest, and hashed JavaScript and CSS in the package", async () => {
    const root = await temporaryDirectory("ghc-gateway-pack-");
    await mkdir(path.join(root, ".vite"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<script src=\"/admin/assets/index-AbCd1234.js\"></script>");
    await writeFile(path.join(root, "assets", "index-AbCd1234.js"), "export {};\n");
    await writeFile(path.join(root, "assets", "index-EfGh5678.css"), "body{}\n");
    await writeFile(path.join(root, ".vite", "manifest.json"), JSON.stringify({
      "index.html": {
        file: "assets/index-AbCd1234.js",
        css: ["assets/index-EfGh5678.css"],
        isEntry: true,
      },
    }));
    const files = [
      "index.html",
      ".vite/manifest.json",
      "assets/index-AbCd1234.js",
      "assets/index-EfGh5678.css",
    ].map((file) => ({ path: `dist/admin/${file}`, size: 1 }));

    const evidence = await inspectAdminBundle({ files }, root);

    expect(evidence.assets).toHaveLength(4);
    expect(evidence.assets.every((asset) => asset.packaged)).toBe(true);
    expect(evidence.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256))).toBe(true);
    expect(evidence.bytes).toBeGreaterThan(0);
  });

  it("fails when npm dry-run omits a required built asset", async () => {
    const root = await temporaryDirectory("ghc-gateway-pack-missing-");
    await mkdir(path.join(root, ".vite"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "admin");
    await writeFile(path.join(root, "assets", "index-AbCd1234.js"), "export {};\n");
    await writeFile(path.join(root, "assets", "index-EfGh5678.css"), "body{}\n");
    await writeFile(path.join(root, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "assets/index-AbCd1234.js", css: ["assets/index-EfGh5678.css"] },
    }));
    const entry: Pick<NpmPackEntry, "files"> = {
      files: [{ path: "dist/admin/index.html", size: 5 }],
    };

    await expect(inspectAdminBundle(entry, root)).rejects.toThrow("npm package omits Admin assets");
  });

  it("rejects extra and missing package files", () => {
    expect(() => assertExactManifest(
      ["package.json", "dist/src/main.js", "src/main.ts"],
      ["package.json", "dist/src/main.js", "dist/admin/index.html"],
    )).toThrow("unexpected=[src/main.ts], missing=[dist/admin/index.html]");
  });

  it.each(["preinstall", "install", "postinstall"])("rejects a transitive runtime %s hook before packaging can invoke a native build", async (hook) => {
    const root = await temporaryDirectory("ghc-gateway-pack-native-");
    const dependency = path.join(root, "node_modules", "runtime");
    const transitive = path.join(dependency, "node_modules", "native-runtime");
    await mkdir(transitive, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { runtime: "1.0.0" },
    }));
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({
      name: "runtime", version: "1.0.0", dependencies: { "native-runtime": "1.0.0" },
    }));
    await writeFile(path.join(transitive, "package.json"), JSON.stringify({
      name: "native-runtime", version: "1.0.0", scripts: { [hook]: "node-gyp rebuild" },
    }));

    await expect(auditRuntimeDependencies(root)).rejects.toThrow(`runtime dependency has an install hook: native-runtime (${hook})`);
  });

  it.each([
    { name: "node-gyp", manifest: {}, file: undefined },
    { name: "better-sqlite3", manifest: {}, file: undefined },
    { name: "native-runtime", manifest: { gypfile: true }, file: undefined },
    { name: "native-runtime", manifest: {}, file: "binding.gyp" },
    { name: "native-runtime", manifest: {}, file: path.join("prebuilds", "addon.node") },
  ])("rejects native runtime dependency evidence without explicit hooks: $name $file $manifest", async ({ name, manifest, file }) => {
    const root = await temporaryDirectory("ghc-gateway-pack-native-");
    const dependency = path.join(root, "node_modules", name);
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { [name]: "1.0.0" } }));
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
    if (file !== undefined) {
      await mkdir(path.dirname(path.join(dependency, file)), { recursive: true });
      await writeFile(path.join(dependency, file), "");
    }

    await expect(auditRuntimeDependencies(root)).rejects.toThrow("native runtime dependency is forbidden: ");
  });

  it("retries transient package cleanup locks without hiding a primary failure", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const warnings: string[] = [];
    await cleanupPackTemporaryDirectory("temporary-root", new Error("daemon stop failed"), {
      remove: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      },
      delay: async (ms) => { delays.push(ms); },
      warning: (message) => { warnings.push(message); },
    });

    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(warnings).toEqual([]);
  });

  it("preserves the primary package failure when cleanup stays locked", async () => {
    const warnings: string[] = [];
    await expect(cleanupPackTemporaryDirectory("temporary-root", new Error("daemon stop failed"), {
      remove: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); },
      delay: async () => undefined,
      warning: (message) => { warnings.push(message); },
    })).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cleanup failed");
    expect(warnings[0]).toContain("EBUSY");
  });

  it("preserves the primary package failure when cleanup retry delay fails", async () => {
    const warnings: string[] = [];
    await expect(cleanupPackTemporaryDirectory("temporary-root", new Error("daemon stop failed"), {
      remove: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); },
      delay: async () => { throw Object.assign(new Error("timer failed"), { code: "ETIMER" }); },
      warning: (message) => { warnings.push(message); },
    })).resolves.toBeUndefined();

    expect(warnings).toEqual(["package smoke cleanup failed after the primary failure: ETIMER"]);
  });

  it("reports package cleanup failure after an otherwise successful smoke", async () => {
    await expect(cleanupPackTemporaryDirectory("temporary-root", undefined, {
      remove: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      delay: async () => undefined,
      warning: () => undefined,
    })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("audits installed production dependencies without including development-only native tools", async () => {
    const dependencies = await auditRuntimeDependencies(process.cwd());

    expect(dependencies).toEqual([
      "@hono/node-server@2.1.1",
      "@sinclair/typebox@0.34.52",
      "hono@4.13.4",
      "undici@8.10.0",
    ]);
  });

  it("includes hoisted peer and installed optional dependencies while allowing absent optional packages", async () => {
    const root = await temporaryDirectory("ghc-gateway-pack-closure-");
    const manifests = {
      runtime: {
        peerDependencies: { peer: "1.0.0" },
        optionalDependencies: { present: "1.0.0", absent: "1.0.0" },
      },
      peer: { scripts: { prepare: "build-release-only" } },
      present: {},
    };
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { runtime: "1.0.0" },
      devDependencies: { "node-gyp": "1.0.0" },
      scripts: { prepack: "build" },
    }));
    for (const [name, manifest] of Object.entries(manifests)) {
      const dependency = path.join(root, "node_modules", name);
      await mkdir(dependency, { recursive: true });
      await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
    }

    await expect(auditRuntimeDependencies(root)).resolves.toEqual(["peer@1.0.0", "present@1.0.0", "runtime@1.0.0"]);
    await writeFile(path.join(root, "node_modules", "peer", "binding.gyp"), "");
    await expect(auditRuntimeDependencies(root)).rejects.toThrow("native runtime dependency is forbidden: peer");
    await rm(path.join(root, "node_modules", "peer"), { recursive: true });
    await expect(auditRuntimeDependencies(root)).rejects.toThrow("runtime dependency is not installed: peer");
  });

  it("smokes durable synchronous transactions through the production database opener", async () => {
    await expect(runSqliteWalSmoke()).resolves.toMatchObject({
      journalMode: "wal",
      rowCount: 1,
      rollback: true,
      nestedRollback: true,
      reopened: true,
    });
  });
});
