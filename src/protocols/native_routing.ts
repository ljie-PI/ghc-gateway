import { invalidRequestFailure, type GatewayFailureError } from "../gateway/failures.js";
import { duplicateMemberNames, memberValues, type WireJsonObject } from "../serialization/wire_json.js";

/**
 * Native routes forward the client body unchanged apart from model mapping, like cc-switch, and let
 * Copilot validate everything else. Only the top-level members the gateway itself routes on are
 * checked, so the gateway and Copilot cannot read them differently.
 */
export type NativeRoutingRule = "REQ-NATIVE-DUPLICATE-MEMBER" | "REQ-NATIVE-MODEL" | "REQ-NATIVE-STREAM";

export interface NativeRoutingViolation {
  readonly field: string;
  readonly ruleId: NativeRoutingRule;
}

export function nativeRoutingViolation(body: WireJsonObject): NativeRoutingViolation | undefined {
  const duplicate = duplicateMemberNames(body)[0];
  if (duplicate !== undefined) return { field: duplicate, ruleId: "REQ-NATIVE-DUPLICATE-MEMBER" };
  const model = memberValues(body, "model")[0];
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    return { field: "model", ruleId: "REQ-NATIVE-MODEL" };
  }
  const stream = memberValues(body, "stream")[0];
  if (stream !== undefined && stream !== true && stream !== false) return { field: "stream", ruleId: "REQ-NATIVE-STREAM" };
  return undefined;
}

/** The rejection a native plan raises; converted plans read these members leniently instead. */
export function nativeRoutingFailure(body: WireJsonObject): GatewayFailureError | undefined {
  const violation = nativeRoutingViolation(body);
  return violation === undefined ? undefined : invalidRequestFailure(violation.ruleId);
}
