import {
  duplicateMemberNames,
  memberValues,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
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

export function decodeResponsesRequest(body: WireJsonObject): ResponsesRequest {
  assertNoDuplicateTopLevelFields(body);

  const model = optionalModel(body);
  const stream = optionalBoolean(body, "stream", false, false);
  const store = preservedBoolean(body, "store");
  const input = memberValues(body, "input")[0];
  const previous = optionalNonEmptyString(body, "previous_response_id", true);

  return {
    body,
    ...(model === undefined ? {} : { model }),
    stream,
    ...(store === undefined ? {} : { store }),
    ...(input === undefined ? {} : { input }),
    ...(previous === undefined ? {} : { previousResponseId: previous }),
  };
}

export function decodeResponsesPlanningRequest(body: WireJsonObject): ResponsesRequest {
  const model = optionalPlanningModel(body);
  const stream = planningBoolean(body, "stream", false);
  const store = preservedBoolean(body, "store");
  const input = memberValues(body, "input")[0];
  const previous = optionalPlanningString(body, "previous_response_id");

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

function optionalPlanningString(body: WireJsonObject, field: string): string | undefined {
  const value = memberValues(body, field)[0];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ResponsesRequestDecodeError(
      field,
      `Responses request field ${field} must be a non-empty string or null`,
      "REQ-NATIVE-PREVIOUS-RESPONSE-ID",
    );
  }
  return value;
}

function planningBoolean(body: WireJsonObject, field: string, defaultValue: boolean): boolean {
  const value = memberValues(body, field)[0];
  return value === true || value === false ? value : defaultValue;
}

function assertNoDuplicateTopLevelFields(body: WireJsonObject): void {
  const duplicate = duplicateMemberNames(body)[0];
  if (duplicate !== undefined) {
    throw new ResponsesRequestDecodeError(duplicate, `duplicate Responses request field: ${duplicate}`, "REQ-NATIVE-DUPLICATE-MEMBER");
  }
}

function optionalModel(body: WireJsonObject): string | undefined {
  const value = memberValues(body, "model")[0];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ResponsesRequestDecodeError("model", "Responses request field model must be a non-empty string when present", "REQ-NATIVE-MODEL");
  }
  return value;
}

function optionalNonEmptyString(
  body: WireJsonObject,
  field: string,
  allowNull: boolean,
): string | undefined {
  const value = memberValues(body, field)[0];
  if (value === undefined || (allowNull && value === null)) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ResponsesRequestDecodeError(
      field,
      `Responses request field ${field} must be a non-empty string or null`,
      "REQ-NATIVE-PREVIOUS-RESPONSE-ID",
    );
  }
  return value;
}

function preservedBoolean(body: WireJsonObject, field: string): boolean | undefined {
  const value = memberValues(body, field)[0];
  return value === true || value === false ? value : undefined;
}

function optionalBoolean(body: WireJsonObject, field: string, defaultValue: boolean, allowNull: boolean): boolean {
  const value = memberValues(body, field)[0];
  if (value === undefined || (allowNull && value === null)) {
    return defaultValue;
  }
  if (value !== true && value !== false) {
    throw new ResponsesRequestDecodeError(field, `Responses request field ${field} must be a boolean or null`, "REQ-NATIVE-STREAM");
  }
  return value;
}
