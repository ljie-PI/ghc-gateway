import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import path from "node:path";
import type { ReplayExchangeRecord, ReplayScenario, ReplayScenarioManifest } from "./types.js";

export const MAX_REPLAY_STEPS = 64;
export const MAX_REPLAY_SCENARIOS = 128;
const MAX_EXCHANGES = 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const PROTOCOLS = new Set(["chat", "messages", "responses"]);
const ROUTES = new Set(["/chat/completions", "/responses", "/v1/messages", "/messages"]);

export function replayConfigurationError(): Error {
  return new Error("invalid replay configuration");
}

export function isReplayId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validateExchanges(value: unknown): asserts value is readonly ReplayExchangeRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXCHANGES) throw replayConfigurationError();
  const ids = new Set<string>();
  for (const exchange of value as unknown[]) {
    if (!isRecord(exchange) || !hasOnlyKeys(exchange, ["version", "caseId", "family", "sourceProtocol", "targetProtocol", "logicalModel", "upstreamModel", "capturedAt", "generatedAt", "request", "response", "downstreamExpectation"])
      || !isReplayId(exchange.caseId) || ids.has(exchange.caseId) || exchange.version !== 1 || exchange.family !== "replay"
      || !PROTOCOLS.has(String(exchange.sourceProtocol)) || !PROTOCOLS.has(String(exchange.targetProtocol))
      || !isReplayId(exchange.logicalModel) || !isReplayId(exchange.upstreamModel)
      || (exchange.capturedAt !== undefined && typeof exchange.capturedAt !== "string")
      || (exchange.generatedAt !== undefined && typeof exchange.generatedAt !== "string")
      || !isRecord(exchange.request) || !isRecord(exchange.response)) throw replayConfigurationError();
    ids.add(exchange.caseId);
    const { request, response } = exchange;
    if (!hasOnlyKeys(request, ["method", "path", "headers", "bodyJson"])
      || request.method !== "POST" || !ROUTES.has(String(request.path))
      || (request.headers !== undefined && !isStringRecord(request.headers))
      || !hasOnlyKeys(response, ["status", "headers", "bodyFile", "bodySha256", "stream"])
      || !Number.isInteger(response.status) || Number(response.status) < 200 || Number(response.status) > 599
      || !isRecord(response.headers) || typeof response.stream !== "boolean"
      || typeof response.bodyFile !== "string" || response.bodyFile.length === 0
      || typeof response.bodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(response.bodySha256)
      || !validExpectation(exchange.downstreamExpectation)) throw replayConfigurationError();
    for (const [name, header] of Object.entries(response.headers)) {
      if (typeof header !== "string" || /^(authorization|proxy-authorization|set-cookie|cookie|x-api-key)$/iu.test(name)) throw replayConfigurationError();
      try {
        validateHeaderName(name);
        validateHeaderValue(name, header);
      } catch {
        throw replayConfigurationError();
      }
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((member) => typeof member === "string");
}

function validExpectation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["goldenFile", "expectedOutput", "textSha256", "minTextChars", "minTextDeltas", "expectedToolCall", "expectedToolCalls", "toolCallsCount", "hasUsage", "usage"])) return false;
  if (value.goldenFile !== undefined && typeof value.goldenFile !== "string") return false;
  if (value.textSha256 !== undefined && (typeof value.textSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.textSha256))) return false;
  for (const key of ["minTextChars", "minTextDeltas", "toolCallsCount"] as const) {
    const member = value[key];
    if (member !== undefined && (!Number.isSafeInteger(member) || Number(member) < 0)) return false;
  }
  if (value.hasUsage !== undefined && typeof value.hasUsage !== "boolean") return false;
  if (value.expectedToolCall !== undefined && (!isRecord(value.expectedToolCall)
    || !hasOnlyKeys(value.expectedToolCall, ["name", "arguments"])
    || typeof value.expectedToolCall.name !== "string" || typeof value.expectedToolCall.arguments !== "string")) return false;
  if (value.expectedToolCalls !== undefined && (!Array.isArray(value.expectedToolCalls) || value.expectedToolCalls.length > MAX_REPLAY_STEPS
    || value.expectedToolCalls.some((call) => !isRecord(call) || !hasOnlyKeys(call, ["name", "arguments"]) || typeof call.name !== "string"))) return false;
  if (value.usage !== undefined) {
    if (!isRecord(value.usage) || !hasOnlyKeys(value.usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "visualTokens"])) return false;
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      if (!Number.isSafeInteger(value.usage[key]) || Number(value.usage[key]) < 0) return false;
    }
    if (value.usage.visualTokens !== "not_reported" && (!Number.isSafeInteger(value.usage.visualTokens) || Number(value.usage.visualTokens) < 0)) return false;
  }
  return true;
}

