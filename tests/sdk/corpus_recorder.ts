import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { BoundCopilot } from "../../src/copilot/backend.js";
import { REPLAY_MODELS } from "../support/replay/catalog.js";
import { parseReplayManifest, parseReplayManifestText, validateReplayCorpus } from "../support/replay/corpus.js";
import {
  RecordingCopilotServer, RecordingFailure, type RecordedExchange, type RecordingRoute,
} from "../support/replay/recording_server.js";
import type { ReplayExchangeRecord, ReplayResponseSet, ReplayScenarioManifest } from "../support/replay/types.js";
import {
  createSdkClients, SDK_PROTOCOLS, sdkToolCalls, TEXT_TERMINAL, TOOL_TERMINAL,
  type SdkClients, type SdkProtocol, type SdkProtocolResult, type SdkToolCall,
} from "./client.js";
import { startSdkGateway } from "./replay_harness.js";
import {
  executeForecastTools, executeMixedImageTool, executeParallelWeather, executeReasoning, executeTextScenario,
  executeWeatherRoundtrip,
} from "./scenario_requests.js";
import {
  expectedForecastArguments, MIN_SESSION_TEXT_CHARACTERS, MIN_TEXT_SCENARIO_CHARACTERS, scheduledShotCount,
  SESSION_SHOT_COUNT, sessionTurnFacts, TEXT_SCENARIOS,
} from "./scenarios.js";
import { createSessionDriver, SESSION_TURNS } from "./session_inputs.js";

export const RECORDING_SCENARIOS = [
  "plain-text", "image", "weather-roundtrip", "parallel-tools", "mixed-image-tool", "reasoning-effort", "coherent-session",
] as const;
export type RecordingScenario = typeof RECORDING_SCENARIOS[number];

export const DEFAULT_CORPUS_DIRECTORY = fileURLToPath(new URL("./corpus", import.meta.url));
const IMAGE_SHA256 = "09cd595db8c42f401f34904574235856719e432d7466f4585f24bf00eeb0d7a2";
const MAX_TOTAL_TIMEOUT_MS = 14_400_000;
const ROUTES: Record<SdkProtocol, RecordingRoute> = { chat: "/chat/completions", responses: "/responses", messages: "/v1/messages" };
const SESSION_FILES = ["image-analysis", "parallel-tools", "tool-results-synthesis", "shot-list", "provenance-audit"] as const;

export type CaptureFailureCode = RecordingFailure["code"] | "capture_invalid_options" | "capture_cleanup_failed";

/** Content-free recorder failure: a code plus optional case, check and upstream status. */
export class CaptureError extends Error {
  constructor(
    readonly code: CaptureFailureCode,
    readonly detail: { readonly caseId?: string; readonly check?: string; readonly status?: number } = {},
  ) {
    super(code);
    this.name = "CaptureError";
  }
}

