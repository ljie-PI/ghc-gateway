import type { CopilotTarget } from "../../copilot/backend.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import { ModelCapabilityUnavailableError } from "../../copilot/model_capabilities.js";
import type { ResolvedModel } from "../model_catalog/resolver.js";
import type { ResponsesRequest } from "./dto.js";
import type { ResponsesRouteReceipt } from "./history.js";

export type ResponsesExecutionPlan = NativeResponsesPlan | ChatBridgePlan;

export interface NativeResponsesPlan {
  readonly kind: "native_responses";
  readonly originalRequest: ResponsesRequest;
  readonly resolvedModel: ResolvedModel;
  readonly upstreamUrl: string;
  readonly stream: boolean;
}

export interface ChatBridgePlan {
  readonly kind: "chat_bridge";
  readonly originalRequest: ResponsesRequest;
  readonly resolvedModel: ResolvedModel;
  readonly continuation?: ResponsesRouteReceipt;
}

export function planResponsesExecution(
  request: ResponsesRequest,
  resolvedModel: ResolvedModel,
  target: Readonly<CopilotTarget>,
  continuation?: Readonly<ResponsesRouteReceipt>,
): ResponsesExecutionPlan {
  const protocols = resolvedModel.capability.protocols.value;
  if (continuation !== undefined) {
    if (continuation.upstreamProtocol === "responses" && protocols?.includes("responses") === true) {
      return {
        kind: "native_responses",
        originalRequest: request,
        resolvedModel,
        upstreamUrl: responsesUpstreamUrl(target.endpoint),
        stream: request.stream,
      };
    }
    if (continuation.upstreamProtocol === "chat" && protocols?.includes("chat") === true) {
      return { kind: "chat_bridge", originalRequest: request, resolvedModel, continuation };
    }
    throw new GatewayFailureError({
      kind: "continuation_conflict",
      source: "continuation",
      phase: "resume",
    });
  }
  if (protocols?.includes("responses") === true) {
    return {
      kind: "native_responses",
      originalRequest: request,
      resolvedModel,
      upstreamUrl: responsesUpstreamUrl(target.endpoint),
      stream: request.stream,
    };
  }
  if (protocols?.includes("chat") === true) {
    return { kind: "chat_bridge", originalRequest: request, resolvedModel };
  }
  throw new GatewayFailureError({
    kind: "unsupported_semantics",
    cause: new ModelCapabilityUnavailableError(),
  });
}

export function responsesUpstreamUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, "")}/responses`;
}
