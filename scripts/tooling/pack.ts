import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNode24 } from "./node_version.js";
import { windowsCmdCommandLine } from "./windows_cmd.js";

const PACKAGE_NAME = "@ljie-pi/ghc-gateway";
const PACKAGE_VERSION = "0.1.0";

export interface AdminAssetEvidence {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly packaged: boolean;
}

export interface ViteManifestEntry {
  readonly file: string;
  readonly css?: readonly string[];
  readonly isEntry?: boolean;
}

export interface NpmPackFile {
  readonly path: string;
  readonly size: number;
}

export interface NpmPackEntry {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: readonly NpmPackFile[];
}

export interface PackSmokeResult {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sha256: string;
  readonly packageBytes: number;
  readonly unpackedBytes: number;
  readonly manifest: readonly string[];
  readonly adminAssets: readonly AdminAssetEvidence[];
  readonly help: true;
  readonly foregroundHealth: true;
  readonly daemonLifecycle: true;
  readonly installScriptsEnabled: true;
  readonly nativeBuildAudit: "passed";
  readonly runtimeDependencies: readonly string[];
  readonly nodeVersion: string;
}

function packagePath(relativePath: string): string {
  return path.posix.join("dist/admin", relativePath.replaceAll(path.sep, "/"));
}

function isHashedAsset(relativePath: string, extension: "js" | "css"): boolean {
  return new RegExp(`^assets/.+[-.][A-Za-z0-9_-]{8,}\\.${extension}$`, "u").test(relativePath);
}

export async function inspectAdminBundle(
  entry: Readonly<Pick<NpmPackEntry, "files">>,
  root = path.resolve("dist", "admin"),
): Promise<Readonly<{
  assets: readonly AdminAssetEvidence[];
  bytes: number;
  viteManifest: Readonly<Record<string, ViteManifestEntry>>;
}>> {
  const manifestText = await readFile(path.join(root, ".vite", "manifest.json"), "utf8");
  const viteManifest = JSON.parse(manifestText) as Readonly<Record<string, ViteManifestEntry>>;
  const referenced = Object.values(viteManifest).flatMap((item) => [item.file, ...(item.css ?? [])]);
  const javascript = referenced.find((file) => isHashedAsset(file, "js"));
  const stylesheet = referenced.find((file) => isHashedAsset(file, "css"));
  if (javascript === undefined || stylesheet === undefined) {
    throw new Error("Admin Vite manifest must reference hashed JavaScript and CSS assets");
  }

  const packagedPaths = new Set(entry.files.map((file) => file.path.replaceAll("\\", "/")));
  const assets = await Promise.all([
    "index.html",
    ".vite/manifest.json",
    javascript,
    stylesheet,
  ].map(async (relativePath): Promise<AdminAssetEvidence> => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const body = await readFile(absolutePath);
    return {
      path: packagePath(relativePath),
      bytes: (await stat(absolutePath)).size,
      sha256: createHash("sha256").update(body).digest("hex"),
      packaged: packagedPaths.has(packagePath(relativePath)),
    };
  }));
  const missing = assets.filter((asset) => !asset.packaged).map((asset) => asset.path);
  if (missing.length > 0) {
    throw new Error(`npm package omits Admin assets: ${missing.join(", ")}`);
  }
  return {
    assets,
    bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
    viteManifest,
  };
}

export async function expectedPackageManifest(root = process.cwd()): Promise<readonly string[]> {
  const sourceFiles = await walkFiles(path.join(root, "src"), root);
  const productionFiles = sourceFiles
    .filter((file) => file.endsWith(".ts") && !file.startsWith("src/persistence/migrations/"))
    .map((file) => `dist/${file.slice(0, -3)}.js`);
  const manifest = JSON.parse(
    await readFile(path.join(root, "dist", "admin", ".vite", "manifest.json"), "utf8"),
  ) as Readonly<Record<string, ViteManifestEntry>>;
  const adminReferences = Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.css ?? [])]);
  return [
    "LICENSE",
    "README.md",
    "package.json",
    ...productionFiles,
    "dist/admin/.vite/manifest.json",
    "dist/admin/index.html",
    ...adminReferences.map((file) => `dist/admin/${normalizePath(file)}`),
  ].sort();
}

