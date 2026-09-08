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
  readonly capturedAt: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly bodyJson?: unknown;
    readonly bodySha256?: string;
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
  };
}

export interface ReplayScenarioManifest {
  readonly schemaVersion: 1;
  readonly description: string;
  readonly items: readonly ReplayExchangeRecord[];
}
