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

export function decodeProtocolStream(
  source: InferenceProtocol,
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
): AsyncIterable<SemanticStreamEvent> {
  if (source === "chat") {
    return decodeChatStream(bytes, eventLimitBytes);
  }
  if (source === "messages") {
    return decodeMessagesStream(bytes, eventLimitBytes);
  }
  return decodeResponsesStream(bytes, eventLimitBytes);
}

async function* decodeChatStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
): AsyncIterable<SemanticStreamEvent> {
  const tools = new Map<number, {
    id: string;
    name: string;
    pendingArguments: string;
    started: boolean;
    done: boolean;
  }>();
  let pendingFinish: SemanticResponse["finishReason"] | undefined;
  for await (const frame of parseChatSse(bytes, eventLimitBytes)) {
    if (frame.kind === "error") {
      throw upstreamStreamEventFailure();
    }
    if (frame.kind === "done") {
      if (pendingFinish === undefined) {
        invalid();
      }
      for (const [index, tool] of tools) {
        if (!tool.started || tool.done) {
          continue;
        }
        tool.done = true;
        yield { kind: "tool_done", key: `chat:${index}` };
      }
      yield {
        kind: "terminal",
        status: pendingFinish === "length" || pendingFinish === "content_filter" ? "incomplete" : "completed",
        finishReason: pendingFinish,
      };
      return;
    }
    const payload = frame.chunk.payload;
    if (!isWireJsonObject(payload)) {
      continue;
    }
    const usage = objectMember(payload, "usage");
    if (usage !== undefined) {
      yield { kind: "usage", usage: chatUsage(usage) };
    }
    const choices = arrayMember(payload, "choices");
    if (choices === undefined || choices.items.length === 0) {
      continue;
    }
    if (choices.items.length !== 1 || !isWireJsonObject(choices.items[0])) {
      invalid();
    }
    const choice = choices.items[0];
    const delta = objectMember(choice, "delta") ?? objectMember(choice, "message");
    if (delta !== undefined) {
      const content = stringMember(delta, "content");
      if (content !== undefined && content.length > 0) {
        yield { kind: "text_delta", delta: content };
      }
      const refusal = stringMember(delta, "refusal");
      if (refusal !== undefined && refusal.length > 0) {
        yield { kind: "refusal_delta", delta: refusal };
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
          const tool = tools.get(index) ?? {
            id: "",
            name: "",
            pendingArguments: "",
            started: false,
            done: false,
          };
          const id = stringMember(value, "id");
          if (id !== undefined) {
            if (tool.id.length > 0 && tool.id !== id) {
              invalid();
            }
            tool.id = id;
          }
          const fn = objectMember(value, "function");
          const nameDelta = stringMember(fn, "name");
          if (nameDelta !== undefined) {
            tool.name += nameDelta;
          }
          const argumentsDelta = stringMember(fn, "arguments");
          if (argumentsDelta !== undefined) {
            tool.pendingArguments += argumentsDelta;
          }
          tools.set(index, tool);
          if (!tool.started && tool.id.length > 0 && tool.name.length > 0) {
            tool.started = true;
            yield {
              kind: "tool_start",
              key: `chat:${index}`,
              callId: tool.id,
              name: tool.name,
            };
          }
          if (tool.started && tool.pendingArguments.length > 0) {
            const pending = tool.pendingArguments;
            tool.pendingArguments = "";
            yield { kind: "tool_arguments_delta", key: `chat:${index}`, delta: pending };
          }
        }
      }
    }
    const finish = singleMember(choice, "finish_reason");
    if (finish !== undefined && finish !== null) {
      pendingFinish = chatFinish(finish);
    }
  }
  invalidTruncated();
}

