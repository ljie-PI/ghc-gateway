import {
  failureFromUnknown,
  failureOutcome,
  type GatewayFailureOutcome,
} from "./failures.js";
import type {
  TelemetryProtocol,
  TelemetryRecorder,
  UsageUpdate,
} from "../telemetry/recorder.js";

export interface AttemptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
}

export interface RequestAttempt {
  readonly enabled: boolean;
  readonly finalized: boolean;
  readonly prepared: boolean;
  readonly handedOff: boolean;
  readonly committed: boolean;
  setAccount(accountId: string): void;
  setRequestedModel(model: string): void;
  setResolvedModel(model: string): void;
  setProtocol(protocol: TelemetryProtocol): void;
  observeUsage(usage: Readonly<AttemptUsage>): void;
  markPrepared(): void;
  markHandedOff(): void;
  markCommitted(): void;
  finish(outcome: UsageUpdate["outcome"], usage: Readonly<AttemptUsage>): void;
  success(usage?: Readonly<AttemptUsage>): void;
  failure(error: unknown): void;
}

export interface RequestAttemptOptions {
  readonly requestId: string;
  readonly protocol: TelemetryProtocol;
  readonly recorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly nowMs?: () => number;
  readonly abortedErrorCount: 0 | 1;
}

const ZERO_USAGE: AttemptUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheTokens: 0,
};

export function createRequestAttempt(options: Readonly<RequestAttemptOptions>): RequestAttempt {
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  let accountId = "unbound";
  let requestedModel: string | undefined;
  let resolvedModel: string | undefined;
  let protocol = options.protocol;
  let observedUsage = ZERO_USAGE;
  let prepared = false;
  let handedOff = false;
  let committed = false;
  let finalized = false;

  const finish = (outcome: UsageUpdate["outcome"], usage: Readonly<AttemptUsage>): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    const occurredAtMs = nowMs();
    try {
      options.recorder?.recordUsage({
        occurredAtMs,
        accountId,
        protocol,
        resolvedModel: resolvedModel ?? requestedModel ?? "unresolved",
        outcome,
        requestCount: 1,
        errorCount: errorCount(outcome, options.abortedErrorCount),
        ...usage,
        latencyMs: Math.max(0, occurredAtMs - startedAtMs),
      });
    } catch (_error: unknown) {
      // Telemetry cannot alter an already claimed request outcome.
    }
  };

  return {
    get enabled(): boolean {
      return options.recorder !== undefined;
    },
    get finalized(): boolean {
      return finalized;
    },
    get prepared(): boolean {
      return prepared;
    },
    get handedOff(): boolean {
      return handedOff;
    },
    get committed(): boolean {
      return committed;
    },
    setAccount(value): void {
      if (accountId === "unbound" && value.length > 0) {
        accountId = value;
      }
    },
    setRequestedModel(value): void {
      if (requestedModel === undefined && resolvedModel === undefined && value.length > 0) {
        requestedModel = value;
      }
    },
    setResolvedModel(value): void {
      if (resolvedModel === undefined && value.length > 0) {
        resolvedModel = value;
      }
    },
    setProtocol(value): void {
      if (protocol === "openai_responses_unknown") {
        protocol = value;
      }
    },
    observeUsage(value): void {
      observedUsage = value;
    },
    markPrepared(): void {
      prepared = true;
    },
    markHandedOff(): void {
      if (prepared) {
        handedOff = true;
      }
    },
    markCommitted(): void {
      if (handedOff) {
        committed = true;
      }
    },
    finish,
    success(value = observedUsage): void {
      finish("success", value);
    },
    failure(error): void {
      finish(
        failureOutcome(failureFromUnknown(error, { source: "gateway", phase: "internal" })),
        ZERO_USAGE,
      );
    },
  };
}

function errorCount(outcome: GatewayFailureOutcome | "success", abortedErrorCount: 0 | 1): number {
  if (outcome === "success") {
    return 0;
  }
  return outcome === "aborted" ? abortedErrorCount : 1;
}
