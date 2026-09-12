import { execFile } from "node:child_process";
import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";
import { assertNode24, currentNodeMajor } from "../../scripts/tooling/node_version.js";
import { isAllowedNetworkTarget, isLoopbackHost } from "../../scripts/tooling/ci_network_guard.js";

const execFileAsync = promisify(execFile);

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly main: string;
  readonly exports: Record<string, string>;
  readonly bin: Record<string, string>;
  readonly scripts: Record<string, string>;
  readonly files: readonly string[];
  readonly engines: { readonly node: string };
  readonly repository: { readonly url: string };
  readonly dependencies: Record<string, string>;
}

interface PackageLock {
  readonly packages: Record<string, { readonly resolved?: string }>;
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
}

function isRuntimeBearingImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) {
    return true;
  }
  if (clause.isTypeOnly) {
    return false;
  }
  if (clause.name !== undefined || clause.namedBindings === undefined) {
    return true;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    return true;
  }
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isRuntimeBearingExport(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) {
    return false;
  }
  if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) {
    return true;
  }
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

async function staticRuntimeImportGraph(entrypoint: string): Promise<Set<string>> {
  const repositoryRoot = path.resolve(".");
  const pending = [path.resolve(entrypoint)];
  const reached = new Set<string>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const relativeCurrent = path.relative(repositoryRoot, current).replaceAll(path.sep, "/");
    if (reached.has(relativeCurrent)) {
      continue;
    }
    reached.add(relativeCurrent);

    const source = await readFile(current, "utf8");
    const sourceFile = ts.createSourceFile(current, source, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      const declaration = ts.isImportDeclaration(statement) && isRuntimeBearingImport(statement)
        ? statement
        : ts.isExportDeclaration(statement) && isRuntimeBearingExport(statement)
          ? statement
          : undefined;
      if (declaration?.moduleSpecifier === undefined
        || !ts.isStringLiteral(declaration.moduleSpecifier)
        || !declaration.moduleSpecifier.text.startsWith(".")) {
        continue;
      }
      const sourceSpecifier = declaration.moduleSpecifier.text.replace(/\.js$/u, ".ts");
      pending.push(path.resolve(path.dirname(current), sourceSpecifier));
    }
  }

  return reached;
}

