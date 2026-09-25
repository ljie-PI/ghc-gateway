import { isWireJsonArray, isWireJsonObject, type WireJson, type WireJsonObject } from "../../../serialization/wire_json.js";
import { withMessagesCacheBreakpoints } from "../messages_cache_breakpoints.js";
import { containsReasoningCarrier, isReasoningCarrier, type ReasoningCarrierRecord } from "../reasoning_carriers.js";
import { decodeResponsesReasoningItem } from "../reasoning.js";
import { type ConversionDegradationRule, type EncodedConversionRequest, type SemanticContent, type SemanticRequest, type SemanticRequestItem } from "../types.js";
import { finiteNumber, invalid, oneMember, optionalBoolean, optionalString, parseStringList, positiveInteger, requiredArray, requiredString, unsupported, wireArray, wireNumber, wireObject } from "../wire.js";
import { decodeMessagesImage, encodeMessagesContent } from "./content.js";
import { decodeMessagesOutputFormat, encodeMessagesOutputConfig } from "./format.js";
import { collectTargetInstructions, decodeMessagesSystem, encodeMessagesSystem } from "./instructions.js";
import { decodeMessagesThinking, mergeReasoning, outputBudget, parallelCallsForTarget, reasoningForTarget, reasoningFromEffort } from "./limits.js";
import { carrierState, applyUnsupportedImageFallback, encodedRequest, MESSAGES_SENSITIVE_EXTENSION_FIELDS, messagesObject, messagesReasoningProjection, metadataForTarget, optionalDiscriminator, optionalProtocolObject, projectMessagesMembers, requiredCarrier, requireProjection, validateCacheControl, validatedMetadata } from "./projection.js";
import { decodeMessagesToolChoice, decodeMessagesToolResult, decodeMessagesTools, decodeMessagesToolUse, encodeMessagesTool, encodeMessagesToolChoice, messagesParallelToolCalls, parseArgumentsObject, projectSemanticToolRequest } from "./tools.js";
import { type EncodeContext } from "./types.js";

const MESSAGES_TOP_LEVEL = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "metadata",
]);

export function decodeMessagesRequest(body: WireJsonObject, carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>): SemanticRequest {
  const degradations = new Set<ConversionDegradationRule>();
  body = projectMessagesMembers(
    body,
    MESSAGES_TOP_LEVEL,
    "REQ-M-TOP",
    degradations,
    MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  );
  const instructions = decodeMessagesSystem(oneMember(body, "system", "REQ-M-SYSTEM"), degradations);
  const items: SemanticRequestItem[] = [];
  for (const value of requiredArray(oneMember(body, "messages", "REQ-M-MESSAGES"), "REQ-M-MESSAGES").items) {
    decodeMessagesMessage(value, items, degradations, carrierRecords);
  }
  if (oneMember(body, "top_k", "REQ-M-TOP-K") !== undefined) {
    positiveInteger(oneMember(body, "top_k", "REQ-M-TOP-K"), "REQ-M-TOP-K");
    degradations.add("sampling.top_k_omitted");
  }
  const outputConfigValue = oneMember(body, "output_config", "REQ-M-OUTPUT-CONFIG");
  let outputConfig = outputConfigValue === undefined
    ? undefined
    : optionalProtocolObject(outputConfigValue, "REQ-M-OUTPUT-CONFIG", degradations);
  if (outputConfig !== undefined) {
    outputConfig = projectMessagesMembers(outputConfig, new Set(["effort", "format"]), "REQ-M-OUTPUT-CONFIG", degradations);
  }
  const reasoning = mergeReasoning(
    reasoningFromEffort(
      optionalString(
        outputConfig === undefined ? undefined : oneMember(outputConfig, "effort", "REQ-M-EFFORT"),
        "REQ-M-EFFORT",
      ),
      "REQ-M-EFFORT",
      degradations,
    ),
    decodeMessagesThinking(oneMember(body, "thinking", "REQ-M-THINKING"), degradations),
  );
  const tools = decodeMessagesTools(oneMember(body, "tools", "REQ-M-TOOLS"), degradations);
  const toolChoice = decodeMessagesToolChoice(oneMember(body, "tool_choice", "REQ-M-TOOL-CHOICE"), degradations);
  const parallelToolCalls = messagesParallelToolCalls(
    oneMember(body, "tool_choice", "REQ-M-TOOL-CHOICE"),
    degradations,
  );
  const projectedTools = projectSemanticToolRequest(
    items,
    tools,
    toolChoice,
    parallelToolCalls,
    degradations,
  );
  return Object.freeze({
    source: "messages",
    model: optionalString(oneMember(body, "model", "REQ-M-MODEL"), "REQ-M-MODEL"),
    stream: optionalBoolean(oneMember(body, "stream", "REQ-M-STREAM"), "REQ-M-STREAM") ?? false,
    instructions,
    items: projectedTools.items,
    tools: projectedTools.tools,
    toolChoice: projectedTools.toolChoice,
    parallelToolCalls: projectedTools.parallelToolCalls,
    maxOutputTokens: positiveInteger(oneMember(body, "max_tokens", "REQ-M-LIMIT"), "REQ-M-LIMIT"),
    temperature: finiteNumber(
      oneMember(body, "temperature", "REQ-M-TEMPERATURE"),
      "REQ-M-TEMPERATURE",
      0,
      1,
    ),
    topP: finiteNumber(oneMember(body, "top_p", "REQ-M-TOP-P"), "REQ-M-TOP-P", 0, 1),
    stop: parseStringList(oneMember(body, "stop_sequences", "REQ-M-STOP"), "REQ-M-STOP"),
    outputFormat: decodeMessagesOutputFormat(
      outputConfig === undefined ? undefined : oneMember(outputConfig, "format", "REQ-M-FORMAT"),
      degradations,
    ),
    reasoning,
    metadata: validatedMetadata(oneMember(body, "metadata", "REQ-M-METADATA"), "messages", degradations),
    degradations: [...degradations],
    ...(carrierRecords === undefined ? {} : { carrierRecords }),
  });
}

