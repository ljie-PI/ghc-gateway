import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import type { BoundCopilot, CopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { SqliteModelCapabilityOverrides } from "../../src/copilot/capability_overrides.js";
import { RuntimeConfigStore } from "../../src/config/runtime_config.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import type { DaemonIdentity } from "../../src/daemon/identity_file.js";
import type { DaemonLogger } from "../../src/daemon/logger.js";
import type { Gateway } from "../../src/gateway/create_gateway.js";
import {
  composeProductionDaemonGateway,
  type ApplicationContext,
} from "../../src/main.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { MIGRATION_MANIFEST } from "../../src/persistence/generated_migrations.js";
import type {
  NativeResponsesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "../../src/copilot/upstream_types.js";
import {
  SqliteResponsesHistory,
  type ResponsesContinuationOwnership,
  type ResponsesHistoryRecord,
} from "../../src/protocols/responses/history.js";
import { TelemetryRecorder } from "../../src/telemetry/recorder.js";
import { nearestRankP95, THRESHOLDS } from "../../src/telemetry/performance.js";
import { assertNode24 } from "./node_version.js";
import type { PerformanceMeasurement, ProtocolPerformanceObserver } from "../../src/telemetry/runtime.js";
import "./ci_network_guard.js";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const IDLE_LIMIT_BYTES = 64 * MIB;
const STABLE_DELTA_LIMIT_BYTES = 16 * MIB;
const DEFAULT_REPEAT = 1;
const DEFAULT_MEMORY_STREAMS = 1_000;
const DEFAULT_BUFFERED_SAMPLES = 600;
const DEFAULT_EVENT_SAMPLES = 600;
const DEFAULT_CHECKPOINT_STREAMS = 30;
const MEMORY_WARMUP_STREAMS = 1_000;
const LATENCY_WARMUP_REQUESTS = 20;
const STABLE_SAMPLE_COUNT = 3;
const STABLE_SAMPLE_INTERVAL_MS = 50;
const encoder = new TextEncoder();

export type ResidentMetric =
  | "windows_private_bytes"
  | "linux_pss_bytes"
  | "linux_rss_bytes"
  | "macos_rss_bytes"
  | "node_rss_bytes";

export interface ResidentSample {
  readonly residentBytes: number;
  readonly metric: ResidentMetric;
}

export interface StableResidentSamples {
  readonly samples: readonly ResidentSample[];
  readonly medianBytes: number;
  readonly metric: ResidentMetric;
}

export interface LatencyMetricResult {
  readonly thresholdMs: number;
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly valuesMs: readonly number[];
  readonly p95Ms: number;
  readonly passed: boolean;
}

export interface BenchmarkEnvironment {
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cpus: number;
  readonly npmUserAgent: string | null;
}

export interface BenchmarkRunResult {
  readonly run: number;
  readonly environment: BenchmarkEnvironment;
  readonly browserIncluded: false;
  readonly offlineScripted: true;
  readonly listener: "loopback";
  readonly idle: {
    readonly limitBytes: number;
    readonly launchArgs: readonly string[];
    readonly resident: StableResidentSamples;
    readonly passed: boolean;
  };
  readonly adminPage: {
    readonly browserIncluded: false;
    readonly assetCount: number;
    readonly resident: StableResidentSamples;
    readonly deltaFromIdleBytes: number;
  };
  readonly streams: {
    readonly warmupCount: number;
    readonly launchArgs: readonly string[];
    readonly executionCount: number;
    readonly completedCount: number;
    readonly abortedCount: number;
    readonly warmedBaseline: StableResidentSamples;
    readonly stabilized: StableResidentSamples;
    readonly deltaBytes: number;
    readonly limitBytes: number;
    readonly passed: boolean;
  };
  readonly buffered: LatencyMetricResult;
  readonly streamEvent: LatencyMetricResult;
  readonly checkpoint: LatencyMetricResult;
  readonly eventLoop: LatencyMetricResult;
  readonly passed: boolean;
}

export interface BenchmarkArtifact {
  readonly kind: "full-gateway";
  readonly generatedAt: string;
  readonly repeat: number;
  readonly requiredRepeat: number;
  readonly runs: readonly BenchmarkRunResult[];
  readonly passed: boolean;
}

interface IdleWorkerResult {
  readonly idle: BenchmarkRunResult["idle"];
}

export interface BenchmarkWorkload {
  readonly memoryStreams: number;
  readonly bufferedSamples: number;
  readonly eventSamples: number;
  readonly checkpointStreams: number;
  readonly openAdmin: boolean;
}

const DEFAULT_WORKLOAD: BenchmarkWorkload = {
  memoryStreams: DEFAULT_MEMORY_STREAMS,
  bufferedSamples: DEFAULT_BUFFERED_SAMPLES,
  eventSamples: DEFAULT_EVENT_SAMPLES,
  checkpointStreams: DEFAULT_CHECKPOINT_STREAMS,
  openAdmin: true,
};

type BackendMode = "ordinary" | "event" | "checkpoint";

class BenchmarkCopilotBackend implements CopilotBackend {
  mode: BackendMode = "ordinary";
  eventCount = DEFAULT_EVENT_SAMPLES + LATENCY_WARMUP_REQUESTS;

  async bind(account: Readonly<{ accountId: string }>, _signal: AbortSignal): Promise<BoundCopilot> {
    return {
      accountId: account.accountId,
      target: { endpoint: "https://scripted.invalid", token: "not-a-credential" },
      completeChat: async (_request) => ({
        status: 200,
        headers: new Headers(),
        body: encoder.encode(BUFFERED_RESPONSE),
      }),
      openChatStream: async (_request) => this.chatStream(),
      completeResponses: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse> => ({
        status: 200,
        headers: new Headers(),
        body: encoder.encode("{\"id\":\"resp_bench\",\"output\":[]}"),
      }),
      openResponsesStream: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream> => ({
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: byteStream([encoder.encode(NATIVE_STREAM_EVENT)]),
        cancel: async () => undefined,
      }),
      completeMessages: async () => { throw new Error("messages must not be called"); },
      openMessagesStream: async () => { throw new Error("messages stream must not be called"); },
    };
  }

  async close(): Promise<void> {}

  forceClose(): void {}

  private chatStream(): UpstreamByteStream {
    const parts = this.mode === "event"
      ? eventStreamParts(this.eventCount)
      : this.mode === "checkpoint"
        ? CHECKPOINT_STREAM_PARTS
        : ORDINARY_STREAM_PARTS;
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      bytes: byteStream(parts),
      cancel: async () => undefined,
    };
  }
}

class MeasuredHistory extends SqliteResponsesHistory {
  readonly valuesMs: number[] = [];
  measuring = false;

  override async recordCheckpoint(
    record: Readonly<ResponsesHistoryRecord>,
    ownership: Readonly<ResponsesContinuationOwnership>,
    checkpointState: "partial" | "complete",
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    await super.recordCheckpoint(record, ownership, checkpointState, signal);
    if (this.measuring) {
      this.valuesMs.push(elapsedMs(started));
    }
  }
}

class EventLoopSampler {
  readonly valuesMs: number[] = [];
  private active = false;
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private scheduledAt = 0;

  start(): void {
    this.active = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.immediate !== undefined) {
      clearImmediate(this.immediate);
    }
    await delay(0);
  }

  private schedule(): void {
    this.scheduledAt = performance.now();
    this.immediate = setImmediate(() => this.tick());
  }

  private tick(): void {
    if (!this.active) {
      return;
    }
    if (this.valuesMs.length === 2_000) {
      this.valuesMs.shift();
    }
    this.valuesMs.push(elapsedMs(this.scheduledAt));
    this.schedule();
  }
}

