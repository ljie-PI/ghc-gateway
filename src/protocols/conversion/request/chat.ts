import { resolveChatOutputTokenField } from "../../../copilot/model_capabilities.js";
import { isWireJsonArray, isWireJsonObject, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { TOOL_RESULT_MEDIA_REPLACEMENT, toolResultMediaReference } from "../compatibility_markers.js";
import { containsReasoningCarrier, isReasoningCarrier, type ReasoningCarrierRecord } from "../reasoning_carriers.js";
import { decodeChatReasoning, decodeResponsesReasoningItem } from "../reasoning.js";
import { type ConversionDegradationRule, type EncodedConversionRequest, type SemanticImage, type SemanticRequest, type SemanticRequestItem, type SemanticToolResultItem } from "../types.js";
import { finiteNumber, invalid, oneMember, optionalBoolean, optionalString, parseStringList, requiredArray, requiredString, unsupported, wireArray, wireNumber, wireObject } from "../wire.js";
import { decodeChatContent, encodeChatContent, encodeChatImage, textContent, toolResultText } from "./content.js";
import { decodeChatOutputFormat, encodeChatOutputFormat } from "./format.js";
import { aliasedPositiveInteger, decodeIndependentStreamOptions, outputBudget, parallelCallsForTarget, reasoningForTarget, reasoningFromEffort, validateSingleChoice } from "./limits.js";
import { appendMember, appendObjectArrayMember, carrierState, applyUnsupportedImageFallback, encodedRequest, independentMetadata, metadataForTarget, replaceUnsupportedChatMessageImages, optionalProtocolArray, projectRequestMembers, reasoningProjection, replaceOptionalMember, requestObject, requiredCarrier, requireProjection } from "./projection.js";
import { decodeChatToolCall, decodeChatToolChoice, decodeChatTools, encodeChatTool, encodeChatToolCall, encodeChatToolChoice, projectSemanticToolRequest } from "./tools.js";
import { collectTargetInstructions } from "./instructions.js";
import { type EncodeContext } from "./types.js";

const CHAT_TOP_LEVEL = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_completion_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "n",
  "stop",
  "metadata",
]);

export function decodeChatRequest(body: WireJsonObject, carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>): SemanticRequest {
  const degradations = new Set<ConversionDegradationRule>();
  body = projectRequestMembers(
    body,
    CHAT_TOP_LEVEL,
    "REQ-C-TOP",
    "chat.extensions_omitted",
    degradations,
  );
  body = replaceOptionalMember(body, "stream_options", decodeIndependentStreamOptions(
    oneMember(body, "stream_options", "REQ-C-STREAM-OPTIONS"),
    "chat.extensions_omitted",
    degradations,
  ));
  validateSingleChoice(oneMember(body, "n", "REQ-C-N"), "REQ-C-N", degradations);
  const items: SemanticRequestItem[] = [];
  const messages = requiredArray(oneMember(body, "messages", "REQ-C-MESSAGES"), "REQ-C-MESSAGES");
  for (const value of messages.items) {
    decodeChatMessage(value, items, degradations, carrierRecords);
  }
  const reasoning = reasoningFromEffort(
    optionalString(oneMember(body, "reasoning_effort", "REQ-C-REASONING"), "REQ-C-REASONING"),
    "REQ-C-REASONING",
    degradations,
    true,
  );
  const tools = decodeChatTools(oneMember(body, "tools", "REQ-C-TOOLS"), degradations);
  const toolChoice = decodeChatToolChoice(oneMember(body, "tool_choice", "REQ-C-TOOL-CHOICE"), degradations);
  const parallelToolCalls = optionalBoolean(
    oneMember(body, "parallel_tool_calls", "REQ-C-PARALLEL"),
    "REQ-C-PARALLEL",
  );
  const projectedTools = projectSemanticToolRequest(
    items,
    tools,
    toolChoice,
    parallelToolCalls,
    degradations,
  );
  return Object.freeze({
    source: "chat",
    model: optionalString(oneMember(body, "model", "REQ-C-MODEL"), "REQ-C-MODEL"),
    stream: optionalBoolean(oneMember(body, "stream", "REQ-C-STREAM"), "REQ-C-STREAM") ?? false,
    instructions: [],
    items: projectedTools.items,
    tools: projectedTools.tools,
    toolChoice: projectedTools.toolChoice,
    parallelToolCalls: projectedTools.parallelToolCalls,
    maxOutputTokens: aliasedPositiveInteger(
      body,
      ["max_completion_tokens", "max_tokens"],
      "REQ-C-LIMIT",
      degradations,
    ),
    temperature: finiteNumber(
      oneMember(body, "temperature", "REQ-C-TEMPERATURE"),
      "REQ-C-TEMPERATURE",
      0,
      2,
    ),
    topP: finiteNumber(oneMember(body, "top_p", "REQ-C-TOP-P"), "REQ-C-TOP-P", 0, 1),
    stop: parseStringList(oneMember(body, "stop", "REQ-C-STOP"), "REQ-C-STOP"),
    outputFormat: decodeChatOutputFormat(oneMember(body, "response_format", "REQ-C-FORMAT"), degradations),
    reasoning,
    metadata: independentMetadata(oneMember(body, "metadata", "REQ-C-METADATA"), degradations),
    degradations: [...degradations],
    ...(carrierRecords === undefined ? {} : { carrierRecords }),
  });
}

