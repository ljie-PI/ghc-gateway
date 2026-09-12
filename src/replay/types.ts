import type { InferenceProtocol } from "../protocols/conversion/types.js";

/** Versioned replay exchange format. Response bytes remain the corpus authority. */
export interface ReplayExchangeRecord {
  readonly version: 1;
  readonly caseId: string;
  readonly family: "replay";
  readonly sourceProtocol: InferenceProtocol;
  readonly targetProtocol: InferenceProtocol;
  readonly logicalModel: string;
  readonly upstreamModel: string;
  readonly capturedAt?: string;
  readonly generatedAt?: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly bodyJson?: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly bodyFile: string;
    readonly bodySha256: string;
    readonly stream: boolean;
  };
  readonly downstreamExpectation?: {
    readonly goldenFile?: string;
    readonly expectedOutput?: unknown;
    readonly textSha256?: string;
    readonly minTextChars?: number;
    readonly minTextDeltas?: number;
    readonly expectedToolCall?: { readonly name: string; readonly arguments: string };
    readonly expectedToolCalls?: readonly {
      readonly name: string;
      readonly arguments: unknown;
    }[];
    readonly toolCallsCount?: number;
    readonly hasUsage?: boolean;
    readonly usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly reasoningTokens: number;
      readonly visualTokens: number | "not_reported";
    };
  };
}

export interface ReplayScenarioManifest {
  readonly schemaVersion: 3;
  readonly exchanges: readonly ReplayExchangeRecord[];
}

export interface ReplayScenarioStep {
  readonly ordinal: number;
  readonly caseId: string;
  readonly stream: boolean;
  /** Synchronous, independently authored semantic request predicate. */
  readonly matchesRequest: (body: unknown) => boolean;
}

/** Harness registration is the sole scenario-selection authority. */
export interface ReplayScenario {
  readonly scenarioId: string;
  readonly targetProtocol: InferenceProtocol;
  readonly model: string;
  readonly steps: readonly ReplayScenarioStep[];
}

export interface ReplayReceipt {
  readonly scenarioId: string;
  readonly scenarioStep: number;
  readonly matchedCaseId?: string;
}