describe("package entrypoints and toolchain", () => {
  it("keeps request-only Stream Execution modules out of the idle runtime import graph", async () => {
    const graph = await staticRuntimeImportGraph("src/main.ts");

    expect(graph).toContain("src/gateway/hono_app.ts");
    expect(graph).toContain("src/gateway/stream_execution.ts");
    expect(graph).not.toContain("src/gateway/stream_execution_owner.ts");
    expect(graph).not.toContain("src/gateway/stream_response.ts");
  });

  it("exposes the production package identity and entrypoints", async () => {
    const pkg = await readPackageJson();

    expect(VERSION).toBe("0.1.0");
    expect(pkg.name).toBe("@ljie-pi/ghc-gateway");
    expect(pkg.version).toBe(VERSION);
    expect(pkg.main).toBe("./dist/src/main.js");
    expect(pkg.exports).toEqual({
      ".": "./dist/src/main.js",
      "./cli": "./dist/src/cli/main.js",
    });
    expect(pkg.bin).toEqual({ ghcg: "dist/src/cli/main.js" });
    expect(pkg.files).toEqual(["dist/src/", "dist/admin/", "README.md", "LICENSE"]);
    expect(pkg.engines.node).toBe(">=24.20.0");
    expect(pkg.repository.url).toBe("git+https://github.com/ljie-PI/ghc-gateway.git");
  });

  it("uses TypeScript defaults and keeps SDK suites manual", async () => {
    const pkg = await readPackageJson();
    const requiredScripts = [
      "start",
      "build",
      "typecheck",
      "lint",
      "test",
      "test:sdk",
      "e2e",
      "fixtures:verify",
      "fixtures:generate",
      "bench",
      "pack",
      "prepack",
    ];

    for (const script of requiredScripts) {
      expect(pkg.scripts[script], script).toBeTypeOf("string");
    }
    expect(Object.keys(pkg.scripts).some((name) => name.includes("legacy"))).toBe(false);
    expect(pkg.scripts.start).toBe("node dist/src/cli/main.js serve");
    expect(pkg.scripts.build).toContain("tsc -p tsconfig.json");
    expect(pkg.scripts.test).toContain("vitest run --config vitest.config.ts");
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts.test).not.toContain("sdk");
    expect(pkg.scripts.e2e).not.toContain("sdk");
    for (const script of ["test:sdk", "typecheck:sdk"]) {
      const command = pkg.scripts[script];
      expect(command, script).toBeTypeOf("string");
      if (command === undefined) {
        throw new Error(`missing package script: ${script}`);
      }
      expect(command).toContain("require_opt_in.ts");
      expect(command).toContain("generate_migrations.ts");
      expect(command.indexOf("require_opt_in.ts")).toBeLessThan(
        command.indexOf("generate_migrations.ts"),
      );
    }
  });

  it("keeps recording explicit, content-free and absent from ordinary automation", async () => {
    const pkg = await readPackageJson();
    expect(Object.values(pkg.scripts).join("\n")).not.toMatch(/capture_upstream|capture_recorder|--execute/u);
    const command = ["scripts/tooling/bootstrap.mjs", "scripts/tooling/capture_upstream.ts"];
    const plan = await execFileAsync(process.execPath, command, {
      windowsHide: true,
      env: { ...process.env, GHC_GATEWAY_CI_NETWORK_GUARD: "1" },
    });
    expect(JSON.parse(plan.stdout)).toMatchObject({ executed: false, requests: 16, model: "gemini-3.5-flash", protocol: "chat" });
    expect(plan.stderr).toBe("");
    for (const args of [
      ["--model", "private-prompt-marker"],
      ["--execute", "--out", "private-prompt-marker"],
      ["--no-dry-run"],
      ["--execute", "--protocol", "messages"],
    ]) {
      await expect(execFileAsync(process.execPath, [...command, ...args], { windowsHide: true }))
        .rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringMatching(/^\{"error":"capture_(?:failed|invalid_options)"\}\r?\n$/u) });
    }
  });

  it("requires Node.js 24.20.0 or newer", () => {
    expect(currentNodeMajor()).toBeGreaterThanOrEqual(24);
    for (const version of ["22.20.0", "24.0.0", "24.19.9"]) {
      expect(() => assertNode24(version)).toThrow(/24\.20\.0/u);
    }
    for (const version of ["24.20.0", "24.21.0", "25.0.0", "26.8.1"]) {
      expect(() => assertNode24(version)).not.toThrow();
    }
  });

  it("locks registry dependencies to the official npm registry", async () => {
    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as PackageLock;
    const resolved = Object.values(lock.packages).flatMap((entry) => entry.resolved === undefined ? [] : [entry.resolved]);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((url) => url.startsWith("https://registry.npmjs.org/"))).toBe(true);
  });

  it("keeps official SDK commands behind manual opt-in guards", async () => {
    const command = ["scripts/tooling/bootstrap.mjs", "scripts/tooling/require_opt_in.ts"];

    await expect(execFileAsync(process.execPath, [...command, "GHC_GATEWAY_SDK_TESTS"], {
      windowsHide: true,
      env: { ...process.env, GHC_GATEWAY_SDK_TESTS: "" },
    })).rejects.toMatchObject({ code: 2 });

    await expect(execFileAsync(process.execPath, [...command, "GHC_GATEWAY_SDK_TESTS"], {
      windowsHide: true,
      env: { ...process.env, GHC_GATEWAY_SDK_TESTS: "1" },
    })).resolves.toMatchObject({ stdout: "" });
  });

  it("classifies loopback network targets for the CI network guard", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("github.com")).toBe(false);
    expect(isAllowedNetworkTarget("http://127.0.0.1:31400/healthz")).toBe(true);
    expect(isAllowedNetworkTarget("https://github.com/login/device/code")).toBe(false);
  });

  it("keeps bootstrap.mjs as the only tool JavaScript shim", async () => {
    const files = await readdir("scripts/tooling");
    expect(files.filter((file) => file.endsWith(".mjs")).sort()).toEqual(["bootstrap.mjs"]);
  });

  it("uses the supported configuration and test layout without compatibility aliases", async () => {
    const pkg = await readPackageJson();
    const sourceFiles = await readdir("src", { recursive: true });
    expect(sourceFiles.filter((file) => file.endsWith(".js"))).toEqual([]);
    expect(Object.keys(pkg.dependencies)).not.toEqual(expect.arrayContaining([
      "express",
      "minimist",
      "eslint_d",
    ]));
    const configurationFiles = (await readdir(".")).filter((file) =>
      (file.startsWith("tsconfig") && file.endsWith(".json"))
      || /^(?:vitest|playwright).*\.config\.[cm]?[jt]s$/u.test(file));
    expect(configurationFiles.sort()).toEqual([
      "playwright.config.ts",
      "tsconfig.json",
      "tsconfig.sdk.json",
      "tsconfig.test.json",
      "vitest.config.ts",
      "vitest.sdk.config.ts",
    ]);
    expect((await readdir("scripts", { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()).toEqual(["tooling"]);
    expect((await readdir("tests", { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()).toEqual([
      "contract", "e2e", "fixtures", "integration", "performance", "sdk", "unit",
    ]);
    for (const current of [
      "scripts/tooling/bootstrap.mjs",
      "tests/unit",
      "tests/fixtures",
    ]) {
      await expect(access(current)).resolves.toBeUndefined();
    }
    const productionText = `${await readFile("package.json", "utf8")}\n${await Promise.all(
      sourceFiles.filter((file) => file.endsWith(".ts")).map((file) => readFile(path.join("src", file), "utf8")),
    )}`;
    expect(productionText).not.toMatch(/ghcp-gateway|ghcpo-server|GHCPO_|\.ghcpo/u);
  });

  it("preloads the CI network guard without contacting external hosts", async () => {
    const bootstrapUrl = pathToFileURL(path.resolve("scripts/tooling/bootstrap.mjs")).href;

    await expect(execFileAsync(process.execPath, [
      "--import",
      bootstrapUrl,
      "--eval",
      "fetch('https://github.com').catch((error) => { console.error(error.message); process.exit(2); })",
    ], {
      windowsHide: true,
      env: { ...process.env, GHC_GATEWAY_CI_NETWORK_GUARD: "1" },
    })).rejects.toMatchObject({ code: 2 });
  });
});
