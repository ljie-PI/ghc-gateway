import type { EffectiveModelCapabilitySnapshot } from "../../copilot/capability_registry.js";
import type { SupportedReasoningEffort } from "../../copilot/model_capabilities.js";
import type { WireJson, WireJsonObject } from "../../serialization/wire_json.js";
import type { RequestDiagnostics } from "../../telemetry/diagnostics.js";
import type {
  ReasoningCarrierBinding,
  ReasoningCarrierRecord,
  ReasoningCarrierStore,
} from "./reasoning_carriers.js";
import type { ConversionDegradationRule } from "./degradations.js";

export type { ConversionDegradationRule } from "./degradations.js";

export type InferenceProtocol = "chat" | "messages" | "responses";

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
  readonly sourceKind?: "function" | "namespace" | "custom" | "tool_search" | undefined;
  readonly sourceName?: string | undefined;
  readonly namespace?: string | undefined;
  readonly rawCustomInput?: string | undefined;
  readonly toolSearchArguments?: WireJsonObject | undefined;
  readonly status?: "completed" | "incomplete" | "in_progress" | "failed" | undefined;
}

export interface SemanticToolResultItem {
  readonly type: "tool_result";
  readonly itemId?: string | undefined;
  readonly callId: string;
  readonly content: readonly SemanticContent[];
  readonly isError: boolean;
  readonly status?: "completed" | "incomplete" | "in_progress" | "failed" | undefined;
}

export type SemanticOpaqueReasoningState =
  | { readonly kind: "responses_item"; readonly item: WireJsonObject }
  | { readonly kind: "messages_block"; readonly block: WireJsonObject }
  | { readonly kind: "chat_state"; readonly state: WireJsonObject };

export interface SemanticReasoningRequestItem {
  readonly type: "reasoning";
  readonly parts: readonly SemanticReasoningPart[];
  readonly opaqueState?: SemanticOpaqueReasoningState | undefined;
}

export type SemanticRequestItem =
  | SemanticMessageItem
  | SemanticReasoningRequestItem
  | SemanticToolCallItem
  | SemanticToolResultItem;

export interface SemanticTool {
  readonly kind: "function" | "namespace" | "custom" | "tool_search";
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters: WireJsonObject;
  readonly strict?: boolean | undefined;
  readonly sourceName?: string | undefined;
  readonly namespace?: string | undefined;
}

export interface ResponsesToolSourceBinding {
  readonly kind: "function" | "namespace" | "custom" | "tool_search";
  readonly chatName: string;
  readonly sourceName: string;
  readonly namespace?: string | undefined;
}

export interface ResponsesToolCallBinding extends ResponsesToolSourceBinding {
  readonly callId: string;
  readonly itemId?: string | undefined;
  readonly status?: "completed" | "incomplete" | "in_progress" | "failed" | undefined;
  readonly rawCustomInput?: string | undefined;
  readonly toolSearchArguments?: WireJsonObject | undefined;
}

export interface ResponsesToolResultBinding {
  readonly kind: ResponsesToolSourceBinding["kind"];
  readonly callId: string;
  readonly itemId?: string | undefined;
  readonly status?: "completed" | "incomplete" | "in_progress" | "failed" | undefined;
}

export interface ResponsesToolBindingLedger {
  readonly kind: "responses_extended_tools";
  readonly bindings: readonly ResponsesToolSourceBinding[];
  readonly calls: readonly ResponsesToolCallBinding[];
  readonly results: readonly ResponsesToolResultBinding[];
  readonly chatMessages: readonly WireJsonObject[];
  readonly chatPrefixMembers: readonly { readonly key: string; readonly value: WireJson }[];
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
  readonly effort?: SupportedReasoningEffort | undefined;
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
  readonly responseBindings?: ResponsesToolBindingLedger | undefined;
  readonly carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord> | undefined;
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
  readonly responseBindings?: ResponsesToolBindingLedger | undefined;
  readonly carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord> | undefined;
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
  readonly diagnostics?: RequestDiagnostics | undefined;
  readonly source: InferenceProtocol;
  readonly body: WireJsonObject;
  readonly stream: boolean;
  readonly capability: EffectiveModelCapabilitySnapshot;
  readonly resolvedModel: string;
  readonly forcedTarget?: InferenceProtocol | undefined;
  readonly carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord> | undefined;
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
  readonly reportedReasoningTokens?: number;
}

