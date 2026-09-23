import type { SqliteDatabase } from "../../persistence/sqlite.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { canonicalizeWireJson } from "../../serialization/canonical_json.js";
import type { InferenceProtocol } from "./types.js";

const PREFIX = "ghcg-rsn-v1";
const DEFAULT_TTL_MS = 7 * 86_400_000;
const DEFAULT_MAX_ITEM_BYTES = 4_194_304;
const DEFAULT_MAX_STORED_BYTES = 33_554_432;
const TOKEN_PATTERN = /^ghcg-rsn-v1:(chat_state|messages_block|responses_item):(chat|messages|responses):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const GATEWAY_CARRIER_PATTERN = /^ghcg-rsn-v[^:]*:/u;

export type ReasoningCarrierSourceKind = "chat_state" | "messages_block" | "responses_item";
export type ReasoningCarrierState = "partial" | "complete";

export function containsReasoningCarrier(value: WireJson): boolean {
  if (typeof value === "string") return isReasoningCarrier(value);
  if (isWireJsonArray(value)) return value.items.some(containsReasoningCarrier);
  if (isWireJsonObject(value)) return value.members.some((member) => containsReasoningCarrier(member.value));
  return false;
}

export interface ReasoningCarrierBinding {
  readonly accountId: string;
  readonly modelId: string;
  readonly upstreamOrigin: string;
  readonly sourceProtocol: InferenceProtocol;
  readonly wireProtocol: InferenceProtocol;
  readonly conversionVersion: string;
}

export interface ReasoningCarrierRecord {
  readonly token: string;
  readonly sourceKind: ReasoningCarrierSourceKind;
  readonly state: ReasoningCarrierState;
  readonly responseId?: string | undefined;
  readonly payload: WireJsonObject;
  readonly projection: WireJsonObject;
  readonly storedBytes: number;
}

export class ReasoningCarrierError extends Error {
  readonly code = "carrier_unavailable";

  constructor() {
    super("reasoning carrier is unavailable");
    this.name = "ReasoningCarrierError";
  }
}

export interface ReasoningCarrierStore {
  claim(token: string, accountId: string, wireProtocol: InferenceProtocol): ReasoningCarrierBinding;
  create(input: Readonly<{
    binding: ReasoningCarrierBinding;
    sourceKind: ReasoningCarrierSourceKind;
    state: ReasoningCarrierState;
    responseId?: string | undefined;
    payload: WireJsonObject;
    projection: WireJsonObject;
  }>): ReasoningCarrierRecord;
  resolve(token: string, binding: Readonly<ReasoningCarrierBinding>): ReasoningCarrierRecord;
  promote(tokens: readonly string[], binding: Readonly<ReasoningCarrierBinding>): void;
  discard(tokens: readonly string[], binding: Readonly<ReasoningCarrierBinding>): void;
  clearAccount(accountId: string): void;
  clearAll(): void;
  setTtlDays(ttlDays: number): void;
}

interface ReasoningCarrierStoreOptions {
  readonly nowMs?: () => number;
  readonly ttlMs?: number;
  readonly maxItemBytes?: number;
  readonly maxStoredBytes?: number;
  readonly createId?: () => string;
}

interface CarrierRow {
  readonly token: string;
  readonly account_id: string;
  readonly model_id: string;
  readonly upstream_origin: string;
  readonly source_protocol: InferenceProtocol;
  readonly wire_protocol: InferenceProtocol;
  readonly conversion_version: string;
  readonly source_kind: ReasoningCarrierSourceKind;
  readonly state: ReasoningCarrierState;
  readonly response_id: string | null;
  readonly payload_json: string;
  readonly projection_json: string;
  readonly stored_bytes: number;
  readonly expires_at_ms: number;
}

export class SqliteReasoningCarrierStore implements ReasoningCarrierStore {
  private readonly nowMs: () => number;
  private ttlMs: number;
  private readonly maxItemBytes: number;
  private readonly maxStoredBytes: number;
  private readonly createId: () => string;

  constructor(
    private readonly database: SqliteDatabase,
    options: ReasoningCarrierStoreOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
    this.maxStoredBytes = options.maxStoredBytes ?? DEFAULT_MAX_STORED_BYTES;
    this.createId = options.createId ?? crypto.randomUUID.bind(crypto);
    this.cleanup();
  }

  claim(token: string, accountId: string, wireProtocol: InferenceProtocol): ReasoningCarrierBinding {
    const parsed = parseToken(token);
    this.cleanup();
    const row = this.row(token);
    if (
      row === undefined
      || row.account_id !== accountId
      || row.wire_protocol !== wireProtocol
      || parsed.sourceKind !== row.source_kind
      || parsed.wireProtocol !== row.wire_protocol
      || row.state !== "complete"
      || row.expires_at_ms <= this.nowMs()
    ) unavailable();
    return {
      accountId: row.account_id,
      modelId: row.model_id,
      upstreamOrigin: row.upstream_origin,
      sourceProtocol: row.source_protocol,
      wireProtocol: row.wire_protocol,
      conversionVersion: row.conversion_version,
    };
  }

