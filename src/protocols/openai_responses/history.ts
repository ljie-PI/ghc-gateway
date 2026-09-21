import type { SqliteDatabase, SqliteStatement } from "../../persistence/sqlite.js";
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
const DEFAULT_MAX_REPLAY_ITEMS = 1_024;
const DEFAULT_MAX_REPLAY_ITEM_BYTES = 4_194_304;
const DEFAULT_MAX_REPLAY_BYTES = 33_554_432;
const DEFAULT_MAX_STORED_REPLAY_BYTES = 33_554_432;
const DAY_MS = 86_400_000;
const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder();
const RESPONSES_CHAT_LEGACY_CONVERSION_VERSION = "responses-chat-v1";
const RESPONSES_MESSAGES_LEGACY_CONVERSION_VERSION = "responses-messages-v1";
export const RESPONSES_CHAT_CONVERSION_VERSION = "responses-chat-v2";
export const RESPONSES_MESSAGES_CONVERSION_VERSION = "responses-messages-v2";
const RESPONSES_CHAT_CONVERSION_VERSIONS = [
  RESPONSES_CHAT_LEGACY_CONVERSION_VERSION,
  RESPONSES_CHAT_CONVERSION_VERSION,
] as const;
const RESPONSES_MESSAGES_CONVERSION_VERSIONS = [
  RESPONSES_MESSAGES_LEGACY_CONVERSION_VERSION,
  RESPONSES_MESSAGES_CONVERSION_VERSION,
] as const;

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
    finalize?: (() => void) | undefined,
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

