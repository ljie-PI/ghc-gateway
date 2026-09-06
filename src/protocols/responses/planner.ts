import type { CopilotTarget } from "../../copilot/backend.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import { ModelCapabilityUnavailableError } from "../../copilot/model_capabilities.js";
import type { ResolvedModel } from "../model_catalog/resolver.js";
import type { ResponsesRequest } from "./dto.js";

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
}

export function planResponsesExecution(
  request: ResponsesRequest,
  resolvedModel: ResolvedModel,
  target: Readonly<CopilotTarget>,
): ResponsesExecutionPlan {
  const protocols = resolvedModel.capability.protocols.value;
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
