import {
  failureFromSignal,
  GatewayFailureError,
} from "../../gateway/failures.js";
import {
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { isGatewayManagedResponseId } from "./bridge_nonstream.js";
import {
  RESPONSES_CHAT_CONVERSION_VERSION,
  RESPONSES_MESSAGES_CONVERSION_VERSION,
  ResponsesContinuationError,
  type ResponsesContinuationOwnership,
  type ResponsesContinuationResolution,
  type ResponsesHistory,
  type ResponsesRouteReceipt,
} from "./history.js";

type ResponsesPlanKind = "native_responses" | "chat_bridge" | "messages_bridge";

export async function resolveResponsesContinuation(
  history: ResponsesHistory,
  previousResponseId: string | undefined,
  accountId: string,
  signal: AbortSignal,
): Promise<ResponsesContinuationResolution> {
  if (previousResponseId === undefined) {
    return { kind: "none" };
  }
  let resolution: ResponsesContinuationResolution;
  try {
    resolution = await history.resolve(previousResponseId, accountId, signal);
  } catch (error: unknown) {
    throw continuationFailure(error, signal);
  }
  if (resolution.kind === "owned" || resolution.kind === "none") {
    return resolution;
  }
  throw new GatewayFailureError({
    kind: resolution.kind === "owned_by_another_account"
      ? "continuation_conflict"
      : "continuation_unavailable",
    source: "continuation",
    phase: "resume",
  });
}

export function ownedContinuationReceipt(
  resolution: Readonly<ResponsesContinuationResolution>,
): ResponsesRouteReceipt | undefined {
  return resolution.kind === "owned" ? resolution.receipt : undefined;
}

export function continuationModel(
  requestedModel: string | undefined,
  receipt: Readonly<ResponsesRouteReceipt> | undefined,
): string | undefined {
  if (receipt === undefined) {
    return requestedModel;
  }
  if (requestedModel !== undefined && requestedModel !== receipt.modelId) {
    throw conflict();
  }
  return receipt.modelId;
}

export function validateContinuationTarget(
  receipt: Readonly<ResponsesRouteReceipt> | undefined,
  endpoint: string,
): void {
  if (receipt === undefined) {
    return;
  }
  if (receipt.upstreamOrigin !== trustedUpstreamOrigin(endpoint)) {
    throw conflict();
  }
  if (
    receipt.owner === "converted"
    && receipt.upstreamProtocol === "chat"
    && receipt.conversionVersion !== RESPONSES_CHAT_CONVERSION_VERSION
  ) {
    throw conflict();
  }
}

export function validateExternalContinuation(
  previousResponseId: string | undefined,
  resolution: Readonly<ResponsesContinuationResolution>,
  planKind: ResponsesPlanKind,
): void {
  if (previousResponseId === undefined || resolution.kind !== "none") {
    return;
  }
  if (planKind !== "native_responses" || isGatewayManagedResponseId(previousResponseId)) {
    throw new GatewayFailureError({
      kind: "continuation_unavailable",
      source: "continuation",
      phase: "resume",
    });
  }
}

export function continuationOwnership(
  accountId: string,
  modelId: string,
  endpoint: string,
  planKind: ResponsesPlanKind,
): ResponsesContinuationOwnership {
  return planKind === "native_responses"
    ? {
      accountId,
      modelId,
      upstreamOrigin: trustedUpstreamOrigin(endpoint),
      owner: "native",
      upstreamProtocol: "responses",
      conversionVersion: null,
    }
    : planKind === "chat_bridge"
      ? {
        accountId,
        modelId,
        upstreamOrigin: trustedUpstreamOrigin(endpoint),
        owner: "converted",
        upstreamProtocol: "chat",
        conversionVersion: RESPONSES_CHAT_CONVERSION_VERSION,
      }
      : {
        accountId,
        modelId,
        upstreamOrigin: trustedUpstreamOrigin(endpoint),
        owner: "converted",
        upstreamProtocol: "messages",
        conversionVersion: RESPONSES_MESSAGES_CONVERSION_VERSION,
      };
}

export async function persistContinuation(
  work: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    throw continuationFailure(error, signal);
  }
}

export function responseIdFromPayload(payload: WireJsonObject): string | undefined {
  const direct = memberValue(payload, "id");
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const nested = memberValue(objectMember(payload, "response"), "id");
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

export function isTerminalResponsesEvent(payload: WireJsonObject): boolean {
  const type = memberValue(payload, "type");
  return type === "response.completed"
    || type === "response.incomplete"
    || type === "response.failed"
    || type === "error";
}

function trustedUpstreamOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch (error: unknown) {
    throw new GatewayFailureError({
      kind: "internal",
      source: "continuation",
      phase: "resume",
      cause: error,
    });
  }
}

function continuationFailure(
  error: unknown,
  signal: AbortSignal,
): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (signal.aborted) {
    return new GatewayFailureError(failureFromSignal(signal, {
      source: "continuation",
      phase: "resume",
    }));
  }
  if (error instanceof ResponsesContinuationError) {
    return new GatewayFailureError({
      kind: error.code === "ownership_conflict"
        ? "continuation_conflict"
        : "continuation_unavailable",
      source: "continuation",
      phase: "resume",
      cause: error,
    });
  }
  return new GatewayFailureError({
    kind: "continuation_persistence",
    source: "continuation",
    phase: "resume",
    cause: error,
  });
}

function conflict(): GatewayFailureError {
  return new GatewayFailureError({
    kind: "continuation_conflict",
    source: "continuation",
    phase: "resume",
  });
}

function objectMember(object: WireJsonObject | undefined, key: string): WireJsonObject | undefined {
  const value = object === undefined ? undefined : memberValue(object, key);
  return isWireJsonObject(value) ? value : undefined;
}

function memberValue(object: WireJsonObject | undefined, key: string): WireJson | undefined {
  if (object === undefined) {
    return undefined;
  }
  const values = memberValues(object, key);
  return values.length === 1 ? values[0] : undefined;
}
