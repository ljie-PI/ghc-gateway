import { GatewayFailureError, type GatewayFailureOrigin } from "../gateway/failures.js";
import { duplicateMemberNames, memberValues, type WireJsonObject } from "../serialization/wire_json.js";
import { ConversionContractError } from "./conversion/types.js";

/**
 * Native routes forward the client body unchanged apart from model mapping, like cc-switch, and let
 * Copilot validate everything else. Only the members the gateway itself routes on are checked here.
 */

/** A request rejection whose rule ID is recorded in content-free diagnostics. */
export function requestRuleFailure(
  ruleId: string,
  origin: Readonly<GatewayFailureOrigin> = { source: "request", phase: "decode" },
): GatewayFailureError {
  return new GatewayFailureError({
    kind: "invalid_request",
    ...origin,
    cause: new ConversionContractError("invalid_request", ruleId),
  });
}

/** Gateway reasoning carriers must resolve for the request's own account and model. */
export function carrierRuleFailure(ruleId: string): GatewayFailureError {
  return requestRuleFailure(ruleId, { source: "converter", phase: "convert" });
}

/** The gateway and the upstream must read the same top-level members (model, stream, input…). */
export function assertNoDuplicateTopLevelMembers(body: WireJsonObject): void {
  if (duplicateMemberNames(body).length > 0) throw requestRuleFailure("REQ-NATIVE-DUPLICATE-MEMBER");
}

/** `model` selects the upstream route, so a present value must be a non-empty string. */
export function routingModel(body: WireJsonObject): string | undefined {
  const value = memberValues(body, "model")[0];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw requestRuleFailure("REQ-NATIVE-MODEL");
  return value;
}

/** `stream` selects buffered or SSE execution, so a present value must be a boolean. */
export function routingStream(body: WireJsonObject): boolean {
  const value = memberValues(body, "stream")[0];
  if (value === undefined) return false;
  if (value !== true && value !== false) throw requestRuleFailure("REQ-NATIVE-STREAM");
  return value;
}
