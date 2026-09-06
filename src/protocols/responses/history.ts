import type { SqliteDatabase } from "../../persistence/sqlite.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import {
  RESPONSE_CALL_KINDS,
  RESPONSE_CALL_OUTPUT_KINDS,
  withResponsesRequestInput,
  type ResponsesCallKind,
  type ResponsesRequest,
} from "./dto.js";

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_RESPONSES = 512;
const DEFAULT_MAX_RECEIPTS = 2_048;
const DAY_MS = 86_400_000;
export const RESPONSES_CHAT_CONVERSION_VERSION = "responses-chat-v1";
export const RESPONSES_MESSAGES_CONVERSION_VERSION = "responses-messages-v1";

const MINIMAL_CALL_FIELDS = new Set([
  "type",
  "id",
  "call_id",
  "name",
  "namespace",
  "arguments",
  "input",
  "status",
  "execution",
  "reasoning_content",
  "reasoning",
]);
const FILL_FIELDS = new Set([
  "name",
  "namespace",
  "arguments",
  "input",
  "status",
  "execution",
  "reasoning_content",
  "reasoning",
]);

export type ResponsesContinuationOwner = "native" | "converted";
export type ResponsesContinuationProtocol = "responses" | "chat" | "messages";
export type ResponsesCheckpointState = "route_only" | "partial" | "complete" | "expired";

export interface ResponsesContinuationOwnership {
  readonly accountId: string;
  readonly modelId: string;
  readonly upstreamOrigin: string;
  readonly owner: ResponsesContinuationOwner;
  readonly upstreamProtocol: ResponsesContinuationProtocol;
  readonly conversionVersion: string | null;
}

export interface ResponsesRouteReceipt extends ResponsesContinuationOwnership {
  readonly responseId: string;
  readonly checkpointState: ResponsesCheckpointState;
  readonly expiresAt: number;
}

export type ResponsesContinuationResolution =
  | { readonly kind: "none" }
  | { readonly kind: "owned"; readonly receipt: ResponsesRouteReceipt }
  | { readonly kind: "expired" }
  | { readonly kind: "legacy_unowned" }
  | { readonly kind: "untracked_blocked" }
  | { readonly kind: "owned_by_another_account" };