  create(input: Readonly<{
    binding: ReasoningCarrierBinding;
    sourceKind: ReasoningCarrierSourceKind;
    state: ReasoningCarrierState;
    responseId?: string | undefined;
    payload: WireJsonObject;
    projection: WireJsonObject;
  }>): ReasoningCarrierRecord {
    validateBinding(input.binding);
    validateSourceSlot(input.sourceKind, input.binding.sourceProtocol, input.binding.wireProtocol);
    const payloadBytes = canonicalizeWireJson(input.payload);
    const projectionBytes = canonicalizeWireJson(input.projection);
    const storedBytes = payloadBytes.byteLength + projectionBytes.byteLength;
    if (storedBytes <= 0 || storedBytes > this.maxItemBytes) unavailable();
    const carrierId = this.createId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(carrierId)) unavailable();
    const token = `${PREFIX}:${input.sourceKind}:${input.binding.wireProtocol}:${carrierId}`;
    const now = this.nowMs();
    const transaction = this.database.transaction(() => {
      this.expire(now);
      this.evictOverflow(storedBytes);
      const next = (this.database.prepare(
        "SELECT COALESCE(MAX(insertion_seq), 0) + 1 AS value FROM reasoning_carriers",
      ).get() as { value: number }).value;
      this.database.prepare(
        `INSERT INTO reasoning_carriers (
           carrier_id, token, account_id, model_id, upstream_origin, source_protocol,
           wire_protocol, conversion_version, source_kind, state, response_id,
           payload_json, projection_json, stored_bytes, insertion_seq, created_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        carrierId,
        token,
        input.binding.accountId,
        input.binding.modelId,
        input.binding.upstreamOrigin,
        input.binding.sourceProtocol,
        input.binding.wireProtocol,
        input.binding.conversionVersion,
        input.sourceKind,
        input.state,
        input.responseId,
        new TextDecoder().decode(payloadBytes),
        new TextDecoder().decode(projectionBytes),
        storedBytes,
        next,
        now,
        now + this.ttlMs,
      );
    });
    transaction();
    return this.resolveInternal(token, input.binding, input.state === "complete");
  }

  resolve(token: string, binding: Readonly<ReasoningCarrierBinding>): ReasoningCarrierRecord {
    return this.resolveInternal(token, binding, true);
  }

  promote(tokens: readonly string[], binding: Readonly<ReasoningCarrierBinding>): void {
    validateBinding(binding);
    const unique = [...new Set(tokens)];
    const transaction = this.database.transaction(() => {
      this.expire(this.nowMs());
      for (const token of unique) {
        const row = this.row(token);
        if (row === undefined || !sameBinding(row, binding)) unavailable();
        if (row.state === "complete") continue;
        this.database.prepare("UPDATE reasoning_carriers SET state = 'complete' WHERE token = ?").run(token);
      }
    });
    transaction();
  }

  discard(tokens: readonly string[], binding: Readonly<ReasoningCarrierBinding>): void {
    validateBinding(binding);
    const transaction = this.database.transaction(() => {
      for (const token of new Set(tokens)) {
        const row = this.row(token);
        if (row !== undefined && sameBinding(row, binding) && row.state === "partial") {
          this.database.prepare("DELETE FROM reasoning_carriers WHERE token = ?").run(token);
        }
      }
    });
    transaction();
  }

  clearAccount(accountId: string): void {
    if (accountId.length === 0) unavailable();
    this.database.prepare("DELETE FROM reasoning_carriers WHERE account_id = ?").run(accountId);
  }

  clearAll(): void {
    this.database.prepare("DELETE FROM reasoning_carriers").run();
  }

  setTtlDays(ttlDays: number): void {
    if (!Number.isSafeInteger(ttlDays) || ttlDays <= 0) unavailable();
    this.ttlMs = ttlDays * 86_400_000;
    const now = this.nowMs();
    this.database.prepare(
      "UPDATE reasoning_carriers SET expires_at_ms = created_at_ms + ?",
    ).run(this.ttlMs);
    this.expire(now);
  }

  private resolveInternal(
    token: string,
    binding: Readonly<ReasoningCarrierBinding>,
    requireComplete: boolean,
  ): ReasoningCarrierRecord {
    validateBinding(binding);
    const parsed = parseToken(token);
    this.cleanup();
    const row = this.row(token);
    if (
      row === undefined
      || !sameBinding(row, binding)
      || parsed.sourceKind !== row.source_kind
      || parsed.wireProtocol !== row.wire_protocol
      || (requireComplete && row.state !== "complete")
      || row.expires_at_ms <= this.nowMs()
    ) unavailable();
    const payload = parseObject(row.payload_json, row.stored_bytes);
    const projection = parseObject(row.projection_json, row.stored_bytes);
    const storedBytes = canonicalizeWireJson(payload).byteLength + canonicalizeWireJson(projection).byteLength;
    if (storedBytes !== row.stored_bytes || storedBytes > this.maxItemBytes) unavailable();
    validateSourceSlot(row.source_kind, row.source_protocol, row.wire_protocol);
    validatePayload(row.source_kind, payload);
    return {
      token: row.token,
      sourceKind: row.source_kind,
      state: row.state,
      ...(row.response_id === null ? {} : { responseId: row.response_id }),
      payload,
      projection,
      storedBytes: row.stored_bytes,
    };
  }

  private cleanup(): void {
    this.expire(this.nowMs());
  }

  private expire(now: number): void {
    this.database.prepare("DELETE FROM reasoning_carriers WHERE expires_at_ms <= ?").run(now);
  }

  private row(token: string): CarrierRow | undefined {
    return this.database.prepare(
      `SELECT token, account_id, model_id, upstream_origin, source_protocol, wire_protocol,
              conversion_version, source_kind, state, response_id, payload_json,
              projection_json, stored_bytes, expires_at_ms
       FROM reasoning_carriers WHERE token = ?`,
    ).get(token) as CarrierRow | undefined;
  }

  private storedBytes(): number {
    return (this.database.prepare(
      "SELECT COALESCE(SUM(stored_bytes), 0) AS value FROM reasoning_carriers",
    ).get() as { value: number }).value;
  }

  private evictOverflow(incomingBytes: number): void {
    let overflow = this.storedBytes() + incomingBytes - this.maxStoredBytes;
    if (overflow <= 0) return;
    const rows = this.database.prepare(
      "SELECT token, stored_bytes FROM reasoning_carriers ORDER BY insertion_seq ASC",
    ).all() as Array<{ token: string; stored_bytes: number }>;
    const remove = this.database.prepare("DELETE FROM reasoning_carriers WHERE token = ?");
    for (const row of rows) {
      if (overflow <= 0) break;
      remove.run(row.token);
      overflow -= row.stored_bytes;
    }
    if (overflow > 0) unavailable();
  }
}

export function isReasoningCarrier(value: string): boolean {
  return GATEWAY_CARRIER_PATTERN.test(value);
}

function parseToken(token: string): {
  readonly sourceKind: ReasoningCarrierSourceKind;
  readonly wireProtocol: InferenceProtocol;
} {
  const match = TOKEN_PATTERN.exec(token);
  if (match?.[1] === undefined || match[2] === undefined) unavailable();
  return {
    sourceKind: match[1] as ReasoningCarrierSourceKind,
    wireProtocol: match[2] as InferenceProtocol,
  };
}

function validateBinding(binding: Readonly<ReasoningCarrierBinding>): void {
  for (const value of [
    binding.accountId,
    binding.modelId,
    binding.upstreamOrigin,
    binding.conversionVersion,
  ]) {
    if (value.length === 0 || new TextEncoder().encode(value).byteLength > 2048) unavailable();
  }
  let origin: string;
  try {
    origin = new URL(binding.upstreamOrigin).origin;
  } catch {
    unavailable();
  }
  if (origin !== binding.upstreamOrigin) unavailable();
}

function validateSourceSlot(
  sourceKind: ReasoningCarrierSourceKind,
  sourceProtocol: InferenceProtocol,
  wireProtocol: InferenceProtocol,
): void {
  const valid = sourceKind === "responses_item"
    ? sourceProtocol === "responses" && (wireProtocol === "chat" || wireProtocol === "messages")
    : sourceKind === "messages_block"
      ? sourceProtocol === "messages" && wireProtocol === "responses"
      : sourceProtocol === "chat" && wireProtocol === "responses";
  if (!valid) unavailable();
}

function validatePayload(sourceKind: ReasoningCarrierSourceKind, payload: WireJsonObject): void {
  const kind = oneString(payload, "kind");
  if (kind !== sourceKind) unavailable();
  const state = memberValues(payload, "state");
  if (state.length !== 1 || !isWireJsonObject(state[0])) unavailable();
}

function sameBinding(row: CarrierRow, binding: Readonly<ReasoningCarrierBinding>): boolean {
  return row.account_id === binding.accountId
    && row.model_id === binding.modelId
    && row.upstream_origin === binding.upstreamOrigin
    && row.source_protocol === binding.sourceProtocol
    && row.wire_protocol === binding.wireProtocol
    && row.conversion_version === binding.conversionVersion;
}

function parseObject(value: string, maxBytes: number): WireJsonObject {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maxBytes) unavailable();
  const parsed = parseWireJson(bytes, { maxBytes: Math.max(1, maxBytes), maxDepth: 64 });
  if (!isWireJsonObject(parsed)) unavailable();
  return parsed;
}

function oneString(object: WireJsonObject, key: string): string | undefined {
  const values = memberValues(object, key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

function unavailable(): never {
  throw new ReasoningCarrierError();
}
