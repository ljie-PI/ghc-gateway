import {
  memberValues,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type { ResponsesRequest } from "./dto.js";

/**
 * Reads only the members the gateway routes on. Values it cannot use are treated as absent and the body
 * is forwarded as-is, like cc-switch, so the upstream validates them.
 */
export function decodeResponsesRequest(body: WireJsonObject): ResponsesRequest {
  const model = nonEmptyString(memberValues(body, "model")[0]);
  const stream = memberValues(body, "stream")[0] === true;
  const store = preservedBoolean(body, "store");
  const input = memberValues(body, "input")[0];
  const previous = nonEmptyString(memberValues(body, "previous_response_id")[0]);

  return {
    body,
    ...(model === undefined ? {} : { model }),
    stream,
    ...(store === undefined ? {} : { store }),
    ...(input === undefined ? {} : { input }),
    ...(previous === undefined ? {} : { previousResponseId: previous }),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function preservedBoolean(body: WireJsonObject, field: string): boolean | undefined {
  const value = memberValues(body, field)[0];
  return value === true || value === false ? value : undefined;
}