function decodeMessagesMessage(
  value: WireJson,
  output: SemanticRequestItem[],
  degradations: Set<ConversionDegradationRule>,
  carrierRecords?: ReadonlyMap<string, ReasoningCarrierRecord>,
): void {
  const message = projectMessagesMembers(
    messagesObject(value, "REQ-M-MESSAGE"),
    new Set(["role", "content"]),
    "REQ-M-MESSAGE",
    degradations,
    MESSAGES_SENSITIVE_EXTENSION_FIELDS,
  );
  const role = requiredString(oneMember(message, "role", "REQ-M-MESSAGE-ROLE"), "REQ-M-MESSAGE-ROLE");
  const content = oneMember(message, "content", "REQ-M-MESSAGE-CONTENT");
  if (role === "system" || role === "developer") {
    const instructions = decodeMessagesSystem(content, degradations);
    if (instructions.length > 0) output.push({ type: "message", role, content: instructions });
    return;
  }
  if (role !== "user" && role !== "assistant") {
    degradations.add("messages.extensions_omitted");
    return;
  }
  if (typeof content === "string") {
    output.push({ type: "message", role, content: [{ type: "text", text: content }] });
    return;
  }
  const ordinary: SemanticContent[] = [];
  const flushOrdinary = (): void => {
    if (ordinary.length === 0) {
      return;
    }
    output.push({ type: "message", role, content: ordinary.splice(0) });
  };
  for (const item of requiredArray(content, "REQ-M-MESSAGE-CONTENT").items) {
    if (!isWireJsonObject(item)) {
      if (containsReasoningCarrier(item)) invalid("REQ-M-CONTENT-BLOCK");
      degradations.add("messages.extensions_omitted");
      continue;
    }
    let block = item;
    const type = optionalDiscriminator(
      oneMember(block, "type", "REQ-M-CONTENT-TYPE"),
      "REQ-M-CONTENT-TYPE",
      degradations,
    );
    if (type === undefined) continue;
    if (type === "text") {
      block = projectMessagesMembers(
        block,
        new Set(["type", "text", "cache_control"]),
        "REQ-M-TEXT",
        degradations,
        MESSAGES_SENSITIVE_EXTENSION_FIELDS,
      );
      if (oneMember(block, "cache_control", "REQ-M-TEXT-CACHE") !== undefined) {
        validateCacheControl(oneMember(block, "cache_control", "REQ-M-TEXT-CACHE"), degradations);
        degradations.add("cache.control_omitted");
      }
      ordinary.push({
        type: "text",
        text: requiredString(oneMember(block, "text", "REQ-M-TEXT"), "REQ-M-TEXT", true),
      });
      continue;
    }
    if (type === "image") {
      if (role !== "user") {
        invalid("REQ-M-IMAGE-ROLE");
      }
      block = projectMessagesMembers(
        block,
        new Set(["type", "source", "cache_control"]),
        "REQ-M-IMAGE",
        degradations,
        MESSAGES_SENSITIVE_EXTENSION_FIELDS,
      );
      if (oneMember(block, "cache_control", "REQ-M-IMAGE-CACHE") !== undefined) {
        validateCacheControl(oneMember(block, "cache_control", "REQ-M-IMAGE-CACHE"), degradations);
        degradations.add("cache.control_omitted");
      }
      const image = decodeMessagesImage(oneMember(block, "source", "REQ-M-IMAGE-SOURCE"), degradations);
      if (image !== undefined) ordinary.push(image);
      continue;
    }
    flushOrdinary();
    if (type === "tool_use") {
      if (role !== "assistant") {
        invalid("REQ-M-TOOL-USE-ROLE");
      }
      output.push(decodeMessagesToolUse(block, degradations));
      continue;
    }
    if (type === "tool_result") {
      if (role !== "user") {
        invalid("REQ-M-TOOL-RESULT-ROLE");
      }
      output.push(decodeMessagesToolResult(block, degradations));
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      if (type === "thinking") {
        block = projectMessagesMembers(
          block,
          new Set(["type", "thinking", "signature"]),
          "REQ-M-THINKING-BLOCK",
          degradations,
        );
        requiredString(oneMember(block, "thinking", "REQ-M-THINKING-TEXT"), "REQ-M-THINKING-TEXT", true);
        const signature = optionalString(oneMember(block, "signature", "REQ-M-THINKING-SIGNATURE"), "REQ-M-THINKING-SIGNATURE");
        if (signature !== undefined && isReasoningCarrier(signature)) {
          const record = requiredCarrier(carrierRecords, signature, "responses_item", "REQ-M-THINKING-SIGNATURE");
          const state = carrierState(record, "REQ-M-THINKING-SIGNATURE");
          const reasoningItem = decodeResponsesReasoningItem(state, () => invalid("REQ-M-THINKING-SIGNATURE"));
          requireProjection(record, messagesReasoningProjection(block), "REQ-M-THINKING-SIGNATURE");
          output.push({ type: "reasoning", parts: reasoningItem.parts, opaqueState: { kind: "responses_item", item: state } });
          continue;
        }
      } else {
        block = projectMessagesMembers(block, new Set(["type", "data"]), "REQ-M-REDACTED-THINKING", degradations);
        const data = requiredString(oneMember(block, "data", "REQ-M-REDACTED-DATA"), "REQ-M-REDACTED-DATA", true);
        if (isReasoningCarrier(data)) {
          const record = requiredCarrier(carrierRecords, data, "responses_item", "REQ-M-REDACTED-DATA");
          const state = carrierState(record, "REQ-M-REDACTED-DATA");
          const reasoningItem = decodeResponsesReasoningItem(state, () => invalid("REQ-M-REDACTED-DATA"));
          requireProjection(record, messagesReasoningProjection(block), "REQ-M-REDACTED-DATA");
          output.push({ type: "reasoning", parts: reasoningItem.parts, opaqueState: { kind: "responses_item", item: state } });
          continue;
        }
      }
      degradations.add(type === "thinking" ? "reasoning.presentation_omitted" : "reasoning.state_omitted");
      continue;
    }
    degradations.add("messages.extensions_omitted");
  }
  flushOrdinary();
}

