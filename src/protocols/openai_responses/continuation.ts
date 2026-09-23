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
import { isGatewayManagedResponseId } from "../conversion/ids.js";
import {
  RESPONSES_CHAT_CONVERSION_VERSION,
  RESPONSES_MESSAGES_CONVERSION_VERSION,
  ResponsesContinuationError,
  isKnownResponsesConversionVersion,
  type ResponsesContinuationOwnership,
  type ResponsesContinuationProtocol,
  type ResponsesContinuationResolution,
  type ResponsesHistory,
  type ResponsesRouteReceipt,
} from "./history.js";

type ResponsesPlanKind = "native_responses" | "chat_bridge" | "messages_bridge";

export type ResolvedResponsesContinuation = Extract<ResponsesContinuationResolution, { readonly kind: "none" | "owned" }>;

/** History that exists in a form the gateway can't replay, as opposed to a storage failure. */
export function isUnrestorableHistory(error: unknown): boolean {
  return error instanceof ResponsesContinuationError;
}

/**
 * Best-effort, like cc-switch: history that is unknown, expired, legacy, uncertain, owned by
 * another account or unreadable resolves as `none`, so the request still reaches the upstream.
 * Storage failures and cancellation still fail the request.
 */
export async function resolveResponsesContinuation(
  history: ResponsesHistory,
  previousResponseId: string | undefined,
  accountId: string,
  signal: AbortSignal,
): Promise<ResolvedResponsesContinuation> {
  if (previousResponseId === undefined) {
    return { kind: "none" };
  }
  let resolution: ResponsesContinuationResolution;
  try {
    resolution = await history.resolve(previousResponseId, accountId, signal);
  } catch (error: unknown) {
    if (signal.aborted || !isUnrestorableHistory(error)) throw continuationFailure(error, signal);
    return { kind: "none" };
  }
  return resolution.kind === "owned" ? resolution : { kind: "none" };
}

export function ownedContinuationReceipt(
  resolution: Readonly<ResolvedResponsesContinuation>,
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
  protocols: readonly ResponsesContinuationProtocol[] | null,
): void {
  if (receipt === undefined) {
    return;
  }
  if (receipt.upstreamOrigin !== trustedUpstreamOrigin(endpoint)) {
    throw conflict();
  }
  if (receipt.owner === "converted") {
    if (!isKnownResponsesConversionVersion(receipt.upstreamProtocol, receipt.conversionVersion)) {
      throw conflict();
    }
  }
  // Unknown capabilities are left to the planner, which reports them as unsupported.
  if (protocols !== null && !protocols.includes(receipt.upstreamProtocol)) {
    throw conflict();
  }
}

/**
 * An unresolved ID is meaningless to converted upstreams, and a gateway-managed ID is unknown to
 * Copilot; both are dropped so the request is still sent. Other native IDs pass through unchanged.
 */
export function shouldDropUnresolvedPreviousResponseId(
  previousResponseId: string | undefined,
  resolution: Readonly<ResolvedResponsesContinuation>,
  nativePlan: boolean,
): boolean {
  if (previousResponseId === undefined || resolution.kind !== "none") {
    return false;
  }
  return !nativePlan || isGatewayManagedResponseId(previousResponseId);
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

export function continuationFailure(
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