interface BenchmarkRuntime {
  readonly gateway: Gateway;
  readonly backend: BenchmarkCopilotBackend;
  readonly history: MeasuredHistory;
  readonly performance: BenchmarkPerformanceObserver;
  close(): Promise<void>;
}

class BenchmarkPerformanceObserver implements ProtocolPerformanceObserver {
  readonly values: Record<PerformanceMeasurement, number[]> = {
    buffered: [],
    event: [],
    checkpoint: [],
  };

  measure<T>(measurement: PerformanceMeasurement, work: () => T): T {
    const startedAtMs = performance.now();
    try {
      return work();
    } finally {
      this.values[measurement].push(elapsedMs(startedAtMs));
    }
  }

  async measureAsync<T>(measurement: PerformanceMeasurement, work: () => Promise<T>): Promise<T> {
    const startedAtMs = performance.now();
    try {
      return await work();
    } finally {
      this.values[measurement].push(elapsedMs(startedAtMs));
    }
  }

  observe(measurement: PerformanceMeasurement, elapsedMs: number): void {
    this.values[measurement].push(elapsedMs);
  }

  reset(measurement: PerformanceMeasurement): void {
    this.values[measurement].length = 0;
  }
}

const BUFFERED_RESPONSE = JSON.stringify({
  id: "chatcmpl_bench",
  model: "chat",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const ORDINARY_STREAM_PARTS = [
  chatSse({ id: "chatcmpl_bench", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }),
  encoder.encode("data: [DONE]\n\n"),
];
const CHECKPOINT_STREAM_PARTS = [
  chatSse({
    id: "chatcmpl_checkpoint",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: "call_bench", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
      },
      finish_reason: "tool_calls",
    }],
  }),
  encoder.encode("data: [DONE]\n\n"),
];
const NATIVE_STREAM_EVENT = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_bench\",\"output\":[]}}\n\n";

