import type { EffectiveModelCapabilitySnapshot } from "../../copilot/capability_registry.js";
import type { WireJson, WireJsonObject } from "../../serialization/wire_json.js";

export type InferenceProtocol = "chat" | "messages" | "responses";

export type ConversionDegradationRule =
  | "cache.control_omitted"
  | "reasoning.budget_coarsened"
  | "reasoning.presentation_omitted"
  | "reasoning.state_omitted"
  | "sampling.top_k_omitted";

export interface SemanticText {
  readonly type: "text";
  readonly text: string;
}

export interface SemanticImage {
  readonly type: "image";
  readonly url: string;
  readonly detail?: "auto" | "low" | "high" | undefined;
}

export interface SemanticRefusal {
  readonly type: "refusal";
  readonly text: string;
}

export type SemanticContent = SemanticText | SemanticImage | SemanticRefusal;

export interface SemanticMessageItem {
  readonly type: "message";
  readonly role: "system" | "developer" | "user" | "assistant";
  readonly content: readonly SemanticContent[];
}

export interface SemanticToolCallItem {
  readonly type: "tool_call";
  readonly key?: string | undefined;
  readonly itemId?: string | undefined;
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface SemanticToolResultItem {
  readonly type: "tool_result";
  readonly callId: string;
  readonly content: readonly SemanticContent[];
  readonly isError: boolean;
}

export type SemanticRequestItem =
  | SemanticMessageItem
  | SemanticToolCallItem
  | SemanticToolResultItem;

export interface SemanticTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters: WireJsonObject;
  readonly strict?: boolean | undefined;
}

export type SemanticToolChoice =
  | { readonly kind: "auto" | "none" | "required" }
  | { readonly kind: "tool"; readonly name: string };

export type SemanticOutputFormat =
  | { readonly kind: "json_object" }
  | {
    readonly kind: "json_schema";
    readonly name: string;
    readonly description?: string | undefined;
    readonly schema: WireJsonObject;
    readonly strict?: boolean | undefined;
  };

export interface SemanticReasoning {
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
}

export interface SemanticRequest {
  readonly source: InferenceProtocol;
  readonly model?: string | undefined;
  readonly stream: boolean;
  readonly instructions: readonly SemanticContent[];
  readonly items: readonly SemanticRequestItem[];
  readonly tools: readonly SemanticTool[];
  readonly toolChoice?: SemanticToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
  readonly stop?: readonly string[] | undefined;
  readonly outputFormat?: SemanticOutputFormat | undefined;
  readonly reasoning?: SemanticReasoning | undefined;
  readonly metadata?: WireJson | undefined;
  readonly degradations: readonly ConversionDegradationRule[];
}

export interface EncodedConversionRequest {
  readonly body: WireJsonObject;
  readonly bytes: Uint8Array;
  readonly stream: boolean;
  readonly hasVisionInput: boolean;
  readonly initiator: "user" | "agent";
  readonly messagesBetaFeatures: readonly (
    | "prompt-caching-2024-07-31"
    | "interleaved-thinking-2025-05-14"
    | "context-1m-2025-08-07"
  )[];
  readonly degradations: readonly ConversionDegradationRule[];
}

export interface NativeProtocolPlan {
  readonly kind: "native";
  readonly source: InferenceProtocol;
  readonly target: InferenceProtocol;
  readonly stream: boolean;
}

export interface ConvertedProtocolPlan {
  readonly kind: "converted";
  readonly source: InferenceProtocol;
  readonly target: InferenceProtocol;
  readonly stream: boolean;
  readonly requestModel: string;
  readonly request: EncodedConversionRequest;
}

export type ProtocolExecutionPlan = NativeProtocolPlan | ConvertedProtocolPlan;

export interface ConversionPlanningInput {
  readonly source: InferenceProtocol;
  readonly body: WireJsonObject;
  readonly stream: boolean;
  readonly capability: EffectiveModelCapabilitySnapshot;
  readonly resolvedModel: string;
  readonly forcedTarget?: InferenceProtocol | undefined;
}

export class ConversionContractError extends Error {
  constructor(
    readonly kind: "invalid_request" | "unsupported_semantics",
    readonly ruleId: string,
  ) {
    super(ruleId);
    this.name = "ConversionContractError";
  }
}

export interface SemanticUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export type SemanticResponseItem =
  | {
    readonly type: "message";
    readonly key?: string | undefined;
    readonly content: readonly (SemanticText | SemanticRefusal)[];
  }
  | SemanticToolCallItem;

export interface SemanticResponse {
  readonly source: InferenceProtocol;
  readonly items: readonly SemanticResponseItem[];
  readonly status: "completed" | "incomplete";
  readonly finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "refusal";
  readonly usage: SemanticUsage;
}

export interface ConversionObservations {
  readonly firstSemantic: boolean;
  readonly usage: SemanticUsage;
  readonly terminal: "completed" | "incomplete";
  readonly degradations: readonly ConversionDegradationRule[];
}

export interface ConversionCheckpointIntent {
  readonly responseId: string;
  readonly output: readonly WireJson[];
  readonly state: "route_only" | "partial" | "complete";
}

export interface ConvertedBufferedResponse {
  readonly body: WireJsonObject;
  readonly bytes: Uint8Array;
  readonly observations: ConversionObservations;
  readonly checkpoint?: ConversionCheckpointIntent | undefined;
}

export type SemanticStreamEvent =
  | { readonly kind: "text_delta"; readonly key: string; readonly delta: string }
  | { readonly kind: "text_done"; readonly key: string; readonly text: string }
  | { readonly kind: "refusal_delta"; readonly key: string; readonly delta: string }
  | { readonly kind: "refusal_done"; readonly key: string; readonly refusal: string }
  | {
    readonly kind: "tool_start";
    readonly key: string;
    readonly itemId?: string | undefined;
    readonly callId: string;
    readonly name: string;
  }
  | { readonly kind: "tool_arguments_delta"; readonly key: string; readonly delta: string }
  | { readonly kind: "tool_done"; readonly key: string; readonly argumentsJson?: string | undefined }
  | { readonly kind: "usage"; readonly usage: SemanticUsage }
  | {
    readonly kind: "terminal";
    readonly status: "completed" | "incomplete";
    readonly finishReason: SemanticResponse["finishReason"];
  };

export type ConvertedStreamEmission =
  | { readonly kind: "wire"; readonly bytes: Uint8Array }
  | { readonly kind: "checkpoint"; readonly intent: ConversionCheckpointIntent }
  | { readonly kind: "first_semantic" }
  | { readonly kind: "usage"; readonly usage: SemanticUsage }
  | { readonly kind: "terminal"; readonly terminal: "completed" | "incomplete" }
  | { readonly kind: "degradation"; readonly ruleId: ConversionDegradationRule };
