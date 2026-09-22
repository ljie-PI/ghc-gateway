import { performance } from "node:perf_hooks";
import { failureFromUnknown, failureOutcome, type GatewayFailure, type GatewayFailureOrigin } from "../gateway/failures.js";
import { ConversionContractError } from "../protocols/conversion/types.js";

export const DIAGNOSTIC_LIMITS = {
  recordBytes: 16 * 1024,
  requestRecords: 32,
  queueRecords: 256,
  queueBytes: 1024 * 1024,
  shapeNodes: 256,
  shapeDepth: 4,
} as const;

export const DIAGNOSTIC_FIELDS = [
  "model", "messages", "system", "input", "instructions", "output", "choices", "content",
  "max_tokens", "max_completion_tokens", "max_output_tokens", "stream", "stream_options",
  "temperature", "top_p", "top_k", "stop", "stop_sequences", "tools", "tool_choice",
  "parallel_tool_calls", "thinking", "output_config", "reasoning", "reasoning_effort",
  "text", "response_format", "metadata", "cache_control", "context_management",
  "previous_response_id", "store", "background", "n", "usage", "error", "type", "status",
  "message", "delta", "index", "content_block", "sequence_number", "output_index",
  "item", "part", "response", "content_index", "item_id",
] as const;
const VALUE_TYPES = ["missing", "duplicate", "null", "boolean", "number", "string", "array", "object"] as const;
const BLOCK_TYPES = [
  "text", "input_text", "output_text", "image", "input_image", "image_url", "document",
  "tool_use", "tool_result", "tool_call", "function_call", "function_call_output",
  "thinking", "redacted_thinking", "reasoning", "message", "refusal", "unknown",
] as const;
const STAGES = [
  "received", "admission", "request_decode", "request_decoded", "request_validation", "account_binding",
  "model_resolution", "continuation", "planning", "upstream_request", "upstream_headers",
  "upstream_output", "client_output", "stream", "committed", "finished",
] as const;
const EVENTS = ["diagnostics_started", "stage", "request_failed", "request_finished"] as const;
const PROTOCOLS = ["chat", "responses", "messages"] as const;
const OUTCOMES = [
  "success", "client_error", "authentication_error", "overloaded", "upstream_error",
  "timeout", "aborted", "internal_error",
] as const;
const TERMINALS = [
  "semantic_success", "precommit_failure", "postcommit_failure", "client_cancel",
  "request_abort", "total_timeout", "first_byte_timeout", "idle_timeout", "shutdown",
] as const;
const CODES = [
  "anthropic_version_missing", "anthropic_version_unsupported", "anthropic_beta_unsupported",
  "anthropic_beta_conversion_unsupported", "status_only",
] as const;
const MESSAGE_BETAS = ["claude-code-20250219", "prompt-caching-2024-07-31", "interleaved-thinking-2025-05-14", "context-1m-2025-08-07"] as const;
const DEGRADATIONS = [
  "cache.control_omitted", "reasoning.budget_coarsened", "reasoning.presentation_omitted",
  "reasoning.state_omitted", "sampling.top_k_omitted",
] as const;
const REASONING_EFFORTS = ["missing", "unknown", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_SUMMARIES = ["missing", "unknown", "auto", "concise", "detailed"] as const;
const PROTOCOL_STATUSES = ["completed", "incomplete", "failed", "error", "in_progress", "queued", "cancelled", "unknown"] as const;
const SSE_TYPES = [
  "chunk", "done", "error", "ping", "message_start", "message_delta", "message_stop",
  "content_block_start", "content_block_delta", "content_block_stop",
  "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed",
  "response.output_item.added", "response.output_item.done", "response.content_part.added",
  "response.content_part.done", "response.output_text.delta", "response.output_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "unknown",
  "response.reasoning_text.delta", "response.reasoning_text.done",
] as const;

export interface DiagnosticShape {
  readonly fields: Partial<Record<typeof DIAGNOSTIC_FIELDS[number], typeof VALUE_TYPES[number]>>;
  readonly counts: {
    readonly messages?: number;
    readonly tools?: number;
    readonly input?: number;
    readonly output?: number;
    readonly choices?: number;
    readonly unknownFields?: number;
  };
  readonly blocks: Partial<Record<typeof BLOCK_TYPES[number], number>>;
  readonly truncated: boolean;
}

export interface DiagnosticFields {
  readonly clientProtocol?: typeof PROTOCOLS[number];
  readonly upstreamProtocol?: typeof PROTOCOLS[number];
  readonly candidateProtocol?: typeof PROTOCOLS[number];
  readonly ruleId?: string;
  readonly model?: string;
  readonly stream?: boolean;
  readonly converted?: boolean;
  readonly httpStatus?: number;
  readonly upstreamStatus?: number;
  readonly code?: typeof CODES[number];
  readonly messagesVersion?: "missing" | "supported" | "unsupported";
  readonly messagesBetas?: readonly typeof MESSAGE_BETAS[number][];
  readonly unknownBetaCount?: number;
  readonly degradations?: readonly typeof DEGRADATIONS[number][];
  readonly reasoningEffort?: typeof REASONING_EFFORTS[number];
  readonly reasoningSummary?: typeof REASONING_SUMMARIES[number];
  readonly reasoningTokens?: number;
  readonly protocolStatus?: typeof PROTOCOL_STATUSES[number];
  readonly shape?: DiagnosticShape;
}

export interface DiagnosticRecord extends DiagnosticFields {
  readonly schemaVersion: 1;
  readonly ts: number;
  readonly event: typeof EVENTS[number];
  readonly requestId?: string;
  readonly seq?: number;
  readonly stage?: typeof STAGES[number];
  readonly elapsedMs?: number;
  readonly outcome?: typeof OUTCOMES[number];
  readonly failure?: Readonly<Pick<GatewayFailure, "kind" | "source" | "phase"> & { readonly ruleId?: string }>;
  readonly terminalCause?: typeof TERMINALS[number];
  readonly upstreamBytes?: number;
  readonly clientBytes?: number;
  readonly sse?: Partial<Record<typeof SSE_TYPES[number], number>>;
  readonly omittedRecords?: number;
}

export interface DiagnosticsStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "recording" | "degraded" | "failed";
  readonly pendingRecords: number;
  readonly droppedRecords: number;
  readonly reason?: "queue_full" | "record_limit" | "record_invalid" | "io_error" | "observer_error" | "shutdown";
}