export function evaluateBenchmarkRuns(runs: readonly BenchmarkRunResult[]): boolean {
  return runs.length > 0 && runs.every((run) => run.passed
    && run.idle.passed
    && run.streams.passed
    && run.buffered.passed
    && run.streamEvent.passed
    && run.checkpoint.passed
    && run.eventLoop.passed);
}

export async function runBenchmarkIteration(
  run: number,
  workload: Readonly<BenchmarkWorkload> = DEFAULT_WORKLOAD,
): Promise<BenchmarkRunResult> {
  const runtime = await createBenchmarkRuntime();
  const eventLoop = new EventLoopSampler();
  try {
    eventLoop.start();
    await delay(20);
    const idleResident = await stableResidentSamples();
    const adminPage = workload.openAdmin
      ? await loadAdminPage(runtime.gateway)
      : { assetCount: 0 };
    const adminResident = await stableResidentSamples();

    await warmRuntime(runtime);
    const warmedBaseline = await stabilizedResidentSamples();
    const completedCount = Math.ceil(workload.memoryStreams / 2);
    const abortedCount = workload.memoryStreams - completedCount;
    await runStreamExecutions(runtime, completedCount, false);
    await runStreamExecutions(runtime, abortedCount, true);
    const stabilized = await stabilizedResidentSamples();

    // Start the durable-commit seam from the stabilized heap so earlier latency phases do not own its GC samples.
    const checkpointValues = await measureCheckpoints(runtime, workload.checkpointStreams);
    const bufferedValues = await measureBufferedRequests(runtime, workload.bufferedSamples);
    const streamEventValues = await measureStreamEvents(runtime, workload.eventSamples);
    await ensureEventLoopSamples(eventLoop.valuesMs, 100);
    await eventLoop.stop();

    const streamDelta = stabilized.medianBytes - warmedBaseline.medianBytes;
    const idlePassed = idleResident.medianBytes <= IDLE_LIMIT_BYTES;
    const streamsPassed = streamDelta <= STABLE_DELTA_LIMIT_BYTES;
    const buffered = latencyResult(bufferedValues, THRESHOLDS.bufferedMs, LATENCY_WARMUP_REQUESTS);
    const streamEvent = latencyResult(streamEventValues, THRESHOLDS.eventMs, LATENCY_WARMUP_REQUESTS);
    const checkpoint = latencyResult(checkpointValues, THRESHOLDS.checkpointMs, 2);
    const eventLoopMetric = latencyResult(eventLoop.valuesMs, THRESHOLDS.eventLoopMs, 20);
    const passed = idlePassed && streamsPassed && buffered.passed && streamEvent.passed
      && checkpoint.passed && eventLoopMetric.passed;

    return {
      run,
      environment: benchmarkEnvironment(),
      browserIncluded: false,
      offlineScripted: true,
      listener: "loopback",
      idle: { limitBytes: IDLE_LIMIT_BYTES, launchArgs: process.execArgv, resident: idleResident, passed: idlePassed },
      adminPage: {
        browserIncluded: false,
        assetCount: adminPage.assetCount,
        resident: adminResident,
        deltaFromIdleBytes: adminResident.medianBytes - idleResident.medianBytes,
      },
      streams: {
        warmupCount: MEMORY_WARMUP_STREAMS,
        launchArgs: process.execArgv,
        executionCount: workload.memoryStreams,
        completedCount,
        abortedCount,
        warmedBaseline,
        stabilized,
        deltaBytes: streamDelta,
        limitBytes: STABLE_DELTA_LIMIT_BYTES,
        passed: streamsPassed,
      },
      buffered,
      streamEvent,
      checkpoint,
      eventLoop: eventLoopMetric,
      passed,
    };
  } finally {
    await eventLoop.stop();
    await runtime.close();
  }
}

