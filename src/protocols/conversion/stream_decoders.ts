import { upstreamStreamEventFailure } from "../../copilot/failures.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type {
  InferenceProtocol,
  SemanticReasoningItem,
  SemanticResponse,
  SemanticStreamEvent,
  SemanticUsage,
} from "./types.js";
import { decodeSseRecords } from "./sse.js";
import type { RequestDiagnostics } from "../../telemetry/diagnostics.js";
import { diagnosticShape } from "./diagnostics.js";
import { mergeMessagesUsage } from "./usage.js";
import {
  chatCompletionsUsageFromCounters,
  mergeChatCompletionsUsageCounters,
  parseOpenaiChatCompletionsSse,
  type ChatCompletionsUsageCounters,
} from "../openai_chat_completions/native.js";
import {
  decodeChatReasoning,
  chatReasoningState,
  decodeResponsesReasoningItem,
  type ChatThinkingBlock,
} from "./reasoning.js";
import {
  responseMessageKey,
  responseMessagePartKey,
  responseMessagePartPosition,
  responseReasoningKey,
  responseReasoningPartKey,
  responseToolKey,
} from "./stream_keys.js";
import { wireObject } from "./wire.js";

export function decodeProtocolStream(
  source: InferenceProtocol,
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
  measureEvent?: (<T>(work: () => T) => T) | undefined,
  diagnostics?: RequestDiagnostics,
): AsyncIterable<SemanticStreamEvent> {
  if (source === "chat") {
    return decodeChatStream(bytes, eventLimitBytes, accumulatorBytes, measureEvent, diagnostics);
  }
  if (source === "messages") {
    return decodeMessagesStream(bytes, eventLimitBytes, accumulatorBytes, measureEvent, diagnostics);
  }
  return decodeResponsesStream(bytes, eventLimitBytes, accumulatorBytes, measureEvent, diagnostics);
}

