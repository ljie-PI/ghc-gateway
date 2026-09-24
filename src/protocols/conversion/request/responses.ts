import { isWireJsonArray, isWireJsonObject, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { containsReasoningCarrier, isReasoningCarrier, type ReasoningCarrierRecord } from "../reasoning_carriers.js";
import { decodeResponsesReasoningItem } from "../reasoning.js";
import { projectIndependentOption } from "../request_projection.js";
import { prepareResponsesExtendedTools } from "./responses_extended_tools.js";
import { type ConversionDegradationRule, type EncodedConversionRequest, type SemanticRequest, type SemanticRequestItem } from "../types.js";
import { finiteNumber, invalid, oneMember, optionalBoolean, optionalString, parseStringList, requiredString, unsupported, wireArray, wireNumber, wireObject } from "../wire.js";
import { decodeResponsesContent, decodeToolResultContent, encodeResponsesContent, encodeResponsesToolResultContent, textContent } from "./content.js";
import { decodeResponsesOutputFormat, encodeResponsesOutputFormat, sanitizeResponsesOutputFormatMembers } from "./format.js";
import { decodeResponsesInstructions } from "./instructions.js";
import { aliasedPositiveInteger, decodeIndependentStreamOptions, parallelCallsForTarget, reasoningForTarget, reasoningFromEffort, validateConditionalTargetParameters, validateSingleChoice } from "./limits.js";
import { carrierState, encodedRequest, independentMetadata, independentResultStatus, omitPresentationStatus, omitPresentationString, optionalProtocolObject, projectRequestMembers, reasoningProjection, replaceOptionalMember, requiredCarrier, requireProjection, safeIndependentOption, TOOL_SENSITIVE_EXTENSION_FIELDS } from "./projection.js";
import { decodeResponsesToolChoice, decodeResponsesTools, encodeResponsesTool, encodeResponsesToolChoice, projectSemanticToolRequest, validateArgumentsJson } from "./tools.js";
import { type EncodeContext } from "./types.js";

const RESPONSES_TOP_LEVEL = new Set([
  "model",
  "instructions",
  "input",
  "stream",
  "stream_options",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "response_format",
  "previous_response_id",
  "store",
  "background",
  "n",
  "stop",
  "metadata",
  "include",
]);

export function decodeResponsesRequest(body: WireJsonObject, carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>): SemanticRequest {
  const degradations = new Set<ConversionDegradationRule>();
  body = projectRequestMembers(
    body,
    RESPONSES_TOP_LEVEL,
    "REQ-R-TOP",
    "responses.extensions_omitted",
    degradations,
  );
  body = replaceOptionalMember(body, "include", decodeResponsesInclude(
    oneMember(body, "include", "REQ-R-INCLUDE"),
    degradations,
  ));
  body = replaceOptionalMember(body, "stream_options", decodeIndependentStreamOptions(
    oneMember(body, "stream_options", "REQ-R-STREAM-OPTIONS"),
    "responses.extensions_omitted",
    degradations,
  ));
  body = replaceOptionalMember(
    body,
    "text",
    optionalProtocolObject(oneMember(body, "text", "REQ-R-TEXT-FORMAT"), "REQ-R-TEXT-FORMAT", degradations),
  );
  body = replaceOptionalMember(
    body,
    "response_format",
    optionalProtocolObject(oneMember(body, "response_format", "REQ-R-FORMAT"), "REQ-R-FORMAT", degradations),
  );
  body = sanitizeResponsesOutputFormatMembers(body, degradations);
  const extended = prepareResponsesExtendedTools(body, degradations);
  let semanticBody = extended?.body ?? body;
  semanticBody = projectRequestMembers(
    semanticBody,
    RESPONSES_TOP_LEVEL,
    "REQ-R-TOP",
    "responses.extensions_omitted",
    degradations,
  );
  validateSingleChoice(oneMember(semanticBody, "n", "REQ-R-N"), "REQ-R-N", degradations);
  const background = optionalBoolean(oneMember(semanticBody, "background", "REQ-R-BACKGROUND"), "REQ-R-BACKGROUND");
  if (background === true) {
    unsupported("REQ-R-BACKGROUND");
  }
  const previousResponseId = oneMember(semanticBody, "previous_response_id", "REQ-R-PREVIOUS");
  if (previousResponseId !== undefined && previousResponseId !== null) {
    unsupported("REQ-R-PREVIOUS");
  }
  const store = optionalBoolean(oneMember(semanticBody, "store", "REQ-R-STORE"), "REQ-R-STORE");
  if (store === true) {
    unsupported("REQ-R-STORE");
  }
  const items = decodeResponsesInput(oneMember(semanticBody, "input", "REQ-R-INPUT"), degradations, carrierRecords);
  const reasoningValue = oneMember(semanticBody, "reasoning", "REQ-R-REASONING");
  const reasoningObject = reasoningValue === undefined
    ? undefined
    : optionalProtocolObject(reasoningValue, "REQ-R-REASONING", degradations);
  const projectedReasoning = reasoningObject === undefined
    ? undefined
    : projectRequestMembers(
      reasoningObject,
      new Set(["effort", "summary", "encrypted_content"]),
      "REQ-R-REASONING",
      "responses.extensions_omitted",
      degradations,
    );
  if (projectedReasoning !== undefined) {
    if (oneMember(projectedReasoning, "summary", "REQ-R-REASONING-SUMMARY") !== undefined) {
      projectIndependentOption(
        safeIndependentOption(
          oneMember(projectedReasoning, "summary", "REQ-R-REASONING-SUMMARY"),
          "REQ-R-REASONING-SUMMARY",
        ),
        (value) => typeof value === "string" && value.length > 0
          ? { kind: "value", value }
          : { kind: "malformed" },
        { omission: "request.option_omitted", degradations },
      );
      degradations.add("reasoning.presentation_omitted");
    }
    if (oneMember(projectedReasoning, "encrypted_content", "REQ-R-REASONING-STATE") !== undefined) {
      const encrypted = requiredString(
        oneMember(projectedReasoning, "encrypted_content", "REQ-R-REASONING-STATE"),
        "REQ-R-REASONING-STATE",
      );
      if (isReasoningCarrier(encrypted)) invalid("REQ-R-REASONING-STATE");
      degradations.add("reasoning.state_omitted");
    }
  }
  const tools = decodeResponsesTools(
    oneMember(semanticBody, "tools", "REQ-R-TOOLS"),
    extended !== undefined,
    degradations,
  ).map((tool) => {
    const binding = extended?.ledger.bindings.find((candidate) => candidate.chatName === tool.name);
    return binding === undefined ? tool : {
      ...tool,
      kind: binding.kind,
      sourceName: binding.sourceName,
      ...(binding.namespace === undefined ? {} : { namespace: binding.namespace }),
    };
  });
  const toolChoice = decodeResponsesToolChoice(
    oneMember(semanticBody, "tool_choice", "REQ-R-TOOL-CHOICE"),
    degradations,
  );
  const parallelToolCalls = optionalBoolean(
    oneMember(semanticBody, "parallel_tool_calls", "REQ-R-PARALLEL"),
    "REQ-R-PARALLEL",
  );
  const projectedTools = extended === undefined
    ? projectSemanticToolRequest(
      "responses",
      items,
      tools,
      toolChoice,
      parallelToolCalls,
      degradations,
    )
    : { items, tools, toolChoice, parallelToolCalls };
  return Object.freeze({
    source: "responses",
    model: optionalString(oneMember(semanticBody, "model", "REQ-R-MODEL"), "REQ-R-MODEL"),
    stream: optionalBoolean(oneMember(semanticBody, "stream", "REQ-R-STREAM"), "REQ-R-STREAM") ?? false,
    instructions: decodeResponsesInstructions(
      oneMember(semanticBody, "instructions", "REQ-R-INSTRUCTIONS"),
      degradations,
    ),
    items: projectedTools.items,
    tools: projectedTools.tools,
    toolChoice: projectedTools.toolChoice,
    parallelToolCalls: projectedTools.parallelToolCalls,
    maxOutputTokens: aliasedPositiveInteger(
      semanticBody,
      ["max_output_tokens", "max_completion_tokens", "max_tokens"],
      "REQ-R-LIMIT",
      degradations,
    ),
    temperature: finiteNumber(
      oneMember(semanticBody, "temperature", "REQ-R-TEMPERATURE"),
      "REQ-R-TEMPERATURE",
      0,
      2,
    ),
    topP: finiteNumber(oneMember(semanticBody, "top_p", "REQ-R-TOP-P"), "REQ-R-TOP-P", 0, 1),
    stop: parseStringList(oneMember(semanticBody, "stop", "REQ-R-STOP"), "REQ-R-STOP"),
    outputFormat: decodeResponsesOutputFormat(semanticBody, degradations),
    reasoning: reasoningFromEffort(
      optionalString(
        projectedReasoning === undefined ? undefined : oneMember(projectedReasoning, "effort", "REQ-R-EFFORT"),
        "REQ-R-EFFORT",
      ),
      "REQ-R-EFFORT",
      degradations,
      true,
    ),
    metadata: independentMetadata(oneMember(semanticBody, "metadata", "REQ-R-METADATA"), degradations),
    degradations: [...degradations],
    ...(extended === undefined ? {} : { responseBindings: extended.ledger }),
    ...(carrierRecords === undefined ? {} : { carrierRecords }),
  });
}

function decodeResponsesInput(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
  carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>,
): readonly SemanticRequestItem[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "message", role: "user", content: [{ type: "text", text: value }] }];
  }
  const values = isWireJsonArray(value) ? value.items : [value];
  const output: SemanticRequestItem[] = [];
  for (const item of values) {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-R-INPUT-ITEM");
      degradations.add("responses.extensions_omitted");
      continue;
    }
    let object = item;
    const rawType = oneMember(object, "type", "REQ-R-INPUT-TYPE");
    if (rawType !== undefined && (typeof rawType !== "string" || rawType.length === 0)) {
      if (containsReasoningCarrier(object)) invalid("REQ-R-INPUT-TYPE");
      degradations.add("responses.extensions_omitted");
      continue;
    }
    const type = rawType as string | undefined;
    if (type === undefined || type === "message") {
      const role = requiredString(oneMember(object, "role", "REQ-R-MESSAGE-ROLE"), "REQ-R-MESSAGE-ROLE");
      if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
        degradations.add("responses.extensions_omitted");
        continue;
      }
      object = projectRequestMembers(
        object,
        new Set(["type", "id", "role", "content", "status", ...(role === "assistant" ? ["phase"] : [])]),
        "REQ-R-MESSAGE",
        "responses.extensions_omitted",
        degradations,
      );
      if (role === "assistant") {
        const phase = oneMember(object, "phase", "REQ-R-ASSISTANT-PHASE");
        if (phase !== undefined && phase !== null) {
          unsupported("REQ-R-ASSISTANT-PHASE");
        }
      }
      output.push({
        type: "message",
        role,
        content: decodeResponsesContent(
          oneMember(object, "content", "REQ-R-MESSAGE-CONTENT"),
          role === "user",
          role === "assistant",
          degradations,
        ),
      });
      omitPresentationString(oneMember(object, "id", "REQ-R-MESSAGE-ID"), degradations);
      omitPresentationStatus(oneMember(object, "status", "REQ-R-MESSAGE-STATUS"), false, degradations);
      continue;
    }
    if (type === "function_call") {
      object = projectRequestMembers(
        object,
        new Set(["type", "id", "call_id", "name", "arguments", "status"]),
        "REQ-R-FUNCTION-CALL",
        "responses.extensions_omitted",
        degradations,
        TOOL_SENSITIVE_EXTENSION_FIELDS,
      );
      const argumentsJson = requiredString(
        oneMember(object, "arguments", "REQ-R-FUNCTION-ARGS"),
        "REQ-R-FUNCTION-ARGS",
        true,
      );
      validateArgumentsJson(argumentsJson, "REQ-R-FUNCTION-ARGS");
      output.push({
        type: "tool_call",
        callId: requiredString(
          oneMember(object, "call_id", "REQ-R-FUNCTION-CALL-ID"),
          "REQ-R-FUNCTION-CALL-ID",
        ),
        name: requiredString(oneMember(object, "name", "REQ-R-FUNCTION-NAME"), "REQ-R-FUNCTION-NAME"),
        argumentsJson,
      });
      omitPresentationString(oneMember(object, "id", "REQ-R-FUNCTION-ITEM-ID"), degradations);
      omitPresentationStatus(oneMember(object, "status", "REQ-R-ITEM-STATUS"), false, degradations);
      continue;
    }
    if (type === "function_call_output") {
      object = projectRequestMembers(
        object,
        new Set(["type", "id", "call_id", "output", "status"]),
        "REQ-R-FUNCTION-OUTPUT",
        "responses.extensions_omitted",
        degradations,
        TOOL_SENSITIVE_EXTENSION_FIELDS,
      );
      output.push({
        type: "tool_result",
        callId: requiredString(
          oneMember(object, "call_id", "REQ-R-FUNCTION-OUTPUT-ID"),
          "REQ-R-FUNCTION-OUTPUT-ID",
        ),
        content: decodeToolResultContent(
          oneMember(object, "output", "REQ-R-FUNCTION-OUTPUT-CONTENT"),
          degradations,
        ),
        isError: independentResultStatus(
          oneMember(object, "status", "REQ-R-FUNCTION-OUTPUT-STATUS"),
          degradations,
        ) === "failed",
      });
      omitPresentationString(oneMember(object, "id", "REQ-R-FUNCTION-OUTPUT-ITEM-ID"), degradations);
      continue;
    }
    if (type === "reasoning") {
      object = projectRequestMembers(
        object,
        new Set(["type", "id", "status", "summary", "content", "encrypted_content"]),
        "REQ-R-REASONING-ITEM",
        "responses.extensions_omitted",
        degradations,
      );
      omitPresentationString(oneMember(object, "id", "REQ-R-REASONING-ID"), degradations);
      omitPresentationStatus(oneMember(object, "status", "REQ-R-REASONING-STATUS"), false, degradations);
      const reasoningCore = {
        kind: "object" as const,
        members: object.members.filter((member) => member.key !== "id" && member.key !== "status"),
      };
      const reasoning = decodeResponsesReasoningItem(
        reasoningCore,
        () => invalid("REQ-R-REASONING-ITEM"),
        false,
        true,
        () => degradations.add("responses.extensions_omitted"),
      );
      const encrypted = oneMember(object, "encrypted_content", "REQ-R-REASONING-STATE");
      if (typeof encrypted === "string" && isReasoningCarrier(encrypted)) {
        const record = requiredCarrier(carrierRecords, encrypted, undefined, "REQ-R-REASONING-STATE");
        const state = carrierState(record, "REQ-R-REASONING-STATE");
        requireProjection(record, reasoningProjection(object), "REQ-R-REASONING-STATE");
        if (record.sourceKind === "messages_block") {
          output.push({ type: "reasoning", parts: reasoning.parts, opaqueState: { kind: "messages_block", block: state } });
        } else if (record.sourceKind === "chat_state") {
          output.push({ type: "reasoning", parts: reasoning.parts, opaqueState: { kind: "chat_state", state } });
        } else {
          invalid("REQ-R-REASONING-STATE");
        }
        continue;
      }
      if (reasoning.parts.some((part) => part.text.length > 0)) {
        output.push({ type: "reasoning", parts: reasoning.parts });
        if (reasoning.hasOpaqueState) degradations.add("reasoning.state_omitted");
        continue;
      }
      if (reasoning.hasOpaqueState) {
        degradations.add("reasoning.state_omitted");
      }
      continue;
    }
    degradations.add("responses.extensions_omitted");
  }
  return output;
}