export function encodeMessagesRequest(
  request: Readonly<SemanticRequest>,
  context: Readonly<EncodeContext>,
): EncodedConversionRequest {
  const instructionProjection = collectTargetInstructions(request, "messages.extensions_omitted");
  const projectedRequest = Object.freeze({
    ...request,
    instructions: instructionProjection.instructions,
    items: instructionProjection.items,
  });
  const targetRequest = applyUnsupportedImageFallback(
    projectedRequest,
    context.capability.capabilities.inputModalities.includes("image"),
  );
  const resolvedReasoning = reasoningForTarget(context.capability, "messages", targetRequest.reasoning);
  const targetReasoning = resolvedReasoning.reasoning?.effort === "none"
    ? undefined
    : resolvedReasoning.reasoning?.effort === "minimal"
      ? { effort: "low" as const }
      : resolvedReasoning.reasoning;
  const targetDegradations = new Set<ConversionDegradationRule>([
    ...instructionProjection.degradations,
    ...resolvedReasoning.degradations,
  ]);
  if (targetRequest.outputFormat?.kind === "json_object"
    || targetRequest.outputFormat?.description !== undefined) {
    targetDegradations.add("request.option_omitted");
  }
  if (resolvedReasoning.reasoning?.effort === "minimal") targetDegradations.add("reasoning.budget_coarsened");
  let budget = outputBudget(targetRequest.maxOutputTokens, context.capability);
  const maximumBudget = context.capability.maxOutputTokens.value;
  if (maximumBudget !== null && budget > maximumBudget) {
    budget = maximumBudget;
    targetDegradations.add("request.option_omitted");
  }
  const targetParallel = parallelCallsForTarget(targetRequest, context.capability);
  for (const degradation of targetParallel.degradations) targetDegradations.add(degradation);
  const hasTools = targetRequest.tools.length > 0;
  if (!hasTools && targetRequest.toolChoice !== undefined) targetDegradations.add("request.option_omitted");
  if (!hasTools && targetRequest.parallelToolCalls !== undefined) targetDegradations.add("tools.parallel_control_omitted");
  let targetTemperature = targetRequest.temperature;
  let targetTopP = targetRequest.topP;
  if (targetReasoning?.effort !== undefined) {
    if (targetTemperature !== undefined || targetTopP !== undefined) targetDegradations.add("request.option_omitted");
    targetTemperature = undefined;
    targetTopP = undefined;
  } else if (targetTemperature !== undefined && targetTemperature > 1) {
    targetTemperature = 1;
    targetDegradations.add("request.option_omitted");
  }
  const messages = encodeMessagesItems(targetRequest.items);
  if (!messages.some(hasSubstantiveMessagesTurn) || !hasSubstantiveLeadingMessagesUser(messages)) {
    if (messages[0] !== undefined && oneMember(messages[0], "role", "REQ-INTERNAL") === "user") {
      messages[0] = syntheticMessagesLeadingUser();
    } else {
      messages.unshift(syntheticMessagesLeadingUser());
    }
    targetDegradations.add("messages.leading_user_synthesized");
  }
  const metadata = metadataForTarget(targetRequest, "messages", targetDegradations);
  const body = withMessagesCacheBreakpoints(wireObject([
    ["model", context.resolvedModel],
    ["system", encodeMessagesSystem(targetRequest.instructions)],
    ["messages", wireArray(messages)],
    ["max_tokens", wireNumber(budget)],
    ["temperature", targetTemperature === undefined ? undefined : wireNumber(targetTemperature)],
    ["top_p", targetTopP === undefined ? undefined : wireNumber(targetTopP)],
    ["stop_sequences", targetRequest.stop === undefined ? undefined : wireArray(targetRequest.stop)],
    ["stream", targetRequest.stream ? true : undefined],
    ["tools", hasTools ? wireArray(targetRequest.tools.map(encodeMessagesTool)) : undefined],
    ["tool_choice", hasTools ? encodeMessagesToolChoice(targetRequest.toolChoice, targetParallel.value) : undefined],
    ["output_config", encodeMessagesOutputConfig(targetRequest.outputFormat, targetReasoning)],
    ["metadata", metadata],
  ]));
  return encodedRequest(targetRequest, body, [...targetDegradations]);
}