export interface ResponsesHistory {
  resolve(
    responseId: string,
    accountId: string,
    signal: AbortSignal,
  ): Promise<ResponsesContinuationResolution>;
  enrich(
    request: Readonly<ResponsesRequest>,
    receipt: Readonly<ResponsesRouteReceipt>,
    signal: AbortSignal,
  ): Promise<ResponsesRequest>;
  recordReceipt(
    receipt: Readonly<ResponsesReceiptRecord>,
    signal: AbortSignal,
  ): Promise<void>;
  recordCheckpoint(
    record: Readonly<ResponsesHistoryRecord>,
    ownership: Readonly<ResponsesContinuationOwnership>,
    checkpointState: "partial" | "complete",
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ResponsesHistoryAdmin {
  inspect(): ResponsesHistoryInspection;
  clear(expectedRevision: number): ResponsesHistoryInspection;
  clearAccount(accountId: string): void;
}

export interface ResponsesHistoryRecord {
  readonly responseId: string;
  readonly output: readonly WireJson[] | WireJson;
}

export interface ResponsesReceiptRecord extends ResponsesContinuationOwnership {
  readonly responseId: string;
  readonly checkpointState: "route_only" | "partial" | "complete";
}

export interface ResponsesHistoryInspection {
  readonly revision: number;
  readonly count: number;
  readonly receiptCount: number;
  readonly legacyCount: number;
  readonly untrackedContinuationBlocked: boolean;
  readonly oldestAt: number | null;
  readonly newestAt: number | null;
  readonly ttlDays: number;
  readonly maxResponses: number;
  readonly maxReceipts: number;
}

export class ResponsesHistoryAdminError extends Error {
  readonly code = "revision_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ResponsesHistoryAdminError";
  }
}

export class ResponsesContinuationError extends Error {
  constructor(
    readonly code: "ownership_conflict" | "checkpoint_unavailable" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "ResponsesContinuationError";
  }
}

interface ResponsesHistoryOptions {
  readonly nowMs?: () => number;
  readonly ttlDays?: number;
  readonly maxResponses?: number;
  readonly maxReceipts?: number;
  readonly accountIsActive?: (accountId: string) => boolean;
}

interface StoredCall {
  readonly responseId: string;
  readonly ordinal: number;
  readonly callId: string;
  readonly kind: ResponsesCallKind;
  readonly item: WireJsonObject;
  readonly itemJson: string;
}

interface StoredResponse {
  readonly responseId: string;
  readonly calls: readonly StoredCall[];
  readonly byCallId: ReadonlyMap<string, StoredCall>;
}

interface ReceiptRow {
  readonly account_id: string;
  readonly response_id: string;
  readonly model_id: string;
  readonly upstream_origin: string;
  readonly owner: ResponsesContinuationOwner;
  readonly upstream_protocol: ResponsesContinuationProtocol;
  readonly conversion_version: string | null;
  readonly checkpoint_state: ResponsesCheckpointState;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
}

interface CallRow {
  readonly response_id: string;
  readonly ordinal: number;
  readonly call_id: string;
  readonly kind: ResponsesCallKind;
  readonly item_json: string;
}

interface StateRow {
  readonly revision: number;
  readonly next_receipt_seq: number;
  readonly next_checkpoint_seq: number;
}

export class SqliteResponsesHistory implements ResponsesHistory, ResponsesHistoryAdmin {
  private readonly nowMs: () => number;
  private ttlMs: number;
  private readonly maxResponses: number;
  private readonly maxReceipts: number;
  private readonly accountIsActive: ((accountId: string) => boolean) | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    options: ResponsesHistoryOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = (options.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS;
    this.maxResponses = options.maxResponses ?? DEFAULT_MAX_RESPONSES;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.accountIsActive = options.accountIsActive;
    this.mutateIfChanged(() => false);
  }

  async resolve(
    responseId: string,
    accountId: string,
    signal: AbortSignal,
  ): Promise<ResponsesContinuationResolution> {
    throwIfAborted(signal);
    const id = requireNonEmpty(responseId, "responseId");
    const account = requireNonEmpty(accountId, "accountId");
    this.mutateIfChanged(() => false);
    throwIfAborted(signal);

    const own = this.readReceipt(account, id);
    if (own !== undefined) {
      return own.checkpoint_state === "expired"
        ? { kind: "expired" }
        : { kind: "owned", receipt: toReceipt(own) };
    }
    const foreign = this.database.prepare(
      "SELECT 1 FROM response_route_receipts WHERE response_id = ? LIMIT 1",
    ).get(id);
    if (foreign !== undefined) {
      return { kind: "owned_by_another_account" };
    }
    const legacy = this.database.prepare(
      "SELECT 1 FROM responses WHERE response_id = ? LIMIT 1",
    ).get(id);
    if (legacy !== undefined) {
      return { kind: "legacy_unowned" };
    }
    const uncertain = this.database.prepare(
      "SELECT 1 FROM response_receipt_uncertainty WHERE singleton_id = 1",
    ).get();
    return uncertain === undefined ? { kind: "none" } : { kind: "untracked_blocked" };
  }