export function assertExactManifest(
  actual: readonly string[],
  expected: readonly string[],
): void {
  const normalizedActual = [...actual].map(normalizePath).sort();
  const normalizedExpected = [...expected].map(normalizePath).sort();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    const expectedSet = new Set(normalizedExpected);
    const actualSet = new Set(normalizedActual);
    const unexpected = normalizedActual.filter((file) => !expectedSet.has(file));
    const missing = normalizedExpected.filter((file) => !actualSet.has(file));
    throw new Error(`package manifest mismatch; unexpected=[${unexpected.join(", ")}], missing=[${missing.join(", ")}]`);
  }
}

interface RuntimeManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly gypfile?: boolean;
}

const NATIVE_BUILD_PACKAGES = new Set([
  "better-sqlite3", "node-gyp", "node-gyp-build", "node-pre-gyp", "@mapbox/node-pre-gyp",
  "prebuild-install", "prebuildify", "cmake-js", "bindings", "node-addon-api",
]);

async function hasNativeFiles(directory: string, recursive = true): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === "binding.gyp" || entry.name.endsWith(".node"))) return true;
    if (recursive && entry.isDirectory() && entry.name !== "node_modules"
      && await hasNativeFiles(path.join(directory, entry.name))) return true;
  }
  return false;
}

export async function auditRuntimeDependencies(root: string): Promise<readonly string[]> {
  const boundary = path.resolve(root);
  const visited = new Set<string>();
  const specs = new Set<string>();

  async function visit(directory: string): Promise<void> {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as RuntimeManifest;
    if (NATIVE_BUILD_PACKAGES.has(manifest.name ?? "") || manifest.gypfile === true
      || await hasNativeFiles(directory, directory !== boundary)) {
      throw new Error(`native runtime dependency is forbidden: ${manifest.name ?? "root"}`);
    }
    const hooks = ["preinstall", "install", "postinstall"];
    // Registry/tarball dependencies do not execute the source root's preparation hooks.
    if (directory === boundary) hooks.push("prepare", "prepublish");
    for (const hook of hooks) {
      if (manifest.scripts?.[hook] !== undefined) {
        throw new Error(`runtime dependency has an install hook: ${manifest.name ?? "root"} (${hook})`);
      }
    }
    if (directory !== boundary) specs.add(`${manifest.name}@${manifest.version}`);
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      let location = directory;
      let resolved = false;
      while (location === boundary || location.startsWith(`${boundary}${path.sep}`)) {
        const candidate = path.join(location, "node_modules", name);
        try {
          await access(path.join(candidate, "package.json"));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          location = path.dirname(location);
          continue;
        }
        await visit(candidate);
        resolved = true;
        break;
      }
      const optional = manifest.optionalDependencies?.[name] !== undefined
        || (manifest.dependencies?.[name] === undefined && manifest.peerDependenciesMeta?.[name]?.optional === true);
      if (!resolved && !optional) {
        throw new Error(`runtime dependency is not installed: ${name}`);
      }
    }
  }

  await visit(boundary);
  return [...specs].sort();
}

const PACK_CLEANUP_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600] as const;
const TRANSIENT_PACK_CLEANUP_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

export interface PackCleanupDependencies {
  readonly remove?: (target: string) => Promise<void>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly warning?: (message: string) => void;
}

export async function cleanupPackTemporaryDirectory(
  target: string,
  primaryError?: unknown,
  dependencies: Readonly<PackCleanupDependencies> = {},
): Promise<void> {
  const remove = dependencies.remove ?? (async (value: string) => {
    await rm(value, { recursive: true, force: true });
  });
  const delay = dependencies.delay ?? (async (ms: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
  const warning = dependencies.warning ?? ((message: string) => console.error(message));
  let lastError: unknown = new Error("package cleanup failed");

  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(target);
      return;
    } catch (error: unknown) {
      lastError = error;
      const retryDelay = PACK_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isTransientPackCleanupError(error)) {
        break;
      }
      try {
        await delay(retryDelay);
      } catch (delayError: unknown) {
        lastError = delayError;
        break;
      }
    }
  }

  if (primaryError !== undefined) {
    warning(`package smoke cleanup failed after the primary failure: ${packCleanupErrorDescription(lastError)}`);
    return;
  }
  throw lastError;
}

