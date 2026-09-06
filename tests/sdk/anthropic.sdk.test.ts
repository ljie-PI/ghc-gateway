import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  decodeCapturedBody,
  getWeather,
  MESSAGES_MODEL,
  NATIVE_RESPONSES_MODEL,
  type OfflineSdkHarness,
  PNG_BASE64,
  REASONING_MODEL,
  startOfflineSdkHarness,
  waitFor,
} from "./harness.js";

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get weather",
  input_schema: {
    type: "object" as const,
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const CHAT_WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

describe("official Anthropic SDK", () => {
  let harness: OfflineSdkHarness;
  let client: Anthropic;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new Anthropic({ apiKey: "local", baseURL: harness.baseUrl, fetch: harness.fetch, maxRetries: 0 });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes Messages non-stream and iterates the complete event stream", async () => {
    const message = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "sdk-anthropic-nonstream" }],
    });

    expect(message.type).toBe("message");
    expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "pong" }));

    const stream = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "sdk-anthropic-stream" }],
      stream: true,
    });

    const eventTypes = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    expect(eventTypes[0]).toBe("message_start");
    expect(eventTypes.at(-1)).toBe("message_stop");
    expect(decodeCapturedBody(harness.chatRequests[0]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-anthropic-nonstream" }],
      max_tokens: 8,
    });
    expect(decodeCapturedBody(harness.chatRequests[1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-anthropic-stream" }],
      max_tokens: 8,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("uses native Messages and converts Messages directly to Responses", async () => {
    const messagesIndex = harness.messagesRequests.length;
    const responsesIndex = harness.responsesRequests.length;
    const native = await client.messages.create({
      model: MESSAGES_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "messages-native" }],
    });
    const converted = await client.messages.create({
      model: NATIVE_RESPONSES_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "messages-to-responses" }],
    });

    expect(native.content).toContainEqual(expect.objectContaining({ type: "text", text: "pong" }));
    expect(converted.content).toContainEqual(expect.objectContaining({ type: "text", text: "pong" }));
    expect(decodeCapturedBody(harness.messagesRequests[messagesIndex]!)).toMatchObject({
      model: MESSAGES_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "messages-native" }],
    });
    expect(decodeCapturedBody(harness.responsesRequests[responsesIndex]!)).toMatchObject({
      model: NATIVE_RESPONSES_MODEL,
      max_output_tokens: 8,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "messages-to-responses" }],
      }],
    });
  });

  it("translates a system prompt and ordinary multi-turn messages", async () => {
    const requestIndex = harness.chatRequests.length;
    const message = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 16,
      system: "Answer concisely.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "What did I say?" },
      ],
    });

    expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "pong" }));
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: "Answer concisely." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "What did I say?" },
      ],
      max_tokens: 16,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
  });

  it("sends a base64 PNG as a Chat image input", async () => {
    const requestIndex = harness.chatRequests.length;
    const message = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 16,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      }],
    });

    expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "Image accepted." }));
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ],
      }],
      max_tokens: 16,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(true);
  });

  it("performs a tool call and sends its tool_use and tool_result in a second HTTP request", async () => {
    const requestIndex = harness.chatRequests.length;
    const first = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 32,
      messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
      tools: [WEATHER_TOOL],
    });
    const toolUse = first.content.find((block) => block.type === "tool_use");
    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "call_weather",
      name: "get_weather",
      input: { city: "Tokyo" },
    });
    if (toolUse === undefined || toolUse.type !== "tool_use") {
      throw new Error("expected an Anthropic tool_use block");
    }
    const toolInput = toolUse.input;
    if (toolInput === null || typeof toolInput !== "object"
      || !("city" in toolInput) || typeof toolInput.city !== "string") {
      throw new Error("expected get_weather city input");
    }
    const weather = getWeather(toolInput.city);

    const second = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 32,
      messages: [
        { role: "user", content: "What is the weather in Tokyo?" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(weather) }],
        },
      ],
      tools: [WEATHER_TOOL],
    });

    expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "Tool result accepted." }));
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
      max_tokens: 32,
      tools: [CHAT_WEATHER_TOOL],
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [
        { role: "user", content: "What is the weather in Tokyo?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_weather",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call_weather", content: JSON.stringify(weather) },
      ],
      max_tokens: 32,
      tools: [CHAT_WEATHER_TOOL],
    });
    expect(harness.chatRequests[requestIndex + 1]!.hasVisionInput).toBe(false);
  });

  it("preserves image input and tool declarations in one request", async () => {
    const requestIndex = harness.chatRequests.length;
    const message = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 32,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Use the image to choose a city." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      }],
      tools: [WEATHER_TOOL],
    });

    expect(message.content).toContainEqual(expect.objectContaining({ type: "tool_use", name: "get_weather" }));
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Use the image to choose a city." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ],
      }],
      max_tokens: 32,
      tools: [CHAT_WEATHER_TOOL],
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(true);
  });

  it("assembles fragmented streamed tool arguments through MessageStream.finalMessage", async () => {
    const requestIndex = harness.chatRequests.length;
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: 32,
      messages: [{ role: "user", content: "Stream the weather tool call." }],
      tools: [WEATHER_TOOL],
    });
    const message = await stream.finalMessage();

    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toContainEqual(expect.objectContaining({
      type: "tool_use",
      id: "call_stream",
      name: "get_weather",
      input: { city: "Tokyo" },
    }));
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Stream the weather tool call." }],
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
      tools: [CHAT_WEATHER_TOOL],
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
  });

  it("maps official reasoning effort and thinking budget parameters", async () => {
    const requestIndex = harness.chatRequests.length;
    const effort = await client.messages.create({
      model: REASONING_MODEL,
      max_tokens: 16_384,
      messages: [{ role: "user", content: "Reason with maximum effort." }],
      output_config: { effort: "max" },
    });
    const budget = await client.messages.create({
      model: REASONING_MODEL,
      max_tokens: 16_384,
      messages: [{ role: "user", content: "Reason within this budget." }],
      thinking: { type: "enabled", budget_tokens: 8_000 },
    });
    const extraHigh = await client.messages.create({
      model: REASONING_MODEL,
      max_tokens: 16_384,
      messages: [{ role: "user", content: "Reason with extra-high effort." }],
      output_config: { effort: "xhigh" },
    });

    expect(effort.content).toContainEqual(expect.objectContaining({ type: "text", text: "Reasoned answer." }));
    expect(budget.content).toContainEqual(expect.objectContaining({ type: "text", text: "Reasoned answer." }));
    expect(extraHigh.content).toContainEqual(expect.objectContaining({ type: "text", text: "Reasoned answer." }));
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: REASONING_MODEL,
      messages: [{ role: "user", content: "Reason with maximum effort." }],
      max_tokens: 16_384,
      reasoning_effort: "xhigh",
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 1]!)).toEqual({
      model: REASONING_MODEL,
      messages: [{ role: "user", content: "Reason within this budget." }],
      max_tokens: 16_384,
      reasoning_effort: "medium",
    });
    expect(harness.chatRequests[requestIndex + 1]!.hasVisionInput).toBe(false);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 2]!)).toEqual({
      model: REASONING_MODEL,
      messages: [{ role: "user", content: "Reason with extra-high effort." }],
      max_tokens: 16_384,
      reasoning_effort: "xhigh",
    });
    expect(harness.chatRequests[requestIndex + 2]!.hasVisionInput).toBe(false);
  });

  it("surfaces the official API error class and gateway request ID", async () => {
    const error = await client.messages.create({
      model: "missing-sdk-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "sdk-error" }],
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Anthropic.APIError);
    expect(error).toMatchObject({ status: 404, requestID: "req_sdk_loopback" });
  });

  it("cancels an in-flight official MessageStream", async () => {
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "cancel-sdk-request" }],
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    stream.abort();
    await waitFor(() => harness.cancelled.chat > 0);
    expect(harness.backendKinds).toContain("chat-stream");
  });
});