export interface DiagnosticSink {
  write(record: Readonly<DiagnosticRecord>): void;
}

export interface RequestDiagnostics {
  set(fields: Readonly<DiagnosticFields>): void;
  stage(stage: typeof STAGES[number], fields?: Readonly<DiagnosticFields>): void;
  observe(work: () => void): void;
  shape(stage: typeof STAGES[number], work: () => DiagnosticShape): void;
  event(type: string): void;
  bytes(side: "upstream" | "client", size: number): void;
  failure(error: unknown, origin?: Readonly<GatewayFailureOrigin>): void;
  outcome(outcome: typeof OUTCOMES[number]): void;
  terminal(cause: typeof TERMINALS[number]): void;
  finish(): void;
}

export const DISABLED_DIAGNOSTICS: DiagnosticsStatus = Object.freeze({
  enabled: false, state: "disabled", pendingRecords: 0, droppedRecords: 0,
});

export function parseDiagnosticsStatus(value: unknown): DiagnosticsStatus | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") throw new Error("invalid diagnostics status");
  const input = value as Record<string, unknown>;
  const state = member(["disabled", "recording", "degraded", "failed"] as const, input.state);
  const reason = member(["queue_full", "record_limit", "record_invalid", "io_error", "observer_error", "shutdown"] as const, input.reason);
  if (typeof input.enabled !== "boolean" || state === undefined
    || (input.enabled === (state === "disabled"))
    || !count(input.pendingRecords) || !count(input.droppedRecords)
    || (input.reason !== undefined && reason === undefined)) throw new Error("invalid diagnostics status");
  return {
    enabled: input.enabled, state, pendingRecords: input.pendingRecords, droppedRecords: input.droppedRecords,
    ...(reason === undefined ? {} : { reason }),
  };
}