async function* decodeChatStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
  measureEvent?: (<T>(work: () => T) => T) | undefined,
  diagnostics?: RequestDiagnostics,
): AsyncIterable<SemanticStreamEvent> {
  const budget = new DecoderBudget(accumulatorBytes);
  const tools = new Map<number, {
    id: string;
    name: string;
    pendingArguments: string;
    argumentsSeen: boolean;
    started: boolean;
    done: boolean;
  }>();
  let nextToolToStart = 0;
  let pendingFinish: SemanticResponse["finishReason"] | undefined;
  let observedUsage: ChatCompletionsUsageCounters = {};
  let chatText = "";
  let chatRefusal = "";
  let chatReasoning = "";
  let scalarReasoning = "";
  let reasoningOpen = false;
  let reasoningClosed = false;
  let opaqueChatValue: string | undefined;
  const observedThinkingBlocks = new Map<number, ChatThinkingBlock>();
  const pendingThinkingKeys: string[] = [];
  let toolObserved = false;
  const pendingPostTool: SemanticStreamEvent[] = [];
  const reasoningKey = "chat:reasoning:generic";
  const reasoningPartKey = `${reasoningKey}:summary:0`;
  const observeThinkingBlocks = function* (
    blocks: readonly ChatThinkingBlock[],
  ): Iterable<SemanticStreamEvent> {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index] as ChatThinkingBlock;
      const existing = observedThinkingBlocks.get(index);
      if (existing !== undefined) {
        if (!sameChatThinkingBlock(existing, block)) invalid();
        continue;
      }
      if (reasoningClosed || chatText.length > 0 || chatRefusal.length > 0 || toolObserved) invalid();
      budget.reserveEntry();
      observedThinkingBlocks.set(index, block);
      const key = `chat:reasoning:block:${index}`;
      if (block.type === "redacted_thinking") {
        if (block.data.length === 0) continue;
        budget.reserve(block.data);
        yield {
          kind: "reasoning_start",
          key,
          messagesState: { type: "redacted_thinking", data: block.data },
        };
        yield { kind: "semantic_progress" };
        pendingThinkingKeys.push(key);
        continue;
      }
      if (block.thinking.length === 0 && (block.signature === undefined || block.signature.length === 0)) continue;
      budget.reserve(block.thinking);
      if (block.signature !== undefined) budget.reserve(block.signature);
      if (block.signature === undefined || block.signature.length === 0) continue;
      yield {
        kind: "reasoning_start",
        key,
        messagesState: { type: "thinking", thinking: block.thinking, signature: block.signature },
      };
      yield { kind: "semantic_progress" };
      pendingThinkingKeys.push(key);
    }
  };
  const updateVisibleReasoning = function* (): Iterable<SemanticStreamEvent> {
    const thinkingReasoning = visibleThinkingBlockText(
      [...observedThinkingBlocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block),
    );
    const next = compatibleReasoningProjection(scalarReasoning, thinkingReasoning);
    if (!next.startsWith(chatReasoning)) invalid();
    const suffix = next.slice(chatReasoning.length);
    if (suffix.length === 0) return;
    budget.reserve(suffix);
    chatReasoning = next;
    reasoningOpen = true;
    yield {
      kind: "reasoning_delta",
      key: reasoningKey,
      partKey: reasoningPartKey,
      presentation: "summary",
      partIndex: 0,
      delta: suffix,
    };
  };
  const observeOpaqueChatState = (value: WireJsonObject): void => {
    const observed = chatReasoningState(value, invalid);
    if (observed === undefined) return;
    const values = memberValues(observed, "reasoning_opaque");
    if (values.length === 0) return;
    const next = values[0];
    if (typeof next !== "string" || next.length === 0) invalid();
    if (opaqueChatValue !== undefined && opaqueChatValue !== next) invalid();
    if (opaqueChatValue === undefined) budget.reserve(next);
    opaqueChatValue = next;
  };
  const closeReasoning = function* (
    status: "completed" | "incomplete" = "completed",
  ): Iterable<SemanticStreamEvent> {
    if (!reasoningOpen && pendingThinkingKeys.length === 0 && opaqueChatValue === undefined) return;
    let closed = false;
    if (reasoningOpen || opaqueChatValue !== undefined) {
      yield {
        kind: "reasoning_start",
        key: reasoningKey,
        opaqueState: {
          kind: "chat_state",
          state: wireObject([
            ["reasoning_content", chatReasoning.length === 0 ? undefined : chatReasoning],
            ["reasoning_opaque", opaqueChatValue],
          ]),
        },
      };
      reasoningOpen = false;
      yield { kind: "reasoning_done", key: reasoningKey, status };
      closed = true;
    }
    for (const key of pendingThinkingKeys.splice(0)) {
      yield { kind: "reasoning_done", key, status };
      closed = true;
    }
    reasoningClosed ||= closed;
  };
  const startReadyTools = function* (): Iterable<SemanticStreamEvent> {
    for (;;) {
      const tool = tools.get(nextToolToStart);
      if (
        tool === undefined
        || tool.started
        || !tool.argumentsSeen
        || tool.id.length === 0
        || tool.name.length === 0
      ) {
        return;
      }
      const index = nextToolToStart;
      nextToolToStart += 1;
      tool.started = true;
      yield {
        kind: "tool_start",
        key: `chat:${index}`,
        callId: tool.id,
        name: tool.name,
      };
      if (tool.pendingArguments.length > 0) {
        const pending = tool.pendingArguments;
        tool.pendingArguments = "";
        yield { kind: "tool_arguments_delta", key: `chat:${index}`, delta: pending };
      }
    }
  };
  const startIdentifiedTools = function* (): Iterable<SemanticStreamEvent> {
    for (const [index, tool] of [...tools.entries()].sort(([left], [right]) => left - right)) {
      if (tool.started) {
        continue;
      }
      if (tool.id.length === 0 || tool.name.length === 0) {
        invalid();
      }
      tool.started = true;
      yield {
        kind: "tool_start",
        key: `chat:${index}`,
        callId: tool.id,
        name: tool.name,
      };
      if (tool.pendingArguments.length > 0) {
        yield {
          kind: "tool_arguments_delta",
          key: `chat:${index}`,
          delta: tool.pendingArguments,
        };
        tool.pendingArguments = "";
      }
    }
  };
  for await (const frame of parseOpenaiChatCompletionsSse(bytes, eventLimitBytes, measureEvent, diagnostics)) {
    if (frame.kind === "error") {
      throw upstreamStreamEventFailure();
    }
    if (frame.kind === "done") {
      if (pendingFinish === undefined) {
        invalid();
      }
      if (pendingFinish === "length" || pendingFinish === "content_filter") {
        yield* startIdentifiedTools();
      }
      yield* closeReasoning(
        pendingFinish === "length" || pendingFinish === "content_filter" ? "incomplete" : "completed",
      );
      for (const [index, tool] of tools) {
        if (pendingFinish === "length" || pendingFinish === "content_filter") {
          continue;
        }
        if (!tool.started) {
          invalid();
        }
        if (tool.done) {
          continue;
        }
        tool.done = true;
        yield {
          kind: "tool_done",
          key: `chat:${index}`,
          completed: true,
        };
      }
      for (const event of pendingPostTool.splice(0)) {
        yield event;
      }
      const terminalFinish = chatRefusal.length > 0 && pendingFinish === "stop"
        ? "refusal"
        : pendingFinish;
      yield {
        kind: "terminal",
        status: terminalFinish === "length" || terminalFinish === "content_filter" || terminalFinish === "refusal"
          ? "incomplete"
          : "completed",
        finishReason: terminalFinish,
      };
      return;
    }
    const payload = frame.chunk.payload;
    if (!isWireJsonObject(payload)) {
      continue;
    }
    const usage = nullableObjectMember(payload, "usage");
    if (usage !== undefined) {
      observedUsage = mergeChatCompletionsUsageCounters(observedUsage, chatUsage(usage));
      yield { kind: "usage", usage: chatCompletionsUsageFromCounters(observedUsage) };
    }
    const choices = arrayMember(payload, "choices");
    if (choices === undefined || choices.items.length === 0) {
      continue;
    }
    if (choices.items.length !== 1 || !isWireJsonObject(choices.items[0])) {
      invalid();
    }
    const choice = choices.items[0];
    const choiceIndexValue = singleMember(choice, "index");
    if (
      choiceIndexValue !== undefined
      && (!isWireJsonNumber(choiceIndexValue) || choiceIndexValue.lexeme !== "0")
    ) {
      invalid();
    }
    const delta = objectMember(choice, "delta");
    if (delta !== undefined) {
      const audio = singleMember(delta, "audio");
      if (audio !== undefined && audio !== null) {
        invalid();
      }
      const reasoning = decodeChatReasoning(delta, invalid);
      observeOpaqueChatState(delta);
      yield* observeThinkingBlocks(reasoning.thinkingBlocks);
      if (reasoning.scalarText.length > 0) {
        if (reasoningClosed || chatText.length > 0 || chatRefusal.length > 0 || toolObserved) invalid();
        budget.reserve(reasoning.scalarText);
        scalarReasoning += reasoning.scalarText;
      }
      const callsValue = singleMember(delta, "tool_calls");
      if (callsValue !== undefined && callsValue !== null && !isWireJsonArray(callsValue)) {
        invalid();
      }
      const calls = isWireJsonArray(callsValue) ? callsValue : undefined;
      yield* updateVisibleReasoning();
      if ((calls?.items.length ?? 0) > 0) yield* closeReasoning();
      const contentValue = singleMember(delta, "content");
      if (contentValue !== undefined && contentValue !== null && typeof contentValue !== "string") {
        invalid();
      }
      const content = typeof contentValue === "string" ? contentValue : undefined;
      if (content !== undefined && content.length > 0) {
        yield* closeReasoning();
        budget.reserve(content);
        chatText += content;
        const event = { kind: "text_delta", key: toolObserved ? "chat:message:1" : "chat:message:0", delta: content } as const;
        if (toolObserved) {
          pendingPostTool.push(event);
        } else {
          yield event;
        }
      }
      const refusalValue = singleMember(delta, "refusal");
      if (refusalValue !== undefined && refusalValue !== null && typeof refusalValue !== "string") {
        invalid();
      }
      const refusal = typeof refusalValue === "string" ? refusalValue : undefined;
      if (refusal !== undefined && refusal.length > 0) {
        yield* closeReasoning();
        budget.reserve(refusal);
        chatRefusal += refusal;
        const event = { kind: "refusal_delta", key: toolObserved ? "chat:message:1" : "chat:message:0", delta: refusal } as const;
        if (toolObserved) {
          pendingPostTool.push(event);
        } else {
          yield event;
        }
      }
      if (calls !== undefined) {
        for (let position = 0; position < calls.items.length; position += 1) {
          const value = calls.items[position];
          if (!isWireJsonObject(value)) {
            invalid();
          }
          const toolIndexValue = singleMember(value, "index");
          if (
            toolIndexValue !== undefined
            && (!isWireJsonNumber(toolIndexValue) || !/^(?:0|[1-9]\d*)$/u.test(toolIndexValue.lexeme))
          ) {
            invalid();
          }
          const index = integerMember(value, "index") ?? position;
          if (index === undefined || index < 0) {
            invalid();
          }
          const existing = tools.get(index);
          if (existing === undefined) {
            budget.reserveEntry();
          }
          const tool = existing ?? {
            id: "",
            name: "",
            pendingArguments: "",
            argumentsSeen: false,
            started: false,
            done: false,
          };
          const toolType = singleMember(value, "type");
          if (toolType !== undefined && toolType !== "function") {
            invalid();
          }
          const idValue = singleMember(value, "id");
          if (idValue !== undefined && typeof idValue !== "string") {
            invalid();
          }
          const id = typeof idValue === "string" ? idValue : undefined;
          if (id !== undefined) {
            if (tool.id.length > 0 && tool.id !== id) {
              invalid();
            }
            budget.reserve(id);
            tool.id = id;
          }
          const functionValue = singleMember(value, "function");
          if (functionValue !== undefined && !isWireJsonObject(functionValue)) {
            invalid();
          }
          const fn = isWireJsonObject(functionValue) ? functionValue : undefined;
          const nameValue = fn === undefined ? undefined : singleMember(fn, "name");
          if (nameValue !== undefined && typeof nameValue !== "string") {
            invalid();
          }
          const nameDelta = typeof nameValue === "string" ? nameValue : undefined;
          if (nameDelta !== undefined) {
            if (tool.started) {
              if (nameDelta.length > 0 && nameDelta !== tool.name) {
                invalid();
              }
            } else if (nameDelta === tool.name) {
              // Repeated complete metadata is idempotent.
            } else if (nameDelta.startsWith(tool.name)) {
              budget.reserve(nameDelta.slice(tool.name.length));
              tool.name = nameDelta;
            } else {
              budget.reserve(nameDelta);
              tool.name += nameDelta;
            }
          }
          const argumentsValue = fn === undefined ? undefined : singleMember(fn, "arguments");
          if (argumentsValue !== undefined && typeof argumentsValue !== "string") {
            invalid();
          }
          const argumentsDelta = typeof argumentsValue === "string" ? argumentsValue : undefined;
          if (argumentsDelta !== undefined && argumentsDelta.length > 0) {
            budget.reserve(argumentsDelta);
            tool.pendingArguments += argumentsDelta;
            tool.argumentsSeen = true;
          }
          tools.set(index, tool);
          if (tool.started && argumentsDelta !== undefined && tool.pendingArguments.length > 0) {
            const pending = tool.pendingArguments;
            tool.pendingArguments = "";
            yield { kind: "tool_arguments_delta", key: `chat:${index}`, delta: pending };
          }
        }
        yield* startReadyTools();
        if (calls.items.length > 0) {
          toolObserved = true;
        }
      }
    }
    const finalMessage = objectMember(choice, "message");
    if (finalMessage !== undefined) {
      const audio = singleMember(finalMessage, "audio");
      if (audio !== undefined && audio !== null) {
        invalid();
      }
      const reasoning = decodeChatReasoning(finalMessage, invalid);
      observeOpaqueChatState(finalMessage);
      yield* observeThinkingBlocks(reasoning.thinkingBlocks);
      if (reasoning.scalarText.length > 0) {
        if (!reasoning.scalarText.startsWith(scalarReasoning)) invalid();
        if (reasoningClosed || chatText.length > 0 || chatRefusal.length > 0 || toolObserved) invalid();
        const suffix = reasoning.scalarText.slice(scalarReasoning.length);
        budget.reserve(suffix);
        scalarReasoning = reasoning.scalarText;
      }
      yield* updateVisibleReasoning();
      const contentValue = singleMember(finalMessage, "content");
      if (contentValue !== undefined && contentValue !== null && typeof contentValue !== "string") {
        invalid();
      }
      if ((contentValue === undefined || contentValue === null) && chatText.length > 0) {
        invalid();
      }
      if (typeof contentValue === "string") {
        if (!contentValue.startsWith(chatText)) {
          invalid();
        }
        const suffix = contentValue.slice(chatText.length);
        if (suffix.length > 0) {
          yield* closeReasoning();
          budget.reserve(suffix);
          chatText = contentValue;
          const event = {
            kind: "text_delta",
            key: toolObserved ? "chat:message:1" : "chat:message:0",
            delta: suffix,
          } as const;
          if (toolObserved) {
            pendingPostTool.push(event);
          } else {
            yield event;
          }
        }
      }
      const refusalValue = singleMember(finalMessage, "refusal");
      if (refusalValue !== undefined && refusalValue !== null && typeof refusalValue !== "string") {
        invalid();
      }
      if ((refusalValue === undefined || refusalValue === null) && chatRefusal.length > 0) {
        invalid();
      }
      if (typeof refusalValue === "string") {
        if (!refusalValue.startsWith(chatRefusal)) {
          invalid();
        }
        const suffix = refusalValue.slice(chatRefusal.length);
        if (suffix.length > 0) {
          yield* closeReasoning();
          budget.reserve(suffix);
          chatRefusal = refusalValue;
          const event = {
            kind: "refusal_delta",
            key: toolObserved ? "chat:message:1" : "chat:message:0",
            delta: suffix,
          } as const;
          if (toolObserved) {
            pendingPostTool.push(event);
          } else {
            yield event;
          }
        }
      }
      const calls = arrayMember(finalMessage, "tool_calls");
      if (calls !== undefined) {
        if (calls.items.length > 0) yield* closeReasoning();
        const finalToolArguments = new Map<number, string>();
        for (let position = 0; position < calls.items.length; position += 1) {
          const value = calls.items[position];
          if (!isWireJsonObject(value)) {
            invalid();
          }
          if (singleMember(value, "type") !== "function") {
            invalid();
          }
          const index = integerMember(value, "index") ?? position;
          const fn = objectMember(value, "function");
          const id = stringMember(value, "id");
          const name = stringMember(fn, "name");
          const argumentsJson = stringMember(fn, "arguments");
          if (
            index < 0
            || finalToolArguments.has(index)
            || id === undefined
            || id.length === 0
            || name === undefined
            || name.length === 0
            || argumentsJson === undefined
          ) {
            invalid();
          }
          let tool = tools.get(index);
          if (tool === undefined) {
            budget.reserveEntry();
            budget.reserve(id);
            budget.reserve(name);
            tool = {
              id,
              name,
              pendingArguments: "",
              argumentsSeen: true,
              started: false,
              done: false,
            };
            tools.set(index, tool);
          } else {
            if (tool.id.length === 0) {
              budget.reserve(id);
              tool.id = id;
            } else if (tool.id !== id) {
              invalid();
            }
            if (tool.name.length === 0) {
              budget.reserve(name);
              tool.name = name;
            } else if (tool.name !== name) {
              if (tool.started || !name.startsWith(tool.name)) {
                invalid();
              }
              budget.reserve(name.slice(tool.name.length));
              tool.name = name;
            }
          }
          if (!tool.started) {
            tool.argumentsSeen = true;
          }
          tool.argumentsSeen = true;
          tools.set(index, tool);
          finalToolArguments.set(index, argumentsJson);
        }
        for (const index of tools.keys()) {
          if (!finalToolArguments.has(index)) {
            invalid();
          }
        }
        yield* startReadyTools();
        for (const [index, argumentsJson] of [...finalToolArguments.entries()].sort(([left], [right]) => left - right)) {
          const tool = tools.get(index);
          if (tool === undefined || !tool.started) {
            invalid();
          }
          tool.done = true;
          yield { kind: "tool_done", key: `chat:${index}`, argumentsJson };
        }
      } else if (tools.size > 0) {
        invalid();
      }
    }
    const finish = singleMember(choice, "finish_reason");
    if (finish !== undefined && finish !== null) {
      const observedFinish = chatFinish(finish);
      if (pendingFinish !== undefined && pendingFinish !== observedFinish) {
        invalid();
      }
      pendingFinish = observedFinish;
      if (pendingFinish === "tool_calls" && tools.size === 0) {
        invalid();
      }
      if (pendingFinish === "length" || pendingFinish === "content_filter") {
        yield* startIdentifiedTools();
      } else {
        yield* startReadyTools();
      }
      for (const event of pendingPostTool.splice(0)) {
        yield event;
      }
    }
  }
  invalidTruncated();
}