export function encodeResponsesRequest(
  request: Readonly<SemanticRequest>,
  context: Readonly<EncodeContext>,
): EncodedConversionRequest {
  validateConditionalTargetParameters(request, context.capability, "responses");
  const targetReasoning = reasoningForTarget(context.capability, "responses", request.reasoning);
  const reasoning = targetReasoning.reasoning;
  const reasoningDegradations = targetReasoning.degradations;
  const targetParallel = parallelCallsForTarget(request, context.capability);
  if (request.stop !== undefined) {
    unsupported("REQ-TARGET-R-STOP");
  }
  const body = wireObject([
    ["model", context.resolvedModel],
    ["instructions", textContent(request.instructions)],
    ["input", wireArray(encodeResponsesItems(request.items))],
    ["max_output_tokens", request.maxOutputTokens === undefined ? undefined : wireNumber(request.maxOutputTokens)],
    ["temperature", request.temperature === undefined ? undefined : wireNumber(request.temperature)],
    ["top_p", request.topP === undefined ? undefined : wireNumber(request.topP)],
    ["stream", request.stream ? true : undefined],
    ["tools", request.tools.length === 0 ? undefined : wireArray(request.tools.map(encodeResponsesTool))],
    ["tool_choice", encodeResponsesToolChoice(request.toolChoice)],
    ["parallel_tool_calls", targetParallel.value],
    ["text", request.outputFormat === undefined
      ? undefined
      : wireObject([["format", encodeResponsesOutputFormat(request.outputFormat)]])],
    ["reasoning", reasoning?.effort === undefined
      ? undefined
      : wireObject([["effort", reasoning.effort]])],
    ["metadata", request.metadata],
  ]);
  return encodedRequest(request, body, [...reasoningDegradations, ...targetParallel.degradations]);
}