export interface CorpusRecordingOptions {
  readonly execute?: boolean;
  readonly model?: string;
  readonly scenario?: string;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CorpusRecordingDependencies {
  /** One bound account and Copilot binding are held for the whole run. */
  readonly bind: (signal: AbortSignal) => Promise<BoundCopilot>;
  readonly corpusDirectory?: string;
  readonly now?: () => Date;
}

interface RecordingPlan {
  readonly models: readonly string[];
  readonly scenarios: readonly RecordingScenario[];
  readonly requests: number;
  readonly totalTimeoutMs: number;
}

export interface PublishedExchange {
  readonly caseId: string;
  readonly bodyFile: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type CorpusRecordingResult = (RecordingPlan & { readonly executed: false }) | (RecordingPlan & {
  readonly executed: true;
  readonly exchanges: readonly PublishedExchange[];
  /** Assistant text digests to pin in SESSION_ASSISTANT_TEXT_SHA256; null means no text. */
  readonly sessionAssistantTextSha256: Partial<Record<SdkProtocol, readonly (string | null)[]>>;
});

interface CaseSpec {
  readonly caseId: string;
  readonly stream: boolean;
  readonly bodyFile: string;
  readonly explicit: boolean;
}

interface UnitContext {
  readonly clients: SdkClients;
  readonly imageBase64: string;
}

interface RecordingUnit {
  readonly protocol: SdkProtocol;
  readonly scenario: RecordingScenario;
  readonly cases: readonly CaseSpec[];
  /** Drive the native SDK request(s) and validate each parsed result; may return session digests. */
  readonly run: (context: UnitContext) => Promise<readonly (string | null)[] | undefined>;
}

/**
 * Record the shared SDK replay corpus from live Copilot through the production gateway.
 * Each protocol-native official SDK request reaches Copilot exactly as the gateway plans it; only
 * complete, validated selections are published, replacing their existing corpus cases.
 */
export async function recordReplayCorpus(
  options: CorpusRecordingOptions,
  deps: CorpusRecordingDependencies,
): Promise<CorpusRecordingResult> {
  const protocols = selectedProtocols(options.model ?? "all");
  const scenarios = options.scenario === undefined || options.scenario === "all" ? RECORDING_SCENARIOS
    : RECORDING_SCENARIOS.filter((scenario) => scenario === options.scenario);
  const totalTimeoutMs = options.totalTimeoutMs ?? 3_600_000;
  if (protocols.length === 0 || scenarios.length === 0 || (options.execute !== undefined && typeof options.execute !== "boolean")
    || !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > MAX_TOTAL_TIMEOUT_MS) {
    throw new CaptureError("capture_invalid_options");
  }
  const units = protocols.flatMap((protocol) => recordingUnits(protocol).filter((unit) => scenarios.includes(unit.scenario)));
  const plan: RecordingPlan = {
    models: protocols.map((protocol) => REPLAY_MODELS[protocol]),
    scenarios: [...scenarios],
    requests: units.reduce((count, unit) => count + unit.cases.length, 0),
    totalTimeoutMs,
  };
  if (options.execute !== true) return { executed: false, ...plan };

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new CaptureError("capture_timeout")), totalTimeoutMs);
  const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, options.signal]);
  const now = deps.now ?? (() => new Date());
  let server: RecordingCopilotServer | undefined;
  let gateway: Awaited<ReturnType<typeof startSdkGateway>> | undefined;
  let current: string | undefined;
  let result: CorpusRecordingResult | undefined;
  let failure: CaptureError | undefined;
  try {
    signal.throwIfAborted();
    const imageBase64 = await referenceImage();
    const bound = await raced(deps.bind(signal), signal);
    server = new RecordingCopilotServer({ bound, signal, now });
    await server.start();
    gateway = await startSdkGateway(server.origin, randomUUID);
    const context: UnitContext = { clients: createSdkClients(gateway), imageBase64 };
    const recorded: { spec: CaseSpec; unit: RecordingUnit; exchange: RecordedExchange }[] = [];
    const digests: Partial<Record<SdkProtocol, readonly (string | null)[]>> = {};
    for (const unit of units) {
      current = unit.cases[0]!.caseId;
      server.selectSteps(unit.cases.map((spec) => ({
        caseId: spec.caseId, path: ROUTES[unit.protocol], model: REPLAY_MODELS[unit.protocol], stream: spec.stream,
      })));
      try {
        const session = await raced(unit.run(context), signal);
        if (session !== undefined) digests[unit.protocol] = session;
        const exchanges = await server.finishSteps();
        exchanges.forEach((exchange, index) => recorded.push({ spec: unit.cases[index]!, unit, exchange }));
      } catch (error: unknown) {
        throw server.failure ?? error;
      } finally {
        server.abortSteps();
      }
    }
    current = undefined;
    signal.throwIfAborted();
    const exchanges = await publish(deps.corpusDirectory ?? DEFAULT_CORPUS_DIRECTORY, recorded);
    result = { executed: true, ...plan, exchanges, sessionAssistantTextSha256: digests };
  } catch (error: unknown) {
    failure = captureError(error, signal, options.signal, current);
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
  // Close both owners even when one fails, so no listener or upstream read outlives the run.
  const cleanup = await Promise.allSettled([gateway?.close(), server?.stop()]);
  if (failure !== undefined) throw failure;
  if (cleanup.some((outcome) => outcome.status === "rejected") || result === undefined) throw new CaptureError("capture_cleanup_failed");
  return result;
}

function selectedProtocols(model: string): readonly SdkProtocol[] {
  if (model === "all") return SDK_PROTOCOLS;
  return SDK_PROTOCOLS.filter((protocol) => REPLAY_MODELS[protocol] === model);
}

