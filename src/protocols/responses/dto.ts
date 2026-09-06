import type { WireJson, WireJsonObject } from "../../serialization/wire_json.js";

export interface ResponsesRequest {
  readonly body: WireJsonObject;
  readonly model?: string;
  readonly stream: boolean;
  readonly store?: boolean;
  readonly input?: WireJson;
  readonly previousResponseId?: string;
}

export type ResponsesCallKind = "function_call" | "custom_tool_call" | "tool_search_call";

export type ResponsesCallOutputKind =
  | "function_call_output"
  | "custom_tool_call_output"
  | "tool_search_output";

export const RESPONSE_CALL_KINDS: readonly ResponsesCallKind[] = [
  "function_call",
  "custom_tool_call",
  "tool_search_call",
] as const;

export const RESPONSE_CALL_OUTPUT_KINDS: readonly ResponsesCallOutputKind[] = [
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
] as const;

export function withResponsesRequestInput(
  request: ResponsesRequest,
  input: WireJson,
): ResponsesRequest {
  let replaced = false;
  const members = request.body.members.map((member) => {
    if (member.key !== "input") {
      return member;
    }

    replaced = true;
    return { key: member.key, value: input };
  });
  if (!replaced) {
    members.push({ key: "input", value: input });
  }

  return {
    body: { kind: "object", members },
    ...(request.model === undefined ? {} : { model: request.model }),
    stream: request.stream,
    ...(request.store === undefined ? {} : { store: request.store }),
    input,
    ...(request.previousResponseId === undefined
      ? {}
      : { previousResponseId: request.previousResponseId }),
  };
}

export function consumeResponsesPreviousResponseId(
  request: Readonly<ResponsesRequest>,
): ResponsesRequest {
  if (request.previousResponseId === undefined) {
    return request as ResponsesRequest;
  }
  return {
    body: {
      kind: "object",
      members: request.body.members.filter((member) => member.key !== "previous_response_id"),
    },
    ...(request.model === undefined ? {} : { model: request.model }),
    stream: request.stream,
    ...(request.store === undefined ? {} : { store: request.store }),
    ...(request.input === undefined ? {} : { input: request.input }),
  };
}