function encodeMessagesItems(items: readonly SemanticRequestItem[]): WireJsonObject[] {
  const output: WireJsonObject[] = [];
  for (const item of items) {
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") continue;
      pushMessagesRole(output, item.role, item.content.map(encodeMessagesContent));
      continue;
    }
    if (item.type === "reasoning") {
      if (item.opaqueState === undefined) {
        const text = item.parts.map((part) => part.text).join("");
        if (text.length > 0) {
          pushMessagesRole(output, "assistant", [wireObject([
            ["type", "thinking"],
            ["thinking", text],
          ])]);
        }
        continue;
      }
      if (item.opaqueState.kind !== "messages_block") unsupported("REQ-TARGET-M-REASONING-STATE");
      pushMessagesRole(output, "assistant", [item.opaqueState.block]);
      continue;
    }
    if (item.type === "tool_call") {
      const input = parseArgumentsObject(item.argumentsJson, "REQ-TARGET-M-TOOL-ARGS");
      pushMessagesRole(output, "assistant", [wireObject([
        ["type", "tool_use"],
        ["id", item.callId],
        ["name", item.name],
        ["input", input],
      ])]);
      continue;
    }
    pushMessagesRole(output, "user", [wireObject([
      ["type", "tool_result"],
      ["tool_use_id", item.callId],
      ["content", wireArray(item.content.map(encodeMessagesContent))],
      ["is_error", item.isError ? true : undefined],
    ])]);
  }
  return output;
}