function recordingUnits(protocol: SdkProtocol): RecordingUnit[] {
  const model = REPLAY_MODELS[protocol];
  // Explicit response-set steps are addressed by turn; other cases by buffered or streamed mode.
  const spec = (name: string, stream: boolean, bodyFile: string, explicit = false): CaseSpec => ({
    caseId: `replay.${protocol}.${name}${explicit ? "" : stream ? ".stream" : ".nonstream"}`,
    stream, bodyFile: `${protocol}/${bodyFile}${stream ? ".stream.txt" : ".nonstream.json"}`, explicit,
  });
  const units: RecordingUnit[] = [];
  for (const scenario of TEXT_SCENARIOS) {
    for (const stream of [false, true]) {
      const mode = stream ? "stream" : "nonstream";
      const caseSpec = spec(scenario.id, stream, scenario.id);
      units.push({ protocol, scenario: scenario.id, cases: [caseSpec], run: async ({ clients, imageBase64 }) => {
        const value = await executeTextScenario(clients, protocol, { protocol, model }, scenario, mode,
          scenario.id === "image" ? imageBase64 : undefined);
        const check = checker(caseSpec.caseId);
        expectText(check, value, MIN_TEXT_SCENARIO_CHARACTERS, scenario.facts.map((fact) => fact.pattern));
        expectStream(check, value, stream);
        return undefined;
      } });
    }
  }
  const call = spec("tool-call", false, "tool-call");
  const result = spec("tool-result", false, "tool-result");
  units.push({ protocol, scenario: "weather-roundtrip", cases: [call, result], run: async ({ clients }) => {
    const { first, second } = await executeWeatherRoundtrip(clients, protocol, protocol, model);
    const calls = sdkToolCalls(first);
    const check = checker(call.caseId);
    check(calls.length === 1 && calls[0]!.name === "get_weather" && isDeepStrictEqual(calls[0]!.arguments, { city: "Tokyo" }), "weather_call");
    check(first.result.terminal === TOOL_TERMINAL[protocol], "terminal");
    expectText(checker(result.caseId), second, 1, []);
    return undefined;
  } });
  const parallel = spec("parallel-tools", false, "parallel-tools");
  units.push({ protocol, scenario: "parallel-tools", cases: [parallel], run: async ({ clients }) => {
    const value = await executeParallelWeather(clients, protocol, model);
    const calls = sdkToolCalls(value);
    const check = checker(parallel.caseId);
    check(calls.length === 2 && calls.every((entry) => entry.name === "get_weather") && calls[0]!.id !== calls[1]!.id, "parallel_calls");
    check(value.result.terminal === TOOL_TERMINAL[protocol], "terminal");
    return undefined;
  } });
  const forecast = spec("parallel-tools", true, "parallel-tools");
  units.push({ protocol, scenario: "parallel-tools", cases: [forecast], run: async ({ clients }) => {
    const value = await executeForecastTools(clients, protocol, model);
    const check = checker(forecast.caseId);
    expectForecastCalls(check, value);
    expectStream(check, value, true);
    return undefined;
  } });
  const mixed = spec("mixed-image-tool", false, "mixed-image-tool");
  units.push({ protocol, scenario: "mixed-image-tool", cases: [mixed], run: async ({ clients, imageBase64 }) => {
    const value = await executeMixedImageTool(clients, protocol, model, imageBase64);
    const calls = sdkToolCalls(value);
    const check = checker(mixed.caseId);
    check(calls.length === 1 && calls[0]!.name === "get_weather", "mixed_call");
    check(value.result.terminal === TOOL_TERMINAL[protocol], "terminal");
    return undefined;
  } });
  const reasoning = spec("reasoning-effort", false, "reasoning-effort");
  units.push({ protocol, scenario: "reasoning-effort", cases: [reasoning], run: async ({ clients }) => {
    const value = await executeReasoning(clients, protocol, model);
    const check = checker(reasoning.caseId);
    expectText(check, value, 1, []);
    check(hasNativeReasoning(value), "native_reasoning");
    return undefined;
  } });
  const turns = SESSION_TURNS.map((turn) => spec(`coherent-session.turn-${turn}`, turn !== 1,
    `session/turn-${turn}-${SESSION_FILES[turn - 1]}`, true));
  units.push({ protocol, scenario: "coherent-session", cases: turns, run: async ({ clients, imageBase64 }) => {
    const execute = createSessionDriver(clients, protocol, model, imageBase64);
    const digests: (string | null)[] = [];
    let calls: readonly SdkToolCall[] = [];
    for (const turn of SESSION_TURNS) {
      const value = await execute(turn, calls);
      const check = checker(turns[turn - 1]!.caseId);
      if (turn === 2) {
        expectForecastCalls(check, value);
        calls = sdkToolCalls(value);
      } else expectSessionText(check, value, turn);
      expectStream(check, value, turn !== 1);
      digests.push(textDigest(value));
    }
    return digests;
  } });
  return units;
}