export class DiagnosticRecorder {
  private readonly queue: Array<{ readonly record: DiagnosticRecord; readonly bytes: number }> = [];
  private queueBytes = 0;
  private dropped = 0;
  private state: DiagnosticsStatus["state"] = "recording";
  private reason: DiagnosticsStatus["reason"];
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private closing = false;
  private drainPromise: Promise<void> | undefined;
  private resolveDrained: (() => void) | undefined;

  constructor(
    private readonly sink: DiagnosticSink,
    private readonly options: {
      readonly nowMs?: () => number;
      readonly monotonicNowMs?: () => number;
      readonly onFailure?: () => void;
    } = {},
  ) {
    this.sink.write({ schemaVersion: 1, ts: this.now(), event: "diagnostics_started" });
  }

  snapshot(): DiagnosticsStatus {
    return {
      enabled: true, state: this.state, pendingRecords: this.queue.length, droppedRecords: this.dropped,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }

  begin(requestId: string, clientProtocol: DiagnosticFields["clientProtocol"]): RequestDiagnostics {
    let started = 0;
    if (this.state !== "failed" && !this.closing) {
      try { started = this.clock(); } catch { this.fail("observer_error"); }
    }
    let fields: DiagnosticFields = clientProtocol === undefined ? {} : { clientProtocol };
    let stage: DiagnosticRecord["stage"] = "received";
    let seq = 0;
    let omitted = 0;
    let finished = false;
    let failure: DiagnosticRecord["failure"];
    let failureSeen = false;
    let outcome: DiagnosticRecord["outcome"];
    let terminalCause: DiagnosticRecord["terminalCause"];
    let upstreamBytes = 0;
    let clientBytes = 0;
    const sse: NonNullable<DiagnosticRecord["sse"]> = {};
    const shapeStages = new Set<NonNullable<DiagnosticRecord["stage"]>>();
    const emit = (event: DiagnosticRecord["event"], extra: Partial<DiagnosticRecord> = {}): void => {
      if (finished) return;
      if (event === "stage" && seq >= DIAGNOSTIC_LIMITS.requestRecords - 2) {
        omitted = increment(omitted, 1);
        this.drop("record_limit");
        return;
      }
      this.enqueue({
        schemaVersion: 1, ts: this.now(), requestId, seq: ++seq, event,
        ...(stage === undefined ? {} : { stage }),
        elapsedMs: Math.max(0, this.clock() - started), ...fields, ...extra,
      });
    };
    const observe = (work: () => void): void => {
      if (finished || this.state === "failed" || this.closing) return;
      try { work(); } catch { this.fail("observer_error"); }
    };
    const record = (work: () => void): void => {
      if (finished) return;
      if (this.state === "failed" || this.closing) {
        this.drop(this.state === "failed" ? this.reason ?? "observer_error" : "shutdown");
        return;
      }
      try { work(); } catch {
        this.dropped = increment(this.dropped, 1);
        this.fail("observer_error");
      }
    };
    const trace: RequestDiagnostics = {
      set: (value) => observe(() => { fields = { ...fields, ...sanitizeDiagnosticFields(value) }; }),
      stage: (value, extra = {}) => record(() => {
        stage = value;
        emit("stage", sanitizeDiagnosticFields(extra));
      }),
      observe,
      shape: (value, work) => {
        if (finished || shapeStages.has(value)) return;
        shapeStages.add(value);
        record(() => {
          const shape = work();
          stage = value;
          emit("stage", { shape });
        });
      },
      event: (type) => observe(() => {
        const key = member(SSE_TYPES, type) ?? "unknown";
        sse[key] = increment(sse[key] ?? 0, 1);
      }),
      bytes: (side, size) => observe(() => {
        if (side === "upstream") upstreamBytes = increment(upstreamBytes, size);
        else clientBytes = increment(clientBytes, size);
      }),
      failure: (error, origin) => {
        if (finished || failureSeen) return;
        failureSeen = true;
        record(() => {
          const value = failureFromUnknown(error, origin ?? diagnosticOrigin(stage, fields.stream));
          const cause = value.cause;
          failure = {
            kind: value.kind,
            ...(value.source === undefined ? {} : { source: value.source }),
            ...(value.phase === undefined ? {} : { phase: value.phase }),
            ...(cause instanceof ConversionContractError && /^REQ-[A-Z0-9-]{1,100}$/u.test(cause.ruleId)
              ? { ruleId: cause.ruleId } : {}),
          };
          outcome = failureOutcome(value);
          emit("request_failed", { failure, outcome });
        });
      },
      outcome: (value) => observe(() => { if (failure === undefined) outcome = value; }),
      terminal: (value) => observe(() => { terminalCause ??= value; }),
      finish: () => {
        if (finished) return;
        record(() => {
          stage = "finished";
          emit("request_finished", {
            outcome: outcome ?? "success", upstreamBytes, clientBytes, sse, omittedRecords: omitted,
            ...(failure === undefined ? {} : { failure }),
            ...(terminalCause === undefined ? {} : { terminalCause }),
          });
        });
        finished = true;
      },
    };
    trace.stage("received");
    return trace;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.queue.length > 0) {
      this.drainPromise ??= new Promise<void>((resolve) => { this.resolveDrained = resolve; });
      await this.drainPromise;
    }
  }

