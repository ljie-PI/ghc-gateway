import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  CHAT_MODEL,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  type ReplaySdkHarness,
} from "./replay_harness.js";

export const SDK_PROTOCOLS = ["chat", "messages", "responses"] as const;
export type SdkProtocol = typeof SDK_PROTOCOLS[number];
export const SDK_MODES = ["nonstream", "stream"] as const;
export type SdkMode = typeof SDK_MODES[number];

export const REPLAY_TARGETS = [
  { protocol: "chat", model: CHAT_MODEL },
  { protocol: "responses", model: NATIVE_RESPONSES_MODEL },
  { protocol: "messages", model: MESSAGES_MODEL },
] as const;

export interface SdkClients {
  readonly openai: OpenAI;
  readonly anthropic: Anthropic;
}

export function createSdkClients(harness: Pick<ReplaySdkHarness, "baseUrl" | "openAiBaseUrl" | "fetch">): SdkClients {
  const options = { apiKey: "local-gateway", fetch: harness.fetch, maxRetries: 0 };
  return {
    openai: new OpenAI({ ...options, baseURL: harness.openAiBaseUrl }),
    anthropic: new Anthropic({ ...options, baseURL: harness.baseUrl }),
  };
}

export interface SdkResult<Response> {
  /** Keep the official result for protocol-specific tool calls and later history inputs. */
  readonly response: Response;
  readonly text: string;
  readonly terminal: string | null | undefined;
  /** Observations only: official SDKs own stream accumulation and lifecycle validation. */
  readonly stream?: {
    readonly text: string;
    readonly terminalCount: number;
    /** Provider extension observed on SDK-parsed chunks; the SDK does not accumulate it. */
    readonly reasoningText?: string | undefined;
    readonly reasoningDeltaCount?: number;
  };
}

export async function executeChat(
  client: OpenAI,
  request: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, "stream">,
  mode: SdkMode,
): Promise<SdkResult<OpenAI.ChatCompletion>> {
  if (mode === "nonstream") {
    const response = await client.chat.completions.create(request);
    return { response, text: response.choices[0]?.message.content ?? "", terminal: response.choices[0]?.finish_reason };
  }
  let text = "";
  let terminalCount = 0;
  let reasoningText: string | undefined;
  let reasoningDeltaCount = 0;
  const stream = client.chat.completions.stream({
    ...request,
    stream_options: { include_usage: true, ...request.stream_options },
  });
  stream.on("content", (delta) => { text += delta; });
  stream.on("chunk", (chunk) => {
    if (chunk.choices[0]?.finish_reason != null) terminalCount += 1;
    const delta = chunk.choices[0]?.delta as { reasoning_text?: unknown } | undefined;
    if (typeof delta?.reasoning_text === "string") {
      reasoningText = (reasoningText ?? "") + delta.reasoning_text;
      reasoningDeltaCount += 1;
    }
  });
  const response = await stream.finalChatCompletion();
  return {
    response,
    text: response.choices[0]?.message.content ?? "",
    terminal: response.choices[0]?.finish_reason,
    stream: { text, terminalCount, reasoningText, reasoningDeltaCount },
  };
}

export async function executeMessages(
  client: Anthropic,
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, "stream">,
  mode: SdkMode,
): Promise<SdkResult<Anthropic.Message>> {
  if (mode === "nonstream") {
    const response = await client.messages.create(request);
    return { response, text: messageText(response), terminal: response.stop_reason };
  }
  let text = "";
  let terminalCount = 0;
  const stream = client.messages.stream(request);
  stream.on("text", (delta) => { text += delta; });
  stream.on("streamEvent", (event) => {
    if (event.type === "message_stop") terminalCount += 1;
  });
  const response = await stream.finalMessage();
  return { response, text: messageText(response), terminal: response.stop_reason, stream: { text, terminalCount } };
}

export async function executeResponses(
  client: OpenAI,
  request: Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, "stream">,
  mode: SdkMode,
): Promise<SdkResult<OpenAI.Responses.Response>> {
  if (mode === "nonstream") {
    const response = await client.responses.create(request);
    return { response, text: response.output_text, terminal: response.status };
  }
  let text = "";
  let terminalCount = 0;
  const stream = client.responses.stream(request);
  stream.on("response.output_text.delta", (event) => { text += event.delta; });
  stream.on("event", (event) => {
    if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
      terminalCount += 1;
    }
  });
  const response = await stream.finalResponse();
  return { response, text: response.output_text, terminal: response.status, stream: { text, terminalCount } };
}

export interface SdkToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type SdkProtocolResult =
  | { readonly protocol: "chat"; readonly result: SdkResult<OpenAI.ChatCompletion> }
  | { readonly protocol: "messages"; readonly result: SdkResult<Anthropic.Message> }
  | { readonly protocol: "responses"; readonly result: SdkResult<OpenAI.Responses.Response> };

/** Read actual SDK calls, including on turns expected to contain text only. */
export function sdkToolCalls(value: SdkProtocolResult): SdkToolCall[] {
  switch (value.protocol) {
  case "chat":
    return (value.result.response.choices[0]?.message.tool_calls ?? []).map((call) => {
      if (call.type !== "function") throw new Error("Unexpected SDK tool type");
      return { id: call.id, name: call.function.name, arguments: toolArguments(call.function.arguments) };
    });
  case "messages":
    if (value.result.response.content.some((block) => !["text", "thinking", "redacted_thinking", "tool_use"].includes(block.type))) {
      throw new Error("Unexpected SDK output block");
    }
    return value.result.response.content.filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input }));
  case "responses":
    if (value.result.response.output.some((item) => !["message", "reasoning", "function_call"].includes(item.type))) {
      throw new Error("Unexpected SDK output item");
    }
    return value.result.response.output.filter((item) => item.type === "function_call")
      .map((item) => ({ id: item.call_id, name: item.name, arguments: toolArguments(item.arguments) }));
  }
}

function toolArguments(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error("Invalid SDK tool arguments"); }
}

function messageText(response: Anthropic.Message): string {
  return response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