export async function runFullBenchmark(repeat: number): Promise<BenchmarkArtifact> {
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  const workerPath = path.resolve("artifacts/bench/scripts/tooling/bench.js");
  await writeCompiledWorker(workerPath);
  const runs: BenchmarkRunResult[] = [];
  for (let run = 1; run <= repeat; run += 1) {
    const idle = await runCompiledIdleWorker();
    const workload = await runCompiledWorker(run);
    const merged = { ...workload, ...idle };
    runs.push({
      ...merged,
      passed: merged.idle.passed
        && merged.streams.passed
        && merged.buffered.passed
        && merged.streamEvent.passed
        && merged.checkpoint.passed
        && merged.eventLoop.passed,
    });
  }
  return {
    kind: "full-gateway",
    generatedAt: new Date().toISOString(),
    repeat,
    requiredRepeat: 3,
    runs,
    passed: evaluateBenchmarkRuns(runs),
  };
}

async function createBenchmarkRuntime(): Promise<BenchmarkRuntime> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ghc-gateway-bench-"));
  const port = await availablePort();
  const nowMs = (): number => 1_700_000_000_000;
  const database = openDatabase({
    path: path.join(dataDir, "state.db"),
    migrations: MIGRATION_MANIFEST,
    nowMs,
  });
  const credentials = new MemoryCredentialStore();
  const directory = new AccountDirectory(database, credentials, nowMs);
  await directory.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "scripted" },
  });
  const runtimeConfig = new RuntimeConfigStore(database, nowMs);
  runtimeConfig.seedIfEmpty({});
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return {
        data: [{
          id: "chat",
          name: "Scripted Chat",
          vendor: "scripted",
          model_picker_enabled: true,
          model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" },
        }],
      };
    },
  }, () => new Date(nowMs()));
  const backend = new BenchmarkCopilotBackend();
  const registry = new ModelCapabilityRegistry(
    catalog,
    new SqliteModelCapabilityOverrides(database, nowMs),
    { get: () => null },
  );
  const measuredHistory = new MeasuredHistory(database, { nowMs });
  const telemetry = new TelemetryRecorder(database, nowMs);
  const performanceObserver = new BenchmarkPerformanceObserver();
  let uuid = 0;
  let closed = false;
  const application: ApplicationContext = {
    database,
    credentials,
    directory,
    catalog,
    registry,
    copilot: backend,
    history: measuredHistory,
    telemetry,
    performanceObserver,
    nowMs,
    createUuid: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
    runtime: runtimeConfig,
    async close() {
      if (closed) return;
      closed = true;
      await telemetry.flush();
      await catalog.close();
      closeDatabase(database);
    },
    forceClose() {
      if (closed) return;
      closed = true;
      closeDatabase(database);
    },
  };
  const startup = parseStartupConfig(["--data-dir", dataDir, "--port", String(port)], {});
  const identity: DaemonIdentity = {
    version: 1,
    managed: false,
    pid: process.pid,
    processStartIdentity: "benchmark-process",
    instanceNonce: "benchmark-instance",
    controlToken: "benchmark-control",
    port,
    createdAt: "2023-11-14T22:13:20.000Z",
  };
  const logger: DaemonLogger = { write: () => undefined };
  let gateway: Awaited<ReturnType<typeof composeProductionDaemonGateway>> | undefined;
  try {
    gateway = await composeProductionDaemonGateway({
      startup,
      env: {},
      identity,
      logger,
      requestStop: () => undefined,
    }, { application, uptimeMs: () => 0 });
    await gateway.listen();
    return {
      gateway,
      backend,
      history: measuredHistory,
      performance: performanceObserver,
      async close() {
        await gateway?.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error: unknown) {
    await gateway?.close().catch(() => undefined);
    await application.close?.();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

async function warmRuntime(runtime: BenchmarkRuntime): Promise<void> {
  await measureBufferedRequests(runtime, LATENCY_WARMUP_REQUESTS, false);
  const complete = Math.ceil(MEMORY_WARMUP_STREAMS / 2);
  await runStreamExecutions(runtime, complete, false);
  await runStreamExecutions(runtime, MEMORY_WARMUP_STREAMS - complete, true);
  await measureCheckpoints(runtime, 2, false);
}

async function measureBufferedRequests(
  runtime: BenchmarkRuntime,
  count: number,
  warmup = true,
): Promise<number[]> {
  runtime.backend.mode = "ordinary";
  if (warmup) {
    await measureBufferedRequests(runtime, LATENCY_WARMUP_REQUESTS, false);
  }
  runtime.performance.reset("buffered");
  for (let index = 0; index < count; index += 1) {
    const response = await runtime.gateway.fetch(openAiRequest(false));
    await response.arrayBuffer();
    assertStatus(response, 200, "buffered request");
    await yieldToEventLoop(index);
  }
  const values = [...runtime.performance.values.buffered];
  if (values.length !== count) {
    throw new Error(`buffered benchmark expected ${count} samples, received ${values.length}`);
  }
  return values;
}

async function measureStreamEvents(runtime: BenchmarkRuntime, count: number): Promise<number[]> {
  runtime.backend.mode = "event";
  runtime.backend.eventCount = LATENCY_WARMUP_REQUESTS;
  let response = await runtime.gateway.fetch(openAiRequest(true));
  assertStatus(response, 200, "stream event warmup request");
  await response.arrayBuffer();
  response = await runtime.gateway.fetch(responsesConvertedEventRequest());
  assertStatus(response, 200, "converted stream event warmup request");
  await response.arrayBuffer();

  runtime.performance.reset("event");
  runtime.backend.eventCount = count;
  response = await runtime.gateway.fetch(openAiRequest(true));
  assertStatus(response, 200, "stream event request");
  await response.arrayBuffer();
  const nativeValues = runtime.performance.values.event.slice(0, count);
  if (nativeValues.length < count) {
    throw new Error(`native stream event benchmark expected ${count} samples, received ${nativeValues.length}`);
  }

  runtime.performance.reset("event");
  response = await runtime.gateway.fetch(responsesConvertedEventRequest());
  assertStatus(response, 200, "converted stream event request");
  await response.arrayBuffer();
  const convertedValues = runtime.performance.values.event.slice(0, count);
  if (convertedValues.length < count) {
    throw new Error(`converted stream event benchmark expected ${count} samples, received ${convertedValues.length}`);
  }
  return nativeValues.map((value, index) => Math.max(value, convertedValues[index] ?? 0));
}

async function measureCheckpoints(
  runtime: BenchmarkRuntime,
  streamCount: number,
  warmup = true,
): Promise<number[]> {
  runtime.backend.mode = "checkpoint";
  if (warmup) {
    await measureCheckpoints(runtime, 2, false);
  }
  runtime.history.valuesMs.length = 0;
  runtime.history.measuring = true;
  try {
    for (let index = 0; index < streamCount; index += 1) {
      const response = await runtime.gateway.fetch(responsesCheckpointRequest());
      await response.arrayBuffer();
      assertStatus(response, 200, "checkpoint stream");
      await yieldToEventLoop(index);
    }
  } finally {
    runtime.history.measuring = false;
  }
  if (runtime.history.valuesMs.length < streamCount) {
    throw new Error(`checkpoint benchmark expected at least ${streamCount} commits, received ${runtime.history.valuesMs.length}`);
  }
  return [...runtime.history.valuesMs];
}

async function runStreamExecutions(runtime: BenchmarkRuntime, count: number, abort: boolean): Promise<void> {
  runtime.backend.mode = "ordinary";
  for (let index = 0; index < count; index += 1) {
    const controller = new AbortController();
    const response = await runtime.gateway.fetch(openAiRequest(true, controller.signal));
    assertStatus(response, 200, abort ? "aborted stream" : "completed stream");
    if (abort) {
      const reader = requiredReader(response);
      await reader.read();
      controller.abort();
      await reader.cancel();
    } else {
      await response.arrayBuffer();
    }
    await yieldToEventLoop(index);
  }
}

async function loadAdminPage(gateway: Gateway): Promise<{ readonly assetCount: number }> {
  const index = await gateway.fetch(new Request("http://127.0.0.1/admin/"));
  assertStatus(index, 200, "Admin index");
  const html = await index.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value?.startsWith("/admin/assets/") === true);
  for (const asset of assets) {
    const response = await gateway.fetch(new Request(`http://127.0.0.1${asset}`));
    assertStatus(response, 200, `Admin asset ${asset}`);
    await response.arrayBuffer();
  }
  return { assetCount: assets.length };
}

function openAiRequest(stream: boolean, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "benchmark" }], stream }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function responsesCheckpointRequest(): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat",
      input: "benchmark",
      stream: true,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: false }],
    }),
  });
}

