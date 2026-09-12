import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtureDirectory = path.resolve("tests/fixtures/stream-execution-loader");
const privateMarker = "private-request-and-loader-content";
let outputRoot = "";

interface FixtureResult {
  readonly activity: {
    readonly activeRequests: number;
    readonly activeStreams: number;
    readonly queuedRequests: number;
  };
  readonly counts: {
    readonly cancel: number;
    readonly iteratorCreated: number;
    readonly iteratorNext: number;
    readonly iteratorReturn: number;
    readonly terminal: number;
  };
  readonly detachedRejections: number;
  readonly handlePresent: boolean;
  readonly loaderInterceptions: number;
  readonly nextBody: string;
  readonly nextStatus: number;
  readonly ownerObservedAlreadyAborted: boolean;
  readonly responseBody: string;
  readonly responseStatus: number;
  readonly settledAfterAbort: boolean;
  readonly settledBeforeRelease: boolean;
}

async function runFixture(mode: "delay" | "reject"): Promise<FixtureResult> {
  const registerUrl = pathToFileURL(path.join(fixtureDirectory, "register.mjs")).href;
  const runnerPath = path.join(fixtureDirectory, "runner.mjs");
  const result = await execFileAsync(process.execPath, [
    "--import",
    registerUrl,
    runnerPath,
    mode,
    outputRoot,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GHCG_STREAM_OWNER_GATE_PATH: path.join(outputRoot, `owner-loader-${mode}`),
      GHCG_STREAM_OWNER_LOADER_MODE: mode,
      GHCG_STREAM_OWNER_OUTPUT_ROOT: outputRoot,
      GHCG_STREAM_OWNER_PRIVATE_MARKER: privateMarker,
      NODE_OPTIONS: "",
    },
    timeout: 30_000,
    windowsHide: true,
  });

  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(privateMarker);
  return JSON.parse(result.stdout) as FixtureResult;
}

describe("Stream Execution dynamic import lifecycle", () => {
  beforeAll(async () => {
    await mkdir(path.resolve("artifacts"), { recursive: true });
    outputRoot = await mkdtemp(path.resolve("artifacts/stream-owner-loader-"));
    await execFileAsync(process.execPath, [
      path.resolve("node_modules/typescript/bin/tsc"),
      "-p",
      path.resolve("tsconfig.json"),
      "--outDir",
      outputRoot,
      "--declaration",
      "false",
      "--sourceMap",
      "false",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
  }, 30_000);

  afterAll(async () => {
    if (outputRoot !== "") {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("bounds cleanup and sanitizes output when the real owner import rejects", async () => {
    const result = await runFixture("reject");

    expect(result).toMatchObject({
      activity: { activeRequests: 0, activeStreams: 0, queuedRequests: 0 },
      counts: {
        cancel: 1,
        iteratorCreated: 0,
        iteratorNext: 0,
        iteratorReturn: 0,
        terminal: 0,
      },
      detachedRejections: 0,
      handlePresent: false,
      loaderInterceptions: 1,
      nextBody: "next",
      nextStatus: 200,
      ownerObservedAlreadyAborted: false,
      responseBody: "{\"kind\":\"internal\"}",
      responseStatus: 500,
    });
  });

  it("keeps the facade awaited until a timed-out request enters the real owner", async () => {
    const result = await runFixture("delay");

    expect(result).toEqual({
      activity: { activeRequests: 0, activeStreams: 0, queuedRequests: 0 },
      counts: {
        cancel: 1,
        iteratorCreated: 1,
        iteratorNext: 0,
        iteratorReturn: 1,
        terminal: 1,
      },
      detachedRejections: 0,
      handlePresent: false,
      loaderInterceptions: 1,
      nextBody: "next",
      nextStatus: 200,
      ownerObservedAlreadyAborted: true,
      responseBody: "{\"kind\":\"upstream_timeout\"}",
      responseStatus: 504,
      settledAfterAbort: false,
      settledBeforeRelease: false,
    });
  });
});