function visibleThinkingBlockText(blocks: readonly ChatThinkingBlock[]): string {
  return blocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("");
}

function compatibleReasoningProjection(left: string, right: string): string {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (left.startsWith(right)) return left;
  if (right.startsWith(left)) return right;
  invalid();
}

function sameChatThinkingBlock(left: ChatThinkingBlock, right: ChatThinkingBlock): boolean {
  if (left.type !== right.type) return false;
  return left.type === "thinking"
    ? left.thinking === (right as typeof left).thinking && left.signature === (right as typeof left).signature
    : left.data === (right as typeof left).data;
}

async function* decodeMessagesStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
  measureEvent?: (<T>(work: () => T) => T) | undefined,
  diagnostics?: RequestDiagnostics,
): AsyncIterable<SemanticStreamEvent> {
  const budget = new DecoderBudget(accumulatorBytes);
  const blocks = new Map<number, MessageBlockState>();
  let pendingFinish: SemanticResponse["finishReason"] | undefined;
  const pendingReasoningKeys: string[] = [];
  let observedUsage = emptyUsage();
  for await (const record of decodeSseRecords(bytes, eventLimitBytes, measureEvent)) {
    if (record.data === "[DONE]") {
      invalid();
    }
    const payload = measuredDecode(measureEvent, () => parseEventObject(record.data, eventLimitBytes));
    const type = stringMember(payload, "type");
    diagnostics?.event(type ?? "unknown");
    diagnostics?.shape("upstream_output", () => diagnosticShape(payload));
    if (type === undefined || (record.eventName !== undefined && record.eventName !== type)) {
      invalid();
    }
    if (type === "error") {
      throw new GatewayFailureError({
        kind: "upstream_stream_error",
        source: "parser",
        phase: "stream",
      });
    }
    if (type === "message_start") {
      const message = objectMember(payload, "message");
      const usage = objectMember(message, "usage");
      if (usage !== undefined) {
        observedUsage = messagesUsage(usage, observedUsage);
        yield { kind: "usage", usage: observedUsage };
      }
      continue;
    }
    if (type === "content_block_start") {
      for (const key of pendingReasoningKeys.splice(0)) {
        yield { kind: "reasoning_done", key, status: "completed" };
      }
      const index = integerMember(payload, "index");
      const block = objectMember(payload, "content_block");
      if (index === undefined || block === undefined || blocks.has(index)) {
        invalid();
      }
      budget.reserveEntry();
      const blockType = stringMember(block, "type");
      if (blockType === "text") {
        const text = singleMember(block, "text");
        if (typeof text !== "string") {
          invalid();
        }
        blocks.set(index, { kind: "text", closed: false, sawContent: text.length > 0 });
        if (text.length > 0) {
          yield { kind: "text_delta", key: `messages:${index}:text`, delta: text };
        }
      } else if (blockType === "refusal") {
        const refusalValue = singleMember(block, "refusal") ?? singleMember(block, "text");
        if (typeof refusalValue !== "string") {
          invalid();
        }
        const refusal = refusalValue;
        blocks.set(index, { kind: "refusal", closed: false, sawContent: refusal.length > 0 });
        if (refusal.length > 0) {
          yield { kind: "refusal_delta", key: `messages:${index}:refusal`, delta: refusal };
        }
      } else if (blockType === "tool_use") {
        const callId = stringMember(block, "id");
        const name = stringMember(block, "name");
        if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0) {
          invalid();
        }
        const key = `messages:${index}`;
        const input = objectMember(block, "input");
        const initialArguments = input === undefined
          ? undefined
          : new TextDecoder().decode(serializeWireJson(input));
        if (initialArguments !== undefined) {
          budget.reserve(initialArguments);
        }
        blocks.set(index, {
          kind: "tool",
          key,
          closed: false,
          initialArguments,
          bufferedArguments: "",
          sawArgumentsDelta: false,
        });
        budget.reserve(callId);
        budget.reserve(name);
        yield { kind: "tool_start", key, callId, name };
      } else if (blockType === "thinking") {
        const thinking = singleMember(block, "thinking");
        const signature = singleMember(block, "signature");
        if (
          typeof thinking !== "string"
          || (signature !== undefined && typeof signature !== "string")
        ) {
          invalid();
        }
        const key = `messages:${index}:reasoning`;
        const partKey = `${key}:summary:0`;
        budget.reserve(thinking);
        if (typeof signature === "string") budget.reserve(signature);
        blocks.set(index, {
          kind: "reasoning",
          key,
          partKey,
          closed: false,
          sawContent: thinking.length > 0,
          thinking,
          signature: typeof signature === "string" ? signature : "",
        });
        if (thinking.length > 0) {
          yield { kind: "reasoning_delta", key, partKey, presentation: "summary", partIndex: 0, delta: thinking };
        }
        if (typeof signature === "string" && signature.length > 0) {
          yield { kind: "semantic_progress" };
        }
      } else if (blockType === "redacted_thinking") {
        const data = singleMember(block, "data");
        if (typeof data !== "string") invalid();
        const key = `messages:${index}:reasoning`;
        const sourceBlock = wireObject([["type", "redacted_thinking"], ["data", data]]);
        budget.reserve(data);
        blocks.set(index, { kind: "opaque_reasoning", key, block: sourceBlock, closed: false });
        if (data.length > 0) {
          yield {
            kind: "reasoning_start",
            key,
            opaqueState: { kind: "messages_block", block: sourceBlock },
          };
          yield { kind: "semantic_progress" };
        }
      } else {
        invalid();
      }
      continue;
    }
    if (type === "content_block_delta") {
      const index = integerMember(payload, "index");
      const delta = objectMember(payload, "delta");
      const block = index === undefined ? undefined : blocks.get(index);
      if (block === undefined || delta === undefined) {
        invalid();
      }
      if (block.closed) {
        invalid();
      }
      const deltaType = stringMember(delta, "type");
      if (block.kind === "text" && deltaType === "text_delta") {
        const text = singleMember(delta, "text");
        if (typeof text !== "string") {
          invalid();
        }
        block.sawContent ||= text.length > 0;
        yield { kind: "text_delta", key: `messages:${index}:text`, delta: text };
      } else if (block.kind === "refusal" && (deltaType === "refusal_delta" || deltaType === "text_delta")) {
        const refusalValue = deltaType === "refusal_delta"
          ? singleMember(delta, "refusal")
          : singleMember(delta, "text");
        if (typeof refusalValue !== "string") {
          invalid();
        }
        const refusal = refusalValue;
        block.sawContent ||= refusal.length > 0;
        yield {
          kind: "refusal_delta",
          key: `messages:${index}:refusal`,
          delta: refusal,
        };
      } else if (block.kind === "tool" && deltaType === "input_json_delta" && block.key !== undefined) {
        const partialJson = singleMember(delta, "partial_json");
        if (typeof partialJson !== "string") {
          invalid();
        }
        if (partialJson.length === 0) {
          continue;
        }
        if (block.initialArguments !== undefined && block.initialArguments !== "{}") {
          budget.reserve(partialJson);
          block.bufferedArguments += partialJson;
          block.sawArgumentsDelta = true;
          continue;
        }
        if (!block.sawArgumentsDelta && block.initialArguments === "{}") {
          budget.release(block.initialArguments);
          block.initialArguments = undefined;
        }
        block.sawArgumentsDelta = true;
        yield {
          kind: "tool_arguments_delta",
          key: block.key,
          delta: partialJson,
        };
      } else if (block.kind === "reasoning" && deltaType === "thinking_delta") {
        const thinking = singleMember(delta, "thinking");
        if (typeof thinking !== "string") invalid();
        block.sawContent ||= thinking.length > 0;
        block.thinking += thinking;
        if (thinking.length > 0) {
          yield {
            kind: "reasoning_delta",
            key: block.key,
            partKey: block.partKey,
            presentation: "summary",
            partIndex: 0,
            delta: thinking,
          };
        }
      } else if (block.kind === "reasoning" && deltaType === "signature_delta") {
        const signature = singleMember(delta, "signature");
        if (typeof signature !== "string") invalid();
        budget.reserve(signature);
        block.signature += signature;
        if (signature.length > 0) yield { kind: "semantic_progress" };
      } else invalid();
      continue;
    }
    if (type === "content_block_stop") {
      const index = integerMember(payload, "index");
      const block = index === undefined ? undefined : blocks.get(index);
      if (block === undefined) {
        invalid();
      }
      if (block.closed) {
        invalid();
      }
      block.closed = true;
      if (block.kind === "tool" && block.key !== undefined) {
        if (
          block.sawArgumentsDelta
          && block.initialArguments !== undefined
          && block.initialArguments !== "{}"
        ) {
          if (!measuredDecode(
            measureEvent,
            () => sameToolArguments(block.initialArguments as string, block.bufferedArguments),
          )) {
            invalid();
          }
          budget.release(block.bufferedArguments);
          block.bufferedArguments = "";
          yield {
            kind: "tool_arguments_delta",
            key: block.key,
            delta: block.initialArguments,
          };
          budget.release(block.initialArguments);
          block.initialArguments = undefined;
        } else if (!block.sawArgumentsDelta && block.initialArguments !== undefined) {
          yield {
            kind: "tool_arguments_delta",
            key: block.key,
            delta: block.initialArguments,
          };
          budget.release(block.initialArguments);
          block.initialArguments = undefined;
        }
      } else if (block.kind === "text") {
        if (!block.sawContent) {
          yield { kind: "text_done", key: `messages:${index}:text`, text: "" };
        }
        yield {
          kind: "content_done",
          key: `messages:${index}:text`,
          orderKey: `messages:${index}:text`,
          contentIndex: 0,
        };
      } else if (block.kind === "refusal") {
        if (!block.sawContent) {
          yield { kind: "refusal_done", key: `messages:${index}:refusal`, refusal: "" };
        }
        yield {
          kind: "content_done",
          key: `messages:${index}:refusal`,
          orderKey: `messages:${index}:refusal`,
          contentIndex: 0,
        };
      } else if (block.kind === "reasoning") {
        if (block.sawContent || block.signature.length > 0) {
          const sourceBlock = wireObject([
            ["type", "thinking"],
            ["thinking", block.thinking],
            ["signature", block.signature],
          ]);
          if (block.signature.length > 0) {
            yield {
              kind: "reasoning_start",
              key: block.key,
              opaqueState: { kind: "messages_block", block: sourceBlock },
            };
          }
          pendingReasoningKeys.push(block.key);
        }
      } else if (block.kind === "opaque_reasoning") {
        pendingReasoningKeys.push(block.key);
      }
      continue;
    }
    if (type === "message_delta") {
      const delta = objectMember(payload, "delta");
      const stopReason = stringMember(delta, "stop_reason");
      if (stopReason !== undefined) {
        const observedFinish = messagesFinish(stopReason);
        if (pendingFinish !== undefined && pendingFinish !== observedFinish) {
          invalid();
        }
        pendingFinish = observedFinish;
      }
      const usage = objectMember(payload, "usage");
      if (usage !== undefined) {
        observedUsage = messagesUsage(usage, observedUsage);
        yield { kind: "usage", usage: observedUsage };
      }
      continue;
    }
    if (type === "message_stop") {
      if (pendingFinish === undefined) {
        invalid();
      }
      if ([...blocks.values()].some((block) => !block.closed)) {
        invalid();
      }
      const completed = pendingFinish !== "length"
        && pendingFinish !== "content_filter"
        && pendingFinish !== "refusal";
      for (const block of blocks.values()) {
        if (block.kind === "tool") {
          yield { kind: "tool_done", key: block.key, completed };
        }
      }
      for (const key of pendingReasoningKeys.splice(0)) {
        yield {
          kind: "reasoning_done",
          key,
          status: completed ? "completed" : "incomplete",
        };
      }
      yield {
        kind: "terminal",
        status: pendingFinish === "length" || pendingFinish === "content_filter" || pendingFinish === "refusal"
          ? "incomplete"
          : "completed",
        finishReason: pendingFinish,
      };
      return;
    }
    if (type === "ping") {
      continue;
    }
    invalid();
  }
  invalidTruncated();
}

