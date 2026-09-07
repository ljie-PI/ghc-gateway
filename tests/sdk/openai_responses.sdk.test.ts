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
  waitFor,
} from "./harness.js";

const WEATHER_TOOL = {
  type: "function",
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  strict: true,
} as const;

describe("official OpenAI Responses SDK", () => {
  let harness: OfflineSdkHarness;
  let client: OpenAI;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new OpenAI({ apiKey: "local", baseURL: harness.openAiBaseUrl, fetch: harness.fetch, maxRetries: 0 });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream and iterates a terminal native Responses stream", async () => {
    const nonstream = await client.responses.create({ model: NATIVE_RESPONSES_MODEL, input: "sdk-responses-nonstream" });
    expect(nonstream.id).toBe("resp_sdk");
    expect(nonstream.output_text).toBe("pong");

    const stream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-stream",
      stream: true,
    });
    const eventTypes = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    expect(eventTypes).toEqual(["response.completed"]);
    expect(decodeCapturedBody(harness.responsesRequests[0]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-nonstream",
    });
    expect(decodeCapturedBody(harness.responsesRequests[1]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-stream",
      stream: true,
    });
  });

  it("deserializes non-stream and iterates a terminal Chat-bridge Responses stream", async () => {
    const nonstream = await client.responses.create({ model: CHAT_MODEL, input: "sdk-bridge-nonstream" });
    expect(nonstream.id).toMatch(/^resp_/u);
    expect(nonstream.output_text).toBe("pong");

    const stream = await client.responses.create({
      model: CHAT_MODEL,
      input: "sdk-bridge-stream",
      stream: true,
    });

    const eventTypes = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    expect(eventTypes).toContain("response.completed");
    expect(harness.backendKinds).toContain("chat");
    expect(harness.backendKinds).toContain("chat-stream");
  });

  it("converts an official Responses request directly to Messages", async () => {
    const requestIndex = harness.messagesRequests.length;
    const response = await client.responses.create({
      model: MESSAGES_MODEL,
      input: "responses-to-messages",
    });

    expect(response.output_text).toBe("pong");
    expect(decodeCapturedBody(harness.messagesRequests[requestIndex]!)).toMatchObject({
      model: MESSAGES_MODEL,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "responses-to-messages" }],
      }],
    });
  });

  it("converts instructions and ordinary multi-turn input through Chat-bridge Responses", async () => {
    const requestIndex = harness.chatRequests.length;
    const input = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
      { role: "user" as const, content: "What did I say?" },
    ];
    const response = await client.responses.create({
      model: CHAT_MODEL,
      instructions: "Answer concisely.",
      input,
    });

    expect(response.output_text).toBe("pong");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: "Answer concisely." },
        ...input,
      ],
    });
  });

  it("restores a Chat-bridge tool call for an actual second Responses request", async () => {
    const requestIndex = harness.chatRequests.length;
    const first = await client.responses.create({
      model: CHAT_MODEL,
      input: "What is the weather in Tokyo?",
      tools: [WEATHER_TOOL],
    });
    const toolCall = first.output.find((item) => item.type === "function_call");
    if (toolCall === undefined) {
      throw new Error("expected a Chat-bridge function call");
    }
    const weather = getWeather(toolCity(toolCall.arguments));

    const second = await client.responses.create({
      model: CHAT_MODEL,
      previous_response_id: first.id,
      input: [{
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(weather),
      }],
    });

    expect(second.output_text).toBe("Tool result accepted.");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [
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
    });
  });

  it("converts mixed PNG and tool input through Chat-bridge Responses", async () => {
    const requestIndex = harness.chatRequests.length;
    const response = await client.responses.create({
      model: CHAT_MODEL,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Use the image to choose a city." },
          { type: "input_image", image_url: PNG_DATA_URL, detail: "auto" },
        ],
      }],
      tools: [WEATHER_TOOL],
    });

    expect(response.output).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: "call_weather",
    }));
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(true);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Use the image to choose a city." },
          { type: "image_url", image_url: { url: PNG_DATA_URL, detail: "auto" } },
        ],
      }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: WEATHER_TOOL.parameters,
          strict: true,
        },
      }],
    });
  });

  it("converts standalone PNG input through Chat-bridge Responses", async () => {
    const requestIndex = harness.chatRequests.length;
    await client.responses.create({
      model: CHAT_MODEL,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image." },
          { type: "input_image", image_url: PNG_DATA_URL, detail: "auto" },
        ],
      }],
    });

    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(true);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: PNG_DATA_URL, detail: "auto" } },
        ],
      }],
    });
  });

  it("sends mixed PNG and tool input natively, then carries the tool result in a second request", async () => {
    const requestIndex = harness.responsesRequests.length;
    const input = [{
      role: "user" as const,
      content: [
        { type: "input_text" as const, text: "Use this map to check Tokyo weather." },
        { type: "input_image" as const, image_url: PNG_DATA_URL, detail: "auto" as const },
      ],
    }];
    const first = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: [...input],
      tools: [WEATHER_TOOL],
    });
    const toolCall = first.output.find((item) => item.type === "function_call");
    expect(toolCall).toMatchObject({
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Tokyo\"}",
    });
    if (toolCall === undefined) {
      throw new Error("expected an SDK Responses function call");
    }
    const weather = getWeather(toolCity(toolCall.arguments));

    const toolOutput = {
      type: "function_call_output",
      call_id: toolCall.call_id,
      output: JSON.stringify(weather),
    } as const;
    const second = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      previous_response_id: first.id,
      input: [toolOutput],
    });

    expect(second.output_text).toBe("pong");
    expect(decodeCapturedBody(harness.responsesRequests[requestIndex]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input,
      tools: [WEATHER_TOOL],
    });
    expect(decodeCapturedBody(harness.responsesRequests[requestIndex + 1]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      previous_response_id: first.id,
      input: [toolOutput],
    });
    expect(harness.responsesRequests[requestIndex]?.hasVisionInput).toBe(true);
    expect(harness.responsesRequests[requestIndex + 1]?.hasVisionInput).toBe(false);
  });

  it("preserves native Responses instructions and ordinary multi-turn input", async () => {
    const requestIndex = harness.responsesRequests.length;
    const input = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
      { role: "user" as const, content: "What did I say?" },
    ];
    await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      instructions: "Answer concisely.",
      input,
    });

    expect(decodeCapturedBody(harness.responsesRequests[requestIndex]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      instructions: "Answer concisely.",
      input,
    });
  });

  it("sends standalone native Responses PNG input as vision", async () => {
    const requestIndex = harness.responsesRequests.length;
    const input = [{
      role: "user" as const,
      content: [
        { type: "input_text" as const, text: "Describe this image." },
        { type: "input_image" as const, image_url: PNG_DATA_URL, detail: "auto" as const },
      ],
    }];
    await client.responses.create({ model: NATIVE_RESPONSES_MODEL, input });

    expect(decodeCapturedBody(harness.responsesRequests[requestIndex]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input,
    });
    expect(harness.responsesRequests[requestIndex]?.hasVisionInput).toBe(true);
  });

  it("parses a fragmented native Responses tool stream through official events", async () => {
    const requestIndex = harness.responsesRequests.length;
    const stream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "Stream the Tokyo weather call.",
      tools: [WEATHER_TOOL],
      stream: true,
    });
    const fragments: string[] = [];
    let completedName: string | undefined;
    let completedArguments: string | undefined;
    for await (const event of stream) {
      if (event.type === "response.function_call_arguments.delta") {
        fragments.push(event.delta);
      } else if (event.type === "response.function_call_arguments.done") {
        completedName = event.name;
        completedArguments = event.arguments;
      }
    }

    expect(fragments.join("")).toBe("{\"city\":\"Tokyo\"}");
    expect(completedName).toBe("get_weather");
    expect(completedArguments).toBe("{\"city\":\"Tokyo\"}");
    expect(harness.responsesRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("parses a fragmented Chat-bridge tool stream through official Responses events", async () => {
    const requestIndex = harness.chatRequests.length;
    const stream = await client.responses.create({
      model: CHAT_MODEL,
      input: "Stream the Tokyo weather call.",
      tools: [WEATHER_TOOL],
      stream: true,
    });
    const argumentDeltas: string[] = [];
    let completedArguments: string | undefined;
    let addedCallId: string | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_item.added" && event.item.type === "function_call") {
        addedCallId = event.item.call_id;
      } else if (event.type === "response.function_call_arguments.delta") {
        argumentDeltas.push(event.delta);
      } else if (event.type === "response.function_call_arguments.done") {
        completedArguments = event.arguments;
        expect(event.name).toBe("get_weather");
      }
    }

    expect(addedCallId).toBe("call_stream");
    expect(argumentDeltas.join("")).toBe("{\"city\":\"Tokyo\"}");
    expect(completedArguments).toBe("{\"city\":\"Tokyo\"}");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Stream the Tokyo weather call." }],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: WEATHER_TOOL.parameters,
          strict: true,
        },
      }],
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("preserves reasoning.effort for native Responses requests", async () => {
    const requestIndex = harness.responsesRequests.length;
    const response = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "Reason natively.",
      reasoning: { effort: "high" },
    });

    expect(response.output_text).toBe("pong");
    expect(decodeCapturedBody(harness.responsesRequests[requestIndex]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input: "Reason natively.",
      reasoning: { effort: "high" },
    });
    expect(harness.responsesRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("maps reasoning.effort through Chat-bridge Responses", async () => {
    const requestIndex = harness.chatRequests.length;
    const response = await client.responses.create({
      model: REASONING_MODEL,
      input: "Reason through Chat.",
      reasoning: { effort: "high" },
    });

    expect(response.output_text).toBe("Reasoned answer.");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: REASONING_MODEL,
      messages: [{ role: "user", content: "Reason through Chat." }],
      reasoning_effort: "high",
    });
    expect(harness.chatRequests[requestIndex]?.hasVisionInput).toBe(false);
  });

  it("surfaces the official API error class and gateway request ID", async () => {
    const error = await client.responses.create({
      model: "missing-sdk-model",
      input: "sdk-error",
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error).toMatchObject({ status: 404, requestID: "req_sdk_loopback" });
  });

  it("cancels an in-flight official Responses stream", async () => {
    const stream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "cancel-sdk-request",
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    stream.controller.abort();
    await waitFor(() => harness.cancelled.responses > 0);
    expect(harness.backendKinds).toContain("responses-stream");
  });
});

function toolCity(argumentsJson: string): string {
  const value = JSON.parse(argumentsJson) as unknown;
  if (value === null || typeof value !== "object" || !("city" in value) || typeof value.city !== "string") {
    throw new Error("expected get_weather city arguments");
  }
  return value.city;
}
