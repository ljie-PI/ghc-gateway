import {
  memberValues,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { nativeRoutingViolation } from "../native_routing.js";
import type { ResponsesRequest } from "./dto.js";

export class ResponsesRequestDecodeError extends Error {
  constructor(
    readonly field: string,
    message: string,
    readonly ruleId: string,
  ) {
    super(message);
    this.name = "ResponsesRequestDecodeError";
  }
}

/** Decodes a request bound for a native Responses upstream; only its routing members are checked. */
export function decodeResponsesRequest(body: WireJsonObject): ResponsesRequest {
  const violation = nativeRoutingViolation(body);
  if (violation !== undefined) {
    throw new ResponsesRequestDecodeError(
      violation.field,
      `invalid Responses request routing field: ${violation.field}`,
      violation.ruleId,
    );
  }
  return decodeResponsesPlanningRequest(body);
}

export function decodeResponsesPlanningRequest(body: WireJsonObject): ResponsesRequest {
  const model = optionalPlanningModel(body);
  const stream = memberValues(body, "stream")[0] === true;
  const store = preservedBoolean(body, "store");
  const input = memberValues(body, "input")[0];
  const previous = optionalPreviousResponseId(body);

  return {
    body,
    ...(model === undefined ? {} : { model }),
    stream,
    ...(store === undefined ? {} : { store }),
    ...(input === undefined ? {} : { input }),
    ...(previous === undefined ? {} : { previousResponseId: previous }),
  };
}

function optionalPlanningModel(body: WireJsonObject): string | undefined {
  const value = memberValues(body, "model")[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Continuation lookup routes on this value for native and converted plans alike. */
function optionalPreviousResponseId(body: WireJsonObject): string | undefined {
  const value = memberValues(body, "previous_response_id")[0];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ResponsesRequestDecodeError(
      "previous_response_id",
      "Responses request field previous_response_id must be a non-empty string or null",
      "REQ-R-PREVIOUS-RESPONSE-ID",
    );
  }
  return value;
}

function preservedBoolean(body: WireJsonObject, field: string): boolean | undefined {
  const value = memberValues(body, field)[0];
  return value === true || value === false ? value : undefined;
}