function sameWireObject(left: WireJsonObject, right: WireJsonObject): boolean {
  const leftBytes = serializeWireJson(left);
  const rightBytes = serializeWireJson(right);
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((value, index) => value === rightBytes[index]);
}

async function* decodeResponsesStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
  measureEvent?: (<T>(work: () => T) => T) | undefined,
  diagnostics?: RequestDiagnostics,
): AsyncIterable<SemanticStreamEvent> {
  const budget = new DecoderBudget(accumulatorBytes);
  const toolsByIndex = new Map<number, ResponseToolIdentity>();
  const reasoningByIndex = new Map<number, ResponseReasoningIdentity>();
  const itemAliases = new Map<string, { readonly outputIndex: number; readonly type: "function_call" | "reasoning" }>();
  const observeToolItemId = (outputIndex: number, value: WireJson | undefined): void => {
    if (value === undefined) return;
    observeResponseItemAlias(itemAliases, outputIndex, "function_call", value, budget);
  };
  const observedOutputIndexes = new Set<number>();
  const observedOutputTypes = new Map<number, string>();
  const observedOutputStatuses = new Map<number, string>();
  const observedContent = new Map<string, "output_text" | "refusal">();
  const addedOutputIndexes = new Set<number>();
  const doneOutputIndexes = new Set<number>();
  const completedReasoningParts = new Set<string>();
  let pendingStatuslessReasoning: { readonly outputIndex: number; readonly key: string } | undefined;
  const finishPendingStatuslessReasoning = function* (
    status: "completed" | "incomplete",
  ): Iterable<SemanticStreamEvent> {
    if (pendingStatuslessReasoning === undefined) return;
    yield { kind: "reasoning_done", key: pendingStatuslessReasoning.key, status };
    yield { kind: "item_done", outputIndex: pendingStatuslessReasoning.outputIndex, itemType: "reasoning" };
    pendingStatuslessReasoning = undefined;
  };
  let observedUsage = emptyUsage();
  let lastSequence = -1;
  for await (const record of decodeSseRecords(bytes, eventLimitBytes, measureEvent)) {
    if (record.data === "[DONE]") {
      invalid();
    }
    const payload = measuredDecode(measureEvent, () => parseEventObject(record.data, eventLimitBytes));
    const type = stringMember(payload, "type");
    diagnostics?.event(type ?? "unknown");
    diagnostics?.shape("upstream_output", () => diagnosticShape(payload));
    if (type === undefined || (record.eventName !== undefined && record.eventName !== type)) {
      invalid();
    }
    const sequence = integerMember(payload, "sequence_number");
    if (sequence !== undefined) {
      if (sequence <= lastSequence) {
        invalid();
      }
      lastSequence = sequence;
    }
    const eventOutputIndex = integerMember(payload, "output_index");
    if (
      pendingStatuslessReasoning !== undefined
      && eventOutputIndex !== undefined
      && eventOutputIndex !== pendingStatuslessReasoning.outputIndex
    ) {
      yield* finishPendingStatuslessReasoning("completed");
    }
    if (type === "response.output_item.added") {
      const outputIndex = integerMember(payload, "output_index");
      const item = objectMember(payload, "item");
      if (outputIndex === undefined || item === undefined) {
        invalid();
      }
      if (addedOutputIndexes.has(outputIndex) || doneOutputIndexes.has(outputIndex)) invalid();
      addedOutputIndexes.add(outputIndex);
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      const itemType = stringMember(item, "type");
      if (
        itemType !== "message"
        && itemType !== "function_call"
        && itemType !== "reasoning"
      ) {
        invalid();
      }
      observeOutputType(observedOutputTypes, outputIndex, itemType);
      if (itemType === "message") {
        observeFinalItemContent(item, outputIndex, observedContent, budget);
        yield { kind: "message_start", key: responseMessageKey(outputIndex) };
        yield* messageContentEvents(item, outputIndex, false);
      }
      if (itemType === "function_call") {
        const key = responseToolKey(outputIndex);
        const callId = stringMember(item, "call_id");
        const name = stringMember(item, "name");
        if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0) {
          invalid();
        }
        const identity = {
          key,
          itemId: stringMember(item, "id"),
          callId,
          name,
        };
        toolsByIndex.set(outputIndex, identity);
        budget.reserve(callId);
        budget.reserve(name);
        observeToolItemId(outputIndex, identity.itemId);
        yield {
          kind: "tool_start",
          key,
          itemId: identity.itemId,
          callId,
          name,
        };
        const argumentsJson = singleMember(item, "arguments");
        if (typeof argumentsJson !== "string") {
          invalid();
        }
        if (argumentsJson.length > 0) {
          yield { kind: "tool_arguments_delta", key, delta: argumentsJson };
        }
      }
      if (itemType === "reasoning") {
        const identity = observeResponseReasoningIdentity(
          reasoningByIndex,
          itemAliases,
          outputIndex,
          item,
          budget,
        );
        yield* responseReasoningItemEvents(item, identity, false, budget);
      }
      continue;
    }
    if (type === "response.output_text.delta") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "text"), "output_text");
      const delta = singleMember(payload, "delta");
      if (typeof delta !== "string") {
        invalid();
      }
      yield {
        kind: "text_delta",
        key: responseContentKey(payload, "text"),
        orderKey: responseStreamMessageKey(payload),
        delta,
      };
      continue;
    }
    if (type === "response.output_text.done") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "text"), "output_text");
      const text = singleMember(payload, "text");
      if (typeof text !== "string") {
        invalid();
      }
      yield {
        kind: "text_done",
        key: responseContentKey(payload, "text"),
        orderKey: responseStreamMessageKey(payload),
        text,
      };
      yield {
        kind: "content_done",
        key: responseContentKey(payload, "text"),
        orderKey: responseStreamMessageKey(payload),
        contentIndex: requiredContentIndex(payload),
      };
      continue;
    }
    if (type === "response.refusal.delta") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "refusal"), "refusal");
      const delta = singleMember(payload, "delta");
      if (typeof delta !== "string") {
        invalid();
      }
      yield {
        kind: "refusal_delta",
        key: responseContentKey(payload, "refusal"),
        orderKey: responseStreamMessageKey(payload),
        delta,
      };
      continue;
    }
    if (type === "response.refusal.done") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "refusal"), "refusal");
      const refusal = singleMember(payload, "refusal");
      if (typeof refusal !== "string") {
        invalid();
      }
      yield {
        kind: "refusal_done",
        key: responseContentKey(payload, "refusal"),
        orderKey: responseStreamMessageKey(payload),
        refusal,
      };
      yield {
        kind: "content_done",
        key: responseContentKey(payload, "refusal"),
        orderKey: responseStreamMessageKey(payload),
        contentIndex: requiredContentIndex(payload),
      };
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      const identity = toolsByIndex.get(outputIndex);
      if (identity === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeToolItemId(outputIndex, singleMember(payload, "item_id"));
      validateResponseToolMetadata(payload, identity);
      const delta = singleMember(payload, "delta");
      if (typeof delta !== "string") {
        invalid();
      }
      yield { kind: "tool_arguments_delta", key: identity.key, delta };
      continue;
    }
    if (type === "response.function_call_arguments.done") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      const identity = toolsByIndex.get(outputIndex);
      if (identity === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeToolItemId(outputIndex, singleMember(payload, "item_id"));
      validateResponseToolMetadata(payload, identity);
      const argumentsJson = singleMember(payload, "arguments");
      if (typeof argumentsJson !== "string") {
        invalid();
      }
      yield { kind: "tool_done", key: identity.key, argumentsJson };
      continue;
    }
    if (type === "response.output_item.done") {
      const outputIndex = integerMember(payload, "output_index");
      const item = objectMember(payload, "item");
      if (outputIndex === undefined || item === undefined) {
        invalid();
      }
      if (doneOutputIndexes.has(outputIndex)) invalid();
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      const itemType = stringMember(item, "type");
      if (itemType === undefined) {
        invalid();
      }
      const observedType = observedOutputTypes.get(outputIndex);
      if (observedType !== undefined && observedType !== itemType) {
        invalid();
      }
      observeOutputType(observedOutputTypes, outputIndex, itemType);
      const itemStatus = stringMember(item, "status");
      if (
        ((itemType === "message" || itemType === "function_call") && itemStatus === undefined)
        || (itemStatus !== undefined
          && itemStatus !== "completed"
          && itemStatus !== "incomplete"
          && itemStatus !== "in_progress")
      ) {
        invalid();
      }
      const observedStatus = observedOutputStatuses.get(outputIndex);
      if (observedStatus !== undefined && observedStatus !== itemStatus) {
        invalid();
      }
      if (itemStatus !== undefined) {
        observedOutputStatuses.set(outputIndex, itemStatus);
      }
      observeFinalItemContent(item, outputIndex, observedContent, budget);
      yield* finalItemEvents(
        item,
        outputIndex,
        toolsByIndex,
        reasoningByIndex,
        itemAliases,
        observeToolItemId,
        budget,
      );
      doneOutputIndexes.add(outputIndex);
      if (itemType === "reasoning" && itemStatus === undefined) {
        const identity = reasoningByIndex.get(outputIndex);
        if (identity === undefined || pendingStatuslessReasoning !== undefined) invalid();
        pendingStatuslessReasoning = { outputIndex, key: identity.key };
      } else {
        yield { kind: "item_done", outputIndex, itemType };
      }
      continue;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = objectMember(payload, "response");
      if (response === undefined) {
        invalid();
      }
      validateTerminalResponse(
        type,
        response,
        observedOutputIndexes,
        observedOutputTypes,
        observedOutputStatuses,
        observedContent,
      );
      if (type === "response.failed") {
        throw new GatewayFailureError({
          kind: "upstream_stream_error",
          source: "parser",
          phase: "stream",
        });
      }

      yield* finalResponseEvents(
        response,
        toolsByIndex,
        reasoningByIndex,
        itemAliases,
        doneOutputIndexes,
        observeToolItemId,
        budget,
      );
      yield* finishPendingStatuslessReasoning(type === "response.incomplete" ? "incomplete" : "completed");
      const usage = objectMember(response, "usage");
      if (usage !== undefined) {
        observedUsage = responsesUsage(usage, observedUsage);
        yield { kind: "usage", usage: observedUsage };
      }
      const incompleteReason = type === "response.incomplete"
        ? stringMember(objectMember(response, "incomplete_details"), "reason")
        : undefined;
      yield {
        kind: "terminal",
        status: type === "response.incomplete" ? "incomplete" : "completed",
        finishReason: type === "response.incomplete"
          ? incompleteReason === "content_filter" ? "content_filter" : "length"
          : responseHasRefusal(response)
            ? "refusal"
            : toolsByIndex.size > 0 ? "tool_calls" : "stop",
      };
      return;
    }

    if (type === "response.content_part.added" || type === "response.content_part.done") {
      const outputIndex = requiredOutputIndex(payload);
      if (doneOutputIndexes.has(outputIndex)) invalid();
      const contentIndex = integerMember(payload, "content_index");
      const part = objectMember(payload, "part");
      if (contentIndex === undefined || contentIndex < 0 || part === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      const partType = stringMember(part, "type");
      if (partType === "output_text") {
        const text = stringMember(part, "text");
        if (text === undefined) {
          invalid();
        }
        const key = responseMessagePartKey(outputIndex, contentIndex, "text");
        observeContent(observedContent, budget, key, "output_text");
        yield {
          kind: "text_done",
          key,
          orderKey: responseMessageKey(outputIndex),
          text,
        };
      } else if (partType === "refusal") {
        const refusal = stringMember(part, "refusal");
        if (refusal === undefined) {
          invalid();
        }
        const key = responseMessagePartKey(outputIndex, contentIndex, "refusal");
        observeContent(observedContent, budget, key, "refusal");
        yield {
          kind: "refusal_done",
          key,
          orderKey: responseMessageKey(outputIndex),
          refusal,
        };
      } else if (partType === "reasoning_text") {
        const identity = requiredResponseReasoningIdentity(
          payload,
          reasoningByIndex,
          itemAliases,
          observedOutputIndexes,
          observedOutputTypes,
          budget,
        );
        const text = stringMember(part, "text");
        if (text === undefined) invalid();
        const partKey = responseReasoningPartKey(identity.key, "content", contentIndex);
        const completedText = identity.completedText.get(partKey);
        if (
          type === "response.content_part.added"
            ? completedReasoningParts.has(partKey) || completedText !== undefined
            : completedReasoningParts.has(partKey) || (completedText !== undefined && completedText !== text)
        ) invalid();
        observeResponseReasoningPart(identity, partKey, budget);
        yield { kind: "reasoning_start", key: identity.key, itemId: identity.itemId };
        yield {
          kind: "reasoning_snapshot",
          key: identity.key,
          partKey,
          itemId: identity.itemId,
          presentation: "content",
          partIndex: contentIndex,
          text,
        };
        if (type === "response.content_part.done") completedReasoningParts.add(partKey);
        if (type === "response.content_part.done") identity.completedText.set(partKey, text);
      } else {
        invalid();
      }
      if (type === "response.content_part.done" && partType !== "reasoning_text") {
        yield {
          kind: "content_done",
          key: partType === "output_text"
            ? responseMessagePartKey(outputIndex, contentIndex, "text")
            : responseMessagePartKey(outputIndex, contentIndex, "refusal"),
          orderKey: responseMessageKey(outputIndex),
          contentIndex,
        };
      }
      continue;
    }
    if (
      type === "response.created"
      || type === "response.in_progress"
    ) {
      const response = objectMember(payload, "response");
      const usage = response === undefined ? undefined : nullableObjectMember(response, "usage");
      if (usage !== undefined) {
        observedUsage = responsesUsage(usage, observedUsage);
        yield { kind: "usage", usage: observedUsage };
      }
      continue;
    }
    if (
      type === "response.reasoning_summary_part.added"
      || type === "response.reasoning_summary_part.done"
    ) {
      const identity = requiredResponseReasoningIdentity(
        payload,
        reasoningByIndex,
        itemAliases,
        observedOutputIndexes,
        observedOutputTypes,
        budget,
      );
      const summaryIndex = requiredReasoningPartIndex(payload, "summary_index");
      const partKey = responseReasoningPartKey(identity.key, "summary", summaryIndex);
      if (
        doneOutputIndexes.has(requiredOutputIndex(payload))
        || completedReasoningParts.has(partKey)
        || (type === "response.reasoning_summary_part.added" && identity.completedText.has(partKey))
      ) invalid();
      observeResponseReasoningPart(identity, partKey, budget);
      const part = objectMember(payload, "part");
      if (part === undefined || stringMember(part, "type") !== "summary_text") invalid();
      const text = stringMember(part, "text");
      if (text === undefined) invalid();
      const completedText = identity.completedText.get(partKey);
      if (type === "response.reasoning_summary_part.done" && completedText !== undefined && completedText !== text) invalid();
      yield {
        kind: "reasoning_snapshot",
        key: identity.key,
        partKey,
        itemId: identity.itemId,
        presentation: "summary",
        partIndex: summaryIndex,
        text,
      };
      if (type === "response.reasoning_summary_part.done") completedReasoningParts.add(partKey);
      if (type === "response.reasoning_summary_part.done") identity.completedText.set(partKey, text);
      continue;
    }
    if (
      type === "response.reasoning_summary_text.delta"
      || type === "response.reasoning_summary_text.done"
      || type === "response.reasoning_text.delta"
      || type === "response.reasoning_text.done"
    ) {
      const identity = requiredResponseReasoningIdentity(
        payload,
        reasoningByIndex,
        itemAliases,
        observedOutputIndexes,
        observedOutputTypes,
        budget,
      );
      const summary = type.includes("summary");
      const done = type.endsWith(".done");
      const presentation = summary ? "summary" as const : "content" as const;
      const partIndex = requiredReasoningPartIndex(payload, summary ? "summary_index" : "content_index");
      const partKey = responseReasoningPartKey(identity.key, presentation, partIndex);
      if (
        doneOutputIndexes.has(requiredOutputIndex(payload))
        || completedReasoningParts.has(partKey)
        || identity.completedText.has(partKey)
      ) invalid();
      observeResponseReasoningPart(identity, partKey, budget);
      const text = singleMember(payload, done ? "text" : "delta");
      if (typeof text !== "string") invalid();
      if (done) identity.completedText.set(partKey, text);
      yield {
        kind: done ? "reasoning_snapshot" : "reasoning_delta",
        key: identity.key,
        partKey,
        itemId: identity.itemId,
        presentation,
        partIndex,
        ...(done ? { text } : { delta: text }),
      } as SemanticStreamEvent;
      continue;
    }
    if (type === "error") {
      throw new GatewayFailureError({
        kind: "upstream_stream_error",
        source: "parser",
        phase: "stream",
      });
    }
    invalid();
  }
  invalidTruncated();
}