  async enrich(
    request: Readonly<ResponsesRequest>,
    receipt: Readonly<ResponsesRouteReceipt>,
    signal: AbortSignal,
  ): Promise<ResponsesRequest> {
    throwIfAborted(signal);
    this.mutateIfChanged(() => false);
    throwIfAborted(signal);
    if (receipt.owner !== "converted" || receipt.checkpointState === "expired") {
      throw new ResponsesContinuationError("checkpoint_unavailable", "continuation has no local checkpoint");
    }

    const originalItems = inputItems(request.input);
    if (originalItems === undefined) {
      throw new ResponsesContinuationError("checkpoint_unavailable", "continuation input is not replayable");
    }
    const scoped = this.readResponse(receipt.accountId, receipt.responseId);
    const originalCallsById = new Map<string, WireJsonObject>();
    for (const item of originalItems) {
      if (isCallItem(item)) {
        const callId = callIdFromItem(item);
        if (callId !== undefined && !originalCallsById.has(callId)) {
          originalCallsById.set(callId, item);
        }
      }
    }

    let changed = false;
    let sawOutput = false;
    let scopedGroupInserted = false;
    const emittedCallIds = new Set<string>();
    const enrichedItems: WireJson[] = [];

    for (const item of originalItems) {
      if (isCallItem(item)) {
        const callId = callIdFromItem(item);
        if (callId !== undefined && emittedCallIds.has(callId)) {
          changed = true;
          continue;
        }
        const cached = callId === undefined ? undefined : scoped?.byCallId.get(callId);
        const filled = cached === undefined ? item : fillEmptyFields(item, cached.item);
        changed ||= filled !== item;
        enrichedItems.push(filled);
        if (callId !== undefined) {
          emittedCallIds.add(callId);
        }
        continue;
      }

      if (isOutputItem(item)) {
        sawOutput = true;
        const outputCallId = callIdFromItem(item);
        if (outputCallId === undefined) {
          throw new ResponsesContinuationError("checkpoint_unavailable", "tool output has no call id");
        }
        if (!emittedCallIds.has(outputCallId)) {
          const scopedCall = scoped?.byCallId.get(outputCallId);
          if (scopedCall === undefined) {
            throw new ResponsesContinuationError("checkpoint_unavailable", "tool checkpoint is unavailable");
          }
          if (!scopedGroupInserted) {
            for (const call of scoped?.calls ?? []) {
              if (!emittedCallIds.has(call.callId)) {
                enrichedItems.push(restoreCall(call, originalCallsById.get(call.callId)));
                emittedCallIds.add(call.callId);
                changed = true;
              }
            }
            scopedGroupInserted = true;
          }
        }
      }

      enrichedItems.push(item);
    }

    if (!sawOutput) {
      throw new ResponsesContinuationError(
        "checkpoint_unavailable",
        "minimal Responses history cannot replay arbitrary conversation content",
      );
    }
    return changed
      ? withResponsesRequestInput(request as ResponsesRequest, { kind: "array", items: enrichedItems })
      : request as ResponsesRequest;
  }

  async recordReceipt(
    receipt: Readonly<ResponsesReceiptRecord>,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.mutateIfChanged(() => this.upsertReceipt(receipt));
    throwIfAborted(signal);
  }

  async recordCheckpoint(
    record: Readonly<ResponsesHistoryRecord>,
    ownership: Readonly<ResponsesContinuationOwnership>,
    checkpointState: "partial" | "complete",
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const responseId = requireNonEmpty(record.responseId.trim(), "responseId");
    const calls = extractRecordableCalls(responseId, record.output);
    validateOwnership(ownership);
    if (this.accountIsActive !== undefined && !this.accountIsActive(ownership.accountId)) {
      throw new ResponsesContinuationError("checkpoint_unavailable", "bound account is no longer active");
    }
    const existing = this.readReceipt(ownership.accountId, responseId);
    if (
      existing !== undefined
      && existing.checkpoint_state !== "expired"
      && existing.created_at_ms + this.ttlMs > this.nowMs()
      && sameOwnership(existing, ownership)
      && checkpointRank(checkpointState) <= checkpointRank(existing.checkpoint_state)
      && (calls.length === 0 || callsEqual(this.readCalls(ownership.accountId, responseId), calls))
    ) {
      return;
    }
    this.mutateIfChanged(() => {
      const receiptChanged = this.upsertReceipt({ ...ownership, responseId, checkpointState });
      const checkpointChanged = calls.length > 0
        ? this.upsertCheckpoint(ownership.accountId, responseId, calls)
        : false;
      return receiptChanged || checkpointChanged;
    });
    throwIfAborted(signal);
  }

