import type { InferenceProtocol } from "../protocols/conversion/types.js";

/**
 * Versioned replay exchange format.
 */
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
  /** Shared ordered responses are never eligible for legacy independent matching. */
  readonly selection?: "explicit";
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

/** Response/expectation ownership is upstream-only; matrix callers reuse these IDs. */
export interface ReplayResponseSet {
  readonly id: string;
  readonly targetProtocol: InferenceProtocol;
  readonly exchangeIds: readonly string[];
}

export interface ReplayScenarioManifest {
  readonly schemaVersion: 2;
  readonly exchanges: readonly ReplayExchangeRecord[];
  readonly responseSets: readonly ReplayResponseSet[];
}

export interface ReplayScenarioStep {
  readonly exchangeId: string;
  /**
   * Independently validate significant ordered history, images, tool names/JSON
   * arguments, and result IDs/content. Never derive this predicate by recording
   * gateway requests. Only synchronous boolean true accepts a request; exceptions
   * and all other return values fail closed. Do not retain the supplied body.
   */
  readonly matchesRequest: (body: unknown) => boolean;
}

export interface ReplayScenario {
  readonly id: string;
  readonly steps: readonly ReplayScenarioStep[];
}