function decodeChatMessage(
  value: WireJson,
  output: SemanticRequestItem[],
  degradations: Set<ConversionDegradationRule>,
  carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>,
): void {
  let message = requestObject(value, "REQ-C-MESSAGE");
  const role = requiredString(oneMember(message, "role", "REQ-C-MESSAGE-ROLE"), "REQ-C-MESSAGE-ROLE");
  if (role === "system" || role === "developer" || role === "user") {
    message = projectRequestMembers(
      message,
      new Set(["role", "content"]),
      "REQ-C-MESSAGE-KEY",
      "chat.extensions_omitted",
      degradations,
    );
    output.push({
      type: "message",
      role,
      content: decodeChatContent(
        oneMember(message, "content", "REQ-C-MESSAGE-CONTENT"),
        role !== "user",
        false,
        degradations,
      ),
    });
    return;
  }
  if (role === "assistant") {
    message = projectRequestMembers(
      message,
      new Set([
        "role",
        "content",
        "tool_calls",
        "refusal",
        "reasoning_items",
        "reasoning_content",
        "reasoning_text",
        "reasoning",
        "reasoning_details",
        "thinking_blocks",
      ]),
      "REQ-C-ASSISTANT",
      "chat.extensions_omitted",
      degradations,
    );
    const visibleReasoning = decodeChatReasoning(
      message,
      () => invalid("REQ-C-ASSISTANT-REASONING"),
      true,
      () => degradations.add("chat.extensions_omitted"),
    );
    if (visibleReasoning.text.length > 0) {
      degradations.add("reasoning.presentation_omitted");
    }
    if (visibleReasoning.hasOpaqueState) {
      degradations.add("reasoning.state_omitted");
    }
    const reasoningItems = oneMember(message, "reasoning_items", "REQ-C-ASSISTANT-REASONING");
    let hasReasoningItems = false;
    if (reasoningItems !== undefined) {
      if (!isWireJsonArray(reasoningItems)) {
        if (containsReasoningCarrier(reasoningItems)) invalid("REQ-C-ASSISTANT-REASONING");
        degradations.add("request.option_omitted");
        degradations.add("reasoning.state_omitted");
      }
      const items = isWireJsonArray(reasoningItems) ? reasoningItems.items : [];
      hasReasoningItems = items.length > 0;
      for (const item of items) {
        if (!isWireJsonObject(item)) {
          if (containsReasoningCarrier(item)) invalid("REQ-C-ASSISTANT-REASONING");
          degradations.add("chat.extensions_omitted");
          continue;
        }
        const object = item;
        const type = oneMember(object, "type", "REQ-C-ASSISTANT-REASONING-TYPE");
        if (type !== "reasoning") {
          if (containsReasoningCarrier(object)) invalid("REQ-C-ASSISTANT-REASONING-TYPE");
          degradations.add("chat.extensions_omitted");
          continue;
        }
        const encrypted = oneMember(object, "encrypted_content", "REQ-C-ASSISTANT-REASONING-STATE");
        if (typeof encrypted === "string" && isReasoningCarrier(encrypted)) {
          const record = requiredCarrier(carrierRecords, encrypted, "responses_item", "REQ-C-ASSISTANT-REASONING-STATE");
          const state = carrierState(record, "REQ-C-ASSISTANT-REASONING-STATE");
          const reasoningItem = decodeResponsesReasoningItem(state, () => invalid("REQ-C-ASSISTANT-REASONING-STATE"));
          requireProjection(record, reasoningProjection(object), "REQ-C-ASSISTANT-REASONING-STATE");
          output.push({ type: "reasoning", parts: reasoningItem.parts, opaqueState: { kind: "responses_item", item: state } });
        }
      }
      degradations.add("reasoning.state_omitted");
    }
    const content = decodeChatContent(
      oneMember(message, "content", "REQ-C-ASSISTANT-CONTENT"),
      true,
      true,
      degradations,
    );
    const refusalValue = oneMember(message, "refusal", "REQ-C-ASSISTANT-REFUSAL");
    const refusal = refusalValue === null
      ? undefined
      : optionalString(refusalValue, "REQ-C-ASSISTANT-REFUSAL");
    const combined = refusal === undefined ? content : [...content, { type: "refusal", text: refusal } as const];
    if (combined.length > 0) {
      output.push({ type: "message", role: "assistant", content: combined });
    }
    const calls = optionalProtocolArray(
      oneMember(message, "tool_calls", "REQ-C-TOOL-CALLS"),
      "REQ-C-TOOL-CALLS",
      degradations,
    );
    if (calls !== undefined) {
      for (const call of calls.items) {
        const decoded = decodeChatToolCall(call, degradations);
        if (decoded !== undefined) output.push(decoded);
      }
    }
    if (combined.length === 0 && calls === undefined && !hasReasoningItems && visibleReasoning.text.length === 0) {
      invalid("REQ-C-ASSISTANT-EMPTY");
    }
    return;
  }
  if (role === "tool") {
    message = projectRequestMembers(
      message,
      new Set(["role", "content", "tool_call_id"]),
      "REQ-C-TOOL-RESULT",
      "chat.extensions_omitted",
      degradations,
    );
    output.push({
      type: "tool_result",
      callId: requiredString(
        oneMember(message, "tool_call_id", "REQ-C-TOOL-RESULT-ID"),
        "REQ-C-TOOL-RESULT-ID",
      ),
      content: decodeChatContent(
        oneMember(message, "content", "REQ-C-TOOL-RESULT-CONTENT"),
        false,
        false,
        degradations,
      ),
      isError: false,
    });
    return;
  }
  degradations.add("chat.extensions_omitted");
}