function responsesConvertedEventRequest(): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat",
      input: "benchmark",
      stream: true,
    }),
  });
}

function requiredReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("benchmark response has no body");
  }
  return reader;
}

function assertStatus(response: Response, expected: number, operation: string): void {
  if (response.status !== expected) {
    throw new Error(`${operation} returned HTTP ${response.status}`);
  }
}

function latencyResult(valuesMs: readonly number[], thresholdMs: number, warmupCount: number): LatencyMetricResult {
  const p95Ms = nearestRankP95(valuesMs);
  if (p95Ms === null) {
    throw new Error("latency benchmark produced no samples");
  }
  return {
    thresholdMs,
    warmupCount,
    sampleCount: valuesMs.length,
    valuesMs,
    p95Ms,
    passed: p95Ms <= thresholdMs,
  };
}

async function stableResidentSamples(pid = process.pid, collectGarbage = true): Promise<StableResidentSamples> {
  if (collectGarbage) {
    for (let index = 0; index < 3; index += 1) {
      globalThis.gc?.();
      await delay(10);
    }
  }
  await delay(STABLE_SAMPLE_INTERVAL_MS);
  const samples: ResidentSample[] = [];
  for (let index = 0; index < STABLE_SAMPLE_COUNT; index += 1) {
    samples.push(await measureResidentBytes(pid));
    if (index + 1 < STABLE_SAMPLE_COUNT) {
      await delay(STABLE_SAMPLE_INTERVAL_MS);
    }
  }
  const metrics = new Set(samples.map((sample) => sample.metric));
  if (metrics.size !== 1 || samples[0] === undefined) {
    throw new Error("resident memory metric changed during one benchmark run");
  }
  const values = samples.map((sample) => sample.residentBytes).sort((left, right) => left - right);
  return {
    samples,
    medianBytes: values[Math.floor(values.length / 2)] ?? 0,
    metric: samples[0].metric,
  };
}

