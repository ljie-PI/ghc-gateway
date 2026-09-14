import { isDeepStrictEqual } from "node:util";
import type { HttpExpectation, HttpRequestObservation } from "../../scripts/tooling/test_support/copilot_http.js";

export const CHAT_MODEL = "chat-sdk";
export const REASONING_MODEL = "gpt-5";
export const NATIVE_RESPONSES_MODEL = "responses-sdk";
export const MESSAGES_MODEL = "messages-sdk";
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

export function getWeather(city: string): Readonly<{ city: string; condition: "sunny"; temperature_c: 22 }> {
  if (city !== "Tokyo") {
    throw new Error("get_weather offline scenario expected Tokyo");
  }
  return { city, condition: "sunny", temperature_c: 22 };
}

const encoder = new TextEncoder();

export const SYNTHETIC_MODELS = {
  data: [
    { id: CHAT_MODEL, name: "SDK Chat", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/chat/completions"], supported_parameters: ["temperature", "top_p", "response_format", "reasoning_effort"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384, chat_output_token_field: "max_tokens" } },
    { id: REASONING_MODEL, name: "SDK Reasoning", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/chat/completions"], supported_parameters: ["temperature", "top_p", "response_format", "reasoning_effort"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384, chat_output_token_field: "max_tokens" } },
    { id: NATIVE_RESPONSES_MODEL, name: "SDK Responses", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/responses"], supported_parameters: ["temperature", "top_p", "response_format", "reasoning"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384 } },
    { id: MESSAGES_MODEL, name: "SDK Messages", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/messages"], supported_parameters: ["temperature", "top_p", "output_config.format", "output_config.effort"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384, default_output_tokens: 4_096 } },
  ],
};

function chatCompletion(
  content: string | null = "pong",
  model = CHAT_MODEL,
  extraMessage: Readonly<Record<string, unknown>> = {},
  finishReason = "stop",
): Record<string, unknown> {
  return {
    id: "chatcmpl_sdk",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content, ...extraMessage }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function syntheticChatCompletion(body: Uint8Array): Record<string, unknown> {
  const request = decodedBody(body);
  const model = typeof request.model === "string" ? request.model : CHAT_MODEL;
  if (containsRole(request, "tool")) {
    return chatCompletion("Tool result accepted.", model);
  }
  if (Array.isArray(request.tools)) {
    return chatCompletion(null, model, {
      tool_calls: [{
        id: "call_weather",
        index: 0,
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
      }],
    }, "tool_calls");
  }
  if (typeof request.reasoning_effort === "string") {
    return chatCompletion("Reasoned answer.", model, { reasoning_content: `reason-${request.reasoning_effort}` });
  }
  return chatCompletion(serialized(body).includes("image_url") ? "Image accepted." : "pong", model);
}

function chatCompletionChunk(model = CHAT_MODEL): Record<string, unknown> {
  return {
    id: "chatcmpl_sdk_stream",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  };
}

function syntheticChatStream(body: Uint8Array): Uint8Array[] {
  const request = decodedBody(body);
  const model = typeof request.model === "string" ? request.model : CHAT_MODEL;
  if (Array.isArray(request.tools)) {
    return [
      chatSse(chatToolChunk(model, {
        index: 0,
        id: "call_stream",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":" },
      })),
      chatSse(chatToolChunk(model, { index: 0, function: { arguments: "\"Tokyo\"}" } })),
      chatSse({
        ...chatCompletionChunk(model),
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
      encoder.encode("data: [DONE]\n\n"),
    ];
  }
  return [chatSse(chatCompletionChunk(model)), encoder.encode("data: [DONE]\n\n")];
}

function chatToolChunk(model: string, toolCall: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...chatCompletionChunk(model),
    choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
  };
}

function responsesObject(
  status: "in_progress" | "completed",
  output?: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const completed = status === "completed";
  return {
    id: "resp_sdk",
    object: "response",
    created_at: 1_700_000_000,
    status,
    completed_at: completed ? 1_700_000_001 : null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 8,
    metadata: null,
    model: NATIVE_RESPONSES_MODEL,
    output: output ?? (completed ? [{
      id: "msg_sdk",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    }] : []),
    output_text: completed && output === undefined ? "pong" : "",
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: completed
      ? { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
      : null,
  };
}

function syntheticResponsesObject(body: Uint8Array): Record<string, unknown> {
  const request = decodedBody(body);
  if (hasFunctionCallOutput(request)) {
    return responsesObject("completed");
  }
  if (Array.isArray(request.tools)) {
    return responsesObject("completed", [{
      id: "fc_weather",
      type: "function_call",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Tokyo\"}",
      status: "completed",
    }]);
  }
  return responsesObject("completed");
}

function syntheticResponsesStream(body: Uint8Array): Uint8Array[] {
  const request = decodedBody(body);
  if (Array.isArray(request.tools)) {
    const inProgress = responsesObject("in_progress");
    const item = {
      id: "fc_stream",
      type: "function_call",
      call_id: "call_stream",
      name: "get_weather",
      arguments: "{\"city\":\"Tokyo\"}",
      status: "completed",
    };
    return [
      responsesSse("response.created", { type: "response.created", sequence_number: 0, response: inProgress }),
      responsesSse("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      }),
      responsesSse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: 2,
        item_id: item.id,
        output_index: 0,
        delta: "{\"city\":" ,
      }),
      responsesSse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: 3,
        item_id: item.id,
        output_index: 0,
        delta: "\"Tokyo\"}",
      }),
      responsesSse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: 4,
        item_id: item.id,
        output_index: 0,
        name: item.name,
        arguments: item.arguments,
      }),
      responsesSse("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 0,
        item,
      }),
      responsesSse("response.completed", {
        type: "response.completed",
        sequence_number: 6,
        response: responsesObject("completed", [item]),
      }),
    ];
  }
  return [responsesSse("response.completed", {
    type: "response.completed",
    sequence_number: 0,
    response: syntheticResponsesObject(body),
  })];
}