export function isKnownResponsesConversionVersion(
  protocol: ResponsesContinuationProtocol,
  version: string | null,
): boolean {
  return protocol === "chat"
    ? (RESPONSES_CHAT_CONVERSION_VERSIONS as readonly unknown[]).includes(version)
    : protocol === "messages"
      && (RESPONSES_MESSAGES_CONVERSION_VERSIONS as readonly unknown[]).includes(version);
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

export interface ResponsesHistoryOptions {
  readonly nowMs?: () => number;
  readonly ttlDays?: number;
  readonly maxResponses?: number;
  readonly maxReceipts?: number;
  readonly maxReplayItems?: number;
  readonly maxReplayItemBytes?: number;
  readonly maxReplayBytes?: number;
  readonly maxStoredReplayBytes?: number;
  readonly accountIsActive?: (accountId: string) => boolean;
}

type ReplayFormatVersion = 1 | 2;
type ReplayItemKind = "reasoning" | ResponsesCallKind;

interface StoredReplayItemBase {
  readonly groupOrdinal: number;
  readonly itemOrdinal: number;
  readonly item: WireJsonObject;
  readonly itemJson: string;
  readonly itemBytes: number;
}

interface StoredReasoningItem extends StoredReplayItemBase {
  readonly kind: "reasoning";
  readonly callId: null;
}

interface StoredCall extends StoredReplayItemBase {
  readonly callId: string;
  readonly kind: ResponsesCallKind;
}

type StoredReplayItem = StoredReasoningItem | StoredCall;

interface StoredReplay {
  readonly formatVersion: ReplayFormatVersion;
  readonly items: readonly StoredReplayItem[];
  readonly itemCount: number;
  readonly bytes: number;
}

interface StoredResponse {
  readonly formatVersion: ReplayFormatVersion;
  readonly items: readonly StoredReplayItem[];
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

interface CheckpointRow {
  readonly response_id: string;
  readonly replay_format_version: number;
  readonly replay_item_count: number;
  readonly replay_bytes: number;
}

interface ReplayItemRow {
  readonly response_id: string;
  readonly group_ordinal: number;
  readonly item_ordinal: number;
  readonly item_kind: ReplayItemKind;
  readonly call_id: string | null;
  readonly item_json: string;
  readonly item_bytes: number;
}

interface ReplaySummaryRow {
  readonly item_count: number;
  readonly replay_bytes: number;
  readonly max_item_bytes: number;
}

interface StateRow {
  readonly revision: number;
  readonly next_receipt_seq: number;
  readonly next_checkpoint_seq: number;
}

export class SqliteResponsesHistory implements ResponsesHistory, ResponsesHistoryAdmin {
  private readonly statements = new Map<string, SqliteStatement>();
  private readonly recentReceiptCleanup = new Map<string, number>();
  private readonly nowMs: () => number;
  private ttlMs: number;
  private readonly maxResponses: number;
  private readonly maxReceipts: number;
  private readonly maxReplayItems: number;
  private readonly maxReplayItemBytes: number;
  private readonly maxReplayBytes: number;
  private readonly maxStoredReplayBytes: number;
  private readonly accountIsActive: ((accountId: string) => boolean) | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    options: ResponsesHistoryOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = (options.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS;
    this.maxResponses = options.maxResponses ?? DEFAULT_MAX_RESPONSES;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.maxReplayItems = options.maxReplayItems ?? DEFAULT_MAX_REPLAY_ITEMS;
    this.maxReplayItemBytes = options.maxReplayItemBytes ?? DEFAULT_MAX_REPLAY_ITEM_BYTES;
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
    this.maxStoredReplayBytes = options.maxStoredReplayBytes ?? DEFAULT_MAX_STORED_REPLAY_BYTES;
    if (
      !isBoundedInteger(this.maxReplayItems, 1, Number.MAX_SAFE_INTEGER - 1)
      || !isBoundedInteger(this.maxReplayItemBytes, 1, Number.MAX_SAFE_INTEGER)
      || !isBoundedInteger(this.maxReplayBytes, 1, Number.MAX_SAFE_INTEGER)
      || !isBoundedInteger(this.maxStoredReplayBytes, 1, Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Responses history replay limits must be positive integers");
    }
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
      validateStoredOwnership(own);
      if (own.checkpoint_state === "expired") {
        return { kind: "expired" };
      }
      if (own.checkpoint_state === "complete" && own.owner === "converted") {
        const checkpoint = this.readResponse(account, id);
        if (checkpoint !== undefined && checkpoint.formatVersion !== replayFormatVersion(toReceipt(own))) {
          unavailableCheckpoint();
        }
      }
      return { kind: "owned", receipt: toReceipt(own) };
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
    if (receipt.owner !== "converted") {
      throw new ResponsesContinuationError("checkpoint_unavailable", "continuation has no local checkpoint");
    }
    const expectedFormatVersion = replayFormatVersion(receipt);
    const persistedReceipt = this.readReceipt(receipt.accountId, receipt.responseId);
    if (
      receipt.checkpointState !== "complete"
      || persistedReceipt === undefined
      || persistedReceipt.checkpoint_state !== "complete"
      || !sameOwnership(persistedReceipt, receipt)
    ) {
      unavailableCheckpoint();
    }

    const originalItems = inputItems(request.input);
    if (originalItems === undefined) {
      throw new ResponsesContinuationError("checkpoint_unavailable", "continuation input is not replayable");
    }
    let scoped: StoredResponse | undefined;
    try {
      scoped = this.readResponse(receipt.accountId, receipt.responseId);
    } catch (error: unknown) {
      if (error instanceof ResponsesContinuationError) {
        throw error;
      }
      unavailableCheckpoint();
    }
    if (scoped === undefined || scoped.formatVersion !== expectedFormatVersion) {
      unavailableCheckpoint();
    }
    const scopedReasoningCarriers = new Set(scoped.items
      .filter((item): item is StoredReasoningItem => item.kind === "reasoning")
      .map((item) => reasoningCarrier(item.item))
      .filter((carrier): carrier is string => carrier !== undefined));
    const originalCallsById = new Map<string, WireJsonObject>();
    const originalReasoningByCarrier = new Map<string, WireJsonObject>();
    for (const item of originalItems) {
      if (isDeclaredReplayItem(item) && !isCallItem(item) && !isReasoningItem(item)) {
        unavailableCheckpoint();
      }
      if (isDeclaredOutputItem(item) && !isOutputItem(item)) {
        unavailableCheckpoint();
      }
      if (isOutputItem(item) && strictCallIdFromItem(item) === undefined) {
        unavailableCheckpoint();
      }
      if (isCallItem(item)) {
        const callId = strictCallIdFromItem(item);
        if (callId === undefined || originalCallsById.has(callId)) {
          unavailableCheckpoint();
        }
        originalCallsById.set(callId, item);
      } else if (isReasoningItem(item)) {
        const carrier = reasoningCarrier(item);
        if (carrier !== undefined) {
          if (!scopedReasoningCarriers.has(carrier) || originalReasoningByCarrier.has(carrier)) unavailableCheckpoint();
          originalReasoningByCarrier.set(carrier, item);
        }
      }
    }

    let changed = false;
    let sawOutput = false;
    let scopedGroupInserted = false;
    const emittedCallIds = new Set<string>();
    const enrichedItems: WireJson[] = [];

    for (const item of originalItems) {
      if (isReasoningItem(item) && reasoningCarrier(item) !== undefined) {
        changed = true;
        continue;
      }
      if (isCallItem(item)) {
        const callId = strictCallIdFromItem(item);
        if (scoped.formatVersion === 2 && callId !== undefined && scoped.byCallId.has(callId)) {
          changed = true;
          continue;
        }
        if (callId !== undefined && emittedCallIds.has(callId)) {
          changed = true;
          continue;
        }
        const cached = callId === undefined ? undefined : scoped.byCallId.get(callId);
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
        const outputCallId = strictCallIdFromItem(item);
        if (outputCallId === undefined) {
          throw new ResponsesContinuationError("checkpoint_unavailable", "tool output has no call id");
        }
        if (scoped.formatVersion === 1) {
          if (!emittedCallIds.has(outputCallId)) {
            if (!scoped.byCallId.has(outputCallId)) {
              throw new ResponsesContinuationError("checkpoint_unavailable", "tool checkpoint is unavailable");
            }
            if (!scopedGroupInserted) {
              for (const call of scoped.calls) {
                if (!emittedCallIds.has(call.callId)) {
                  enrichedItems.push(restoreCall(call, originalCallsById.get(call.callId)));
                  emittedCallIds.add(call.callId);
                  changed = true;
                }
              }
              scopedGroupInserted = true;
            }
          }
        } else {
          if (!scoped.byCallId.has(outputCallId)) {
            throw new ResponsesContinuationError("checkpoint_unavailable", "tool checkpoint is unavailable");
          }
          if (!scopedGroupInserted) {
            for (const replayItem of scoped.items) {
              if (replayItem.kind === "reasoning") {
                const carrier = reasoningCarrier(replayItem.item);
                enrichedItems.push(
                  carrier === undefined
                    ? replayItem.item
                    : originalReasoningByCarrier.get(carrier) ?? replayItem.item,
                );
                changed = true;
              } else if (!emittedCallIds.has(replayItem.callId)) {
                enrichedItems.push(restoreCall(replayItem, originalCallsById.get(replayItem.callId)));
                emittedCallIds.add(replayItem.callId);
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
    this.rememberReceiptCleanup(receipt.accountId, receipt.responseId);
    throwIfAborted(signal);
  }

  async recordCheckpoint(
    record: Readonly<ResponsesHistoryRecord>,
    ownership: Readonly<ResponsesContinuationOwnership>,
    checkpointState: "partial" | "complete",
    signal: AbortSignal,
    finalize?: (() => void) | undefined,
  ): Promise<void> {
    throwIfAborted(signal);
    const responseId = requireNonEmpty(record.responseId.trim(), "responseId");
    validateOwnership(ownership);
    if (ownership.owner !== "converted") {
      throw new ResponsesContinuationError("ownership_conflict", "native continuation cannot store local history");
    }
    if (this.accountIsActive !== undefined && !this.accountIsActive(ownership.accountId)) {
      throw new ResponsesContinuationError("checkpoint_unavailable", "bound account is no longer active");
    }
    const replay = extractRecordableReplay(
      record.output,
      replayFormatVersion(ownership),
      this.maxReplayItems,
      this.maxReplayItemBytes,
      this.maxReplayBytes,
    );
    const existing = this.readReceipt(ownership.accountId, responseId);
    if (
      existing !== undefined
      && existing.checkpoint_state !== "expired"
      && existing.created_at_ms + this.ttlMs > this.nowMs()
      && sameOwnership(existing, ownership)
      && checkpointRank(checkpointState) <= checkpointRank(existing.checkpoint_state)
      && (replay.items.length === 0 || this.checkpointMatches(ownership.accountId, responseId, replay))
    ) {
      if (
        checkpointState === "complete"
        && finalize !== undefined
        && replay.items.length === 0
        && this.readResponse(ownership.accountId, responseId) === undefined
      ) {
        throw new ResponsesContinuationError("checkpoint_unavailable", "response checkpoint is unavailable");
      }
      this.finalizeCheckpoint(checkpointState, finalize);
      return;
    }
    if (
      existing !== undefined
      && existing.checkpoint_state !== "expired"
      && existing.created_at_ms + this.ttlMs > this.nowMs()
      && sameOwnership(existing, ownership)
    ) {
      const nowMs = this.nowMs();
      const cleanupKey = receiptCleanupKey(ownership.accountId, responseId);
      const cleanupValidUntil = this.recentReceiptCleanup.get(cleanupKey);
      const canSkipExpiry = cleanupValidUntil !== undefined && nowMs < cleanupValidUntil;
      if (!canSkipExpiry || checkpointState === "complete") {
        this.recentReceiptCleanup.delete(cleanupKey);
      }
      if (
        canSkipExpiry
        && checkpointState === "complete"
        && existing.checkpoint_state === "partial"
        && (replay.items.length === 0 || this.checkpointMatches(ownership.accountId, responseId, replay))
      ) {
        if (
          finalize !== undefined
          && replay.items.length === 0
          && this.readResponse(ownership.accountId, responseId) === undefined
        ) {
          throw new ResponsesContinuationError("checkpoint_unavailable", "response checkpoint is unavailable");
        }
        const promote = this.database.transaction(() => {
          this.statement(
            `UPDATE response_route_receipts
             SET checkpoint_state = 'complete'
             WHERE account_id = ? AND response_id = ? AND checkpoint_state = 'partial'`,
          ).run(ownership.accountId, responseId);
          finalize?.();
        });
        promote();
        throwIfAborted(signal);
        return;
      }
      let unavailableAfterCleanup = false;
      let ownershipChanged = false;
      const transaction = this.database.transaction(() => {
        let revisionBumped = false;
        const receiptsExpired = canSkipExpiry ? false : this.expireReceipts(nowMs);
        const legacyExpired = canSkipExpiry ? false : this.expireLegacy(nowMs);
        const current = canSkipExpiry ? existing : this.readReceipt(ownership.accountId, responseId);
        unavailableAfterCleanup = current === undefined
          || current.checkpoint_state === "expired"
          || current.created_at_ms + this.ttlMs <= nowMs;
        ownershipChanged = current !== undefined && !sameOwnership(current, ownership);
        const receiptChanged = !unavailableAfterCleanup
          && !ownershipChanged
          && current !== undefined
          && current.checkpoint_state !== "expired"
          && checkpointRank(checkpointState) > checkpointRank(current.checkpoint_state);
        if (receiptChanged) {
          this.statement(
            `UPDATE response_route_receipts
             SET checkpoint_state = ?
             WHERE account_id = ? AND response_id = ?`,
          ).run(checkpointState, ownership.accountId, responseId);
        }
        const checkpointChanged = !unavailableAfterCleanup && !ownershipChanged && replay.items.length > 0
          ? canSkipExpiry && existing.checkpoint_state === "route_only"
            ? (revisionBumped = this.insertFirstCheckpoint(
              ownership.accountId,
              responseId,
              replay,
              nowMs,
            ))
            : this.upsertCheckpoint(ownership.accountId, responseId, replay)
          : false;
        const checkpointEvicted = receiptsExpired || legacyExpired || receiptChanged || checkpointChanged
          ? this.evictCheckpointOverflow()
          : false;
        const receiptEvicted = receiptsExpired || legacyExpired
          ? this.evictReceiptOverflow()
          : false;
        if (!revisionBumped && (
          receiptsExpired
          || legacyExpired
          || receiptChanged
          || checkpointChanged
          || checkpointEvicted
          || receiptEvicted
        )) {
          this.bumpRevision(nowMs);
        }
        if (!unavailableAfterCleanup && !ownershipChanged && checkpointState === "complete") {
          finalize?.();
        }
      });
      transaction();
      if (ownershipChanged) {
        throw new ResponsesContinuationError("ownership_conflict", "response id ownership conflict");
      }
      if (unavailableAfterCleanup) {
        throw new ResponsesContinuationError("expired", "response continuation expired");
      }
      throwIfAborted(signal);
      return;
    }
    if (checkpointState === "complete" && finalize !== undefined && replay.items.length === 0) {
      throw new ResponsesContinuationError("checkpoint_unavailable", "response checkpoint is unavailable");
    }
    this.mutateIfChanged(() => {
      const receiptChanged = this.upsertReceipt({ ...ownership, responseId, checkpointState });
      const checkpointChanged = replay.items.length > 0
        ? this.upsertCheckpoint(ownership.accountId, responseId, replay)
        : false;
      if (checkpointState === "complete") finalize?.();
      return receiptChanged || checkpointChanged;
    });
    throwIfAborted(signal);
  }

  private finalizeCheckpoint(
    checkpointState: "partial" | "complete",
    finalize: (() => void) | undefined,
  ): void {
    if (checkpointState !== "complete" || finalize === undefined) return;
    this.database.transaction(finalize)();
  }

  setTtlDays(ttlDays: number): void {
    this.ttlMs = ttlDays * DAY_MS;
    this.recentReceiptCleanup.clear();
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
    this.recentReceiptCleanup.clear();
    const clear = this.database.transaction(() => {
      const state = this.readState();
      if (state.revision !== expectedRevision) {
        throw new ResponsesHistoryAdminError("Responses history revision conflict");
      }
      const changed = this.responseCount() > 0
        || this.receiptCount() > 0
        || this.legacyCount() > 0
        || this.uncertaintyCount() > 0
        || this.carrierCount() > 0;
      if (!changed) {
        return;
      }
      this.database.prepare("DELETE FROM response_route_receipts").run();
      this.database.prepare("DELETE FROM reasoning_carriers").run();
      this.database.prepare("DELETE FROM response_calls").run();
      this.database.prepare("DELETE FROM responses").run();
      this.database.prepare("DELETE FROM response_receipt_uncertainty").run();
      this.bumpRevision(this.nowMs());
    });
    clear();
    return this.inspect();
  }

  clearAccount(accountId: string): void {
    for (const key of this.recentReceiptCleanup.keys()) {
      if (key.startsWith(`${accountId}\u0000`)) {
        this.recentReceiptCleanup.delete(key);
      }
    }
    const account = requireNonEmpty(accountId, "accountId");
    this.mutateIfChanged(() => {
      const carriers = this.database.prepare("DELETE FROM reasoning_carriers WHERE account_id = ?").run(account);
      const result = this.database.prepare(
        "DELETE FROM response_route_receipts WHERE account_id = ?",
      ).run(account);
      if (result.changes > 0) {
        this.markUncertain(this.nowMs());
      }
      return result.changes > 0 || carriers.changes > 0;
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
    const expired = this.statement(
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
      this.database.prepare(
        "DELETE FROM reasoning_carriers WHERE account_id = ? AND response_id = ?",
      ).run(row.account_id, row.response_id);
      markExpired.run(row.account_id, row.response_id);
    }
    return true;
  }

  private insertFirstCheckpoint(
    accountId: string,
    responseId: string,
    replay: Readonly<StoredReplay>,
    nowMs: number,
  ): true {
    const inserted = this.statement(
      `INSERT INTO response_scoped_checkpoints
       (account_id, response_id, insertion_seq, created_at_ms, expires_at_ms,
        replay_format_version, replay_item_count, replay_bytes)
       SELECT ?, ?, next_checkpoint_seq, ?, ?, ?, ?, ?
       FROM responses_continuation_state
       WHERE singleton_id = 1`,
    ).run(
      accountId,
      responseId,
      nowMs,
      nowMs + this.ttlMs,
      replay.formatVersion,
      replay.itemCount,
      replay.bytes,
    );
    if (inserted.changes !== 1) {
      throw new Error("Responses history state is unavailable");
    }
    this.insertReplayItems(accountId, responseId, replay.items);
    this.statement(
      `UPDATE responses_continuation_state
       SET next_checkpoint_seq = next_checkpoint_seq + 1,
           revision = revision + 1,
           updated_at_ms = ?
       WHERE singleton_id = 1`,
    ).run(nowMs);
    return true;
  }

  private expireLegacy(nowMs: number): boolean {
    const expired = this.statement(
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
    let overflow = (this.statement(
      `SELECT
         (SELECT COUNT(*) FROM response_scoped_checkpoints)
         + (SELECT COUNT(*) FROM responses)
         - ? AS overflow`,
    ).get(this.maxResponses) as { overflow: number }).overflow;
    let changed = false;
    if (overflow > 0) {
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
        changed = true;
      }
    }
    const remove = this.database.prepare(
      "DELETE FROM response_scoped_checkpoints WHERE account_id = ? AND response_id = ?",
    );
    const reset = this.database.prepare(
      `UPDATE response_route_receipts
       SET checkpoint_state = 'route_only'
       WHERE account_id = ? AND response_id = ? AND checkpoint_state <> 'expired'`,
    );
    if (overflow > 0) {
      const rows = this.database.prepare(
        `SELECT account_id, response_id
         FROM response_scoped_checkpoints
         ORDER BY insertion_seq ASC LIMIT ?`,
      ).all(overflow) as Array<{ account_id: string; response_id: string }>;
      for (const row of rows) {
        this.deleteResponseCarriers(row.account_id, row.response_id);
        remove.run(row.account_id, row.response_id);
        reset.run(row.account_id, row.response_id);
      }
      changed ||= rows.length > 0;
    }
    let storedBytes = (this.database.prepare(
      "SELECT COALESCE(SUM(replay_bytes), 0) AS value FROM response_scoped_checkpoints",
    ).get() as { value: number }).value;
    if (storedBytes > this.maxStoredReplayBytes) {
      const overflowRows = this.database.prepare(
        `SELECT account_id, response_id, replay_bytes
         FROM response_scoped_checkpoints
         ORDER BY insertion_seq ASC`,
      ).all() as Array<{ account_id: string; response_id: string; replay_bytes: number }>;
      for (const row of overflowRows) {
        if (storedBytes <= this.maxStoredReplayBytes) break;
        this.deleteResponseCarriers(row.account_id, row.response_id);
        remove.run(row.account_id, row.response_id);
        reset.run(row.account_id, row.response_id);
        storedBytes -= row.replay_bytes;
        changed = true;
      }
    }
    return changed;
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
    replay: Readonly<StoredReplay>,
  ): boolean {
    if (this.checkpointMatches(accountId, responseId, replay)) {
      return false;
    }
    const existing = this.statement(
      `SELECT 1 FROM response_scoped_checkpoints
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId);
    if (existing === undefined) {
      return replay.items.length > 0
        ? this.insertCheckpoint(accountId, responseId, replay)
        : false;
    } else {
      this.statement(
        "DELETE FROM response_scoped_replay_items WHERE account_id = ? AND response_id = ?",
      ).run(accountId, responseId);
    }
    this.statement(
      `UPDATE response_scoped_checkpoints
       SET replay_format_version = ?, replay_item_count = ?, replay_bytes = ?
       WHERE account_id = ? AND response_id = ?`,
    ).run(replay.formatVersion, replay.itemCount, replay.bytes, accountId, responseId);
    this.insertReplayItems(accountId, responseId, replay.items);
    return true;
  }

  private insertCheckpoint(
    accountId: string,
    responseId: string,
    replay: Readonly<StoredReplay>,
  ): boolean {
    const state = this.readState();
    const nowMs = this.nowMs();
    this.statement(
      `INSERT INTO response_scoped_checkpoints
       (account_id, response_id, insertion_seq, created_at_ms, expires_at_ms,
        replay_format_version, replay_item_count, replay_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      responseId,
      state.next_checkpoint_seq,
      nowMs,
      nowMs + this.ttlMs,
      replay.formatVersion,
      replay.itemCount,
      replay.bytes,
    );
    this.statement(
      "UPDATE responses_continuation_state SET next_checkpoint_seq = ? WHERE singleton_id = 1",
    ).run(state.next_checkpoint_seq + 1);
    this.insertReplayItems(accountId, responseId, replay.items);
    return true;
  }

  private insertReplayItems(
    accountId: string,
    responseId: string,
    items: readonly StoredReplayItem[],
  ): void {
    const insertItem = this.statement(
      `INSERT INTO response_scoped_replay_items
       (account_id, response_id, group_ordinal, item_ordinal, item_kind, call_id,
        item_json, item_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insertItem.run(
        accountId,
        responseId,
        item.groupOrdinal,
        item.itemOrdinal,
        item.kind,
        item.callId,
        item.itemJson,
        item.itemBytes,
      );
    }
  }

  private deleteResponseCarriers(accountId: string, responseId: string): void {
    this.database.prepare(
      "DELETE FROM reasoning_carriers WHERE account_id = ? AND response_id = ?",
    ).run(accountId, responseId);
  }

  private readReceipt(accountId: string, responseId: string): ReceiptRow | undefined {
    return this.statement(
      `SELECT account_id, response_id, model_id, upstream_origin, owner, upstream_protocol,
              conversion_version, checkpoint_state, created_at_ms, expires_at_ms
       FROM response_route_receipts
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId) as ReceiptRow | undefined;
  }

  private readResponse(accountId: string, responseId: string): StoredResponse | undefined {
    const row = this.database.prepare(
      `SELECT response_id, replay_format_version, replay_item_count, replay_bytes
       FROM response_scoped_checkpoints
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId) as CheckpointRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const replay = this.readReplay(accountId, responseId, row);
    return responseFromReplay(replay);
  }

  private checkpointMatches(
    accountId: string,
    responseId: string,
    replay: Readonly<StoredReplay>,
  ): boolean {
    const row = this.statement(
      `SELECT response_id, replay_format_version, replay_item_count, replay_bytes
       FROM response_scoped_checkpoints
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId) as CheckpointRow | undefined;
    if (row === undefined) {
      return false;
    }
    const stored = this.readReplay(accountId, responseId, row);
    if (stored.formatVersion !== replay.formatVersion) {
      unavailableCheckpoint();
    }
    return stored.itemCount === replay.itemCount
      && stored.bytes === replay.bytes
      && replayItemsEqual(stored.items, replay.items);
  }

  private readReplay(
    accountId: string,
    responseId: string,
    checkpoint: Readonly<CheckpointRow>,
  ): StoredReplay {
    const formatVersion = storedReplayFormatVersion(checkpoint.replay_format_version);
    if (
      !isBoundedInteger(checkpoint.replay_item_count, 1, this.maxReplayItems)
      || !isBoundedInteger(checkpoint.replay_bytes, 1, this.maxReplayBytes)
    ) {
      unavailableCheckpoint();
    }
    const summary = this.statement(
      `SELECT COUNT(*) AS item_count,
              COALESCE(SUM(item_bytes), 0) AS replay_bytes,
              COALESCE(MAX(item_bytes), 0) AS max_item_bytes
       FROM response_scoped_replay_items
       WHERE account_id = ? AND response_id = ?`,
    ).get(accountId, responseId) as ReplaySummaryRow;
    if (
      summary.item_count !== checkpoint.replay_item_count
      || summary.replay_bytes !== checkpoint.replay_bytes
      || !isBoundedInteger(summary.max_item_bytes, 1, this.maxReplayItemBytes)
    ) {
      unavailableCheckpoint();
    }
    const rows = this.readReplayRows(accountId, responseId);
    if (rows.length !== checkpoint.replay_item_count) {
      unavailableCheckpoint();
    }
    let bytes = 0;
    const items = rows.map((row) => {
      if (
        !isBoundedInteger(row.group_ordinal, 0, this.maxReplayItems - 1)
        || !isBoundedInteger(row.item_ordinal, 0, this.maxReplayItems - 1)
        || !isBoundedInteger(row.item_bytes, 1, this.maxReplayItemBytes)
      ) {
        unavailableCheckpoint();
      }
      const encoded = JSON_ENCODER.encode(row.item_json);
      if (encoded.byteLength !== row.item_bytes) {
        unavailableCheckpoint();
      }
      bytes += row.item_bytes;
      if (bytes > this.maxReplayBytes) {
        unavailableCheckpoint();
      }
      let item: WireJson;
      try {
        item = parseWireJson(encoded, { maxBytes: this.maxReplayItemBytes, maxDepth: 64 });
      } catch {
        unavailableCheckpoint();
      }
      if (!isWireJsonObject(item)) {
        unavailableCheckpoint();
      }
      return replayItemFromRow(row, item);
    });
    if (bytes !== checkpoint.replay_bytes) {
      unavailableCheckpoint();
    }
    validateStoredReplay(formatVersion, items);
    return { formatVersion, items, itemCount: items.length, bytes };
  }

  private readReplayRows(accountId: string, responseId: string): readonly ReplayItemRow[] {
    return this.statement(
      `SELECT response_id, group_ordinal, item_ordinal, item_kind, call_id,
              item_json, item_bytes
       FROM response_scoped_replay_items
       WHERE account_id = ? AND response_id = ?
       ORDER BY group_ordinal ASC, item_ordinal ASC
       LIMIT ?`,
    ).all(accountId, responseId, this.maxReplayItems + 1) as ReplayItemRow[];
  }

  private responseCount(): number {
    return (this.statement(
      "SELECT COUNT(*) AS count FROM response_scoped_checkpoints",
    ).get() as { count: number }).count;
  }

  private carrierCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM reasoning_carriers",
    ).get() as { count: number }).count;
  }

  private receiptCount(): number {
    return (this.statement(
      "SELECT COUNT(*) AS count FROM response_route_receipts",
    ).get() as { count: number }).count;
  }

  private legacyCount(): number {
    return (this.statement(
      "SELECT COUNT(*) AS count FROM responses",
    ).get() as { count: number }).count;
  }

  private uncertaintyCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS count FROM response_receipt_uncertainty",
    ).get() as { count: number }).count;
  }

  private markUncertain(nowMs: number): void {
    this.statement(
      `INSERT OR IGNORE INTO response_receipt_uncertainty
       (singleton_id, uncertain_since_ms) VALUES (1, ?)`,
    ).run(nowMs);
  }

  private readState(): StateRow {
    return this.statement(
      `SELECT revision, next_receipt_seq, next_checkpoint_seq
       FROM responses_continuation_state WHERE singleton_id = 1`,
    ).get() as StateRow;
  }

  private bumpRevision(nowMs: number): void {
    this.statement(
      `UPDATE responses_continuation_state
       SET revision = revision + 1, updated_at_ms = ?
       WHERE singleton_id = 1`,
    ).run(nowMs);
  }

  private statement(sql: string): SqliteStatement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private rememberReceiptCleanup(accountId: string, responseId: string): void {
    const row = this.statement(
      `SELECT MIN(expires_at_ms) AS expires_at_ms
       FROM (
         SELECT created_at_ms + ? AS expires_at_ms
         FROM response_route_receipts
         WHERE checkpoint_state <> 'expired'
         UNION ALL
         SELECT created_at_ms + ? AS expires_at_ms
         FROM responses
       )`,
    ).get(this.ttlMs, this.ttlMs) as { expires_at_ms: number | null };
    const key = receiptCleanupKey(accountId, responseId);
    this.recentReceiptCleanup.set(key, row.expires_at_ms ?? Number.POSITIVE_INFINITY);
    while (this.recentReceiptCleanup.size > this.maxReceipts) {
      const oldest = this.recentReceiptCleanup.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.recentReceiptCleanup.delete(oldest);
    }
  }
}

function receiptCleanupKey(accountId: string, responseId: string): string {
  return `${accountId}\u0000${responseId}`;
}

function extractRecordableReplay(
  output: readonly WireJson[] | WireJson,
  formatVersion: ReplayFormatVersion,
  maxItems: number,
  maxItemBytes: number,
  maxBytes: number,
): StoredReplay {
  const items: StoredReplayItem[] = [];
  const callIds = new Set<string>();
  const reasoningCarriers = new Set<string>();
  let group: Array<{
    readonly kind: ReplayItemKind;
    readonly callId: string | null;
    readonly item: WireJsonObject;
  }> = [];
  let groupOrdinal = 0;
  let bytes = 0;

  const finishGroup = (): void => {
    if (!group.some((item) => item.kind !== "reasoning")) {
      group = [];
      return;
    }
    for (let itemOrdinal = 0; itemOrdinal < group.length; itemOrdinal += 1) {
      const groupItem = group[itemOrdinal];
      if (groupItem === undefined) {
        unavailableCheckpoint();
      }
      const encoded = encodeReplayItem(groupItem.item, maxItemBytes);
      if (items.length >= maxItems || bytes + encoded.itemBytes > maxBytes) {
        unavailableCheckpoint();
      }
      const base = { groupOrdinal, itemOrdinal, item: groupItem.item, ...encoded };
      items.push(groupItem.kind === "reasoning"
        ? { ...base, kind: "reasoning", callId: null }
        : { ...base, kind: groupItem.kind, callId: groupItem.callId as string });
      bytes += encoded.itemBytes;
    }
    group = [];
    groupOrdinal += 1;
  };

  for (const outputItem of outputItems(output)) {
    if (isReasoningItem(outputItem)) {
      if (memberValues(outputItem, "call_id").length > 0) {
        unavailableCheckpoint();
      }
      if (formatVersion === 1) {
        continue;
      }
      const carrier = reasoningCarrier(outputItem);
      if (carrier !== undefined) {
        if (reasoningCarriers.has(carrier)) unavailableCheckpoint();
        reasoningCarriers.add(carrier);
      }
      if (group.some((item) => item.kind !== "reasoning")) {
        finishGroup();
      }
      group.push({ kind: "reasoning", callId: null, item: outputItem });
      continue;
    }
    if (isDeclaredReplayItem(outputItem) && !isCallItem(outputItem)) {
      unavailableCheckpoint();
    }
    if (!isCallItem(outputItem)) {
      continue;
    }
    const callId = strictCallIdFromItem(outputItem);
    if (callId === undefined || callIds.has(callId)) {
      unavailableCheckpoint();
    }
    callIds.add(callId);
    const item = minimalCallItem(outputItem);
    const encoded = encodeReplayItem(item, maxItemBytes);
    const kind = firstMemberValue(outputItem, "type") as ResponsesCallKind;
    if (formatVersion === 1) {
      if (items.length >= maxItems || bytes + encoded.itemBytes > maxBytes) {
        unavailableCheckpoint();
      }
      items.push({
        groupOrdinal: 0,
        itemOrdinal: items.length,
        callId,
        kind,
        item,
        ...encoded,
      });
      bytes += encoded.itemBytes;
    } else {
      group.push({ kind, callId, item });
    }
  }
  if (formatVersion === 2) {
    finishGroup();
  }
  return { formatVersion, items, itemCount: items.length, bytes };
}

function encodeReplayItem(
  item: WireJsonObject,
  maxItemBytes: number,
): { readonly itemJson: string; readonly itemBytes: number } {
  let encoded: Uint8Array;
  try {
    encoded = serializeWireJson(item);
  } catch {
    unavailableCheckpoint();
  }
  if (encoded.byteLength === 0 || encoded.byteLength > maxItemBytes) {
    unavailableCheckpoint();
  }
  return { itemJson: JSON_DECODER.decode(encoded), itemBytes: encoded.byteLength };
}

function outputItems(output: readonly WireJson[] | WireJson): readonly WireJson[] {
  if (Array.isArray(output)) {
    return output;
  }
  if (isWireJsonArray(output)) {
    return output.items;
  }
  if (isWireJsonObject(output)) {
    const nested = firstMemberValue(output, "output");
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
  const types = memberValues(item, "type");
  const type = types.length === 1 ? types[0] : undefined;
  return typeof type === "string" && (RESPONSE_CALL_KINDS as readonly string[]).includes(type);
}

function isReasoningItem(item: WireJson): item is WireJsonObject {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const types = memberValues(item, "type");
  return types.length === 1 && types[0] === "reasoning";
}

function reasoningCarrier(item: WireJsonObject): string | undefined {
  const values = memberValues(item, "encrypted_content");
  return values.length === 1 && typeof values[0] === "string" && values[0].length > 0
    ? values[0]
    : undefined;
}

function isDeclaredReplayItem(item: WireJson): boolean {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const types = memberValues(item, "type");
  return types.some((type) => type === "reasoning"
    || (typeof type === "string" && (RESPONSE_CALL_KINDS as readonly string[]).includes(type)));
}

function isOutputItem(item: WireJson): item is WireJsonObject {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const types = memberValues(item, "type");
  const type = types.length === 1 ? types[0] : undefined;
  return typeof type === "string" && (RESPONSE_CALL_OUTPUT_KINDS as readonly string[]).includes(type);
}

function isDeclaredOutputItem(item: WireJson): boolean {
  if (!isWireJsonObject(item)) {
    return false;
  }
  return memberValues(item, "type").some((type) => typeof type === "string"
    && (RESPONSE_CALL_OUTPUT_KINDS as readonly string[]).includes(type));
}

function strictCallIdFromItem(item: WireJsonObject): string | undefined {
  const callIds = memberValues(item, "call_id");
  const ids = memberValues(item, "id");
  if (callIds.length > 1 || ids.length > 1) {
    return undefined;
  }
  const callId = callIds.length === 1 ? trimmedString(callIds[0]) : undefined;
  const id = ids.length === 1 ? trimmedString(ids[0]) : undefined;
  if ((callIds.length === 1 && callId === undefined) || (ids.length === 1 && id === undefined)) {
    return undefined;
  }
  return callId ?? id;
}

function firstMemberValue(item: WireJsonObject, key: string): WireJson | undefined {
  for (const member of item.members) {
    if (member.key === key) {
      return member.value;
    }
  }
  return undefined;
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

function responseFromReplay(replay: Readonly<StoredReplay>): StoredResponse {
  const byCallId = new Map<string, StoredCall>();
  const calls: StoredCall[] = [];
  for (const item of replay.items) {
    if (item.kind === "reasoning") {
      continue;
    }
    if (byCallId.has(item.callId)) {
      unavailableCheckpoint();
    }
    calls.push(item);
    byCallId.set(item.callId, item);
  }
  return { formatVersion: replay.formatVersion, items: replay.items, calls, byCallId };
}

function replayItemsEqual(left: readonly StoredReplayItem[], right: readonly StoredReplayItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined
      && item.groupOrdinal === other.groupOrdinal
      && item.itemOrdinal === other.itemOrdinal
      && item.kind === other.kind
      && item.callId === other.callId
      && item.itemJson === other.itemJson
      && item.itemBytes === other.itemBytes;
  });
}

function replayItemFromRow(row: Readonly<ReplayItemRow>, item: WireJsonObject): StoredReplayItem {
  const types = memberValues(item, "type");
  if (types.length !== 1 || types[0] !== row.item_kind || !isReplayItemKind(row.item_kind)) {
    unavailableCheckpoint();
  }
  if (row.item_kind === "reasoning") {
    if (row.call_id !== null || memberValues(item, "call_id").length > 0) {
      unavailableCheckpoint();
    }
    return {
      groupOrdinal: row.group_ordinal,
      itemOrdinal: row.item_ordinal,
      kind: "reasoning",
      callId: null,
      item,
      itemJson: row.item_json,
      itemBytes: row.item_bytes,
    };
  }
  const callId = strictCallIdFromItem(item);
  if (row.call_id === null || callId !== row.call_id) {
    unavailableCheckpoint();
  }
  return {
    groupOrdinal: row.group_ordinal,
    itemOrdinal: row.item_ordinal,
    kind: row.item_kind,
    callId: row.call_id,
    item,
    itemJson: row.item_json,
    itemBytes: row.item_bytes,
  };
}

function isReplayItemKind(value: string): value is ReplayItemKind {
  return value === "reasoning" || (RESPONSE_CALL_KINDS as readonly string[]).includes(value);
}

function validateStoredReplay(
  formatVersion: ReplayFormatVersion,
  items: readonly StoredReplayItem[],
): void {
  const callIds = new Set<string>();
  const reasoningCarriers = new Set<string>();
  let expectedGroup = 0;
  let expectedItem = 0;
  let groupHasCall = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      unavailableCheckpoint();
    }
    if (formatVersion === 1) {
      if (
        item.kind === "reasoning"
        || item.groupOrdinal !== 0
        || item.itemOrdinal !== expectedItem
      ) {
        unavailableCheckpoint();
      }
      expectedItem += 1;
    } else {
      if (item.groupOrdinal !== expectedGroup || item.itemOrdinal !== expectedItem) {
        unavailableCheckpoint();
      }
      if (item.kind === "reasoning") {
        const carrier = reasoningCarrier(item.item);
        if (carrier !== undefined) {
          if (reasoningCarriers.has(carrier)) unavailableCheckpoint();
          reasoningCarriers.add(carrier);
        }
        if (groupHasCall) {
          unavailableCheckpoint();
        }
      } else {
        groupHasCall = true;
      }
      expectedItem += 1;
      const next = items[index + 1];
      if (next === undefined || next.groupOrdinal !== expectedGroup) {
        if (!groupHasCall) {
          unavailableCheckpoint();
        }
        expectedGroup += 1;
        expectedItem = 0;
        groupHasCall = false;
      }
    }
    if (item.kind !== "reasoning") {
      if (callIds.has(item.callId)) {
        unavailableCheckpoint();
      }
      callIds.add(item.callId);
    }
  }
}

function storedReplayFormatVersion(value: number): ReplayFormatVersion {
  if (value !== 1 && value !== 2) {
    unavailableCheckpoint();
  }
  return value;
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
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
  if (ownership.upstreamProtocol !== "chat" && ownership.upstreamProtocol !== "messages") {
    throw new ResponsesContinuationError("ownership_conflict", "invalid converted continuation ownership");
  }
  replayFormatVersion(ownership);
}

function replayFormatVersion(
  ownership: Pick<ResponsesContinuationOwnership, "owner" | "upstreamProtocol" | "conversionVersion">,
): ReplayFormatVersion {
  if (ownership.owner !== "converted") {
    throw new ResponsesContinuationError("ownership_conflict", "invalid converted continuation ownership");
  }
  if (ownership.upstreamProtocol === "chat") {
    return knownReplayFormatVersion(
      ownership.conversionVersion,
      RESPONSES_CHAT_CONVERSION_VERSIONS,
    );
  } else if (ownership.upstreamProtocol === "messages") {
    return knownReplayFormatVersion(
      ownership.conversionVersion,
      RESPONSES_MESSAGES_CONVERSION_VERSIONS,
    );
  }
  throw new ResponsesContinuationError("ownership_conflict", "unknown converted continuation version");
}

function knownReplayFormatVersion(
  version: string | null,
  versions: readonly [string, string],
): ReplayFormatVersion {
  if (version === versions[0]) {
    return 1;
  }
  if (version === versions[1]) {
    return 2;
  }
  throw new ResponsesContinuationError("ownership_conflict", "unknown converted continuation version");
}

function validateStoredOwnership(row: Readonly<ReceiptRow>): void {
  if (row.owner === "native") {
    if (row.upstream_protocol !== "responses" || row.conversion_version !== null) {
      unavailableCheckpoint();
    }
    return;
  }
  if (!isKnownResponsesConversionVersion(row.upstream_protocol, row.conversion_version)) {
    unavailableCheckpoint();
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

function unavailableCheckpoint(): never {
  throw new ResponsesContinuationError("checkpoint_unavailable", "response checkpoint is unavailable");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("operation aborted", "AbortError");
  }
}