async function stabilizedResidentSamples(pid = process.pid): Promise<StableResidentSamples> {
  let previous: StableResidentSamples | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await stableResidentSamples(pid, true);
    if (previous !== undefined && Math.abs(current.medianBytes - previous.medianBytes) <= MIB) {
      return current;
    }
    previous = current;
    await delay(250);
  }
  return previous ?? await stableResidentSamples(pid, true);
}

async function measureResidentBytes(pid: number): Promise<ResidentSample> {
  if (process.platform === "linux") {
    try {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const pssKb = parseKilobytes(rollup, "Pss:");
      if (pssKb !== undefined) {
        return { residentBytes: pssKb * 1024, metric: "linux_pss_bytes" };
      }
    } catch {
      // Linux containers may not expose smaps_rollup; RSS remains process-resident memory.
    }
    const statm = await readFile(`/proc/${pid}/statm`, "utf8");
    const pages = Number.parseInt(statm.trim().split(/\s+/u)[1] ?? "", 10);
    if (!Number.isInteger(pages)) {
      throw new Error("could not read Linux RSS");
    }
    return { residentBytes: pages * 4096, metric: "linux_rss_bytes" };
  }
  if (process.platform === "darwin") {
    const stdout = await execText("ps", ["-o", "rss=", "-p", String(pid)]);
    const rssKb = Number.parseInt(stdout, 10);
    if (!Number.isInteger(rssKb)) {
      throw new Error("could not read macOS RSS");
    }
    return { residentBytes: rssKb * 1024, metric: "macos_rss_bytes" };
  }
  if (process.platform === "win32") {
    try {
      const stdout = await execText("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid}).PrivateMemorySize64`,
      ]);
      const privateBytes = Number.parseInt(stdout, 10);
      if (Number.isInteger(privateBytes)) {
        return { residentBytes: privateBytes, metric: "windows_private_bytes" };
      }
    } catch {
      // Minimal Windows runners may omit PowerShell from PATH.
    }
  }
  return { residentBytes: process.memoryUsage().rss, metric: "node_rss_bytes" };
}