  forceClose(): void {
    this.closing = true;
    if (this.queue.length > 0) this.drop("shutdown", this.queue.length);
    this.clear();
  }

  private now(): number { return this.options.nowMs?.() ?? Date.now(); }
  private clock(): number { return this.options.monotonicNowMs?.() ?? performance.now(); }

  private enqueue(record: DiagnosticRecord): void {
    if (this.state === "failed" || this.closing) {
      this.dropped = increment(this.dropped, 1);
      return;
    }
    const clean = sanitizeDiagnosticRecord(record);
    const bytes = Buffer.byteLength(JSON.stringify(clean), "utf8") + 1;
    if (bytes > DIAGNOSTIC_LIMITS.recordBytes) {
      this.drop("record_invalid");
      return;
    }
    const priority = record.event === "request_failed" || record.event === "request_finished";
    while (this.queue.length >= DIAGNOSTIC_LIMITS.queueRecords || this.queueBytes + bytes > DIAGNOSTIC_LIMITS.queueBytes) {
      const index = priority ? this.queue.findIndex((entry) => entry.record.event === "stage") : -1;
      if (index < 0) { this.drop("queue_full"); return; }
      const [removed] = this.queue.splice(index, 1);
      this.queueBytes -= removed!.bytes;
      this.drop("queue_full");
    }
    this.queue.push({ record: clean, bytes });
    this.queueBytes += bytes;
    this.scheduled ??= setImmediate(() => this.drain());
  }

  private drain(): void {
    this.scheduled = undefined;
    const entry = this.queue.shift();
    if (entry !== undefined) {
      this.queueBytes -= entry.bytes;
      try { this.sink.write(entry.record); }
      catch { this.dropped = increment(this.dropped, 1); this.fail("io_error"); return; }
    }
    if (this.queue.length > 0) this.scheduled = setImmediate(() => this.drain());
    else this.resolveDrain();
  }

  private drop(reason: NonNullable<DiagnosticsStatus["reason"]>, count = 1): void {
    this.dropped = increment(this.dropped, count);
    if (this.state !== "failed") { this.state = "degraded"; this.reason = reason; }
  }