export type SemanticReasoningPresentation = "summary" | "content";

export type SemanticMessagesReasoningState =
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string };

export interface SemanticReasoningPart {
  readonly key?: string | undefined;
  readonly presentation: SemanticReasoningPresentation;
  readonly index: number;
  readonly text: string;
}

export interface SemanticReasoningItem {
  readonly type: "reasoning";
  readonly key?: string | undefined;
  readonly itemId?: string | undefined;
  readonly parts: readonly SemanticReasoningPart[];
  readonly status?: "completed" | "incomplete" | "in_progress" | undefined;
  readonly hasOpaqueState: boolean;
  readonly messagesState?: SemanticMessagesReasoningState | undefined;
  readonly opaqueState?: SemanticOpaqueReasoningState | undefined;
}

export type SemanticResponseItem =
  | {
    readonly type: "message";
    readonly key?: string | undefined;
    readonly contentKeys?: readonly string[] | undefined;
    readonly content: readonly (SemanticText | SemanticRefusal)[];
  }
  | SemanticReasoningItem
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
  readonly carrierTokens?: readonly string[] | undefined;
}

export interface ReasoningCarrierConversionContext {
  readonly store: ReasoningCarrierStore;
  readonly binding: ReasoningCarrierBinding;
  readonly responseId?: string | undefined;
  readonly stream: boolean;
  readonly onCreated?: ((token: string) => void) | undefined;
}

export interface ConvertedBufferedResponse {
  readonly body: WireJsonObject;
  readonly bytes: Uint8Array;
  readonly observations: ConversionObservations;
  readonly checkpoint?: ConversionCheckpointIntent | undefined;
}

export type SemanticStreamEvent =
  | { readonly kind: "semantic_progress" }
  | {
    readonly kind: "reasoning_start";
    readonly key: string;
    readonly itemId?: string | undefined;
    readonly messagesState?: SemanticMessagesReasoningState | undefined;
    readonly opaqueState?: SemanticOpaqueReasoningState | undefined;
  }
  | {
    readonly kind: "reasoning_delta";
    readonly key: string;
    readonly partKey: string;
    readonly itemId?: string | undefined;
    readonly presentation: SemanticReasoningPresentation;
    readonly partIndex: number;
    readonly delta: string;
  }
  | {
    readonly kind: "reasoning_snapshot";
    readonly key: string;
    readonly partKey: string;
    readonly itemId?: string | undefined;
    readonly presentation: SemanticReasoningPresentation;
    readonly partIndex: number;
    readonly text: string;
  }
  | {
    readonly kind: "reasoning_done";
    readonly key: string;
    readonly status: "completed" | "incomplete" | "in_progress";
  }
  | { readonly kind: "message_start"; readonly key: string }
  | { readonly kind: "text_delta"; readonly key: string; readonly orderKey?: string | undefined; readonly delta: string }
  | { readonly kind: "text_done"; readonly key: string; readonly orderKey?: string | undefined; readonly text: string }
  | { readonly kind: "refusal_delta"; readonly key: string; readonly orderKey?: string | undefined; readonly delta: string }
  | { readonly kind: "refusal_done"; readonly key: string; readonly orderKey?: string | undefined; readonly refusal: string }
  | { readonly kind: "content_done"; readonly key: string; readonly orderKey: string; readonly contentIndex: number }
  | { readonly kind: "item_done"; readonly outputIndex: number; readonly itemType: string }
  | {
    readonly kind: "tool_start";
    readonly key: string;
    readonly itemId?: string | undefined;
    readonly callId: string;
    readonly name: string;
  }
  | { readonly kind: "tool_arguments_delta"; readonly key: string; readonly delta: string }
  | {
    readonly kind: "tool_done";
    readonly key: string;
    readonly argumentsJson?: string | undefined;
    readonly completed?: boolean | undefined;
  }
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