function parseKilobytes(text: string, prefix: string): number | undefined {
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
  const value = Number.parseInt(line?.match(/\d+/u)?.[0] ?? "", 10);
  return Number.isInteger(value) ? value : undefined;
}

async function execText(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], { encoding: "utf8" });
  return stdout.trim();
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a loopback benchmark port"));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function runCompiledWorker(run: number): Promise<BenchmarkRunResult> {
  const workerPath = path.resolve("artifacts/bench/scripts/tooling/bench.js");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--jitless",
    "--optimize-for-size",
    "--gc-global",
    "--expose-gc",
    workerPath,
    "__worker",
    String(run),
  ], {
    encoding: "utf8",
    maxBuffer: 32 * MIB,
    env: {
      ...process.env,
      GHC_GATEWAY_CI_NETWORK_GUARD: "1",
      NODE_ENV: "production",
      NODE_OPTIONS: "",
    },
  });
  if (stderr.trim().length > 0) {
    throw new Error(`benchmark worker wrote stderr: ${stderr.trim()}`);
  }
  return JSON.parse(stdout) as BenchmarkRunResult;
}

async function runCompiledIdleWorker(): Promise<IdleWorkerResult> {
  const workerPath = path.resolve("artifacts/bench/scripts/tooling/bench_idle.js");
  await writeFile(workerPath, idleWorkerSource(), "utf8");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ghc-gateway-idle-"));
  const port = await availablePort();
  return await new Promise<IdleWorkerResult>((resolve, reject) => {
    const launchArgs = idleLaunchArgs(workerPath);
    const child = spawn(process.execPath, [...launchArgs, dataDir, String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GHC_GATEWAY_CI_NETWORK_GUARD: "1",
        NODE_ENV: "production",
        NODE_OPTIONS: "",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, result?: IdleWorkerResult): void => {
      if (settled) return;
      settled = true;
      child.stdin.write("STOP\n");
      child.stdin.end();
      void rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
      if (error !== null) reject(error);
      else if (result === undefined) reject(new Error("idle benchmark produced no result"));
      else resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!settled && stdout.includes("READY") && child.pid !== undefined) {
        stableResidentSamples(child.pid, false).then((resident) => finish(null, {
          idle: {
            limitBytes: IDLE_LIMIT_BYTES,
            launchArgs: launchArgs.slice(0, -1),
            resident,
            passed: resident.medianBytes <= IDLE_LIMIT_BYTES,
          },
        }), (error: unknown) => finish(asError(error)));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`idle benchmark worker failed with ${code}: ${stderr}`));
    });
  });
}

async function writeCompiledWorker(workerPath: string): Promise<void> {
  const ts = await import("typescript");
  const productionEntry = fileURLToPath(new URL("../../dist/src/main.js", import.meta.url));
  try {
    await readFile(productionEntry);
  } catch {
    throw new Error("compiled production gateway is missing; run npm run build before bench");
  }
  const compilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    verbatimModuleSyntax: true,
  } as const;
  const sourcePath = fileURLToPath(import.meta.url);
  const output = ts.transpileModule(await readFile(sourcePath, "utf8"), {
    compilerOptions,
    fileName: sourcePath,
  });
  await mkdir(path.dirname(workerPath), { recursive: true });
  await writeFile(workerPath, output.outputText.replaceAll("../../src/", "../../../../dist/src/"), "utf8");
  for (const name of ["ci_network_guard", "node_version"]) {
    const helperSource = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
    const helperOutput = ts.transpileModule(await readFile(helperSource, "utf8"), {
      compilerOptions,
      fileName: helperSource,
    });
    await writeFile(path.join(path.dirname(workerPath), `${name}.js`), helperOutput.outputText, "utf8");
  }
}

function benchmarkEnvironment(): BenchmarkEnvironment {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    npmUserAgent: process.env.npm_config_user_agent ?? null,
  };
}