  setTtlDays(ttlDays: number): void {
    this.ttlMs = ttlDays * DAY_MS;
  }

  inspect(): ResponsesHistoryInspection {
    const state = this.readState();
    const counts = this.database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM responses) AS legacy_count,
         (SELECT COUNT(*) FROM response_scoped_checkpoints) AS scoped_count,
         (SELECT COUNT(*) FROM response_route_receipts) AS receipt_count,
         MIN(created_at_ms) AS oldest_at_ms,
         MAX(created_at_ms) AS newest_at_ms
       FROM (
         SELECT created_at_ms FROM responses
         UNION ALL
         SELECT created_at_ms FROM response_scoped_checkpoints
       )`,
    ).get() as {
      legacy_count: number;
      scoped_count: number;
      receipt_count: number;
      oldest_at_ms: number | null;
      newest_at_ms: number | null;
    };

    return {
      revision: state.revision,
      count: counts.legacy_count + counts.scoped_count,
      receiptCount: counts.receipt_count,
      legacyCount: counts.legacy_count,
      untrackedContinuationBlocked: this.uncertaintyCount() > 0,
      oldestAt: counts.oldest_at_ms,
      newestAt: counts.newest_at_ms,
      ttlDays: this.ttlMs / DAY_MS,
      maxResponses: this.maxResponses,
      maxReceipts: this.maxReceipts,
    };
  }

  clear(expectedRevision: number): ResponsesHistoryInspection {
    const clear = this.database.transaction(() => {
      const state = this.readState();
      if (state.revision !== expectedRevision) {
        throw new ResponsesHistoryAdminError("Responses history revision conflict");
      }
      const changed = this.responseCount() > 0
        || this.receiptCount() > 0
        || this.legacyCount() > 0
        || this.uncertaintyCount() > 0;
      if (!changed) {
        return;
      }
      this.database.prepare("DELETE FROM response_route_receipts").run();
      this.database.prepare("DELETE FROM response_calls").run();
      this.database.prepare("DELETE FROM responses").run();
      this.database.prepare("DELETE FROM response_receipt_uncertainty").run();
      this.bumpRevision(this.nowMs());
    });
    clear();
    return this.inspect();
  }

  clearAccount(accountId: string): void {
    const account = requireNonEmpty(accountId, "accountId");
    this.mutateIfChanged(() => {
      const result = this.database.prepare(
        "DELETE FROM response_route_receipts WHERE account_id = ?",
      ).run(account);
      if (result.changes > 0) {
        this.markUncertain(this.nowMs());
      }
      return result.changes > 0;
    });
  }

  private mutateIfChanged(work: () => boolean): void {
    const nowMs = this.nowMs();
    const transaction = this.database.transaction(() => {
      const receiptsExpired = this.expireReceipts(nowMs);
      const legacyExpired = this.expireLegacy(nowMs);
      const changed = work();
      const checkpointsEvicted = receiptsExpired || legacyExpired || changed
        ? this.evictCheckpointOverflow()
        : false;
      const receiptsEvicted = receiptsExpired || legacyExpired || changed
        ? this.evictReceiptOverflow()
        : false;
      if (receiptsExpired || legacyExpired || changed || checkpointsEvicted || receiptsEvicted) {
        this.bumpRevision(nowMs);
      }
    });
    transaction();
  }

  private expireReceipts(nowMs: number): boolean {
    const expired = this.database.prepare(
      `SELECT account_id, response_id
       FROM response_route_receipts
       WHERE checkpoint_state <> 'expired' AND created_at_ms + ? <= ?`,
    ).all(this.ttlMs, nowMs) as Array<{ account_id: string; response_id: string }>;
    if (expired.length === 0) {
      return false;
    }
    const deleteCheckpoint = this.database.prepare(
      "DELETE FROM response_scoped_checkpoints WHERE account_id = ? AND response_id = ?",
    );
    const markExpired = this.database.prepare(
      `UPDATE response_route_receipts
       SET checkpoint_state = 'expired'
       WHERE account_id = ? AND response_id = ?`,
    );
    for (const row of expired) {
      deleteCheckpoint.run(row.account_id, row.response_id);
      markExpired.run(row.account_id, row.response_id);
    }
    return true;
  }

  private expireLegacy(nowMs: number): boolean {
    const expired = this.database.prepare(
      "SELECT response_id FROM responses WHERE created_at_ms + ? <= ?",
    ).all(this.ttlMs, nowMs) as Array<{ response_id: string }>;
    if (expired.length === 0) {
      return false;
    }
    this.markUncertain(nowMs);
    const removeCalls = this.database.prepare("DELETE FROM response_calls WHERE response_id = ?");
    const removeResponse = this.database.prepare("DELETE FROM responses WHERE response_id = ?");
    for (const row of expired) {
      removeCalls.run(row.response_id);
      removeResponse.run(row.response_id);
    }
    return true;
  }

  private evictCheckpointOverflow(): boolean {
    let overflow = this.responseCount() + this.legacyCount() - this.maxResponses;
    if (overflow <= 0) {
      return false;
    }
    const legacy = this.database.prepare(
      "SELECT response_id FROM responses ORDER BY insertion_seq ASC LIMIT ?",
    ).all(overflow) as Array<{ response_id: string }>;
    if (legacy.length > 0) {
      this.markUncertain(this.nowMs());
      const removeCalls = this.database.prepare("DELETE FROM response_calls WHERE response_id = ?");
      const removeResponse = this.database.prepare("DELETE FROM responses WHERE response_id = ?");
      for (const row of legacy) {
        removeCalls.run(row.response_id);
        removeResponse.run(row.response_id);
      }
      overflow -= legacy.length;
    }
    if (overflow <= 0) {
      return legacy.length > 0;
    }
    const rows = this.database.prepare(
      `SELECT account_id, response_id
       FROM response_scoped_checkpoints
       ORDER BY insertion_seq ASC LIMIT ?`,
    ).all(overflow) as Array<{ account_id: string; response_id: string }>;
    const remove = this.database.prepare(
      "DELETE FROM response_scoped_checkpoints WHERE account_id = ? AND response_id = ?",
    );
    const reset = this.database.prepare(
      `UPDATE response_route_receipts
       SET checkpoint_state = 'route_only'
       WHERE account_id = ? AND response_id = ? AND checkpoint_state <> 'expired'`,
    );
    for (const row of rows) {
      remove.run(row.account_id, row.response_id);
      reset.run(row.account_id, row.response_id);
    }
    return legacy.length > 0 || rows.length > 0;
  }

  private evictReceiptOverflow(): boolean {
    const overflow = this.receiptCount() - this.maxReceipts;
    if (overflow <= 0) {
      return false;
    }
    const rows = this.database.prepare(
      `SELECT receipt.account_id, receipt.response_id
       FROM response_route_receipts AS receipt
       LEFT JOIN response_scoped_checkpoints AS checkpoint
         ON checkpoint.account_id = receipt.account_id
        AND checkpoint.response_id = receipt.response_id
       WHERE checkpoint.response_id IS NULL
       ORDER BY CASE WHEN receipt.checkpoint_state = 'expired' THEN 0 ELSE 1 END,
                receipt.insertion_seq ASC
       LIMIT ?`,
    ).all(overflow) as Array<{ account_id: string; response_id: string }>;
    const remove = this.database.prepare(
      "DELETE FROM response_route_receipts WHERE account_id = ? AND response_id = ?",
    );
    for (const row of rows) {
      this.markUncertain(this.nowMs());
      remove.run(row.account_id, row.response_id);
    }
    return rows.length > 0;
  }

  private upsertReceipt(receipt: Readonly<ResponsesReceiptRecord>): boolean {
    validateOwnership(receipt);
    if (this.accountIsActive !== undefined && !this.accountIsActive(receipt.accountId)) {
      throw new ResponsesContinuationError("checkpoint_unavailable", "bound account is no longer active");
    }
    const responseId = requireNonEmpty(receipt.responseId.trim(), "responseId");
    const existing = this.readReceipt(receipt.accountId, responseId);
    if (existing !== undefined) {
      if (!sameOwnership(existing, receipt)) {
        throw new ResponsesContinuationError("ownership_conflict", "response id ownership conflict");
      }
      if (existing.checkpoint_state === "expired") {
        throw new ResponsesContinuationError("expired", "response continuation expired");
      }
      if (checkpointRank(receipt.checkpointState) <= checkpointRank(existing.checkpoint_state)) {
        return false;
      }
      this.database.prepare(
        `UPDATE response_route_receipts
         SET checkpoint_state = ?
         WHERE account_id = ? AND response_id = ?`,
      ).run(receipt.checkpointState, receipt.accountId, responseId);
      return true;
    }

    const state = this.readState();
    const nowMs = this.nowMs();
    this.database.prepare(
      `INSERT INTO response_route_receipts (
         account_id, response_id, model_id, upstream_origin, owner, upstream_protocol,
         conversion_version, checkpoint_state, insertion_seq, created_at_ms, expires_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.accountId,
      responseId,
      receipt.modelId,
      receipt.upstreamOrigin,
      receipt.owner,
      receipt.upstreamProtocol,
      receipt.conversionVersion,
      receipt.checkpointState,
      state.next_receipt_seq,
      nowMs,
      nowMs + this.ttlMs,
    );
    this.database.prepare(
      "UPDATE responses_continuation_state SET next_receipt_seq = ? WHERE singleton_id = 1",
    ).run(state.next_receipt_seq + 1);
    return true;
  }