function encodeResponsesItems(items: readonly SemanticRequestItem[]): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  for (const item of items) {
    if (item.type === "message") {
      output.push(wireObject([
        ["type", "message"],
        ["role", item.role],
        ["content", wireArray(item.content.map((part) => encodeResponsesContent(part, item.role === "assistant")))],
      ]));
    } else if (item.type === "reasoning") {
      if (item.opaqueState?.kind !== "responses_item") unsupported("REQ-TARGET-R-REASONING-STATE");
      output.push(item.opaqueState.item);
    } else if (item.type === "tool_call") {
      output.push(wireObject([
        ["type", "function_call"],
        ["id", item.itemId],
        ["call_id", item.callId],
        ["name", item.name],
        ["arguments", item.argumentsJson],
      ]));
    } else {
      output.push(wireObject([
        ["type", "function_call_output"],
        ["call_id", item.callId],
        ["output", encodeResponsesToolResultContent(item.content, item.isError)],
      ]));
    }
  }
  return output;
}

/** Output items a converted Responses reply already satisfies: gateway reasoning carriers. */
const SATISFIED_RESPONSES_INCLUDES = new Set(["reasoning.encrypted_content"]);

/**
 * Codex sends `include` on every Responses request. Converted routes, like cc-switch, never forward
 * it: an empty list or `reasoning.encrypted_content` is already met by the converted output, and
 * other or malformed values are omitted. A carrier token is never silently dropped.
 */
function decodeResponsesInclude(
  value: WireJson | undefined,
  degradations: Set<ConversionDegradationRule>,
): undefined {
  projectIndependentOption(safeIndependentOption(value, "REQ-R-INCLUDE"), (candidate) => (
    isWireJsonArray(candidate)
      && candidate.items.every((item) => typeof item === "string" && SATISFIED_RESPONSES_INCLUDES.has(item))
      ? { kind: "value", value: undefined }
      : { kind: "malformed" }
  ), { omission: "request.option_omitted", degradations });
  return undefined;
}