function idleLaunchArgs(workerPath: string): string[] {
  if (process.platform === "win32") {
    return [
      "--jitless",
      "--optimize-for-size",
      "--gc-global",
      "--expose-gc",
      workerPath,
    ];
  }
  return ["--jitless", "--optimize-for-size", "--gc-global", "--expose-gc", workerPath];
}

function idleWorkerSource(): string {
  return [
    "import \"./ci_network_guard.js\";",
    "import { parseStartupConfig } from \"../../../../dist/src/config/startup_config.js\";",
    "import { composeProductionDaemonGateway, createProductionApplicationContext } from \"../../../../dist/src/main.js\";",
    "const dataDir = process.argv[2];",
    "const port = Number.parseInt(process.argv[3] ?? \"\", 10);",
    "if (dataDir === undefined || !Number.isInteger(port)) throw new Error(\"invalid idle worker arguments\");",
    "const startup = parseStartupConfig([\"--data-dir\", dataDir, \"--port\", String(port)], {});",
    "const application = await createProductionApplicationContext(startup, {});",
    "const gateway = await composeProductionDaemonGateway({",
    "  startup, env: {},",
    "  identity: { version: 1, managed: false, pid: process.pid, processStartIdentity: \"benchmark\", instanceNonce: \"benchmark\", controlToken: \"benchmark\", port, createdAt: \"2023-11-14T22:13:20.000Z\" },",
    "  logger: { write() {} }, requestStop() {},",
    "}, { application, uptimeMs: () => 0 });",
    "await gateway.listen();",
    "for (let index = 0; index < 3; index += 1) { globalThis.gc?.(); await new Promise((resolve) => setTimeout(resolve, 10)); }",
    "console.log(\"READY\");",
    "process.stdin.resume();",
    "process.stdin.once(\"data\", async () => { await gateway.close(); process.exit(0); });",
  ].join("\n");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function eventStreamParts(count: number): readonly Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(chatSse({
      id: "chatcmpl_events",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
    }));
  }
  parts.push(chatSse({
    id: "chatcmpl_events",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }));
  parts.push(encoder.encode("data: [DONE]\n\n"));
  return parts;
}

function chatSse(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

async function* byteStream(parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield part;
  }
}

async function ensureEventLoopSamples(values: readonly number[], minimum: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (values.length < minimum && performance.now() < deadline) {
    await delay(1);
  }
  if (values.length < minimum) {
    throw new Error(`event-loop benchmark expected ${minimum} samples, received ${values.length}`);
  }
}

async function yieldToEventLoop(index: number): Promise<void> {
  void index;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function elapsedMs(started: number): number {
  return performance.now() - started;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: readonly string[]): { readonly command: "full" | "worker"; readonly repeat: number } {
  const [rawCommand = "full", ...rest] = argv;
  if (rawCommand === "__worker") {
    const run = Number.parseInt(rest[0] ?? "", 10);
    if (!Number.isInteger(run) || run < 1) {
      throw new Error("benchmark worker run must be a positive integer");
    }
    return { command: "worker", repeat: run };
  }
  if (rawCommand !== "full" && rawCommand !== "baseline") {
    throw new Error("usage: bench [full] [--repeat <positive integer>]");
  }
  const repeatIndex = rest.indexOf("--repeat");
  const repeat = repeatIndex === -1
    ? DEFAULT_REPEAT
    : Number.parseInt(rest[repeatIndex + 1] ?? "", 10);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  return { command: "full", repeat };
}

async function main(): Promise<void> {
  assertNode24();
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "worker") {
    const result = await runBenchmarkIteration(parsed.repeat);
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const artifact = await runFullBenchmark(parsed.repeat);
  const artifactDir = path.resolve("artifacts", "bench");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "full-gateway.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    artifactPath,
    repeat: artifact.repeat,
    passed: artifact.passed,
    runs: artifact.runs.map((run) => ({
      run: run.run,
      idleMiB: run.idle.resident.medianBytes / MIB,
      streamDeltaMiB: run.streams.deltaBytes / MIB,
      bufferedP95Ms: run.buffered.p95Ms,
      streamEventP95Ms: run.streamEvent.p95Ms,
      checkpointP95Ms: run.checkpoint.p95Ms,
      eventLoopP95Ms: run.eventLoop.p95Ms,
      passed: run.passed,
    })),
  }));
  if (!artifact.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