function validateTerminalResponse(
  eventType: string,
  response: WireJsonObject,
  observedOutputIndexes: ReadonlySet<number>,
  observedOutputTypes: ReadonlyMap<number, string>,
  observedOutputStatuses: ReadonlyMap<number, string>,
  observedContent: ReadonlyMap<string, "output_text" | "refusal">,
): void {
  const expectedStatus = eventType === "response.completed"
    ? "completed"
    : eventType === "response.incomplete"
      ? "incomplete"
      : "failed";
  if (stringMember(response, "status") !== expectedStatus) {
    invalid();
  }
  const output = arrayMember(response, "output");
  if (output === undefined) {
    invalid();
  }
  for (const item of output.items) {
    if (!isWireJsonObject(item)) {
      continue;
    }
    const itemType = stringMember(item, "type");
    if (itemType !== "function_call" && itemType !== "message" && itemType !== "reasoning") {
      continue;
    }
    const itemStatus = stringMember(item, "status");
    if (
      ((itemType === "function_call" || itemType === "message") && itemStatus === undefined)
      || (itemStatus !== undefined
        && itemStatus !== "completed"
        && itemStatus !== "incomplete"
        && itemStatus !== "in_progress")
      || (expectedStatus === "completed" && itemStatus !== undefined && itemStatus !== "completed")
    ) {
      invalid();
    }
  }
  for (const index of observedOutputIndexes) {
    const item = output.items[index];
    if (index < 0 || index >= output.items.length || !isWireJsonObject(item)) {
      invalid();
    }
    const observedType = observedOutputTypes.get(index);
    if (observedType !== undefined && stringMember(item, "type") !== observedType) {
      invalid();
    }
    const observedStatus = observedOutputStatuses.get(index);
    const finalStatus = stringMember(item, "status");
    if (observedStatus !== undefined && finalStatus !== undefined && finalStatus !== observedStatus) {
      invalid();
    }
  }
  for (const [key, expectedType] of observedContent) {
    const position = responseMessagePartPosition(key);
    if (position === undefined) invalid();
    const { outputIndex, contentIndex } = position;
    const item = output.items[outputIndex];
    const content = isWireJsonObject(item) ? arrayMember(item, "content") : undefined;
    const part = content?.items[contentIndex];
    if (!isWireJsonObject(part) || stringMember(part, "type") !== expectedType) {
      invalid();
    }
  }
}