export function encodeChatRequest(
  request: Readonly<SemanticRequest>,
  context: Readonly<EncodeContext>,
): EncodedConversionRequest {
  const instructionProjection = request.responseBindings === undefined
    ? collectTargetInstructions(request, "chat.extensions_omitted")
    : { instructions: request.instructions, items: request.items, degradations: [] };
  const projectedRequest = Object.freeze({
    ...request,
    instructions: instructionProjection.instructions,
    items: instructionProjection.items,
  });
  const targetRequest = applyUnsupportedImageFallback(
    projectedRequest,
    context.capability.capabilities.inputModalities.includes("image"),
  );
  const targetDegradations = new Set<ConversionDegradationRule>(instructionProjection.degradations);
  const targetReasoning = reasoningForTarget(context.capability, "chat", targetRequest.reasoning);
  const reasoning = targetReasoning.reasoning;
  for (const degradation of targetReasoning.degradations) targetDegradations.add(degradation);
  const targetParallel = parallelCallsForTarget(targetRequest, context.capability);
  for (const degradation of targetParallel.degradations) targetDegradations.add(degradation);
  const hasTools = targetRequest.tools.length > 0;
  if (!hasTools && targetRequest.toolChoice !== undefined) targetDegradations.add("request.option_omitted");
  if (!hasTools && targetRequest.parallelToolCalls !== undefined) targetDegradations.add("tools.parallel_control_omitted");
  let messages = targetRequest.responseBindings === undefined
    ? encodeChatMessages(targetRequest)
    : targetRequest.responseBindings.chatMessages;
  if (targetRequest.responseBindings !== undefined
    && !context.capability.capabilities.inputModalities.includes("image")) {
    const fallback = replaceUnsupportedChatMessageImages(messages);
    messages = [...fallback.messages];
    if (fallback.replaced) targetDegradations.add("request.option_omitted");
  }
  const budget = targetRequest.source === "messages"
    ? outputBudget(targetRequest.maxOutputTokens, context.capability)
    : targetRequest.maxOutputTokens;
  const tokenField = resolveChatOutputTokenField(context.capability.modelId, context.capability.profile.chatOutputTokenField);
  const metadata = metadataForTarget(targetRequest, "chat", targetDegradations);
  const body = targetRequest.responseBindings === undefined
    ? wireObject([
      ["model", context.resolvedModel],
      ["messages", wireArray(messages)],
      ...(budget === undefined ? [] : [[tokenField, wireNumber(budget)] as const]),
      ["temperature", targetRequest.temperature === undefined ? undefined : wireNumber(targetRequest.temperature)],
      ["top_p", targetRequest.topP === undefined ? undefined : wireNumber(targetRequest.topP)],
      ["stop", targetRequest.stop === undefined ? undefined : wireArray(targetRequest.stop)],
      ["stream", targetRequest.stream ? true : undefined],
      ["stream_options", targetRequest.stream ? wireObject([["include_usage", true]]) : undefined],
      ["tools", hasTools ? wireArray(targetRequest.tools.map((tool) => encodeChatTool(tool, targetDegradations))) : undefined],
      ["tool_choice", hasTools ? encodeChatToolChoice(targetRequest.toolChoice) : undefined],
      ["parallel_tool_calls", hasTools ? targetParallel.value : undefined],
      ["response_format", encodeChatOutputFormat(targetRequest.outputFormat)],
      ["reasoning_effort", reasoning?.effort],
      ["metadata", metadata],
    ])
    : wireObject([
      ["model", context.resolvedModel],
      ["messages", wireArray(messages)],
      ...targetRequest.responseBindings.chatPrefixMembers
        .filter((member) => member.key !== "parallel_tool_calls")
        .map((member) => [member.key, member.value] as const),
      ["stream_options", targetRequest.stream
        && !targetRequest.responseBindings.chatPrefixMembers.some((member) => member.key === "stream_options")
        ? wireObject([["include_usage", true]])
        : undefined],
      ["tools", hasTools ? wireArray(targetRequest.tools.map((tool) => encodeChatTool(tool, targetDegradations))) : undefined],
      ["tool_choice", hasTools ? encodeChatToolChoice(targetRequest.toolChoice) : undefined],
      ["parallel_tool_calls", hasTools ? targetParallel.value : undefined],
      ...(budget === undefined ? [] : [[tokenField, wireNumber(budget)] as const]),
      ["temperature", targetRequest.temperature === undefined ? undefined : wireNumber(targetRequest.temperature)],
      ["top_p", targetRequest.topP === undefined ? undefined : wireNumber(targetRequest.topP)],
      ["response_format", encodeChatOutputFormat(targetRequest.outputFormat)],
      ["reasoning_effort", reasoning?.effort],
      ["metadata", metadata],
    ]);
  return encodedRequest(targetRequest, body, [...targetDegradations]);
}

