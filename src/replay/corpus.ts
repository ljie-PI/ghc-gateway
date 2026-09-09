import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import path from "node:path";
import type { ReplayExchangeRecord, ReplayScenarioManifest } from "./types.js";

export const MAX_REPLAY_STEPS = 64;
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

function validateExchanges(value: unknown): asserts value is readonly ReplayExchangeRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXCHANGES) throw replayConfigurationError();
  const ids = new Set<string>();
  for (const exchange of value as unknown[]) {
    if (!isRecord(exchange) || !isReplayId(exchange.caseId) || ids.has(exchange.caseId)
      || exchange.version !== 1 || exchange.family !== "replay"
      || !PROTOCOLS.has(String(exchange.sourceProtocol)) || !PROTOCOLS.has(String(exchange.targetProtocol))
      || !isReplayId(exchange.logicalModel) || !isReplayId(exchange.upstreamModel)
      || (exchange.selection !== undefined && exchange.selection !== "explicit")
      || "session" in exchange || !isRecord(exchange.request) || !isRecord(exchange.response)) throw replayConfigurationError();
    ids.add(exchange.caseId);
    const { request, response } = exchange;
    if (request.method !== "POST" || !ROUTES.has(String(request.path))
      || "canonicalBodySha256" in request || "bodySha256" in request
      || !Number.isInteger(response.status) || Number(response.status) < 200 || Number(response.status) > 599
      || !isRecord(response.headers) || typeof response.stream !== "boolean"
      || typeof response.bodyFile !== "string" || response.bodyFile.length === 0
      || typeof response.bodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(response.bodySha256)) throw replayConfigurationError();
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

/** Validate structure without assigning capture authenticity to historical labels. */
export function parseReplayManifest(value: unknown): ReplayScenarioManifest {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.responseSets)
    || value.responseSets.length > MAX_EXCHANGES) throw replayConfigurationError();
  validateExchanges(value.exchanges);
  const exchanges = new Map(value.exchanges.map((exchange) => [exchange.caseId, exchange]));
  const setIds = new Set<string>();
  const owned = new Set<string>();
  for (const set of value.responseSets as unknown[]) {
    if (!isRecord(set) || !isReplayId(set.id) || setIds.has(set.id) || !PROTOCOLS.has(String(set.targetProtocol))
      || !Array.isArray(set.exchangeIds) || set.exchangeIds.length === 0 || set.exchangeIds.length > MAX_REPLAY_STEPS) throw replayConfigurationError();
    setIds.add(set.id);
    for (const id of set.exchangeIds as unknown[]) {
      if (typeof id !== "string" || owned.has(id)) throw replayConfigurationError();
      const exchange = exchanges.get(id);
      if (exchange === undefined || exchange.selection !== "explicit" || exchange.targetProtocol !== set.targetProtocol) throw replayConfigurationError();
      owned.add(id);
    }
  }
  for (const exchange of value.exchanges) {
    if (exchange.selection === "explicit" && !owned.has(exchange.caseId)) throw replayConfigurationError();
  }
  return value as unknown as ReplayScenarioManifest;
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