function observeOutputIndex(
  indexes: Set<number>,
  budget: DecoderBudget,
  outputIndex: number,
): void {
  if (!indexes.has(outputIndex)) {
    budget.reserveEntry();
    indexes.add(outputIndex);
  }
}

function observeOutputType(types: Map<number, string>, outputIndex: number, type: string): void {
  const existing = types.get(outputIndex);
  if (existing !== undefined && existing !== type) invalid();
  types.set(outputIndex, type);
}

function observeResponseItemAlias(
  aliases: Map<string, { readonly outputIndex: number; readonly type: "function_call" | "reasoning" }>,
  outputIndex: number,
  type: "function_call" | "reasoning",
  value: WireJson,
  budget: DecoderBudget,
): void {
  if (typeof value !== "string" || value.length === 0) invalid();
  const existing = aliases.get(value);
  if (existing !== undefined) {
    if (existing.outputIndex !== outputIndex || existing.type !== type) invalid();
    return;
  }
  budget.reserveEntry();
  budget.reserve(value);
  aliases.set(value, { outputIndex, type });
}

function observeContent(
  content: Map<string, "output_text" | "refusal">,
  budget: DecoderBudget,
  key: string,
  type: "output_text" | "refusal",
): void {
  const existing = content.get(key);
  if (existing !== undefined) {
    if (existing !== type) {
      invalid();
    }
    return;
  }
  budget.reserveEntry();
  content.set(key, type);
}

function observeFinalItemContent(
  item: WireJsonObject,
  outputIndex: number,
  observedContent: Map<string, "output_text" | "refusal">,
  budget: DecoderBudget,
): void {
  if (stringMember(item, "type") !== "message") {
    return;
  }
  const content = arrayMember(item, "content");
  if (content === undefined) {
    invalid();
  }
  for (let contentIndex = 0; contentIndex < content.items.length; contentIndex += 1) {
    const part = content.items[contentIndex];
    if (!isWireJsonObject(part)) {
      invalid();
    }
    const type = stringMember(part, "type");
    if (type !== "output_text" && type !== "refusal") {
      invalid();
    }
    observeContent(
      observedContent,
      budget,
      responseMessagePartKey(outputIndex, contentIndex, type === "output_text" ? "text" : "refusal"),
      type,
    );
  }
}

function requiredOutputIndex(object: WireJsonObject): number {
  const value = integerMember(object, "output_index");
  if (value === undefined || value < 0) {
    invalid();
  }
  return value;
}

function requiredContentIndex(object: WireJsonObject): number {
  const value = integerMember(object, "content_index");
  if (value === undefined || value < 0) {
    invalid();
  }
  return value;
}

function responseHasRefusal(response: WireJsonObject): boolean {
  const output = arrayMember(response, "output");
  return output?.items.some((item) => {
    if (!isWireJsonObject(item) || stringMember(item, "type") !== "message") {
      return false;
    }
    return arrayMember(item, "content")?.items.some((part) => (
      isWireJsonObject(part) && stringMember(part, "type") === "refusal"
    )) === true;
  }) === true;
}

function sameToolArguments(left: string, right: string): boolean {
  try {
    const leftBytes = new TextEncoder().encode(left);
    const rightBytes = new TextEncoder().encode(right);
    const leftValue = parseWireJson(leftBytes, { maxBytes: Math.max(1, leftBytes.byteLength), maxDepth: 32 });
    const rightValue = parseWireJson(rightBytes, { maxBytes: Math.max(1, rightBytes.byteLength), maxDepth: 32 });
    return isWireJsonObject(leftValue)
      && isWireJsonObject(rightValue)
      && equalWireJson(leftValue, rightValue);
  } catch {
    return false;
  }
}

function equalWireJson(left: WireJson, right: WireJson): boolean {
  if (isWireJsonNumber(left) || isWireJsonNumber(right)) {
    return isWireJsonNumber(left)
      && isWireJsonNumber(right)
      && normalizeJsonNumber(left.lexeme) === normalizeJsonNumber(right.lexeme);
  }
  if (isWireJsonArray(left) || isWireJsonArray(right)) {
    return isWireJsonArray(left)
      && isWireJsonArray(right)
      && left.items.length === right.items.length
      && left.items.every((item, index) => equalWireJson(item, right.items[index] as WireJson));
  }
  if (isWireJsonObject(left) || isWireJsonObject(right)) {
    if (
      !isWireJsonObject(left)
      || !isWireJsonObject(right)
      || left.members.length !== right.members.length
      || duplicateMemberNames(left).length > 0
      || duplicateMemberNames(right).length > 0
    ) {
      return false;
    }
    const rightByKey = new Map(right.members.map((member) => [member.key, member.value]));
    return left.members.every((member) => {
      const match = rightByKey.get(member.key);
      return match !== undefined && equalWireJson(member.value, match);
    });
  }
  return left === right;
}

function normalizeJsonNumber(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (match?.[2] === undefined) {
    return value;
  }
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, "");
  if (digits.length === 0) {
    return "0";
  }
  let exponentAdjustment = -fraction.length;
  let trailingZeros = 0;
  for (let index = digits.length - 1; index >= 0 && digits[index] === "0"; index -= 1) {
    trailingZeros += 1;
  }
  if (trailingZeros > 0) {
    digits = digits.slice(0, -trailingZeros);
    exponentAdjustment += trailingZeros;
  }
  return `${match[1] ?? ""}${digits}e${adjustSignedDecimal(match[4] ?? "0", exponentAdjustment)}`;
}

function adjustSignedDecimal(value: string, adjustment: number): string {
  const left = signedDecimal(value);
  const right = signedDecimal(String(adjustment));
  if (left.negative === right.negative) {
    return signedMagnitude(left.negative, addMagnitude(left.digits, right.digits));
  }
  const comparison = compareMagnitude(left.digits, right.digits);
  if (comparison === 0) {
    return "0";
  }
  return comparison > 0
    ? signedMagnitude(left.negative, subtractMagnitude(left.digits, right.digits))
    : signedMagnitude(right.negative, subtractMagnitude(right.digits, left.digits));
}

function signedDecimal(value: string): { readonly negative: boolean; readonly digits: string } {
  const negative = value.startsWith("-");
  const unsigned = value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value;
  const digits = unsigned.replace(/^0+/u, "") || "0";
  return { negative: negative && digits !== "0", digits };
}

function signedMagnitude(negative: boolean, digits: string): string {
  return negative && digits !== "0" ? `-${digits}` : digits;
}

function compareMagnitude(left: string, right: string): number {
  return left.length === right.length
    ? left === right ? 0 : left > right ? 1 : -1
    : left.length > right.length ? 1 : -1;
}

function addMagnitude(left: string, right: string): string {
  const output: string[] = [];
  let carry = 0;
  for (let offset = 0; offset < Math.max(left.length, right.length) || carry > 0; offset += 1) {
    const leftDigit = offset < left.length ? left.charCodeAt(left.length - 1 - offset) - 48 : 0;
    const rightDigit = offset < right.length ? right.charCodeAt(right.length - 1 - offset) - 48 : 0;
    const total = leftDigit + rightDigit + carry;
    output.push(String(total % 10));
    carry = Math.floor(total / 10);
  }
  return output.reverse().join("");
}

