export interface UpstreamRequestLimits {
  readonly nonstreamBodyBytes: number;
  readonly connectTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface ChatCompletionsUpstreamRequest extends UpstreamRequestLimits {
  readonly model: string;
  readonly body: Uint8Array;
  readonly stream: boolean;
  readonly hasVisionInput: boolean;
}

export interface NativeResponsesUpstreamRequest extends UpstreamRequestLimits {
  readonly body: Uint8Array;
  readonly hasVisionInput: boolean;
  readonly initiator: "user" | "agent";
  readonly requestId: string;
}

export const MESSAGES_VERSION = "2023-06-01" as const;

export type MessagesVersion = typeof MESSAGES_VERSION;

export const MESSAGES_BETA_FEATURES = [
  "claude-code-20250219",
  "prompt-caching-2024-07-31",
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
] as const;

export type MessagesBetaFeature = typeof MESSAGES_BETA_FEATURES[number];

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