function syntheticMessagesObject(_body: Uint8Array): Record<string, unknown> {
  return {
    id: "msg_sdk",
    type: "message",
    role: "assistant",
    model: MESSAGES_MODEL,
    content: [{ type: "text", text: "pong" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function syntheticMessagesStream(_body: Uint8Array): Uint8Array[] {
  return [
    messagesSse("message_start", {
      type: "message_start",
      message: {
        id: "msg_sdk_stream",
        type: "message",
        role: "assistant",
        content: [],
        model: MESSAGES_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    messagesSse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    messagesSse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "pong" },
    }),
    messagesSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    messagesSse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    messagesSse("message_stop", { type: "message_stop" }),
  ];
}

function decodedBody(body: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(serialized(body)) as unknown;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function serialized(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function containsRole(value: unknown, role: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsRole(item, role));
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.role === role || Object.values(record).some((item) => containsRole(item, role));
}

function hasFunctionCallOutput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasFunctionCallOutput);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "function_call_output" || Object.values(record).some(hasFunctionCallOutput);
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function chatSse(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function responsesSse(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function messagesSse(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

/** Optional single-use fixture catalog; each SDK case separately asserts its exact HTTP operation delta.
 * Response bytes are fixed before the HTTP listener sees a request. */
export function syntheticSdkFixtureCatalog(): readonly HttpExpectation[] {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const chat = (body: Record<string, unknown>) => requests.push({ path: "/chat/completions", body });
  const responses = (body: Record<string, unknown>) => requests.push({ path: "/responses", body });
  const messages = (body: Record<string, unknown>) => requests.push({ path: "/v1/messages", body });
  const user = (content: unknown) => ({ role: "user", content });
  const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
  const chatTool = { type: "function", function: { name: "get_weather", description: "Get the weather for a city", parameters: schema } };
  const responseTool = { type: "function", name: "get_weather", description: "Get the weather for a city", parameters: schema, strict: true };
  const bridgeTool = { type: "function", function: { ...chatTool.function, strict: true } };
  const anthropicTool = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: schema, strict: false } };
  const chatImage = (text: string, detail = false) => user([
    { type: "text", text }, { type: "image_url", image_url: { url: PNG_DATA_URL, ...(detail ? { detail: "auto" } : {}) } },
  ]);
  const responseImage = (text: string) => user([
    { type: "input_text", text }, { type: "input_image", image_url: PNG_DATA_URL, detail: "auto" },
  ]);
  const stream = { stream: true, stream_options: { include_usage: true } };
  const call = { role: "assistant", content: null, tool_calls: [{ id: "call_weather", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" } }] };
  const result = { role: "tool", tool_call_id: "call_weather", content: JSON.stringify(getWeather("Tokyo")) };
  for (const [prompt, streaming] of [["sdk-chat-nonstream", false], ["sdk-chat-stream", true], ["sdk-bridge-nonstream", false], ["sdk-bridge-stream", true], ["cancel-sdk-request", true]] as const) {
    chat({ model: CHAT_MODEL, messages: [user(prompt)], ...(streaming ? stream : {}) });
  }
  for (const [prompt, streaming] of [["sdk-anthropic-nonstream", false], ["sdk-anthropic-stream", true], ["cancel-sdk-request", true]] as const) {
    chat({ model: CHAT_MODEL, messages: [user(prompt)], max_tokens: 8, ...(streaming ? stream : {}) });
  }
  const turns = (reply: string) => [{ role: "system", content: "Answer concisely." }, user("Hello"), { role: "assistant", content: reply }, user("What did I say?")];
  chat({ model: CHAT_MODEL, messages: turns("Hi there") });
  chat({ model: CHAT_MODEL, messages: turns("Hi") });
  chat({ model: CHAT_MODEL, messages: turns("Hi"), max_tokens: 16 });
  for (const detail of [false, true]) chat({ model: CHAT_MODEL, messages: [chatImage("Describe this image.", detail)] });
  chat({ model: CHAT_MODEL, messages: [chatImage("Describe this image.")], max_tokens: 16 });
  chat({ model: CHAT_MODEL, messages: [chatImage("Use the image to choose a city.")], tools: [chatTool] });
  chat({ model: CHAT_MODEL, messages: [chatImage("Use the image to choose a city.", true)], tools: [bridgeTool] });
  chat({ model: CHAT_MODEL, messages: [chatImage("Use the image to choose a city.")], max_tokens: 32, tools: [anthropicTool] });
  for (const tool of [chatTool, bridgeTool]) chat({ model: CHAT_MODEL, messages: [user("What is the weather in Tokyo?")], tools: [tool] });
  chat({ model: CHAT_MODEL, messages: [user("What is the weather in Tokyo?"), call, result], tools: [chatTool] });
  chat({ model: CHAT_MODEL, messages: [call, result] });
  chat({ model: CHAT_MODEL, messages: [user("What is the weather in Tokyo?")], max_tokens: 32, tools: [anthropicTool] });
  chat({ model: CHAT_MODEL, messages: [user("What is the weather in Tokyo?"), call, result], max_tokens: 32, tools: [anthropicTool] });
  for (const tool of [chatTool, bridgeTool]) chat({ model: CHAT_MODEL, messages: [user("Stream the Tokyo weather call.")], tools: [tool], ...stream });
  chat({ model: CHAT_MODEL, messages: [user("Stream the weather tool call.")], max_tokens: 32, tools: [anthropicTool], ...stream });
  for (const prompt of ["Reason about this.", "Reason through Chat."]) chat({ model: REASONING_MODEL, messages: [user(prompt)], reasoning_effort: "high" });
  for (const [prompt, effort] of [["Reason with maximum effort.", "xhigh"], ["Reason within this budget.", "medium"], ["Reason with extra-high effort.", "xhigh"]]) {
    chat({ model: REASONING_MODEL, messages: [user(prompt)], max_tokens: 16_384, reasoning_effort: effort });
  }
  for (const [prompt, streaming] of [["sdk-responses-nonstream", false], ["sdk-responses-stream", true], ["cancel-sdk-request", true]] as const) {
    responses({ model: NATIVE_RESPONSES_MODEL, input: prompt, ...(streaming ? { stream: true } : {}) });
  }
  responses({ model: NATIVE_RESPONSES_MODEL, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "chat-to-responses" }] }] });
  responses({ model: NATIVE_RESPONSES_MODEL, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "messages-to-responses" }] }], max_output_tokens: 8 });
  responses({ model: NATIVE_RESPONSES_MODEL, input: [responseImage("Use this map to check Tokyo weather.")], tools: [responseTool] });
  responses({ model: NATIVE_RESPONSES_MODEL, previous_response_id: "resp_sdk", input: [{ type: "function_call_output", call_id: "call_weather", output: JSON.stringify(getWeather("Tokyo")) }] });
  responses({ model: NATIVE_RESPONSES_MODEL, instructions: "Answer concisely.", input: [user("Hello"), { role: "assistant", content: "Hi" }, user("What did I say?")] });
  responses({ model: NATIVE_RESPONSES_MODEL, input: [responseImage("Describe this image.")] });
  responses({ model: NATIVE_RESPONSES_MODEL, input: "Stream the Tokyo weather call.", tools: [responseTool], stream: true });
  responses({ model: NATIVE_RESPONSES_MODEL, input: "Reason natively.", reasoning: { effort: "high" } });
  for (const text of ["chat-to-messages", "responses-to-messages"]) messages({ model: MESSAGES_MODEL, max_tokens: 4096, messages: [user([{ type: "text", text }])] });
  messages({ model: MESSAGES_MODEL, max_tokens: 8, messages: [user("messages-native")] });
  return [
    { method: "GET", path: "/models", body: new Uint8Array(), reply: { headers: { "content-type": "application/json" }, body: jsonBytes(SYNTHETIC_MODELS) } },
    ...requests.map(({ path, body }): HttpExpectation => {
      const bytes = jsonBytes(body);
      const streaming = body.stream === true;
      const protocol = path === "/chat/completions" ? "chat" : path === "/responses" ? "responses" : "messages";
      const headers = { "content-type": streaming ? "text/event-stream" : "application/json", "x-scripted-remote": protocol };
      const cancellation = serialized(bytes).includes("cancel-sdk-request");
      const chunks = !streaming ? [] : cancellation
        ? protocol === "chat" ? [chatSse({ ...chatCompletionChunk(), choices: [{ index: 0, delta: { role: "assistant", content: "waiting" }, finish_reason: null }] })]
          : [responsesSse("response.created", { type: "response.created", response: responsesObject("in_progress") })]
        : protocol === "chat" ? syntheticChatStream(bytes) : protocol === "responses" ? syntheticResponsesStream(bytes) : syntheticMessagesStream(bytes);
      return {
        method: "POST", path,
        headers: { "content-type": "application/json" },
        body: (actual) => isDeepStrictEqual(decodedBody(actual), body),
        reply: streaming ? { headers, async stream(exchange) {
          for (const chunk of chunks) await exchange.write(chunk);
          if (cancellation) await exchange.waitForClose();
          else await exchange.end();
        } } : { headers, body: jsonBytes(protocol === "chat" ? syntheticChatCompletion(bytes) : protocol === "responses" ? syntheticResponsesObject(bytes) : syntheticMessagesObject(bytes)) },
      };
    }),
  ];
}

export type SyntheticOperation = readonly [path: "/chat/completions" | "/responses" | "/v1/messages", stream: boolean];

/** Catalog discovery is counted separately for the suite; every inference is ordered and counted per case. */
export function assertSyntheticOperations(requests: readonly HttpRequestObservation[], expected: readonly SyntheticOperation[]): void {
  const actual = requests.filter((request) => !(request.method === "GET" && request.path === "/models"))
    .map((request) => [request.method, request.path, decodedBody(request.body).stream === true]);
  if (!isDeepStrictEqual(actual, expected.map(([path, stream]) => ["POST", path, stream]))) {
    throw new Error("synthetic SDK HTTP operation sequence mismatch");
  }
}