function isTransientPackCleanupError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && TRANSIENT_PACK_CLEANUP_CODES.has(error.code);
}

function packCleanupErrorDescription(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : String(error);
}

export async function runPackSmoke(): Promise<PackSmokeResult> {
  await auditRuntimeDependencies(process.cwd());
  const temporaryParent = path.resolve("artifacts", "test-data");
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(temporaryParent, "ghc-gateway-pack-"));
  let primaryError: unknown;
  try {
    if (process.platform === "win32") {
      const identity = await runCommand("whoami", ["/user", "/fo", "csv", "/nh"], temporaryRoot);
      const sid = /^"[^"]+","(S-\d+(?:-\d+)+)"$/u.exec(identity.stdout.trim())?.[1];
      if (sid === undefined) throw new Error("unable to resolve package smoke directory owner");
      await runCommand("icacls", [
        temporaryRoot, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)(F)`,
      ], temporaryRoot);
    }
    const packDirectory = path.join(temporaryRoot, "tarball");
    const installDirectory = path.join(temporaryRoot, "install");
    await mkdir(packDirectory);
    const packed = await runNpm([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory,
    ], process.cwd());
    const entry = await readPackEntry(packed.stdout, packDirectory);
    if (entry.name !== PACKAGE_NAME || entry.version !== PACKAGE_VERSION) {
      throw new Error(`unexpected package identity ${entry.name}@${entry.version}`);
    }
    const actualManifest = entry.files.map((file) => file.path);
    assertExactManifest(actualManifest, await expectedPackageManifest());
    const admin = await inspectAdminBundle(entry);
    const tarballPath = path.join(packDirectory, entry.filename);
    const tarball = await readFile(tarballPath);

    await runNpm([
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts=false",
      "--prefix",
      installDirectory,
      tarballPath,
    ], temporaryRoot);
    const runtimeDependencies = await auditRuntimeDependencies(installDirectory);
    const installedRoot = path.join(installDirectory, "node_modules", "@ljie-pi", "ghc-gateway");
    await verifyInstalledPackage(installedRoot, installDirectory, temporaryRoot);

    const result: PackSmokeResult = {
      packageName: entry.name,
      packageVersion: entry.version,
      sha256: createHash("sha256").update(tarball).digest("hex"),
      packageBytes: entry.size,
      unpackedBytes: entry.unpackedSize,
      manifest: [...actualManifest].sort(),
      adminAssets: admin.assets,
      help: true,
      foregroundHealth: true,
      daemonLifecycle: true,
      installScriptsEnabled: true,
      nativeBuildAudit: "passed",
      runtimeDependencies,
      nodeVersion: process.versions.node,
    };
    const artifactDirectory = path.resolve("artifacts", "ci");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(path.join(artifactDirectory, "package-smoke.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupPackTemporaryDirectory(temporaryRoot, primaryError);
  }
}

async function verifyInstalledPackage(
  installedRoot: string,
  installRoot: string,
  temporaryRoot: string,
): Promise<void> {
  const cliEntry = path.join(installedRoot, "dist", "src", "cli", "main.js");
  await access(cliEntry);
  const binPath = path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "ghcg.cmd" : "ghcg");
  await access(binPath);
  const help = await runBin(binPath, ["--help"], temporaryRoot);
  if (!help.stdout.includes("Usage: ghcg") || !help.stdout.includes("serve")) {
    throw new Error(`installed ghcg --help did not return canonical help; stdout=${safeOutput(help.stdout)}; stderr=${safeOutput(help.stderr)}`);
  }

  const foregroundData = path.join(temporaryRoot, "foreground");
  const foregroundPort = await reservePort();
  const foreground = spawn(process.execPath, [
    cliEntry,
    "serve",
    "--data-dir", foregroundData,
    "--port", String(foregroundPort),
  ], {
    cwd: temporaryRoot,
    env: sanitizedEnvironment(),
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitForHealth(foregroundPort);
  } finally {
    foreground.kill("SIGTERM");
    await waitForExit(foreground, 15_000);
  }

  const daemonData = path.join(temporaryRoot, "daemon");
  const daemonPort = await reservePort();
  const common = ["--data-dir", daemonData];
  await runNode(cliEntry, [...common, "start", "--port", String(daemonPort)], temporaryRoot);
  try {
    await waitForHealth(daemonPort);
    const status = await runNode(cliEntry, [...common, "status"], temporaryRoot);
    if (!status.stdout.includes("running")) {
      throw new Error("installed daemon status did not report running");
    }
    const first = lifecycleResult(status.stdout);
    const restarted = await runNode(cliEntry, [...common, "restart"], temporaryRoot);
    const second = lifecycleResult(restarted.stdout);
    if (second.state !== "running" || second.pid === first.pid || second.port !== daemonPort) {
      throw new Error("installed daemon restart did not replace the process on the configured port");
    }
    await waitForHealth(daemonPort);
  } finally {
    await runNode(cliEntry, [...common, "stop"], temporaryRoot);
  }
  const stopped = await runNode(cliEntry, [...common, "status"], temporaryRoot, [3]);
  if (!stopped.stdout.includes("stopped")) {
    throw new Error("installed daemon status did not report stopped");
  }
}

function lifecycleResult(output: string): { readonly state: string; readonly pid: number | null; readonly port: number | null } {
  const value = JSON.parse(output) as unknown;
  if (value === null || typeof value !== "object") {
    throw new Error("installed lifecycle command returned invalid JSON");
  }
  const result = value as Record<string, unknown>;
  if (typeof result.state !== "string"
    || (result.pid !== null && typeof result.pid !== "number")
    || (result.port !== null && typeof result.port !== "number")) {
    throw new Error("installed lifecycle command returned an invalid result");
  }
  return { state: result.state, pid: result.pid, port: result.port };
}

async function readPackEntry(output: string, packDirectory: string): Promise<NpmPackEntry> {
  const entries = JSON.parse(output) as NpmPackEntry[];
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error("npm pack produced no package entry");
  }
  const packed = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
  if (packed === undefined) {
    throw new Error("npm pack produced no tarball");
  }
  if (entry.filename !== packed) {
    throw new Error("npm pack filename does not match its JSON manifest");
  }
  return entry;
}

async function walkFiles(directory: string, root: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolute, root));
    } else if (entry.isFile()) {
      files.push(normalizePath(path.relative(root, absolute)));
    }
  }
  return files;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^package\//u, "");
}

function runNpm(args: readonly string[], cwd: string): Promise<CommandResult> {
  const npmCli = process.env.npm_execpath;
  return npmCli === undefined
    ? runCommand("npm", args, cwd)
    : runCommand(process.execPath, [npmCli, ...args], cwd);
}

function runNode(
  cliEntry: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return runCommand(process.execPath, [cliEntry, ...args], cwd, allowedExitCodes);
}

function runBin(binPath: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return process.platform === "win32"
    ? runCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", windowsCmdCommandLine(binPath, args)], cwd, [0], {
      windowsVerbatimArguments: true,
    })
    : runCommand(binPath, args, cwd);
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly windowsVerbatimArguments?: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === null || !allowedExitCodes.includes(code)) {
        const safeArgs = args.map((arg) => path.basename(arg)).join(" ");
        reject(new Error(
          `${path.basename(command)} ${safeArgs} failed with exit code ${String(code)}; stdout=${safeOutput(stdout)}; stderr=${safeOutput(stderr)}`,
        ));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function safeOutput(value: string): string {
  return value.trim().replaceAll(/[\r\n]+/gu, " ").slice(0, 1_024);
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.NODE_OPTIONS = `--experimental-strip-types --import=${pathToFileURL(path.resolve("scripts", "tooling", "ci_network_guard.ts")).href}`;
  for (const key of Object.keys(env)) {
    if (/^(?:GHC_GATEWAY_(?!CI_NETWORK_GUARD))/u.test(key)
      || /(?:token|secret|password|authorization|auth_token)/iu.test(key)) {
      delete env[key];
    }
  }
  env.npm_config_registry = "https://registry.npmjs.org/";
  return env;
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("unable to reserve loopback port")));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("installed gateway did not become healthy");
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("foreground gateway did not stop")), timeoutMs)),
  ]);
}

async function main(): Promise<void> {
  assertNode24();
  console.log(JSON.stringify(await runPackSmoke()));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