function encodeChatMessages(request: Readonly<SemanticRequest>): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  if (request.instructions.length > 0) {
    output.push(wireObject([["role", "system"], ["content", textContent(request.instructions) ?? ""]]));
  }
  for (let itemIndex = 0; itemIndex < request.items.length; itemIndex += 1) {
    const item = request.items[itemIndex];
    if (item === undefined) {
      continue;
    }
    if (item.type === "message") {
      output.push(wireObject([
        ["role", item.role],
        ["content", encodeChatContent(item.content)],
      ]));
      continue;
    }
    if (item.type === "reasoning") {
      if (item.opaqueState === undefined) {
        const text = item.parts.map((part) => part.text).join("");
        if (text.length === 0) continue;
        const previous = output.at(-1);
        if (
          previous === undefined
          || oneMember(previous, "role", "REQ-INTERNAL") !== "assistant"
          || oneMember(previous, "tool_calls", "REQ-INTERNAL") !== undefined
        ) {
          output.push(wireObject([
            ["role", "assistant"],
            ["content", null],
            ["reasoning_content", text],
          ]));
        } else {
          appendMember(previous, "reasoning_content", text);
        }
        continue;
      }
      if (item.opaqueState.kind !== "chat_state") unsupported("REQ-TARGET-C-REASONING-STATE");
      const last = output.at(-1);
      if (
        last === undefined
        || oneMember(last, "role", "REQ-INTERNAL") !== "assistant"
        || oneMember(last, "tool_calls", "REQ-INTERNAL") !== undefined
      ) {
        output.push(wireObject([["role", "assistant"], ["content", null], ...item.opaqueState.state.members.map((member) => [member.key, member.value] as const)]));
      } else {
        for (const member of item.opaqueState.state.members) appendMember(last, member.key, member.value);
      }
      continue;
    }
    if (item.type === "tool_call") {
      const last = output.at(-1);
      if (last !== undefined && oneMember(last, "role", "REQ-INTERNAL") === "assistant") {
        appendObjectArrayMember(last, "tool_calls", encodeChatToolCall(item));
        if (oneMember(last, "content", "REQ-INTERNAL") === undefined) {
          appendMember(last, "content", null);
        }
      } else {
        output.push(wireObject([
          ["role", "assistant"],
          ["content", null],
          ["tool_calls", wireArray([encodeChatToolCall(item)])],
        ]));
      }
      continue;
    }
    const results: SemanticToolResultItem[] = [];
    for (; itemIndex < request.items.length; itemIndex += 1) {
      const candidate = request.items[itemIndex];
      if (candidate?.type !== "tool_result") {
        itemIndex -= 1;
        break;
      }
      results.push(candidate);
    }
    const mediaContent: WireJson[] = [];
    for (const result of results) {
      const text = textContent(result.content) ?? "";
      const images = result.content.filter((part): part is SemanticImage => part.type === "image");
      output.push(wireObject([
        ["role", "tool"],
        ["tool_call_id", result.callId],
        ["content", images.length === 0
          ? toolResultText(text, result.isError)
          : `${toolResultText(text, result.isError)}${text.length === 0 && !result.isError ? "" : "\n"}${TOOL_RESULT_MEDIA_REPLACEMENT}`],
      ]));
      if (images.length > 0) {
        mediaContent.push(
          wireObject([["type", "text"], ["text", toolResultMediaReference(result.callId)]]),
          ...images.map(encodeChatImage),
        );
      }
    }
    if (mediaContent.length > 0) {
      output.push(wireObject([["role", "user"], ["content", wireArray(mediaContent)]]));
    }
  }
  return output;
}