/** Parse untrusted manifest text without exposing JSON diagnostics. */
export function parseReplayManifestText(text: string): ReplayScenarioManifest {
  try {
    return parseReplayManifest(JSON.parse(text));
  } catch {
    throw replayConfigurationError();
  }
}

/** Validate manifest structure without assigning scenario ownership to it. */
export function parseReplayManifest(value: unknown): ReplayScenarioManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "exchanges"]) || value.schemaVersion !== 3) throw replayConfigurationError();
  validateExchanges(value.exchanges);
  return value as unknown as ReplayScenarioManifest;
}

/** Validate and snapshot the sole scenario catalogue, including total corpus ownership. */
export function validateReplayScenarios(exchanges: readonly ReplayExchangeRecord[], value: unknown): readonly ReplayScenario[] {
  validateExchanges(exchanges);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPLAY_SCENARIOS) throw replayConfigurationError();
  const exchangeMap = new Map(exchanges.map((exchange) => [exchange.caseId, exchange]));
  const scenarioIds = new Set<string>();
  const owned = new Set<string>();
  const scenarios: ReplayScenario[] = [];
  for (const candidate of value as unknown[]) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["scenarioId", "targetProtocol", "model", "steps"])
      || !isReplayId(candidate.scenarioId) || scenarioIds.has(candidate.scenarioId)
      || !PROTOCOLS.has(String(candidate.targetProtocol)) || !isReplayId(candidate.model)
      || !Array.isArray(candidate.steps) || candidate.steps.length === 0 || candidate.steps.length > MAX_REPLAY_STEPS) throw replayConfigurationError();
    scenarioIds.add(candidate.scenarioId);
    const steps = candidate.steps.map((step: unknown, index: number) => {
      if (!isRecord(step) || !hasOnlyKeys(step, ["ordinal", "caseId", "stream", "matchesRequest"])
        || step.ordinal !== index + 1 || !isReplayId(step.caseId) || typeof step.stream !== "boolean"
        || typeof step.matchesRequest !== "function" || step.matchesRequest.constructor.name === "AsyncFunction"
        || owned.has(step.caseId)) throw replayConfigurationError();
      const exchange = exchangeMap.get(step.caseId);
      if (exchange === undefined || exchange.targetProtocol !== candidate.targetProtocol
        || (exchange.logicalModel !== candidate.model && exchange.upstreamModel !== candidate.model)
        || exchange.response.stream !== step.stream) throw replayConfigurationError();
      owned.add(step.caseId);
      return { ordinal: step.ordinal, caseId: step.caseId, stream: step.stream, matchesRequest: step.matchesRequest as (body: unknown) => boolean };
    });
    scenarios.push({ scenarioId: candidate.scenarioId, targetProtocol: candidate.targetProtocol as ReplayScenario["targetProtocol"], model: candidate.model, steps });
  }
  if (owned.size !== exchanges.length) throw replayConfigurationError();
  return scenarios;
}

/** Public byte-integrity and safe-resolution seam; errors never include file paths or payloads. */
export async function validateReplayCorpus(corpusDir: string, exchanges: readonly ReplayExchangeRecord[]): Promise<void> {
  validateExchanges(exchanges);
  for (const exchange of exchanges) await readReplayResponse(corpusDir, exchange);
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function readReplayResponse(corpusDir: string, exchange: ReplayExchangeRecord): Promise<Buffer> {
  try {
    const bodyFile = exchange.response.bodyFile;
    if (path.posix.isAbsolute(bodyFile) || path.win32.isAbsolute(bodyFile) || bodyFile.includes(":")) throw replayConfigurationError();
    const root = await realpath(corpusDir);
    const lexical = path.resolve(root, bodyFile);
    if (!contained(root, lexical)) throw replayConfigurationError();
    const file = await realpath(lexical);
    if (!contained(root, file)) throw replayConfigurationError();
    const handle = await open(file, "r");
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RESPONSE_BYTES) throw replayConfigurationError();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw replayConfigurationError();
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, size);
    } finally {
      await handle.close();
    }
    if (createHash("sha256").update(bytes).digest("hex") !== exchange.response.bodySha256) throw replayConfigurationError();
    return bytes;
  } catch {
    throw new Error("invalid replay corpus");
  }
}
