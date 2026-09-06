import { parseChatSse } from "../../copilot/chat_sse.js";
import { upstreamStreamEventFailure } from "../../copilot/failures.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import {
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
  SemanticResponse,
  SemanticStreamEvent,
  SemanticUsage,
} from "./types.js";
import { decodeSseRecords } from "./sse.js";
import { mergeMessagesUsage } from "./usage.js";

export function decodeProtocolStream(
  source: InferenceProtocol,
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
): AsyncIterable<SemanticStreamEvent> {
  if (source === "chat") {
    return decodeChatStream(bytes, eventLimitBytes, accumulatorBytes);
  }
  if (source === "messages") {
    return decodeMessagesStream(bytes, eventLimitBytes, accumulatorBytes);
  }
  return decodeResponsesStream(bytes, eventLimitBytes, accumulatorBytes);
}

async function* decodeChatStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
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
  let observedUsage = emptyUsage();
  let chatText = "";
  let chatRefusal = "";
  let toolObserved = false;
  const pendingPostTool: SemanticStreamEvent[] = [];
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
  for await (const frame of parseChatSse(bytes, eventLimitBytes)) {
    if (frame.kind === "error") {
      throw upstreamStreamEventFailure();
    }
    if (frame.kind === "done") {
      if (pendingFinish === undefined) {
        invalid();
      }
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
        yield { kind: "tool_done", key: `chat:${index}` };
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
    const payload = frame.chunk.payload;
    if (!isWireJsonObject(payload)) {
      continue;
    }
    const usage = nullableObjectMember(payload, "usage");
    if (usage !== undefined) {
      observedUsage = chatUsage(usage, observedUsage);
      yield { kind: "usage", usage: observedUsage };
    }
    const choices = arrayMember(payload, "choices");
    if (choices === undefined || choices.items.length === 0) {
      continue;
    }
    if (choices.items.length !== 1 || !isWireJsonObject(choices.items[0])) {
      invalid();
    }
    const choice = choices.items[0];
    const delta = objectMember(choice, "delta");
    if (delta !== undefined) {
      const content = stringMember(delta, "content");
      if (content !== undefined && content.length > 0) {
        budget.reserve(content);
        chatText += content;
        const event = { kind: "text_delta", key: toolObserved ? "chat:message:1" : "chat:message:0", delta: content } as const;
        if (toolObserved) {
          pendingPostTool.push(event);
        } else {
          yield event;
        }
      }
      const refusal = stringMember(delta, "refusal");
      if (refusal !== undefined && refusal.length > 0) {
        budget.reserve(refusal);
        chatRefusal += refusal;
        const event = { kind: "refusal_delta", key: toolObserved ? "chat:message:1" : "chat:message:0", delta: refusal } as const;
        if (toolObserved) {
          pendingPostTool.push(event);
        } else {
          yield event;
        }
      }
      const calls = arrayMember(delta, "tool_calls");
      if (calls !== undefined) {
        for (let position = 0; position < calls.items.length; position += 1) {
          const value = calls.items[position];
          if (!isWireJsonObject(value)) {
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
          const id = stringMember(value, "id");
          if (id !== undefined) {
            if (tool.id.length > 0 && tool.id !== id) {
              invalid();
            }
            budget.reserve(id);
            tool.id = id;
          }
          const fn = objectMember(value, "function");
          const nameDelta = stringMember(fn, "name");
          if (nameDelta !== undefined) {
            if (tool.started && nameDelta.length > 0) {
              invalid();
            }
            budget.reserve(nameDelta);
            tool.name += nameDelta;
          }
          const argumentsDelta = stringMember(fn, "arguments");
          if (argumentsDelta !== undefined) {
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
      const contentValue = singleMember(finalMessage, "content");
      if (contentValue !== undefined && contentValue !== null && typeof contentValue !== "string") {
        invalid();
      }
      if (typeof contentValue === "string") {
        if (!contentValue.startsWith(chatText)) {
          invalid();
        }
        const suffix = contentValue.slice(chatText.length);
        if (suffix.length > 0) {
          budget.reserve(suffix);
          chatText = contentValue;
          pendingPostTool.push({
            kind: "text_delta",
            key: toolObserved ? "chat:message:1" : "chat:message:0",
            delta: suffix,
          });
        }
      }
      const refusalValue = singleMember(finalMessage, "refusal");
      if (refusalValue !== undefined && refusalValue !== null && typeof refusalValue !== "string") {
        invalid();
      }
      if (typeof refusalValue === "string") {
        if (!refusalValue.startsWith(chatRefusal)) {
          invalid();
        }
        const suffix = refusalValue.slice(chatRefusal.length);
        if (suffix.length > 0) {
          budget.reserve(suffix);
          chatRefusal = refusalValue;
          pendingPostTool.push({
            kind: "refusal_delta",
            key: toolObserved ? "chat:message:1" : "chat:message:0",
            delta: suffix,
          });
        }
      }
      const calls = arrayMember(finalMessage, "tool_calls");
      if (calls !== undefined) {
        const finalToolArguments = new Map<number, string>();
        for (let position = 0; position < calls.items.length; position += 1) {
          const value = calls.items[position];
          if (!isWireJsonObject(value)) {
            invalid();
          }
          const index = integerMember(value, "index") ?? position;
          const fn = objectMember(value, "function");
          const id = stringMember(value, "id");
          const name = stringMember(fn, "name");
          const argumentsJson = stringMember(fn, "arguments");
          if (
            index < 0
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
          } else if (tool.id !== id || tool.name !== name) {
            invalid();
          } else if (!tool.started) {
            tool.argumentsSeen = true;
          }
          tool.argumentsSeen = true;
          tools.set(index, tool);
          finalToolArguments.set(index, argumentsJson);
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
      }
    }
    const finish = singleMember(choice, "finish_reason");
    if (finish !== undefined && finish !== null) {
      pendingFinish = chatFinish(finish);
      yield* startReadyTools();
      for (const event of pendingPostTool.splice(0)) {
        yield event;
      }
    }
  }
  invalidTruncated();
}

async function* decodeMessagesStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
): AsyncIterable<SemanticStreamEvent> {
  const budget = new DecoderBudget(accumulatorBytes);
  const blocks = new Map<number, MessageBlockState>();
  let pendingFinish: SemanticResponse["finishReason"] | undefined;
  let observedUsage = emptyUsage();
  for await (const record of decodeSseRecords(bytes, eventLimitBytes)) {
    if (record.data === "[DONE]") {
      invalid();
    }
    const payload = parseEventObject(record.data, eventLimitBytes);
    const type = stringMember(payload, "type");
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
      const index = integerMember(payload, "index");
      const block = objectMember(payload, "content_block");
      if (index === undefined || block === undefined || blocks.has(index)) {
        invalid();
      }
      budget.reserveEntry();
      const blockType = stringMember(block, "type");
      if (blockType === "text") {
        blocks.set(index, { kind: "text", closed: false });
        const text = stringMember(block, "text");
        if (text !== undefined && text.length > 0) {
          yield { kind: "text_delta", key: `messages:${index}:text`, delta: text };
        }
      } else if (blockType === "refusal") {
        blocks.set(index, { kind: "refusal", closed: false });
        const refusal = stringMember(block, "refusal") ?? stringMember(block, "text");
        if (refusal !== undefined && refusal.length > 0) {
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
          sawArgumentsDelta: false,
        });
        budget.reserve(callId);
        budget.reserve(name);
        yield { kind: "tool_start", key, callId, name };
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        blocks.set(index, { kind: "ignored", closed: false });
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
        yield { kind: "text_delta", key: `messages:${index}:text`, delta: stringMember(delta, "text") ?? "" };
      } else if (block.kind === "refusal" && (deltaType === "refusal_delta" || deltaType === "text_delta")) {
        yield {
          kind: "refusal_delta",
          key: `messages:${index}:refusal`,
          delta: stringMember(delta, "refusal") ?? stringMember(delta, "text") ?? "",
        };
      } else if (block.kind === "tool" && deltaType === "input_json_delta" && block.key !== undefined) {
        if (!block.sawArgumentsDelta && block.initialArguments !== undefined) {
          budget.release(block.initialArguments);
          block.initialArguments = undefined;
        }
        block.sawArgumentsDelta = true;
        yield {
          kind: "tool_arguments_delta",
          key: block.key,
          delta: stringMember(delta, "partial_json") ?? "",
        };
      } else if (block.kind !== "ignored") {
        invalid();
      }
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
        if (!block.sawArgumentsDelta && block.initialArguments !== undefined) {
          yield {
            kind: "tool_arguments_delta",
            key: block.key,
            delta: block.initialArguments,
          };
          budget.release(block.initialArguments);
          block.initialArguments = undefined;
        }
        yield { kind: "tool_done", key: block.key };
      }
      continue;
    }
    if (type === "message_delta") {
      const delta = objectMember(payload, "delta");
      const stopReason = stringMember(delta, "stop_reason");
      if (stopReason !== undefined) {
        pendingFinish = messagesFinish(stopReason);
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

async function* decodeResponsesStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  accumulatorBytes: number,
): AsyncIterable<SemanticStreamEvent> {
  const budget = new DecoderBudget(accumulatorBytes);
  const toolsByIndex = new Map<number, ResponseToolIdentity>();
  const observedOutputIndexes = new Set<number>();
  const observedOutputTypes = new Map<number, string>();
  const observedContent = new Map<string, "output_text" | "refusal">();
  let lastSequence = -1;
  for await (const record of decodeSseRecords(bytes, eventLimitBytes)) {
    if (record.data === "[DONE]") {
      invalid();
    }
    const payload = parseEventObject(record.data, eventLimitBytes);
    const type = stringMember(payload, "type");
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
    if (type === "response.output_item.added") {
      const outputIndex = integerMember(payload, "output_index");
      const item = objectMember(payload, "item");
      if (outputIndex === undefined || item === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      const itemType = stringMember(item, "type");
      if (itemType === undefined) {
        invalid();
      }
      observedOutputTypes.set(outputIndex, itemType);
      if (itemType === "message") {
        yield { kind: "message_start", key: `responses:${outputIndex}:message` };
      }
      if (itemType === "function_call") {
        const key = `responses:${outputIndex}`;
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
        if (identity.itemId !== undefined) {
          budget.reserve(identity.itemId);
        }
        yield {
          kind: "tool_start",
          key,
          itemId: identity.itemId,
          callId,
          name,
        };
        const argumentsJson = stringMember(item, "arguments");
        if (argumentsJson !== undefined && argumentsJson.length > 0) {
          yield { kind: "tool_arguments_delta", key, delta: argumentsJson };
        }
      }
      continue;
    }
    if (type === "response.output_text.delta") {
      const outputIndex = requiredOutputIndex(payload);
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "text"), "output_text");
      yield {
        kind: "text_delta",
        key: responseContentKey(payload, "text"),
        orderKey: responseStreamMessageKey(payload),
        delta: stringMember(payload, "delta") ?? "",
      };
      continue;
    }
    if (type === "response.output_text.done") {
      const outputIndex = requiredOutputIndex(payload);
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "text"), "output_text");
      yield {
        kind: "text_done",
        key: responseContentKey(payload, "text"),
        orderKey: responseStreamMessageKey(payload),
        text: stringMember(payload, "text") ?? "",
      };
      continue;
    }
    if (type === "response.refusal.delta") {
      const outputIndex = requiredOutputIndex(payload);
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "refusal"), "refusal");
      yield {
        kind: "refusal_delta",
        key: responseContentKey(payload, "refusal"),
        orderKey: responseStreamMessageKey(payload),
        delta: stringMember(payload, "delta") ?? "",
      };
      continue;
    }
    if (type === "response.refusal.done") {
      const outputIndex = requiredOutputIndex(payload);
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      observeContent(observedContent, budget, responseContentKey(payload, "refusal"), "refusal");
      yield {
        kind: "refusal_done",
        key: responseContentKey(payload, "refusal"),
        orderKey: responseStreamMessageKey(payload),
        refusal: stringMember(payload, "refusal") ?? "",
      };
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const outputIndex = requiredOutputIndex(payload);
      const identity = toolsByIndex.get(outputIndex);
      if (identity === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      yield { kind: "tool_arguments_delta", key: identity.key, delta: stringMember(payload, "delta") ?? "" };
      continue;
    }
    if (type === "response.function_call_arguments.done") {
      const outputIndex = requiredOutputIndex(payload);
      const identity = toolsByIndex.get(outputIndex);
      if (identity === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      yield { kind: "tool_done", key: identity.key, argumentsJson: stringMember(payload, "arguments") };
      continue;
    }
    if (type === "response.output_item.done") {
      const outputIndex = integerMember(payload, "output_index");
      const item = objectMember(payload, "item");
      if (outputIndex === undefined || item === undefined) {
        invalid();
      }
      observeOutputIndex(observedOutputIndexes, budget, outputIndex);
      const itemType = stringMember(item, "type");
      if (itemType === undefined) {
        invalid();
      }
      const observedType = observedOutputTypes.get(outputIndex);
      if (observedType !== undefined && observedType !== itemType) {
        invalid();
      }
      observedOutputTypes.set(outputIndex, itemType);
      observeFinalItemContent(item, outputIndex, observedContent, budget);
      yield* finalItemEvents(item, outputIndex, toolsByIndex);
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
        observedContent,
      );
      if (type === "response.failed") {
        throw new GatewayFailureError({
          kind: "upstream_stream_error",
          source: "parser",
          phase: "stream",
        });
      }

      yield* finalResponseEvents(response, toolsByIndex);
      const usage = objectMember(response, "usage");
      if (usage !== undefined) {
        yield { kind: "usage", usage: responsesUsage(usage) };
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

    if (
      type === "response.created"
      || type === "response.in_progress"
      || type === "response.content_part.added"
      || type === "response.content_part.done"
      || type.startsWith("response.reasoning_")
    ) {
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
  for (const index of observedOutputIndexes) {
    const item = output.items[index];
    if (index < 0 || index >= output.items.length || !isWireJsonObject(item)) {
      invalid();
    }
    const observedType = observedOutputTypes.get(index);
    if (observedType !== undefined && stringMember(item, "type") !== observedType) {
      invalid();
    }
  }
  for (const [key, expectedType] of observedContent) {
    const match = /^responses:(\d+):(\d+):(text|refusal)$/u.exec(key);
    if (match?.[1] === undefined || match[2] === undefined) {
      invalid();
    }
    const outputIndex = Number.parseInt(match[1], 10);
    const contentIndex = Number.parseInt(match[2], 10);
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
      `responses:${outputIndex}:${contentIndex}:${type === "output_text" ? "text" : "refusal"}`,
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

function* finalResponseEvents(
  response: WireJsonObject,
  toolsByIndex: Map<number, ResponseToolIdentity>,
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
    yield* finalItemEvents(item, index, toolsByIndex);
  }
}

function* finalItemEvents(
  item: WireJsonObject,
  outputIndex: number,
  toolsByIndex: Map<number, ResponseToolIdentity>,
): Iterable<SemanticStreamEvent> {
  const type = stringMember(item, "type");
  if (type === "message") {
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
        yield {
          kind: "text_done",
          key: `responses:${outputIndex}:${contentIndex}:text`,
          orderKey: `responses:${outputIndex}:message`,
          text,
        };
      } else if (partType === "refusal") {
        const refusal = stringMember(part, "refusal");
        if (refusal === undefined) {
          invalid();
        }
        yield {
          kind: "refusal_done",
          key: `responses:${outputIndex}:${contentIndex}:refusal`,
          orderKey: `responses:${outputIndex}:message`,
          refusal,
        };
      } else {
        invalid();
      }
    }
    return;
  }
  if (type === "function_call") {
    let identity = toolsByIndex.get(outputIndex);
    if (identity === undefined) {
      const callId = stringMember(item, "call_id");
      const name = stringMember(item, "name");
      if (callId === undefined || name === undefined) {
        invalid();
      }
      identity = {
        key: `responses:${outputIndex}`,
        itemId: stringMember(item, "id"),
        callId,
        name,
      };
      toolsByIndex.set(outputIndex, identity);
      yield {
        kind: "tool_start",
        key: identity.key,
        itemId: identity.itemId,
        callId,
        name,
      };
    } else {
      const finalCallId = stringMember(item, "call_id");
      const finalName = stringMember(item, "name");
      const finalItemId = stringMember(item, "id");
      if (
        (finalCallId !== undefined && finalCallId !== identity.callId)
        || (finalName !== undefined && finalName !== identity.name)
        || (identity.itemId !== undefined && finalItemId !== undefined && finalItemId !== identity.itemId)
      ) {
        invalid();
      }
    }
    yield { kind: "tool_done", key: identity.key, argumentsJson: stringMember(item, "arguments") };
    return;
  }

  if (type === "reasoning") {
    return;
  }
  invalid();
}

interface ResponseToolIdentity {
  readonly key: string;
  readonly itemId?: string | undefined;
  readonly callId: string;
  readonly name: string;
}

type MessageBlockState =
  | { readonly kind: "text" | "refusal" | "ignored"; closed: boolean }
  | {
    readonly kind: "tool";
    readonly key: string;
    initialArguments?: string | undefined;
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

function chatUsage(value: WireJsonObject, current: Readonly<SemanticUsage>): SemanticUsage {
  const promptDetails = objectMember(value, "prompt_tokens_details");
  const completionDetails = objectMember(value, "completion_tokens_details");
  return {
    inputTokens: optionalNonnegativeIntegerMember(value, "prompt_tokens") ?? current.inputTokens,
    outputTokens: optionalNonnegativeIntegerMember(value, "completion_tokens") ?? current.outputTokens,
    cacheReadTokens: optionalNonnegativeIntegerMember(promptDetails, "cached_tokens")
      ?? optionalNonnegativeIntegerMember(value, "cache_read_input_tokens")
      ?? current.cacheReadTokens,
    cacheWriteTokens: optionalNonnegativeIntegerMember(promptDetails, "cache_write_tokens")
      ?? optionalNonnegativeIntegerMember(value, "cache_creation_input_tokens")
      ?? current.cacheWriteTokens,
    reasoningTokens: optionalNonnegativeIntegerMember(completionDetails, "reasoning_tokens")
      ?? current.reasoningTokens,
  };
}

function messagesUsage(value: WireJsonObject, current: Readonly<SemanticUsage>): SemanticUsage {
  return mergeMessagesUsage(current, {
    inputTokens: optionalNonnegativeIntegerMember(value, "input_tokens"),
    outputTokens: optionalNonnegativeIntegerMember(value, "output_tokens"),
    cacheReadTokens: optionalNonnegativeIntegerMember(value, "cache_read_input_tokens"),
    cacheWriteTokens: optionalNonnegativeIntegerMember(value, "cache_creation_input_tokens"),
  });
}

function responsesUsage(value: WireJsonObject): SemanticUsage {
  const inputDetails = objectMember(value, "input_tokens_details");
  const outputDetails = objectMember(value, "output_tokens_details");
  return {
    inputTokens: nonnegativeIntegerMember(value, "input_tokens"),
    outputTokens: nonnegativeIntegerMember(value, "output_tokens"),
    cacheReadTokens: nonnegativeIntegerMember(inputDetails, "cached_tokens"),
    cacheWriteTokens: nonnegativeIntegerMember(inputDetails, "cache_write_tokens"),
    reasoningTokens: nonnegativeIntegerMember(outputDetails, "reasoning_tokens"),
  };
}

function responseContentKey(object: WireJsonObject, kind: "text" | "refusal"): string {
  const outputIndex = integerMember(object, "output_index");
  const contentIndex = integerMember(object, "content_index");
  if (outputIndex === undefined || contentIndex === undefined) {
    invalid();
  }
  return `responses:${outputIndex}:${contentIndex}:${kind}`;
}

function responseStreamMessageKey(object: WireJsonObject): string {
  return `responses:${requiredOutputIndex(object)}:message`;
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

function nonnegativeIntegerMember(object: WireJsonObject | undefined, key: string): number {
  return optionalNonnegativeIntegerMember(object, key) ?? 0;
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
