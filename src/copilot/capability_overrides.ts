import type { SqliteDatabase } from "../persistence/sqlite.js";
import type { ModelCapabilityOverrideValue } from "./model_capabilities.js";

export const MAX_MODEL_CAPABILITY_OVERRIDES_PER_ACCOUNT = 64;
export const MAX_MODEL_CAPABILITY_OVERRIDES_TOTAL = 256;
export const MAX_CAPABILITY_MODEL_ID_LENGTH = 128;

export interface StoredModelCapabilityOverride {
  readonly accountId: string;
  readonly modelId: string;
  readonly revision: number;
  readonly value: ModelCapabilityOverrideValue | null;
}

export class ModelCapabilityOverrideError extends Error {
  constructor(readonly code: "revision_conflict" | "capacity" | "validation_failed") {
    super(code.replaceAll("_", " "));
    this.name = "ModelCapabilityOverrideError";
  }
}

export class SqliteModelCapabilityOverrides {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly nowMs: () => number = Date.now,
  ) {}

  get(accountId: string, modelId: string): StoredModelCapabilityOverride {
    const row = this.database.prepare(
      "SELECT account_id, model_id, revision, configuration_json FROM model_capability_overrides WHERE account_id = ? AND model_id = ?",
    ).get(accountId, modelId) as OverrideRow | undefined;
    return row === undefined
      ? { accountId, modelId, revision: 0, value: null }
      : rowToStored(row);
  }

  list(accountId: string): readonly StoredModelCapabilityOverride[] {
    return (this.database.prepare(
      `SELECT account_id, model_id, revision, configuration_json
       FROM model_capability_overrides
       WHERE account_id = ? AND configuration_json IS NOT NULL
       ORDER BY model_id`,
    ).all(accountId) as OverrideRow[]).map(rowToStored);
  }

  revisions(accountId: string): Readonly<Record<string, number>> {
    const rows = this.database.prepare(
      "SELECT model_id, revision FROM model_capability_overrides WHERE account_id = ? ORDER BY model_id",
    ).all(accountId) as Array<{ model_id: string; revision: number }>;
    return Object.freeze(Object.fromEntries(rows.map((row) => [row.model_id, row.revision])));
  }

  set(
    accountId: string,
    modelId: string,
    candidate: Readonly<ModelCapabilityOverrideValue>,
    expectedRevision: number,
  ): StoredModelCapabilityOverride {
    validateModelId(modelId);
    validateOverride(candidate);
    const current = this.get(accountId, modelId);
    if (current.revision !== expectedRevision) {
      throw new ModelCapabilityOverrideError("revision_conflict");
    }
    if (current.value === null) {
      this.enforceCapacity(accountId);
    }
    const next = Object.freeze({
      enabled: candidate.enabled,
      ...(candidate.protocols === undefined ? {} : { protocols: Object.freeze([...candidate.protocols]) }),
      ...(candidate.maxInputTokens === undefined ? {} : { maxInputTokens: candidate.maxInputTokens }),
      ...(candidate.maxOutputTokens === undefined ? {} : { maxOutputTokens: candidate.maxOutputTokens }),
      ...(candidate.defaultOutputTokens === undefined ? {} : { defaultOutputTokens: candidate.defaultOutputTokens }),
      ...(candidate.chatOutputTokenField === undefined ? {} : {
        chatOutputTokenField: candidate.chatOutputTokenField,
      }),
    });
    this.database.prepare(
      `INSERT INTO model_capability_overrides (
         account_id, model_id, revision, configuration_json, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, model_id) DO UPDATE SET
         revision = excluded.revision,
         configuration_json = excluded.configuration_json,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(accountId, modelId, current.revision + 1, JSON.stringify(next), this.nowMs());
    return this.get(accountId, modelId);
  }

  reset(accountId: string, modelId: string, expectedRevision: number): StoredModelCapabilityOverride {
    validateModelId(modelId);
    const current = this.get(accountId, modelId);
    if (current.revision !== expectedRevision) {
      throw new ModelCapabilityOverrideError("revision_conflict");
    }
    if (current.value === null) {
      return current;
    }
    this.database.prepare(
      `UPDATE model_capability_overrides
       SET revision = revision + 1, configuration_json = NULL, updated_at_ms = ?
       WHERE account_id = ? AND model_id = ?`,
    ).run(this.nowMs(), accountId, modelId);
    return this.get(accountId, modelId);
  }

  clearAccount(accountId: string): void {
    this.database.prepare("DELETE FROM model_capability_overrides WHERE account_id = ?").run(accountId);
  }

  private enforceCapacity(accountId: string): void {
    const perAccount = this.database.prepare(
      "SELECT COUNT(*) AS count FROM model_capability_overrides WHERE account_id = ? AND configuration_json IS NOT NULL",
    ).get(accountId) as { count: number };
    const total = this.database.prepare(
      "SELECT COUNT(*) AS count FROM model_capability_overrides WHERE configuration_json IS NOT NULL",
    ).get() as { count: number };
    if (perAccount.count >= MAX_MODEL_CAPABILITY_OVERRIDES_PER_ACCOUNT
      || total.count >= MAX_MODEL_CAPABILITY_OVERRIDES_TOTAL) {
      throw new ModelCapabilityOverrideError("capacity");
    }
  }
}

function rowToStored(row: OverrideRow): StoredModelCapabilityOverride {
  return Object.freeze({
    accountId: row.account_id,
    modelId: row.model_id,
    revision: row.revision,
    value: row.configuration_json === null
      ? null
      : Object.freeze(JSON.parse(row.configuration_json) as ModelCapabilityOverrideValue),
  });
}

function validateModelId(modelId: string): void {
  if (modelId.length === 0 || modelId.length > MAX_CAPABILITY_MODEL_ID_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(modelId)) {
    throw new ModelCapabilityOverrideError("validation_failed");
  }
}

function validateOverride(value: Readonly<ModelCapabilityOverrideValue>): void {
  if (typeof value.enabled !== "boolean") {
    throw new ModelCapabilityOverrideError("validation_failed");
  }
  if (value.protocols !== undefined) {
    if (!Array.isArray(value.protocols) || new Set(value.protocols).size !== value.protocols.length
      || value.protocols.some((protocol) => protocol !== "chat" && protocol !== "messages" && protocol !== "responses")) {
      throw new ModelCapabilityOverrideError("validation_failed");
    }
  }
  for (const tokenValue of [
    value.maxInputTokens,
    value.maxOutputTokens,
    value.defaultOutputTokens,
  ]) {
    if (tokenValue !== undefined && (!Number.isSafeInteger(tokenValue) || tokenValue <= 0)) {
      throw new ModelCapabilityOverrideError("validation_failed");
    }
  }
  if (value.defaultOutputTokens !== undefined && value.maxOutputTokens !== undefined
    && value.defaultOutputTokens > value.maxOutputTokens) {
    throw new ModelCapabilityOverrideError("validation_failed");
  }
  if (value.chatOutputTokenField !== undefined
    && value.chatOutputTokenField !== "max_tokens"
    && value.chatOutputTokenField !== "max_completion_tokens") {
    throw new ModelCapabilityOverrideError("validation_failed");
  }
}

interface OverrideRow {
  readonly account_id: string;
  readonly model_id: string;
  readonly revision: number;
  readonly configuration_json: string | null;
}
