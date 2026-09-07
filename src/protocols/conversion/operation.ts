import type { BoundCopilot } from "../../copilot/backend.js";
import { normalizeTransportFailure } from "../../copilot/failures.js";
import {
  MESSAGES_VERSION,
  type UpstreamByteResponse,
  type UpstreamByteStream,
} from "../../copilot/upstream_types.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import type { ConvertedProtocolPlan } from "./types.js";

export async function completeConvertedOperation(
  bound: BoundCopilot,
  plan: Readonly<ConvertedProtocolPlan>,
  scope: Readonly<RequestScope>,
): Promise<UpstreamByteResponse> {
  try {
    if (plan.target === "chat") {
      return await bound.completeChat({
        model: plan.requestModel,
        body: plan.request.bytes,
        stream: false,
        hasVisionInput: plan.request.hasVisionInput,
        ...limits(scope),
      });
    }
    if (plan.target === "messages") {
      return await bound.completeMessages({
        body: plan.request.bytes,
        version: MESSAGES_VERSION,
        betaFeatures: plan.request.messagesBetaFeatures,
        ...limits(scope),
      });
    }
    return await bound.completeResponses({
      body: plan.request.bytes,
      hasVisionInput: plan.request.hasVisionInput,
      initiator: plan.request.initiator,
      requestId: scope.requestId,
      ...limits(scope),
    });
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, scope.signal, { source: "transport", phase: "headers" });
  }
}

export async function openConvertedOperation(
  bound: BoundCopilot,
  plan: Readonly<ConvertedProtocolPlan>,
  scope: Readonly<RequestScope>,
): Promise<UpstreamByteStream> {
  try {
    if (plan.target === "chat") {
      return await bound.openChatStream({
        model: plan.requestModel,
        body: plan.request.bytes,
        stream: true,
        hasVisionInput: plan.request.hasVisionInput,
        ...limits(scope),
      });
    }
    if (plan.target === "messages") {
      return await bound.openMessagesStream({
        body: plan.request.bytes,
        version: MESSAGES_VERSION,
        betaFeatures: plan.request.messagesBetaFeatures,
        ...limits(scope),
      });
    }
    return await bound.openResponsesStream({
      body: plan.request.bytes,
      hasVisionInput: plan.request.hasVisionInput,
      initiator: plan.request.initiator,
      requestId: scope.requestId,
      ...limits(scope),
    });
  } catch (error: unknown) {
    throw normalizeTransportFailure(error, scope.signal, { source: "transport", phase: "headers" });
  }
}

function limits(scope: Readonly<RequestScope>) {
  return {
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  };
}