  private upsertCheckpoint(
    accountId: string,
    responseId: string,
    calls: readonly StoredCall[],
  ): boolean {
    const existingCalls = this.readCalls(accountId, responseId);
    if (existingCalls.length > 0 && callsEqual(existingCalls, calls)) {
      return false;
    }
    const existing = this.database.prepare(
      `SELECT 1 FROM response_scoped_checkpoints
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId);
    if (existing === undefined) {
      const state = this.readState();
      const nowMs = this.nowMs();
      this.database.prepare(
        `INSERT INTO response_scoped_checkpoints
         (account_id, response_id, insertion_seq, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(accountId, responseId, state.next_checkpoint_seq, nowMs, nowMs + this.ttlMs);
      this.database.prepare(
        "UPDATE responses_continuation_state SET next_checkpoint_seq = ? WHERE singleton_id = 1",
      ).run(state.next_checkpoint_seq + 1);
    } else {
      this.database.prepare(
        "DELETE FROM response_scoped_calls WHERE account_id = ? AND response_id = ?",
      ).run(accountId, responseId);
    }
    const insertCall = this.database.prepare(
      `INSERT INTO response_scoped_calls
       (account_id, response_id, ordinal, call_id, kind, item_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const call of calls) {
      insertCall.run(accountId, responseId, call.ordinal, call.callId, call.kind, call.itemJson);
    }
    return true;
  }

  private readReceipt(accountId: string, responseId: string): ReceiptRow | undefined {
    return this.database.prepare(
      `SELECT account_id, response_id, model_id, upstream_origin, owner, upstream_protocol,
              conversion_version, checkpoint_state, created_at_ms, expires_at_ms
       FROM response_route_receipts
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId) as ReceiptRow | undefined;
  }

  private readResponse(accountId: string, responseId: string): StoredResponse | undefined {
    const row = this.database.prepare(
      `SELECT response_id FROM response_scoped_checkpoints
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId) as { response_id: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const calls = this.readCalls(accountId, responseId);
    return responseFromCalls(responseId, calls);
  }

  private readCalls(accountId: string, responseId: string): readonly StoredCall[] {
    const rows = this.database.prepare(
      `SELECT response_id, ordinal, call_id, kind, item_json
       FROM response_scoped_calls
       WHERE account_id = ? AND response_id = ?
       ORDER BY ordinal ASC`,
    ).all(accountId, responseId) as CallRow[];
    return rows.map((row) => {
      const itemBytes = new TextEncoder().encode(row.item_json);
      const item = parseWireJson(itemBytes, {
        maxBytes: Math.max(itemBytes.byteLength, 1),
        maxDepth: 64,
      });
      if (!isWireJsonObject(item)) {
        throw new Error("Responses history stored call item must be an object");
      }
      return {
        responseId: row.response_id,
        ordinal: row.ordinal,
        callId: row.call_id,
        kind: row.kind,
        itemJson: row.item_json,
        item,
      };
    });
  }

  private responseCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM response_scoped_checkpoints",
    ).get() as { count: number }).count;
  }

  private receiptCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM response_route_receipts",
    ).get() as { count: number }).count;
  }

  private legacyCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM responses",
    ).get() as { count: number }).count;
  }

  private uncertaintyCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM response_receipt_uncertainty",
    ).get() as { count: number }).count;
  }

  private markUncertain(nowMs: number): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO response_receipt_uncertainty
       (singleton_id, uncertain_since_ms) VALUES (1, ?)`,
    ).run(nowMs);
  }

  private readState(): StateRow {
    return this.database.prepare(
      `SELECT revision, next_receipt_seq, next_checkpoint_seq
       FROM responses_continuation_state WHERE singleton_id = 1`,
    ).get() as StateRow;
  }

  private bumpRevision(nowMs: number): void {
    this.database.prepare(
      `UPDATE responses_continuation_state
       SET revision = revision + 1, updated_at_ms = ?
       WHERE singleton_id = 1`,
    ).run(nowMs);
  }
}

function extractRecordableCalls(responseId: string, output: readonly WireJson[] | WireJson): readonly StoredCall[] {
  const calls: StoredCall[] = [];
  for (const item of outputItems(output)) {
    if (!isCallItem(item)) {
      continue;
    }
    const callId = callIdFromItem(item);
    if (callId === undefined) {
      continue;
    }
    const itemObject = minimalCallItem(item);
    calls.push({
      responseId,
      ordinal: calls.length,
      callId,
      kind: memberValues(item, "type")[0] as ResponsesCallKind,
      item: itemObject,
      itemJson: new TextDecoder().decode(serializeWireJson(itemObject)),
    });
  }
  return calls;
}

function outputItems(output: readonly WireJson[] | WireJson): readonly WireJson[] {
  if (Array.isArray(output)) {
    return output;
  }
  if (isWireJsonArray(output)) {
    return output.items;
  }
  if (isWireJsonObject(output)) {
    const nested = memberValues(output, "output")[0];
    return isWireJsonArray(nested) ? nested.items : [output];
  }
  return [];
}

function inputItems(input: WireJson | undefined): readonly WireJson[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (isWireJsonArray(input)) {
    return input.items;
  }
  return isWireJsonObject(input) ? [input] : undefined;
}

function isCallItem(item: WireJson): item is WireJsonObject {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const type = memberValues(item, "type")[0];
  return typeof type === "string" && (RESPONSE_CALL_KINDS as readonly string[]).includes(type);
}

function isOutputItem(item: WireJson): item is WireJsonObject {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const type = memberValues(item, "type")[0];
  return typeof type === "string" && (RESPONSE_CALL_OUTPUT_KINDS as readonly string[]).includes(type);
}

function callIdFromItem(item: WireJsonObject): string | undefined {
  return trimmedString(memberValues(item, "call_id")[0])
    ?? trimmedString(memberValues(item, "id")[0]);
}

function trimmedString(value: WireJson | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function minimalCallItem(item: WireJsonObject): WireJsonObject {
  return {
    kind: "object",
    members: item.members.filter((member) => MINIMAL_CALL_FIELDS.has(member.key)),
  };
}

function fillEmptyFields(item: WireJsonObject, cached: WireJsonObject): WireJsonObject {
  const existingKeys = new Set(item.members.map((member) => member.key));
  const additions = cached.members.filter((member) => {
    if (!FILL_FIELDS.has(member.key)) {
      return false;
    }
    const current = memberValues(item, member.key)[0];
    return current === undefined || current === null || current === "";
  });
  const members = item.members.map((member) => {
    if (!FILL_FIELDS.has(member.key)) {
      return member;
    }
    const replacement = member.value === null || member.value === ""
      ? memberValues(cached, member.key)[0]
      : undefined;
    return replacement === undefined ? member : { key: member.key, value: replacement };
  });
  for (const addition of additions) {
    if (!existingKeys.has(addition.key)) {
      members.push(addition);
    }
  }
  return membersEqual(item.members, members) ? item : { kind: "object", members };
}

function restoreCall(cached: StoredCall, original: WireJsonObject | undefined): WireJsonObject {
  return original === undefined ? cached.item : fillEmptyFields(original, cached.item);
}

function responseFromCalls(responseId: string, calls: readonly StoredCall[]): StoredResponse {
  const byCallId = new Map<string, StoredCall>();
  for (const call of calls) {
    if (!byCallId.has(call.callId)) {
      byCallId.set(call.callId, call);
    }
  }
  return { responseId, calls, byCallId };
}

function callsEqual(left: readonly StoredCall[], right: readonly StoredCall[]): boolean {
  return left.length === right.length && left.every((call, index) => {
    const other = right[index];
    return other !== undefined
      && call.callId === other.callId
      && call.kind === other.kind
      && call.itemJson === other.itemJson;
  });
}

function membersEqual(
  left: WireJsonObject["members"],
  right: WireJsonObject["members"],
): boolean {
  return left.length === right.length && left.every((member, index) => {
    const other = right[index];
    return other !== undefined && member.key === other.key && member.value === other.value;
  });
}

function validateOwnership(ownership: Readonly<ResponsesContinuationOwnership>): void {
  requireNonEmpty(ownership.accountId, "accountId");
  requireNonEmpty(ownership.modelId, "modelId");
  requireNonEmpty(ownership.upstreamOrigin, "upstreamOrigin");
  if (ownership.owner === "native") {
    if (ownership.upstreamProtocol !== "responses" || ownership.conversionVersion !== null) {
      throw new ResponsesContinuationError("ownership_conflict", "invalid native continuation ownership");
    }
    return;
  }
  if (
    (ownership.upstreamProtocol !== "chat" && ownership.upstreamProtocol !== "messages")
    || ownership.conversionVersion === null
    || ownership.conversionVersion.length === 0
  ) {
    throw new ResponsesContinuationError("ownership_conflict", "invalid converted continuation ownership");
  }
}

function sameOwnership(
  row: Readonly<ReceiptRow>,
  ownership: Readonly<ResponsesContinuationOwnership>,
): boolean {
  return row.model_id === ownership.modelId
    && row.upstream_origin === ownership.upstreamOrigin
    && row.owner === ownership.owner
    && row.upstream_protocol === ownership.upstreamProtocol
    && row.conversion_version === ownership.conversionVersion;
}

function toReceipt(row: Readonly<ReceiptRow>): ResponsesRouteReceipt {
  return {
    accountId: row.account_id,
    responseId: row.response_id,
    modelId: row.model_id,
    upstreamOrigin: row.upstream_origin,
    owner: row.owner,
    upstreamProtocol: row.upstream_protocol,
    conversionVersion: row.conversion_version,
    checkpointState: row.checkpoint_state,
    expiresAt: row.expires_at_ms,
  };
}

function checkpointRank(state: Exclude<ResponsesCheckpointState, "expired">): number {
  if (state === "complete") {
    return 2;
  }
  return state === "partial" ? 1 : 0;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new Error(`Responses history ${field} must be non-empty`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("operation aborted", "AbortError");
  }
}
