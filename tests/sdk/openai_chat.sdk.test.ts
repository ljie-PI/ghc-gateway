import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  decodeCapturedBody,
  getWeather,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  PNG_DATA_URL,
  REASONING_MODEL,
  type OfflineSdkHarness,
  startOfflineSdkHarness,
} from "./harness.js";

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
} as const;

describe("official OpenAI Chat SDK", () => {
  let harness: OfflineSdkHarness;
  let client: OpenAI;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new OpenAI({ apiKey: "local", baseURL: harness.openAiBaseUrl, fetch: harness.fetch, maxRetries: 0 });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream and iterates stream responses while capturing exact Chat requests", async () => {
    const nonstream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-nonstream" }],
    });

    expect(nonstream.choices[0]?.message.content).toBe("pong");

    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-stream" }],
      stream: true,
    });

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content).filter(Boolean)).toEqual(["pong"]);
    expect(decodeCapturedBody(harness.chatRequests[0]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-nonstream" }],
    });
    expect(decodeCapturedBody(harness.chatRequests[1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-stream" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("converts official Chat requests directly to Responses and Messages operations", async () => {
    const responsesIndex = harness.responsesRequests.length;
    const messagesIndex = harness.messagesRequests.length;
    const viaResponses = await client.chat.completions.create({
      model: NATIVE_RESPONSES_MODEL,
      messages: [{ role: "user", content: "chat-to-responses" }],
    });
    const viaMessages = await client.chat.completions.create({
      model: MESSAGES_MODEL,
      messages: [{ role: "user", content: "chat-to-messages" }],
    });

    expect(viaResponses.choices[0]?.message.content).toBe("pong");
    expect(viaMessages.choices[0]?.message.content).toBe("pong");
    expect(decodeCapturedBody(harness.responsesRequests[responsesIndex]!)).toMatchObject({
      model: NATIVE_RESPONSES_MODEL,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "chat-to-responses" }],
      }],
    });
    expect(decodeCapturedBody(harness.messagesRequests[messagesIndex]!)).toMatchObject({
      model: MESSAGES_MODEL,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "chat-to-messages" }],
      }],
      max_tokens: 4096,
    });
  });

  it("preserves system instructions and an ordinary multi-turn conversation", async () => {
    const requestIndex = harness.chatRequests.length;
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "Answer concisely." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "What did I say?" },
    ];

    const completion = await client.chat.completions.create({ model: CHAT_MODEL, messages: [...messages] });

    expect(completion.choices[0]?.message.content).toBe("pong");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages,
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("sends a PNG image input and marks the upstream request as vision", async () => {
    const requestIndex = harness.chatRequests.length;
    const messages: OpenAI.ChatCompletionMessageParam[] = [{
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
      ],
    }];

    const completion = await client.chat.completions.create({ model: CHAT_MODEL, messages: [...messages] });

    expect(completion.choices[0]?.message.content).toBe("Image accepted.");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages,
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(true);
  });

  it("sends image and tool input together through the official Chat SDK", async () => {
    const requestIndex = harness.chatRequests.length;
    const messages: OpenAI.ChatCompletionMessageParam[] = [{
      role: "user",
      content: [
        { type: "text", text: "Use the image to choose a city." },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
      ],
    }];
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: [WEATHER_TOOL],
    });

    expect(completion.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      id: "call_weather",
      function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
    });
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages,
      tools: [WEATHER_TOOL],
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(true);
  });

  it("parses a tool call and sends its result in an actual second Chat request", async () => {
    const requestIndex = harness.chatRequests.length;
    const userMessage = { role: "user", content: "What is the weather in Tokyo?" } as const;
    const first = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [userMessage],
      tools: [WEATHER_TOOL],
    });
    const toolCall = first.choices[0]?.message.tool_calls?.[0];
    expect(toolCall).toMatchObject({
      id: "call_weather",
      type: "function",
      function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
    });
    if (toolCall?.type !== "function") {
      throw new Error("expected an SDK function tool call");
    }
    const parsedArguments = JSON.parse(toolCall.function.arguments) as unknown;
    if (parsedArguments === null || typeof parsedArguments !== "object"
      || !("city" in parsedArguments) || typeof parsedArguments.city !== "string") {
      throw new Error("expected get_weather city arguments");
    }
    const weather = getWeather(parsedArguments.city);

    const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: toolCall.id,
        type: toolCall.type,
        function: toolCall.function,
      }],
    };
    const toolMessage: OpenAI.ChatCompletionToolMessageParam = {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(weather),
    };
    const second = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [userMessage, assistantMessage, toolMessage],
      tools: [WEATHER_TOOL],
    });

    expect(second.choices[0]?.message.content).toBe("Tool result accepted.");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [userMessage],
      tools: [WEATHER_TOOL],
    });
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [userMessage, assistantMessage, toolMessage],
      tools: [WEATHER_TOOL],
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(false);
    expect(harness.chatRequests[requestIndex + 1]?.hasVisionInput).toBe(false);
  });

  it("parses fragmented streaming tool calls through the official SDK stream", async () => {
    const requestIndex = harness.chatRequests.length;
    const argumentDeltas: string[] = [];
    let callId: string | undefined;
    let functionName: string | undefined;
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Stream the Tokyo weather call." }],
      tools: [WEATHER_TOOL],
      stream: true,
    });
    for await (const chunk of stream) {
      const toolCall = chunk.choices[0]?.delta.tool_calls?.[0];
      callId = toolCall?.id ?? callId;
      functionName = toolCall?.function?.name ?? functionName;
      if (toolCall?.function?.arguments !== undefined) {
        argumentDeltas.push(toolCall.function.arguments);
      }
    }

    expect(argumentDeltas).toEqual(["{\"city\":", "\"Tokyo\"}"]);
    expect(callId).toBe("call_stream");
    expect(functionName).toBe("get_weather");
    expect(argumentDeltas.join("")).toBe("{\"city\":\"Tokyo\"}");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Stream the Tokyo weather call." }],
      tools: [WEATHER_TOOL],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("sends Chat reasoning_effort and preserves reasoning content from the SDK response", async () => {
    const requestIndex = harness.chatRequests.length;
    const completion = await client.chat.completions.create({
      model: REASONING_MODEL,
      messages: [{ role: "user", content: "Reason about this." }],
      reasoning_effort: "high",
    });

    expect(completion.choices[0]?.message).toHaveProperty("reasoning_content", "reason-high");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: REASONING_MODEL,
      messages: [{ role: "user", content: "Reason about this." }],
      reasoning_effort: "high",
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("surfaces the official API error class and gateway request ID", async () => {
    const error = await client.chat.completions.create({
      model: "missing-sdk-model",
      messages: [{ role: "user", content: "sdk-error" }],
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error).toMatchObject({ status: 404, requestID: "req_sdk_loopback" });
  });

  it("exposes official SDK stream cancellation while loopback cleanup is covered by integration tests", async () => {
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "cancel-sdk-request" }],
      stream: true,
    });
    let received = false;
    for await (const chunk of stream) {
      void chunk;
      received = true;
      break;
    }
    expect(received).toBe(true);
    expect(stream.controller.signal.aborted).toBe(true);
    expect(harness.backendKinds).toContain("chat-stream");
  });
});