async function* decodeMessagesStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
): AsyncIterable<SemanticStreamEvent> {
  const blocks = new Map<number, { readonly kind: "text" | "refusal" | "tool" | "ignored"; readonly key?: string }>();
  let pendingFinish: SemanticResponse["finishReason"] | undefined;
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
        yield { kind: "usage", usage: messagesUsage(usage) };
      }
      continue;
    }
    if (type === "content_block_start") {
      const index = integerMember(payload, "index");
      const block = objectMember(payload, "content_block");
      if (index === undefined || block === undefined || blocks.has(index)) {
        invalid();
      }
      const blockType = stringMember(block, "type");
      if (blockType === "text") {
        blocks.set(index, { kind: "text" });
        const text = stringMember(block, "text");
        if (text !== undefined && text.length > 0) {
          yield { kind: "text_delta", delta: text };
        }
      } else if (blockType === "refusal") {
        blocks.set(index, { kind: "refusal" });
        const refusal = stringMember(block, "refusal") ?? stringMember(block, "text");
        if (refusal !== undefined && refusal.length > 0) {
          yield { kind: "refusal_delta", delta: refusal };
        }
      } else if (blockType === "tool_use") {
        const callId = stringMember(block, "id");
        const name = stringMember(block, "name");
        if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0) {
          invalid();
        }
        const key = `messages:${index}`;
        blocks.set(index, { kind: "tool", key });
        yield { kind: "tool_start", key, callId, name };
        const input = objectMember(block, "input");
        if (input !== undefined && input.members.length > 0) {
          yield {
            kind: "tool_arguments_delta",
            key,
            delta: new TextDecoder().decode(serializeWireJson(input)),
          };
        }
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        blocks.set(index, { kind: "ignored" });
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
      const deltaType = stringMember(delta, "type");
      if (block.kind === "text" && deltaType === "text_delta") {
        yield { kind: "text_delta", delta: stringMember(delta, "text") ?? "" };
      } else if (block.kind === "refusal" && (deltaType === "refusal_delta" || deltaType === "text_delta")) {
        yield { kind: "refusal_delta", delta: stringMember(delta, "refusal") ?? stringMember(delta, "text") ?? "" };
      } else if (block.kind === "tool" && deltaType === "input_json_delta" && block.key !== undefined) {
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
      if (block.kind === "tool" && block.key !== undefined) {
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
        yield { kind: "usage", usage: messagesUsage(usage) };
      }
      continue;
    }
    if (type === "message_stop") {
      if (pendingFinish === undefined) {
        invalid();
      }
      yield {
        kind: "terminal",
        status: pendingFinish === "length" || pendingFinish === "content_filter" ? "incomplete" : "completed",
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
): AsyncIterable<SemanticStreamEvent> {
  const toolsByIndex = new Map<number, string>();
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
      if (stringMember(item, "type") === "function_call") {
        const key = `responses:${outputIndex}`;
        const callId = stringMember(item, "call_id");
        const name = stringMember(item, "name");
        if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0) {
          invalid();
        }
        toolsByIndex.set(outputIndex, key);
        yield {
          kind: "tool_start",
          key,
          itemId: stringMember(item, "id"),
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
      yield { kind: "text_delta", delta: stringMember(payload, "delta") ?? "" };
      continue;
    }
    if (type === "response.output_text.done") {
      yield { kind: "text_done", text: stringMember(payload, "text") ?? "" };
      continue;
    }
    if (type === "response.refusal.delta") {
      yield { kind: "refusal_delta", delta: stringMember(payload, "delta") ?? "" };
      continue;
    }
    if (type === "response.refusal.done") {
      yield { kind: "refusal_done", refusal: stringMember(payload, "refusal") ?? "" };
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const outputIndex = integerMember(payload, "output_index");
      const key = outputIndex === undefined ? undefined : toolsByIndex.get(outputIndex);
      if (key === undefined) {
        invalid();
      }
      yield { kind: "tool_arguments_delta", key, delta: stringMember(payload, "delta") ?? "" };
      continue;
    }
    if (type === "response.function_call_arguments.done") {
      const outputIndex = integerMember(payload, "output_index");
      const key = outputIndex === undefined ? undefined : toolsByIndex.get(outputIndex);
      if (key === undefined) {
        invalid();
      }
      yield { kind: "tool_done", key, argumentsJson: stringMember(payload, "arguments") };
      continue;
    }
    if (type === "response.output_item.done") {
      const outputIndex = integerMember(payload, "output_index");
      const item = objectMember(payload, "item");
      if (outputIndex === undefined || item === undefined) {
        invalid();
      }
      yield* finalItemEvents(item, outputIndex, toolsByIndex);
      continue;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = objectMember(payload, "response");
      if (response === undefined) {
        invalid();
      }
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

function* finalResponseEvents(
  response: WireJsonObject,
  toolsByIndex: Map<number, string>,
): Iterable<SemanticStreamEvent> {
  const output = arrayMember(response, "output");
  if (output === undefined) {
    return;
  }
  for (let index = 0; index < output.items.length; index += 1) {
    const item = output.items[index];
    if (isWireJsonObject(item)) {
      yield* finalItemEvents(item, index, toolsByIndex);
    }
  }
}

function* finalItemEvents(
  item: WireJsonObject,
  outputIndex: number,
  toolsByIndex: Map<number, string>,
): Iterable<SemanticStreamEvent> {
  const type = stringMember(item, "type");
  if (type === "message") {
    const content = arrayMember(item, "content");
    if (content === undefined) {
      return;
    }
    for (const part of content.items) {
      if (!isWireJsonObject(part)) {
        continue;
      }
      const partType = stringMember(part, "type");
      if (partType === "output_text") {
        yield { kind: "text_done", text: stringMember(part, "text") ?? "" };
      } else if (partType === "refusal") {
        yield { kind: "refusal_done", refusal: stringMember(part, "refusal") ?? "" };
      }
    }
    return;
  }
  if (type === "function_call") {
    let key = toolsByIndex.get(outputIndex);
    if (key === undefined) {
      const callId = stringMember(item, "call_id");
      const name = stringMember(item, "name");
      if (callId === undefined || name === undefined) {
        invalid();
      }
      key = `responses:${outputIndex}`;
      toolsByIndex.set(outputIndex, key);
      yield {
        kind: "tool_start",
        key,
        itemId: stringMember(item, "id"),
        callId,
        name,
      };
    }
    yield { kind: "tool_done", key, argumentsJson: stringMember(item, "arguments") };
  }
}

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

function chatUsage(value: WireJsonObject): SemanticUsage {
  const promptDetails = objectMember(value, "prompt_tokens_details");
  const completionDetails = objectMember(value, "completion_tokens_details");
  return {
    inputTokens: nonnegativeIntegerMember(value, "prompt_tokens"),
    outputTokens: nonnegativeIntegerMember(value, "completion_tokens"),
    cacheReadTokens: nonnegativeIntegerMember(promptDetails, "cached_tokens")
      || nonnegativeIntegerMember(value, "cache_read_input_tokens"),
    cacheWriteTokens: nonnegativeIntegerMember(promptDetails, "cache_write_tokens")
      || nonnegativeIntegerMember(value, "cache_creation_input_tokens"),
    reasoningTokens: nonnegativeIntegerMember(completionDetails, "reasoning_tokens"),
  };
}

function messagesUsage(value: WireJsonObject): SemanticUsage {
  const read = nonnegativeIntegerMember(value, "cache_read_input_tokens");
  const write = nonnegativeIntegerMember(value, "cache_creation_input_tokens");
  return {
    inputTokens: nonnegativeIntegerMember(value, "input_tokens") + read + write,
    outputTokens: nonnegativeIntegerMember(value, "output_tokens"),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    reasoningTokens: 0,
  };
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
  if (object === undefined) {
    return 0;
  }
  const value = singleMember(object, key);
  if (value === undefined) {
    return 0;
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