function subtractMagnitude(left: string, right: string): string {
  const output: string[] = [];
  let borrow = 0;
  for (let offset = 0; offset < left.length; offset += 1) {
    let digit = left.charCodeAt(left.length - 1 - offset) - 48 - borrow;
    const rightDigit = offset < right.length ? right.charCodeAt(right.length - 1 - offset) - 48 : 0;
    if (digit < rightDigit) {
      digit += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    output.push(String(digit - rightDigit));
  }
  return output.reverse().join("").replace(/^0+/u, "") || "0";
}

function* finalResponseEvents(
  response: WireJsonObject,
  toolsByIndex: Map<number, ResponseToolIdentity>,
  reasoningByIndex: Map<number, ResponseReasoningIdentity>,
  itemAliases: Map<string, { readonly outputIndex: number; readonly type: "function_call" | "reasoning" }>,
  doneOutputIndexes: ReadonlySet<number>,
  observeToolItemId: (outputIndex: number, value: WireJson | undefined) => void,
  budget: DecoderBudget,
): Iterable<SemanticStreamEvent> {
  const output = arrayMember(response, "output");
  if (output === undefined) {
    invalid();
  }
  for (let index = 0; index < output.items.length; index += 1) {
    const item = output.items[index];
    if (!isWireJsonObject(item)) {
      invalid();
    }
    yield* finalItemEvents(
      item,
      index,
      toolsByIndex,
      reasoningByIndex,
      itemAliases,
      observeToolItemId,
      budget,
      doneOutputIndexes.has(index),
    );
  }
}

function* finalItemEvents(
  item: WireJsonObject,
  outputIndex: number,
  toolsByIndex: Map<number, ResponseToolIdentity>,
  reasoningByIndex: Map<number, ResponseReasoningIdentity>,
  itemAliases: Map<string, { readonly outputIndex: number; readonly type: "function_call" | "reasoning" }>,
  observeToolItemId: (outputIndex: number, value: WireJson | undefined) => void,
  budget: DecoderBudget,
  alreadyDone = false,
): Iterable<SemanticStreamEvent> {
  const type = stringMember(item, "type");
  if (type === "message") {
    yield* messageContentEvents(item, outputIndex, true);
    return;
  }
  if (type === "function_call") {
    const finalItemId = requiredStreamString(item, "id");
    const finalCallId = requiredStreamString(item, "call_id");
    const finalName = requiredStreamString(item, "name");
    const finalArguments = requiredStreamString(item, "arguments", true);
    const status = requiredStreamString(item, "status");
    if (status !== "completed" && status !== "incomplete" && status !== "in_progress") {
      invalid();
    }
    observeToolItemId(outputIndex, finalItemId);
    let identity = toolsByIndex.get(outputIndex);
    if (identity === undefined) {
      identity = {
        key: responseToolKey(outputIndex),
        itemId: finalItemId,
        callId: finalCallId,
        name: finalName,
      };
      toolsByIndex.set(outputIndex, identity);
      yield {
        kind: "tool_start",
        key: identity.key,
        itemId: identity.itemId,
        callId: finalCallId,
        name: finalName,
      };
    } else {
      // The output index and stable call metadata identify the tool, not the opaque item ID.
      if (
        finalCallId !== identity.callId
        || finalName !== identity.name
      ) {
        invalid();
      }
    }
    yield {
      kind: "tool_done",
      key: identity.key,
      argumentsJson: finalArguments,
      completed: status === "completed",
    };
    return;
  }

  if (type === "reasoning") {
    const identity = observeResponseReasoningIdentity(
      reasoningByIndex,
      itemAliases,
      outputIndex,
      item,
      budget,
    );
    yield* responseReasoningItemEvents(item, identity, true, budget, alreadyDone);
    return;
  }
  invalid();
}

function* messageContentEvents(
  item: WireJsonObject,
  outputIndex: number,
  complete: boolean,
): Iterable<SemanticStreamEvent> {
  const content = arrayMember(item, "content");
  if (content === undefined) {
    invalid();
  }
  for (let contentIndex = 0; contentIndex < content.items.length; contentIndex += 1) {
    const part = content.items[contentIndex];
    if (!isWireJsonObject(part)) {
      invalid();
    }
    const partType = stringMember(part, "type");
    if (partType === "output_text") {
      const text = stringMember(part, "text");
      if (text === undefined) {
        invalid();
      }
      const key = responseMessagePartKey(outputIndex, contentIndex, "text");
      yield {
        kind: "text_done",
        key,
        orderKey: responseMessageKey(outputIndex),
        text,
      };
      if (complete) {
        yield {
          kind: "content_done",
          key,
          orderKey: responseMessageKey(outputIndex),
          contentIndex,
        };
      }
    } else if (partType === "refusal") {
      const refusal = stringMember(part, "refusal");
      if (refusal === undefined) {
        invalid();
      }
      const key = responseMessagePartKey(outputIndex, contentIndex, "refusal");
      yield {
        kind: "refusal_done",
        key,
        orderKey: responseMessageKey(outputIndex),
        refusal,
      };
      if (complete) {
        yield {
          kind: "content_done",
          key,
          orderKey: responseMessageKey(outputIndex),
          contentIndex,
        };
      }
    } else {
      invalid();
    }
  }
}

function validateResponseToolMetadata(payload: WireJsonObject, identity: ResponseToolIdentity): void {
  // Argument events may omit stable metadata; any explicit value must agree with the indexed call.
  const callId = singleMember(payload, "call_id");
  const name = singleMember(payload, "name");
  if ((callId !== undefined && callId !== identity.callId) || (name !== undefined && name !== identity.name)) {
    invalid();
  }
}

interface ResponseToolIdentity {
  readonly key: string;
  readonly itemId?: string | undefined;
  readonly callId: string;
  readonly name: string;
}

interface ResponseReasoningIdentity {
  readonly key: string;
  readonly itemId: string;
  readonly parts: Set<string>;
  readonly completedText: Map<string, string>;
  finalItem?: SemanticReasoningItem | undefined;
  doneItem?: SemanticReasoningItem | undefined;
}

function observeResponseReasoningIdentity(
  identities: Map<number, ResponseReasoningIdentity>,
  itemAliases: Map<string, { readonly outputIndex: number; readonly type: "function_call" | "reasoning" }>,
  outputIndex: number,
  item: WireJsonObject,
  budget: DecoderBudget,
): ResponseReasoningIdentity {
  const itemId = stringMember(item, "id");
  if (itemId === undefined || itemId.length === 0) invalid();
  const existing = identities.get(outputIndex);
  if (existing !== undefined) {
    observeResponseItemAlias(itemAliases, outputIndex, "reasoning", itemId, budget);
    return existing;
  }
  observeResponseItemAlias(itemAliases, outputIndex, "reasoning", itemId, budget);
  budget.reserveEntry();
  const identity = {
    key: responseReasoningKey(outputIndex),
    itemId,
    parts: new Set<string>(),
    completedText: new Map<string, string>(),
  };
  identities.set(outputIndex, identity);
  return identity;
}

function requiredResponseReasoningIdentity(
  payload: WireJsonObject,
  identities: Map<number, ResponseReasoningIdentity>,
  itemAliases: Map<string, { readonly outputIndex: number; readonly type: "function_call" | "reasoning" }>,
  observedOutputIndexes: Set<number>,
  observedOutputTypes: Map<number, string>,
  budget: DecoderBudget,
): ResponseReasoningIdentity {
  const outputIndex = requiredOutputIndex(payload);
  const itemId = stringMember(payload, "item_id");
  if (itemId === undefined || itemId.length === 0) invalid();
  let identity = identities.get(outputIndex);
  if (identity === undefined) {
    observeOutputIndex(observedOutputIndexes, budget, outputIndex);
    const observedType = observedOutputTypes.get(outputIndex);
    if (observedType !== undefined && observedType !== "reasoning") invalid();
    observeOutputType(observedOutputTypes, outputIndex, "reasoning");
    observeResponseItemAlias(itemAliases, outputIndex, "reasoning", itemId, budget);
    budget.reserveEntry();
    identity = {
      key: responseReasoningKey(outputIndex),
      itemId,
      parts: new Set<string>(),
      completedText: new Map<string, string>(),
    };
    identities.set(outputIndex, identity);
  } else observeResponseItemAlias(itemAliases, outputIndex, "reasoning", itemId, budget);
  return identity;
}

function requiredReasoningPartIndex(payload: WireJsonObject, key: "summary_index" | "content_index"): number {
  const index = integerMember(payload, key);
  if (index === undefined || index < 0) invalid();
  return index;
}

function observeResponseReasoningPart(
  identity: ResponseReasoningIdentity,
  partKey: string,
  budget: DecoderBudget,
): void {
  if (identity.parts.has(partKey)) return;
  budget.reserveEntry();
  identity.parts.add(partKey);
}

function* responseReasoningItemEvents(
  item: WireJsonObject,
  identity: ResponseReasoningIdentity,
  complete: boolean,
  budget: DecoderBudget,
  alreadyDone = false,
): Iterable<SemanticStreamEvent> {
  const reasoning = decodeResponsesReasoningItem(item, invalid);
  if (alreadyDone) {
    const observed = identity.finalItem ?? identity.doneItem;
    if (observed === undefined || !sameSemanticReasoning(observed, reasoning)) invalid();
    return;
  }
  if (complete && reasoning.opaqueState !== undefined) {
    yield {
      kind: "reasoning_start",
      key: identity.key,
      itemId: identity.itemId,
      opaqueState: reasoning.opaqueState,
    };
  }
  const finalParts = new Set(reasoning.parts.map((part) => (
    responseReasoningPartKey(identity.key, part.presentation, part.index)
  )));
  if (complete && [...identity.parts].some((partKey) => !finalParts.has(partKey))) invalid();
  if (complete) {
    const finalText = new Map(reasoning.parts.map((part) => [
      responseReasoningPartKey(identity.key, part.presentation, part.index),
      part.text,
    ]));
    if ([...identity.completedText].some(([partKey, text]) => finalText.get(partKey) !== text)) invalid();
  }
  yield { kind: "reasoning_start", key: identity.key, itemId: identity.itemId };
  for (const part of reasoning.parts) {
    const partKey = responseReasoningPartKey(identity.key, part.presentation, part.index);
    observeResponseReasoningPart(identity, partKey, budget);
    yield {
      kind: "reasoning_snapshot",
      key: identity.key,
      partKey,
      itemId: identity.itemId,
      presentation: part.presentation,
      partIndex: part.index,
      text: part.text,
    };
  }
  if (reasoning.parts.every((part) => part.text.length === 0) && reasoning.hasOpaqueState) {
    yield { kind: "semantic_progress" };
  }
  if (complete && reasoning.parts.some((part) => part.text.length > 0)) {
    if (reasoning.status !== undefined) {
      yield {
        kind: "reasoning_done",
        key: identity.key,
        status: reasoning.status,
      };
    }
  }
  if (complete) {
    identity.doneItem = reasoning;
    identity.finalItem = reasoning;
    if (reasoning.parts.every((part) => part.text.length === 0) && reasoning.status !== undefined) {
      yield {
        kind: "reasoning_done",
        key: identity.key,
        status: reasoning.status,
      };
    }
  }
}

function sameSemanticReasoning(left: SemanticReasoningItem, right: SemanticReasoningItem): boolean {
  return (left.status === undefined || right.status === undefined || left.status === right.status)
    && left.parts.length === right.parts.length
    && left.parts.every((part, index) => {
      const candidate = right.parts[index];
      return candidate !== undefined
        && part.presentation === candidate.presentation
        && part.index === candidate.index
        && part.text === candidate.text;
    })
    && sameRotatingOpaqueState(left.opaqueState, right.opaqueState);
}

function sameRotatingOpaqueState(
  left: SemanticReasoningItem["opaqueState"],
  right: SemanticReasoningItem["opaqueState"],
): boolean {
  if (left?.kind !== "responses_item" || right?.kind !== "responses_item") {
    return sameOptionalOpaqueState(left, right);
  }
  const leftEncrypted = memberValues(left.item, "encrypted_content");
  const rightEncrypted = memberValues(right.item, "encrypted_content");
  if (leftEncrypted.length !== 1 || rightEncrypted.length !== 1) return false;
  if (typeof leftEncrypted[0] !== "string" || typeof rightEncrypted[0] !== "string") return false;
  return sameResponseReasoningProjection(left.item, right.item);
}

function sameResponseReasoningProjection(left: WireJsonObject, right: WireJsonObject): boolean {
  const leftValue = {
    kind: "object" as const,
    members: left.members.filter((member) => (
      member.key !== "id" && member.key !== "status" && member.key !== "encrypted_content"
    )),
  };
  const rightValue = {
    kind: "object" as const,
    members: right.members.filter((member) => (
      member.key !== "id" && member.key !== "status" && member.key !== "encrypted_content"
    )),
  };
  return sameWireObject(leftValue, rightValue);
}

function sameOptionalOpaqueState(
  left: SemanticReasoningItem["opaqueState"],
  right: SemanticReasoningItem["opaqueState"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  const leftValue = left.kind === "responses_item" ? normalizedResponseOpaqueItem(left.item)
    : left.kind === "messages_block" ? left.block : left.state;
  const rightValue = right.kind === "responses_item" ? normalizedResponseOpaqueItem(right.item)
    : right.kind === "messages_block" ? right.block : right.state;
  return sameWireObject(leftValue, rightValue);
}

function normalizedResponseOpaqueItem(item: WireJsonObject): WireJsonObject {
  return {
    kind: "object",
    members: item.members.filter((member) => member.key !== "id" && member.key !== "status"),
  };
}

type MessageBlockState =
  | { readonly kind: "text" | "refusal"; closed: boolean; sawContent: boolean }
  | { readonly kind: "opaque_reasoning"; readonly key: string; readonly block: WireJsonObject; closed: boolean }
  | {
    readonly kind: "reasoning";
    readonly key: string;
    readonly partKey: string;
    closed: boolean;
    sawContent: boolean;
    thinking: string;
    signature: string;
  }
  | {
    readonly kind: "tool";
    readonly key: string;
    initialArguments?: string | undefined;
    bufferedArguments: string;
    sawArgumentsDelta: boolean;
    closed: boolean;
  };

function parseEventObject(data: string, eventLimitBytes: number): WireJsonObject {
  try {
    const bytes = new TextEncoder().encode(data);
    const parsed = parseWireJson(bytes, { maxBytes: Math.min(eventLimitBytes, Math.max(1, bytes.byteLength)), maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      invalid();
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({
      kind: "invalid_upstream_response",
      source: "parser",
      phase: "stream",
      cause: error,
    });
  }
}

function measuredDecode<T>(
  measureEvent: (<Result>(work: () => Result) => Result) | undefined,
  work: () => T,
): T {
  return measureEvent === undefined ? work() : measureEvent(work);
}

function requiredStreamString(object: WireJsonObject, key: string, allowEmpty = false): string {
  const values = memberValues(object, key);
  if (
    values.length !== 1
    || typeof values[0] !== "string"
    || (!allowEmpty && values[0].length === 0)
  ) {
    invalid();
  }
  return values[0];
}

function chatFinish(value: WireJson): SemanticResponse["finishReason"] {
  if (value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter") {
    return value;
  }
  invalid();
}

function messagesFinish(value: string): SemanticResponse["finishReason"] {
  if (value === "end_turn" || value === "stop_sequence") {
    return "stop";
  }
  if (value === "tool_use") {
    return "tool_calls";
  }
  if (value === "max_tokens" || value === "model_context_window_exceeded") {
    return "length";
  }
  if (value === "refusal") {
    return "refusal";
  }
  invalid();
}

function chatUsage(value: WireJsonObject): ChatCompletionsUsageCounters {
  const promptDetails = objectMember(value, "prompt_tokens_details");
  const completionDetails = objectMember(value, "completion_tokens_details");
  const detailedReasoningTokens = optionalNonnegativeIntegerMember(completionDetails, "reasoning_tokens");
  return {
    promptTokens: optionalNonnegativeIntegerMember(value, "prompt_tokens"),
    completionTokens: optionalNonnegativeIntegerMember(value, "completion_tokens"),
    detailedReasoningTokens,
    separateReasoningTokens: detailedReasoningTokens === undefined
      ? optionalNonnegativeIntegerMember(value, "reasoning_tokens")
      : undefined,
    cacheReadTokens: optionalNonnegativeIntegerMember(promptDetails, "cached_tokens")
      ?? optionalNonnegativeIntegerMember(value, "cache_read_input_tokens"),
    cacheWriteTokens: optionalNonnegativeIntegerMember(promptDetails, "cache_write_tokens")
      ?? optionalNonnegativeIntegerMember(value, "cache_creation_input_tokens"),
  };
}

function messagesUsage(value: WireJsonObject, current: Readonly<SemanticUsage>): SemanticUsage {
  const outputDetails = nullableObjectMember(value, "output_tokens_details");
  return mergeMessagesUsage(current, {
    inputTokens: optionalNonnegativeIntegerMember(value, "input_tokens"),
    outputTokens: optionalNonnegativeIntegerMember(value, "output_tokens"),
    cacheReadTokens: optionalNonnegativeIntegerMember(value, "cache_read_input_tokens"),
    cacheWriteTokens: optionalNonnegativeIntegerMember(value, "cache_creation_input_tokens"),
    thinkingTokens: optionalNonnegativeIntegerMember(outputDetails, "thinking_tokens"),
  });
}

function responsesUsage(value: WireJsonObject, current: Readonly<SemanticUsage>): SemanticUsage {
  const inputDetails = objectMember(value, "input_tokens_details");
  const outputDetails = objectMember(value, "output_tokens_details");
  return {
    inputTokens: optionalNonnegativeIntegerMember(value, "input_tokens") ?? current.inputTokens,
    outputTokens: optionalNonnegativeIntegerMember(value, "output_tokens") ?? current.outputTokens,
    cacheReadTokens: optionalNonnegativeIntegerMember(inputDetails, "cached_tokens") ?? current.cacheReadTokens,
    cacheWriteTokens: optionalNonnegativeIntegerMember(inputDetails, "cache_write_tokens") ?? current.cacheWriteTokens,
    reasoningTokens: optionalNonnegativeIntegerMember(outputDetails, "reasoning_tokens") ?? current.reasoningTokens,
  };
}

function responseContentKey(object: WireJsonObject, kind: "text" | "refusal"): string {
  const outputIndex = integerMember(object, "output_index");
  const contentIndex = integerMember(object, "content_index");
  if (outputIndex === undefined || contentIndex === undefined) {
    invalid();
  }
  return responseMessagePartKey(outputIndex, contentIndex, kind);
}

function responseStreamMessageKey(object: WireJsonObject): string {
  return responseMessageKey(requiredOutputIndex(object));
}

function singleMember(object: WireJsonObject, key: string): WireJson | undefined {
  const values = memberValues(object, key);
  if (values.length > 1) {
    invalid();
  }
  return values[0];
}

function stringMember(object: WireJsonObject | undefined, key: string): string | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = singleMember(object, key);
  return typeof value === "string" ? value : undefined;
}

function objectMember(object: WireJsonObject | undefined, key: string): WireJsonObject | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = singleMember(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonObject(value)) {
    invalid();
  }
  return value;
}

function nullableObjectMember(object: WireJsonObject, key: string): WireJsonObject | undefined {
  const value = singleMember(object, key);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isWireJsonObject(value)) {
    invalid();
  }
  return value;
}

function arrayMember(object: WireJsonObject, key: string) {
  const value = singleMember(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonArray(value)) {
    invalid();
  }
  return value;
}

function integerMember(object: WireJsonObject, key: string): number | undefined {
  const value = singleMember(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonNumber(value)) {
    invalid();
  }
  const parsed = Number(value.lexeme);
  if (!Number.isSafeInteger(parsed)) {
    invalid();
  }
  return parsed;
}

function optionalNonnegativeIntegerMember(
  object: WireJsonObject | undefined,
  key: string,
): number | undefined {
  if (object === undefined) {
    return undefined;
  }
  const value = singleMember(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isWireJsonNumber(value)) {
    invalid();
  }
  const parsed = Number(value.lexeme);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalid();
  }
  return parsed;
}

function emptyUsage(): SemanticUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

class DecoderBudget {
  private readonly encoder = new TextEncoder();
  private used = 0;

  constructor(private readonly maxBytes: number) {}

  reserve(value: string): void {
    this.used += this.encoder.encode(value).byteLength;
    this.assertBounded();
  }

  reserveEntry(): void {
    this.used += 64;
    this.assertBounded();
  }

  release(value: string): void {
    this.used = Math.max(0, this.used - this.encoder.encode(value).byteLength);
  }

  private assertBounded(): void {
    if (this.used > this.maxBytes) {
      invalid();
    }
  }
}

function invalid(): never {
  throw new GatewayFailureError({
    kind: "invalid_upstream_response",
    source: "parser",
    phase: "stream",
  });
}

function invalidTruncated(): never {
  throw new GatewayFailureError({
    kind: "upstream_stream_truncated",
    source: "parser",
    phase: "stream",
  });
}
