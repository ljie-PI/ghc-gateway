import type { InferenceProtocol } from "../../../src/protocols/conversion/types.js";

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
  /** Historical recording metadata only; never executable scenario selection. */
  readonly selection?: "explicit";
  readonly request: {
    readonly method: string;
    readonly path: string;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly bodyFile: string;
    readonly bodySha256: string;
    readonly stream: boolean;
  };
}

/** Historical recording grouping only; harness registration owns executable scenarios. */
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