function hasSubstantiveLeadingMessagesUser(output: readonly WireJsonObject[]): boolean {
  const first = output[0];
  return first !== undefined
    && oneMember(first, "role", "REQ-INTERNAL") === "user"
    && hasSubstantiveMessagesUserContent(oneMember(first, "content", "REQ-INTERNAL"));
}

function hasSubstantiveMessagesTurn(message: WireJsonObject): boolean {
  const role = oneMember(message, "role", "REQ-INTERNAL");
  const content = oneMember(message, "content", "REQ-INTERNAL");
  if (role === "user") return hasSubstantiveMessagesUserContent(content);
  if (role !== "assistant" || !isWireJsonArray(content)) return false;
  return content.items.some((item) => {
    if (!isWireJsonObject(item)) return false;
    const type = oneMember(item, "type", "REQ-INTERNAL");
    if (type === "text") {
      const text = oneMember(item, "text", "REQ-INTERNAL");
      return typeof text === "string" && text.trim().length > 0;
    }
    if (type === "thinking") {
      const text = oneMember(item, "thinking", "REQ-INTERNAL");
      return typeof text === "string" && text.trim().length > 0;
    }
    return type === "redacted_thinking" || type === "tool_use";
  });
}

function syntheticMessagesLeadingUser(): WireJsonObject {
  return wireObject([
    ["role", "user"],
    ["content", wireArray([wireObject([
      ["type", "text"],
      ["text", "(continuing the conversation)"],
    ])])],
  ]);
}

function hasSubstantiveMessagesUserContent(value: WireJson | undefined): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!isWireJsonArray(value)) {
    return false;
  }
  return value.items.some((item) => {
    if (!isWireJsonObject(item)) {
      return false;
    }
    const type = oneMember(item, "type", "REQ-INTERNAL");
    if (type === "text") {
      const text = oneMember(item, "text", "REQ-INTERNAL");
      return typeof text === "string" && text.trim().length > 0;
    }
    if (type === "image") {
      return true;
    }
    return false;
  });
}

function pushMessagesRole(
  output: WireJsonObject[],
  role: "user" | "assistant",
  blocks: readonly WireJson[],
): void {
  const previous = output.at(-1);
  if (previous !== undefined && oneMember(previous, "role", "REQ-INTERNAL") === role) {
    const content = oneMember(previous, "content", "REQ-INTERNAL");
    if (isWireJsonArray(content)) {
      (content.items as WireJson[]).push(...blocks);
      return;
    }
  }
  output.push(wireObject([["role", role], ["content", wireArray(blocks)]]));
}
