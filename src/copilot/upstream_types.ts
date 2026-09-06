export interface UpstreamRequestLimits {
  readonly nonstreamBodyBytes: number;
  readonly connectTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface NativeResponsesUpstreamRequest extends UpstreamRequestLimits {
  readonly body: Uint8Array;
  readonly hasVisionInput: boolean;
  readonly initiator: "user" | "agent";
  readonly requestId: string;
}

export const MESSAGES_VERSION = "2023-06-01" as const;

export type MessagesVersion = typeof MESSAGES_VERSION;

export type MessagesBetaFeature =
  | "prompt-caching-2024-07-31"
  | "interleaved-thinking-2025-05-14"
  | "context-1m-2025-08-07";

export interface MessagesUpstreamRequest extends UpstreamRequestLimits {
  readonly body: Uint8Array;
  readonly version: MessagesVersion;
  readonly betaFeatures: readonly MessagesBetaFeature[];
}

export interface UpstreamByteResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface UpstreamByteStream {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}