  private fail(reason: "observer_error" | "io_error"): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.reason = reason;
    this.dropped = increment(this.dropped, this.queue.length);
    this.clear();
    try { this.options.onFailure?.(); } catch { /* Status remains observable when the warning sink also fails. */ }
  }

  private clear(): void {
    if (this.scheduled !== undefined) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.queue.length = 0;
    this.queueBytes = 0;
    this.resolveDrain();
  }

  private resolveDrain(): void {
    this.resolveDrained?.();
    this.resolveDrained = undefined;
  }
}

export function sanitizeDiagnosticRecord(record: Readonly<DiagnosticRecord>): DiagnosticRecord {
  const result: DiagnosticRecord = {
    schemaVersion: 1, ts: finite(record.ts), event: member(EVENTS, record.event) ?? "stage",
    ...sanitizeDiagnosticFields(record),
    ...(typeof record.requestId === "string" && /^req_[A-Za-z0-9_-]{1,128}$/u.test(record.requestId) ? { requestId: record.requestId } : {}),
    ...(record.seq === undefined ? {} : { seq: finite(record.seq) }),
    ...(member(STAGES, record.stage) === undefined ? {} : { stage: member(STAGES, record.stage)! }),
    ...(record.elapsedMs === undefined ? {} : { elapsedMs: finite(record.elapsedMs) }),
    ...(member(OUTCOMES, record.outcome) === undefined ? {} : { outcome: member(OUTCOMES, record.outcome)! }),
    ...(member(TERMINALS, record.terminalCause) === undefined ? {} : { terminalCause: member(TERMINALS, record.terminalCause)! }),
    ...(record.upstreamBytes === undefined ? {} : { upstreamBytes: finite(record.upstreamBytes) }),
    ...(record.clientBytes === undefined ? {} : { clientBytes: finite(record.clientBytes) }),
    ...(record.omittedRecords === undefined ? {} : { omittedRecords: finite(record.omittedRecords) }),
    ...(record.sse === undefined ? {} : { sse: safeCounts(SSE_TYPES, record.sse) }),
    ...(record.failure === undefined ? {} : { failure: safeFailure(record.failure) }),
  };
  return result;
}

function sanitizeDiagnosticFields(value: Readonly<DiagnosticFields>): DiagnosticFields {
  return {
    ...(member(PROTOCOLS, value.clientProtocol) === undefined ? {} : { clientProtocol: member(PROTOCOLS, value.clientProtocol)! }),
    ...(member(PROTOCOLS, value.upstreamProtocol) === undefined ? {} : { upstreamProtocol: member(PROTOCOLS, value.upstreamProtocol)! }),
    ...(member(PROTOCOLS, value.candidateProtocol) === undefined ? {} : { candidateProtocol: member(PROTOCOLS, value.candidateProtocol)! }),
    ...(typeof value.ruleId === "string" && /^REQ-[A-Z0-9-]{1,100}$/u.test(value.ruleId) ? { ruleId: value.ruleId } : {}),
    ...(typeof value.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.model) ? { model: value.model } : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    ...(typeof value.converted === "boolean" ? { converted: value.converted } : {}),
    ...(httpStatus(value.httpStatus) ? { httpStatus: value.httpStatus } : {}),
    ...(httpStatus(value.upstreamStatus) ? { upstreamStatus: value.upstreamStatus } : {}),
    ...(member(CODES, value.code) === undefined ? {} : { code: member(CODES, value.code)! }),
    ...(member(["missing", "supported", "unsupported"] as const, value.messagesVersion) === undefined
      ? {} : { messagesVersion: value.messagesVersion }),
    ...(value.messagesBetas === undefined ? {} : { messagesBetas: MESSAGE_BETAS.filter((item) => value.messagesBetas?.slice(0, MESSAGE_BETAS.length).includes(item)) }),
    ...(value.unknownBetaCount === undefined ? {} : { unknownBetaCount: finite(value.unknownBetaCount) }),
    ...(value.degradations === undefined ? {} : { degradations: DEGRADATIONS.filter((item) => value.degradations?.slice(0, 5).includes(item)) }),
    ...(member(REASONING_EFFORTS, value.reasoningEffort) === undefined ? {} : { reasoningEffort: member(REASONING_EFFORTS, value.reasoningEffort)! }),
    ...(member(REASONING_SUMMARIES, value.reasoningSummary) === undefined ? {} : { reasoningSummary: member(REASONING_SUMMARIES, value.reasoningSummary)! }),
    ...(count(value.reasoningTokens) ? { reasoningTokens: value.reasoningTokens } : {}),
    ...(member(PROTOCOL_STATUSES, value.protocolStatus) === undefined ? {} : { protocolStatus: member(PROTOCOL_STATUSES, value.protocolStatus)! }),
    ...(value.shape === undefined ? {} : { shape: {
      fields: Object.fromEntries(DIAGNOSTIC_FIELDS.flatMap((key) => {
        const type = member(VALUE_TYPES, value.shape?.fields[key]);
        return type === undefined ? [] : [[key, type]];
      })),
      counts: safeCounts(["messages", "tools", "input", "output", "choices", "unknownFields"] as const, value.shape.counts),
      blocks: safeCounts(BLOCK_TYPES, value.shape.blocks),
      truncated: value.shape.truncated === true,
    } }),
  };
}