type Check = (condition: boolean, check: string) => void;

function checker(caseId: string): Check {
  return (condition, check) => {
    if (!condition) throw new CaptureError("capture_invalid_response", { caseId, check });
  };
}

function expectText(check: Check, value: SdkProtocolResult, minCharacters: number, facts: readonly RegExp[]): void {
  check(sdkToolCalls(value).length === 0, "no_tool_calls");
  check(value.result.terminal === TEXT_TERMINAL[value.protocol], "terminal");
  check(value.result.text.length >= minCharacters, "text_length");
  for (const fact of facts) check(fact.test(value.result.text), `fact:${fact.source}`);
  check(textParts(value) <= 1, "single_text_part");
}

function expectSessionText(check: Check, value: SdkProtocolResult, turn: 1 | 3 | 4 | 5): void {
  expectText(check, value, MIN_SESSION_TEXT_CHARACTERS, sessionTurnFacts(turn));
  if (turn === 4) check(scheduledShotCount(value.result.text) === SESSION_SHOT_COUNT, "scheduled_shots");
}

function expectForecastCalls(check: Check, value: SdkProtocolResult): void {
  const calls = sdkToolCalls(value);
  check(calls.length === 2 && calls[0]!.id !== calls[1]!.id, "forecast_calls");
  for (const [index, city] of (["Tokyo", "Paris"] as const).entries()) {
    check(calls[index]?.name === "get_hourly_forecast" && isDeepStrictEqual(calls[index]?.arguments, expectedForecastArguments(city)), "forecast_arguments");
  }
  check(value.result.terminal === TOOL_TERMINAL[value.protocol], "terminal");
  check(textParts(value) <= 1, "single_text_part");
}

function expectStream(check: Check, value: SdkProtocolResult, stream: boolean): void {
  if (!stream) {
    check(value.result.stream === undefined, "buffered");
    return;
  }
  check(value.result.stream?.terminalCount === 1, "stream_terminal");
  check(value.result.stream?.text === value.result.text, "stream_text");
}

/** Session history hashes each assistant text part, so a text turn must carry at most one. */
function textParts(value: SdkProtocolResult): number {
  switch (value.protocol) {
  case "chat": return value.result.text.length === 0 ? 0 : 1;
  case "messages": return value.result.response.content.filter((block) => block.type === "text").length;
  case "responses": return value.result.response.output.flatMap((item) => item.type === "message"
    ? item.content.filter((part) => part.type === "output_text") : []).length;
  }
}

function hasNativeReasoning(value: SdkProtocolResult): boolean {
  switch (value.protocol) {
  case "chat": {
    const message = value.result.response.choices[0]?.message as unknown as { reasoning_text?: unknown } | undefined;
    return typeof message?.reasoning_text === "string" && message.reasoning_text.length > 0;
  }
  case "messages": return value.result.response.content.some((block) => block.type === "thinking" && block.thinking.length > 0);
  case "responses": return value.result.response.output.some((item) => item.type === "reasoning");
  }
}

function textDigest(value: SdkProtocolResult): string | null {
  return value.result.text.length === 0 ? null : createHash("sha256").update(value.result.text).digest("hex");
}

async function referenceImage(): Promise<string> {
  const image = await readFile(new URL("./images/vergil.jpg", import.meta.url));
  if (createHash("sha256").update(image).digest("hex") !== IMAGE_SHA256) throw new CaptureError("capture_invalid_options");
  return image.toString("base64");
}

/** Replace recorded cases in place; files are staged and renamed before the manifest is replaced. */
async function publish(
  directory: string,
  recorded: readonly { spec: CaseSpec; unit: RecordingUnit; exchange: RecordedExchange }[],
): Promise<PublishedExchange[]> {
  const manifestPath = path.join(directory, "manifest.json");
  const current = parseReplayManifestText(await readFile(manifestPath, "utf8"));
  const exchanges = [...current.exchanges];
  const published: PublishedExchange[] = [];
  const staged: { temporary: string; target: string }[] = [];
  try {
    for (const { spec, unit, exchange } of recorded) {
      const sha256 = createHash("sha256").update(exchange.body).digest("hex");
      const record: ReplayExchangeRecord = {
        version: 1, caseId: spec.caseId, family: "replay", sourceProtocol: unit.protocol, targetProtocol: unit.protocol,
        logicalModel: REPLAY_MODELS[unit.protocol], upstreamModel: REPLAY_MODELS[unit.protocol], capturedAt: exchange.capturedAt,
        ...(spec.explicit ? { selection: "explicit" as const } : {}),
        request: { method: "POST", path: exchange.path },
        response: { status: exchange.status, headers: { "content-type": exchange.contentType }, bodyFile: spec.bodyFile, bodySha256: sha256, stream: exchange.stream },
      };
      const index = exchanges.findIndex((candidate) => candidate.caseId === spec.caseId);
      if (index === -1) exchanges.push(record);
      else exchanges[index] = record;
      const target = path.join(directory, ...spec.bodyFile.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, exchange.body, { flag: "wx" });
      staged.push({ temporary, target });
      published.push({ caseId: spec.caseId, bodyFile: spec.bodyFile, bytes: exchange.body.byteLength, sha256 });
    }
    const manifest: ReplayScenarioManifest = parseReplayManifest({
      schemaVersion: 2, exchanges, responseSets: responseSets(current.responseSets, exchanges),
    });
    const manifestTemporary = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    staged.push({ temporary: manifestTemporary, target: manifestPath });
    // Publication point: body files first, then the manifest that references them. A failure
    // part-way leaves the old manifest, whose digest checks then reject the corpus until repaired.
    while (staged.length > 0) {
      const { temporary, target } = staged[0]!;
      await rename(temporary, target);
      staged.shift();
    }
  } finally {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
  }
  await validateReplayCorpus(directory, parseReplayManifestText(await readFile(manifestPath, "utf8")).exchanges);
  return published;
}

function responseSets(existing: readonly ReplayResponseSet[], exchanges: readonly ReplayExchangeRecord[]): ReplayResponseSet[] {
  const sets = existing.filter((set) => set.exchangeIds.every((id) => exchanges.some((exchange) => exchange.caseId === id)));
  for (const protocol of SDK_PROTOCOLS) {
    const exchangeIds = SESSION_TURNS.map((turn) => `replay.${protocol}.coherent-session.turn-${turn}`);
    if (exchangeIds.every((id) => exchanges.some((exchange) => exchange.caseId === id))
      && !sets.some((set) => set.targetProtocol === protocol)) {
      sets.push({ id: `cosplay-shoot-planning.${protocol}`, targetProtocol: protocol, exchangeIds });
    }
  }
  return sets;
}

async function raced<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let remove = (): void => undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, rejectAbort) => {
      const abort = () => rejectAbort(signal.reason instanceof CaptureError ? signal.reason : new CaptureError("capture_cancelled"));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      remove = () => signal.removeEventListener("abort", abort);
    })]);
  } finally { remove(); }
}

function captureError(error: unknown, signal: AbortSignal, callerSignal: AbortSignal | undefined, caseId: string | undefined): CaptureError {
  if (signal.aborted && signal.reason instanceof CaptureError && signal.reason.code === "capture_timeout") return new CaptureError("capture_timeout", caseIdDetail(caseId));
  if (callerSignal?.aborted === true) return new CaptureError("capture_cancelled", caseIdDetail(caseId));
  if (error instanceof CaptureError) return error;
  if (error instanceof RecordingFailure) {
    return new CaptureError(error.code, { ...caseIdDetail(error.caseId ?? caseId), ...(error.status === undefined ? {} : { status: error.status }) });
  }
  const status = (error as { status?: unknown } | null)?.status;
  return new CaptureError("capture_failed", {
    ...caseIdDetail(caseId), ...(Number.isInteger(status) ? { status: status as number } : {}),
  });
}

function caseIdDetail(caseId: string | undefined): { caseId?: string } {
  return caseId === undefined ? {} : { caseId };
}