function safeFailure(value: NonNullable<DiagnosticRecord["failure"]>): NonNullable<DiagnosticRecord["failure"]> {
  const kinds = [
    "invalid_request", "body_too_large", "unsupported_media_type", "unsupported_semantics",
    "authentication", "permission", "model_not_found", "continuation_conflict", "continuation_unavailable",
    "continuation_persistence", "queue_full", "queue_timeout", "upstream_http", "upstream_timeout",
    "upstream_network", "upstream_stream_error", "upstream_stream_truncated", "invalid_upstream_response",
    "invalid_tool_arguments", "invalid_logprobs", "aborted", "internal",
  ] as const;
  const sources = ["request", "account", "credential", "catalog", "transport", "parser", "converter", "continuation", "gateway"] as const;
  const phases = ["decode", "bind", "refresh", "discover", "connect", "headers", "body", "stream", "parse", "convert", "resume", "admission", "deadline", "internal"] as const;
  return {
    kind: member(kinds, value.kind) ?? "internal",
    ...(member(sources, value.source) === undefined ? {} : { source: member(sources, value.source)! }),
    ...(member(phases, value.phase) === undefined ? {} : { phase: member(phases, value.phase)! }),
    ...(typeof value.ruleId === "string" && /^REQ-[A-Z0-9-]{1,100}$/u.test(value.ruleId) ? { ruleId: value.ruleId } : {}),
  };
}

function diagnosticOrigin(stage: DiagnosticRecord["stage"], stream: boolean | undefined): GatewayFailureOrigin {
  if (stage === "admission") return { source: "gateway", phase: "admission" };
  if (stage === "request_decode" || stage === "request_decoded" || stage === "request_validation") return { source: "request", phase: "decode" };
  if (stage === "account_binding") return { source: "account", phase: "bind" };
  if (stage === "model_resolution") return { source: "catalog", phase: "discover" };
  if (stage === "continuation") return { source: "continuation", phase: "resume" };
  if (stage === "planning") return { source: "converter", phase: "convert" };
  if (stage === "upstream_request" || stage === "upstream_headers") return { source: "transport", phase: "headers" };
  if (stage === "upstream_output" || stage === "stream") return { source: "parser", phase: stream === true ? "stream" : "body" };
  return { source: "gateway", phase: "internal" };
}

function safeCounts<T extends string>(keys: readonly T[], values: Partial<Record<T, number>>): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const key of keys) {
    if (values[key] !== undefined) result[key] = finite(values[key]);
  }
  return result;
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function httpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value)) : 0;
}

function increment(value: number, amount: number): number { return finite(value + finite(amount)); }
