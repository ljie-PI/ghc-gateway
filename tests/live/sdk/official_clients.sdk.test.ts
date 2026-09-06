import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertLiveSdkTestsEnabled,
  assertNonEmptyArray,
  consumeAtLeastOne,
  expectCancelledStream,
  isManagedBridgeResponseId,
  liveBaseUrl,
  loopbackOnlyFetch,
  getWeather,
  parseWeatherArguments,
  PNG_BASE64,
  PNG_DATA_URL,
  recordLiveStatus,
} from "./harness.js";

const OPENAI_CHAT_WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get deterministic weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    strict: true,
  },
} as const;

const OPENAI_CHAT_WEATHER_CHOICE = {
  type: "function",
  function: { name: "get_weather" },
} as const;

const RESPONSES_WEATHER_TOOL = {
  type: "function",
  name: "get_weather",
  description: "Get deterministic weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const RESPONSES_WEATHER_CHOICE = { type: "function", name: "get_weather" } as const;

const ANTHROPIC_WEATHER_TOOL = {
  name: "get_weather",
  description: "Get deterministic weather for a city",
  input_schema: {
    type: "object" as const,
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

const ANTHROPIC_WEATHER_CHOICE = { type: "tool", name: "get_weather" } as const;

const CHAT_SCENARIO_TOKENS = 256;
const NATIVE_RESPONSES_SCENARIO_TOKENS = 512;

describe("guarded live official SDK smoke", () => {
  let openai: OpenAI;
  let anthropic: Anthropic;
  let chatModel: string;
  let visionModel: string;
  let reasoningModel: string;
  let responsesModel: string;
  let nativeResponsesModel: string | undefined;

  beforeAll(async () => {
    assertLiveSdkTestsEnabled();
    const baseUrl = liveBaseUrl();
    const guardedFetch = loopbackOnlyFetch(baseUrl);
    openai = new OpenAI({ apiKey: "local-gateway", baseURL: `${baseUrl}/v1`, fetch: guardedFetch, maxRetries: 0, logLevel: "off" });
    anthropic = new Anthropic({ apiKey: "local-gateway", baseURL: baseUrl, fetch: guardedFetch, maxRetries: 0, logLevel: "off" });

    const [openAiModels, anthropicModels] = await Promise.all([
      openai.models.list(),
      anthropic.models.list(),
    ]);
    const openAiIds = openAiModels.data.map((model) => model.id);
    const anthropicIds = new Set(anthropicModels.data.map((model) => model.id));
    const sharedIds = openAiIds.filter((id) => anthropicIds.has(id));
    const explicitChat = process.env.GHC_GATEWAY_LIVE_CHAT_MODEL;
    chatModel = explicitChat ?? "";
    if (chatModel === "" || !sharedIds.includes(chatModel)) {
      throw new Error("GHC_GATEWAY_LIVE_CHAT_MODEL must select a model shared by the OpenAI and Anthropic SDK catalogs");
    }
    if (modelMode(openAiModels.data.find((model) => model.id === chatModel)) === "responses") {
      throw new Error("GHC_GATEWAY_LIVE_CHAT_MODEL must not be Responses-only");
    }
    visionModel = process.env.GHC_GATEWAY_LIVE_VISION_MODEL ?? "";
    if (visionModel === "" || !sharedIds.includes(visionModel)) {
      throw new Error("GHC_GATEWAY_LIVE_VISION_MODEL must select a model shared by the OpenAI and Anthropic SDK catalogs");
    }
    if (modelMode(openAiModels.data.find((model) => model.id === visionModel)) === "responses") {
      throw new Error("GHC_GATEWAY_LIVE_VISION_MODEL must not be Responses-only");
    }
    reasoningModel = process.env.GHC_GATEWAY_LIVE_REASONING_MODEL ?? "";
    if (reasoningModel === "" || !sharedIds.includes(reasoningModel)) {
      throw new Error("GHC_GATEWAY_LIVE_REASONING_MODEL must select a model shared by the OpenAI and Anthropic SDK catalogs");
    }
    if (modelMode(openAiModels.data.find((model) => model.id === reasoningModel)) === "responses") {
      throw new Error("GHC_GATEWAY_LIVE_REASONING_MODEL must not be Responses-only");
    }
    const explicitResponses = process.env.GHC_GATEWAY_LIVE_RESPONSES_MODEL;
    const explicitNoNative = process.env.GHC_GATEWAY_LIVE_NATIVE_RESPONSES_NOT_AVAILABLE === "1";
    if ((explicitResponses === undefined) === !explicitNoNative) {
      throw new Error("set exactly one native Responses model or verified not-available declaration");
    }
    nativeResponsesModel = explicitResponses;
    if (explicitResponses !== undefined && !openAiIds.includes(explicitResponses)) {
      throw new Error("GHC_GATEWAY_LIVE_RESPONSES_MODEL is not in the current catalog");
    }
    if (explicitResponses !== undefined
      && modelMode(openAiModels.data.find((model) => model.id === explicitResponses)) === "chat") {
      throw new Error("GHC_GATEWAY_LIVE_RESPONSES_MODEL is explicitly Chat-only");
    }
    if (explicitNoNative && openAiModels.data.some((model) => modelMode(model) === "responses")) {
      throw new Error("native Responses is publicly available and cannot be declared unavailable");
    }
    if (explicitNoNative) {
      for (const model of openAiModels.data.filter((item) => modelMode(item) !== "chat")) {
        const probe = await openai.responses.create({ model: model.id, input: "Reply with OK.", max_output_tokens: 16 });
        if (!isManagedBridgeResponseId(probe.id)) {
          throw new Error("native Responses is available and cannot be declared unavailable");
        }
      }
    }
    responsesModel = nativeResponsesModel ?? chatModel;
    recordLiveStatus("models", "passing", [chatModel, responsesModel]);
  });

  it("calls OpenAI Chat non-stream, stream, and cancellation", async () => {
    const completion = await openai.chat.completions.create({
      model: chatModel,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    expect(completion.choices.length).toBeGreaterThan(0);
    const stream = await openai.chat.completions.create({
      model: chatModel,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = await openai.chat.completions.create({
      model: chatModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "Count from one to five." }],
      stream: true,
    });
    await expectCancelledStream(cancelled, () => cancelled.controller.abort());
    expect(cancelled.controller.signal.aborted).toBe(true);
    recordLiveStatus("openai_chat", "passing", [chatModel]);
  });

  it("covers OpenAI Chat rich official-SDK scenarios", async () => {
    const conversation: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "Answer concisely." },
      { role: "user", content: "Remember the exact token SDK-NONCE-42." },
      { role: "assistant", content: "I will remember SDK-NONCE-42." },
      { role: "user", content: "Repeat only the token from the first turn." },
    ];
    let ordinaryMessage: OpenAI.ChatCompletionMessage | undefined;
    for (let attempt = 0; attempt < 3 && !hasOpenAiChatOutput(ordinaryMessage); attempt += 1) {
      const ordinary = await openai.chat.completions.create({
        model: chatModel,
        max_completion_tokens: CHAT_SCENARIO_TOKENS,
        messages: conversation,
      });
      ordinaryMessage = ordinary.choices[0]?.message;
    }
    assertOpenAiChatOutput(ordinaryMessage, "OpenAI Chat multi-turn response was empty");

    const image = await openai.chat.completions.create({
      model: visionModel,
      max_completion_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this valid PNG." },
          { type: "image_url", image_url: { url: PNG_DATA_URL } },
        ],
      }],
    });
    assertOpenAiChatOutput(image.choices[0]?.message, "OpenAI Chat image response was empty");

    const toolUserMessage = {
      role: "user",
      content: "You must call get_weather for Tokyo now.",
    } as const;
    const first = await openai.chat.completions.create({
      model: chatModel,
      max_completion_tokens: CHAT_SCENARIO_TOKENS,
      messages: [toolUserMessage],
      tools: [OPENAI_CHAT_WEATHER_TOOL],
      tool_choice: OPENAI_CHAT_WEATHER_CHOICE,
    });
    const toolCall = first.choices[0]?.message.tool_calls?.[0];
    if (toolCall?.type !== "function") {
      throw new Error("OpenAI Chat did not return a function tool call");
    }
    const toolArguments = parseWeatherArguments(toolCall.function.arguments);
    expect(toolCall.id.length).toBeGreaterThan(0);
    expect(toolCall.function.name).toBe("get_weather");
    getWeather(toolArguments.city);
    const weather = getWeather(toolArguments.city);
    const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: toolCall.id,
        type: "function",
        function: toolCall.function,
      }],
    };
    const toolResultMessage: OpenAI.ChatCompletionToolMessageParam = {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(weather),
    };
    const second = await openai.chat.completions.create({
      model: chatModel,
      max_completion_tokens: CHAT_SCENARIO_TOKENS,
      messages: [toolUserMessage, assistantMessage, toolResultMessage],
      tools: [OPENAI_CHAT_WEATHER_TOOL],
    });
    assertOpenAiChatOutput(second.choices[0]?.message, "OpenAI Chat tool-result response was empty");
    expect(toolResultMessage.tool_call_id).toBe(toolCall.id);

    const mixed = await openai.chat.completions.create({
      model: visionModel,
      max_completion_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this PNG, then you must call get_weather for Tokyo." },
          { type: "image_url", image_url: { url: PNG_DATA_URL } },
        ],
      }],
      tools: [OPENAI_CHAT_WEATHER_TOOL],
      tool_choice: OPENAI_CHAT_WEATHER_CHOICE,
    });
    const mixedCall = mixed.choices[0]?.message.tool_calls?.[0];
    if (mixedCall?.type !== "function") {
      throw new Error("OpenAI Chat mixed scenario did not return a function tool call");
    }
    expect(mixedCall.id.length).toBeGreaterThan(0);
    expect(mixedCall.function.name).toBe("get_weather");
    getWeather(parseWeatherArguments(mixedCall.function.arguments).city);

    let streamedCallId: string | undefined;
    let streamedName: string | undefined;
    let argumentFragments: string[] = [];
    for (let attempt = 0; attempt < 3 && streamedName === undefined; attempt += 1) {
      const stream = await openai.chat.completions.create({
        model: chatModel,
        max_completion_tokens: CHAT_SCENARIO_TOKENS,
        messages: [{ role: "user", content: "You must stream a get_weather call for Tokyo." }],
        tools: [OPENAI_CHAT_WEATHER_TOOL],
        tool_choice: OPENAI_CHAT_WEATHER_CHOICE,
        stream: true,
      });
      argumentFragments = [];
      for await (const chunk of stream) {
        for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
          streamedCallId = call.id ?? streamedCallId;
          streamedName = call.function?.name ?? streamedName;
          if (call.function?.arguments !== undefined) {
            argumentFragments.push(call.function.arguments);
          }
        }
      }
    }
    if (streamedCallId !== undefined && streamedCallId.length === 0) {
      throw new Error("OpenAI Chat stream returned an empty tool call ID");
    }
    expect(streamedName).toBe("get_weather");
    getWeather(parseWeatherArguments(argumentFragments.join("")).city);

    const reasoning = await openai.chat.completions.create({
      model: reasoningModel,
      max_completion_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{ role: "user", content: "Use low reasoning effort for this request." }],
      reasoning_effort: "low",
    });
    assertOpenAiChatOutput(reasoning.choices[0]?.message, "OpenAI Chat reasoning response was empty");
    recordLiveStatus("openai_chat_scenarios", "passing", [chatModel]);
  });

  it("calls OpenAI Responses non-stream, stream, and cancellation", async () => {
    const response = await openai.responses.create({
      model: responsesModel,
      input: "Reply with OK.",
      max_output_tokens: 16,
    });
    expect(response.id.length).toBeGreaterThan(0);
    expect(isManagedBridgeResponseId(response.id)).toBe(nativeResponsesModel === undefined);
    const stream = await openai.responses.create({
      model: responsesModel,
      input: "Reply with OK.",
      max_output_tokens: 16,
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = await openai.responses.create({
      model: responsesModel,
      input: "Count from one to five.",
      max_output_tokens: 16,
      stream: true,
    });
    await expectCancelledStream(cancelled, () => cancelled.controller.abort());
    expect(cancelled.controller.signal.aborted).toBe(true);
    recordLiveStatus("openai_responses", "passing", [responsesModel]);
    recordLiveStatus("native_responses", nativeResponsesModel === undefined ? "not_available" : "passing", nativeResponsesModel === undefined ? [] : [nativeResponsesModel]);
  });

  it("covers Chat-bridge OpenAI Responses rich official-SDK scenarios", async () => {
    await runResponsesScenarios(openai, chatModel, true, reasoningModel, visionModel);
    recordLiveStatus("openai_responses_bridge_scenarios", "passing", [chatModel]);
  });

  it("covers native OpenAI Responses rich official-SDK scenarios", async () => {
    if (nativeResponsesModel === undefined) {
      recordLiveStatus("openai_responses_native_scenarios", "not_available", []);
      return;
    }
    await runResponsesScenarios(openai, nativeResponsesModel, false, nativeResponsesModel, nativeResponsesModel);
    recordLiveStatus("openai_responses_native_scenarios", "passing", [nativeResponsesModel]);
  });

  it("calls Anthropic Messages non-stream, stream, and cancellation", async () => {
    const message = await anthropic.messages.create({
      model: chatModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    expect(message.content.length).toBeGreaterThan(0);
    const stream = await anthropic.messages.create({
      model: chatModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = anthropic.messages.stream({
      model: chatModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "Count from one to five." }],
    });
    await expectCancelledStream(cancelled, () => cancelled.abort());
    expect(cancelled.aborted).toBe(true);
    recordLiveStatus("anthropic_messages", "passing", [chatModel]);
  });

  it("covers Anthropic rich official-SDK scenarios", async () => {
    const ordinary = await anthropic.messages.create({
      model: chatModel,
      max_tokens: CHAT_SCENARIO_TOKENS,
      system: "Answer concisely.",
      messages: [
        { role: "user", content: "Remember the exact token SDK-NONCE-42." },
        { role: "assistant", content: "I will remember SDK-NONCE-42." },
        { role: "user", content: "Repeat only the token from the first turn." },
      ],
    });
    assertNonEmptyArray(ordinary.content, "Anthropic multi-turn response was empty");

    const image = await anthropic.messages.create({
      model: visionModel,
      max_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this valid PNG." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      }],
    });
    assertNonEmptyArray(image.content, "Anthropic image response was empty");

    const toolPrompt = "You must call get_weather for Tokyo now.";
    const first = await anthropic.messages.create({
      model: chatModel,
      max_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{ role: "user", content: toolPrompt }],
      tools: [ANTHROPIC_WEATHER_TOOL],
      tool_choice: ANTHROPIC_WEATHER_CHOICE,
    });
    const toolUse = first.content.find((block) => block.type === "tool_use");
    if (toolUse === undefined) {
      throw new Error("Anthropic did not return a tool_use block");
    }
    const toolArguments = parseWeatherArguments(toolUse.input);
    expect(toolUse.id.length).toBeGreaterThan(0);
    expect(toolUse.name).toBe("get_weather");
    getWeather(toolArguments.city);
    const weather = getWeather(toolArguments.city);
    const secondMessages: Anthropic.MessageParam[] = [
      { role: "user", content: toolPrompt },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(weather) }],
      },
    ];
    const second = await anthropic.messages.create({
      model: chatModel,
      max_tokens: CHAT_SCENARIO_TOKENS,
      messages: secondMessages,
      tools: [ANTHROPIC_WEATHER_TOOL],
    });
    assertNonEmptyArray(second.content, "Anthropic tool-result response was empty");
    const toolResult = secondMessages[2]?.content;
    expect(Array.isArray(toolResult) && toolResult[0]?.type === "tool_result" ? toolResult[0].tool_use_id : undefined)
      .toBe(toolUse.id);

    const mixed = await anthropic.messages.create({
      model: visionModel,
      max_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this PNG, then you must call get_weather for Tokyo." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      }],
      tools: [ANTHROPIC_WEATHER_TOOL],
      tool_choice: ANTHROPIC_WEATHER_CHOICE,
    });
    const mixedCall = mixed.content.find((block) => block.type === "tool_use");
    if (mixedCall === undefined) {
      throw new Error("Anthropic mixed scenario did not return a tool_use block");
    }
    expect(mixedCall.id.length).toBeGreaterThan(0);
    expect(mixedCall.name).toBe("get_weather");
    getWeather(parseWeatherArguments(mixedCall.input).city);

    let streamedCall: Anthropic.ToolUseBlock | undefined;
    for (let attempt = 0; attempt < 3 && streamedCall === undefined; attempt += 1) {
      const stream = anthropic.messages.stream({
        model: chatModel,
        max_tokens: CHAT_SCENARIO_TOKENS,
        messages: [{ role: "user", content: "You must stream a get_weather call for Tokyo." }],
        tools: [ANTHROPIC_WEATHER_TOOL],
        tool_choice: ANTHROPIC_WEATHER_CHOICE,
      });
      const streamed = await stream.finalMessage();
      streamedCall = streamed.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    }
    if (streamedCall === undefined) {
      throw new Error("Anthropic stream did not assemble a tool_use block");
    }
    expect(streamedCall.id.length).toBeGreaterThan(0);
    expect(streamedCall.name).toBe("get_weather");
    getWeather(parseWeatherArguments(streamedCall.input).city);

    const reasoning = await anthropic.messages.create({
      model: reasoningModel,
      max_tokens: CHAT_SCENARIO_TOKENS,
      messages: [{ role: "user", content: "Use low reasoning effort for this request." }],
      output_config: { effort: "low" },
    });
    assertNonEmptyArray(reasoning.content, "Anthropic reasoning response was empty");
    recordLiveStatus("anthropic_scenarios", "passing", [chatModel]);
  });

});

async function runResponsesScenarios(
  client: OpenAI,
  model: string,
  expectBridge: boolean,
  reasoningScenarioModel: string,
  visionScenarioModel: string,
): Promise<void> {
  const maxOutputTokens = expectBridge ? CHAT_SCENARIO_TOKENS : NATIVE_RESPONSES_SCENARIO_TOKENS;
  const expectExecutionPlan = (id: string): void => {
    expect(id.length).toBeGreaterThan(0);
    expect(isManagedBridgeResponseId(id)).toBe(expectBridge);
  };

  const ordinary = await client.responses.create({
    model,
    instructions: "Answer concisely.",
    input: [
      { role: "user", content: "Remember the exact token SDK-NONCE-42." },
      { role: "assistant", content: "I will remember SDK-NONCE-42." },
      { role: "user", content: "Repeat only the token from the first turn." },
    ],
    max_output_tokens: maxOutputTokens,
  });
  expectExecutionPlan(ordinary.id);
  assertNonEmptyArray(ordinary.output, "OpenAI Responses multi-turn response was empty");

  const image = await client.responses.create({
    model: visionScenarioModel,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Inspect this valid PNG." },
        { type: "input_image", image_url: PNG_DATA_URL, detail: "auto" },
      ],
    }],
    max_output_tokens: maxOutputTokens,
  });
  expect(image.id.length).toBeGreaterThan(0);
  expect(isManagedBridgeResponseId(image.id)).toBe(expectBridge);
  if (expectBridge) {
    assertNonEmptyArray(image.output, "OpenAI Responses image response was empty");
  } else if (image.output.length === 0) {
    throw new Error("native OpenAI Responses image output was empty");
  }

  const toolPrompt = "You must call get_weather for Tokyo now.";
  const first = await client.responses.create({
    model,
    input: toolPrompt,
    max_output_tokens: maxOutputTokens,
    tools: [RESPONSES_WEATHER_TOOL],
    tool_choice: RESPONSES_WEATHER_CHOICE,
  });
  expectExecutionPlan(first.id);
  const toolCall = first.output.find((item) => item.type === "function_call");
  if (toolCall === undefined) {
    throw new Error("OpenAI Responses did not return a function call");
  }
  const toolArguments = parseWeatherArguments(toolCall.arguments);
  expect(toolCall.call_id.length).toBeGreaterThan(0);
  expect(toolCall.name).toBe("get_weather");
  getWeather(toolArguments.city);
  const weather = getWeather(toolArguments.city);
  const toolOutput = {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: JSON.stringify(weather),
  } as const;
  const second = expectBridge
    ? await client.responses.create({
      model,
      previous_response_id: first.id,
      input: [toolOutput],
      max_output_tokens: maxOutputTokens,
    })
    : await client.responses.create({
      model,
      input: [toolCall, toolOutput],
      max_output_tokens: maxOutputTokens,
      tools: [RESPONSES_WEATHER_TOOL],
    });
  expectExecutionPlan(second.id);
  if (second.output.length === 0) {
    throw new Error("OpenAI Responses tool-result output was empty");
  }
  expect(toolOutput.call_id).toBe(toolCall.call_id);

  const mixed = await client.responses.create({
    model: expectBridge ? visionScenarioModel : model,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Inspect this PNG, then you must call get_weather for Tokyo." },
        { type: "input_image", image_url: PNG_DATA_URL, detail: "auto" },
      ],
    }],
    max_output_tokens: maxOutputTokens,
    tools: [RESPONSES_WEATHER_TOOL],
    tool_choice: RESPONSES_WEATHER_CHOICE,
  });
  expectExecutionPlan(mixed.id);
  const mixedCall = mixed.output.find((item) => item.type === "function_call");
  if (mixedCall === undefined) {
    throw new Error("OpenAI Responses mixed scenario did not return a function call");
  }
  expect(mixedCall.call_id.length).toBeGreaterThan(0);
  expect(mixedCall.name).toBe("get_weather");
  getWeather(parseWeatherArguments(mixedCall.arguments).city);

  let streamedResponseId: string | undefined;
  let streamedCallId: string | undefined;
  let streamedName: string | undefined;
  let completedArguments: string | undefined;
  let argumentFragments: string[] = [];
  for (let attempt = 0; attempt < 3 && streamedCallId === undefined; attempt += 1) {
    const stream = await client.responses.create({
      model,
      input: "You must stream a get_weather call for Tokyo.",
      max_output_tokens: maxOutputTokens,
      tools: [RESPONSES_WEATHER_TOOL],
      tool_choice: RESPONSES_WEATHER_CHOICE,
      stream: true,
    });
    argumentFragments = [];
    completedArguments = undefined;
    streamedName = undefined;
    for await (const event of stream) {
      if (event.type === "response.created" || event.type === "response.completed") {
        streamedResponseId = event.response.id;
      } else if (event.type === "response.output_item.added" && event.item.type === "function_call") {
        streamedCallId = event.item.call_id;
        streamedName = event.item.name;
      } else if (event.type === "response.output_item.done" && event.item.type === "function_call") {
        streamedCallId = event.item.call_id;
        streamedName = event.item.name;
        completedArguments ??= event.item.arguments;
      } else if (event.type === "response.function_call_arguments.delta") {
        argumentFragments.push(event.delta);
      } else if (event.type === "response.function_call_arguments.done") {
        completedArguments = event.arguments;
        streamedName = event.name;
      }
    }
  }
  if (streamedResponseId === undefined) {
    throw new Error("OpenAI Responses stream omitted response.created");
  }
  expect(streamedResponseId.length).toBeGreaterThan(0);
  expect(streamedCallId?.length).toBeGreaterThan(0);
  expect(streamedName).toBe("get_weather");
  expect(argumentFragments.length).toBeGreaterThan(0);
  getWeather(parseWeatherArguments(argumentFragments.join("")).city);
  getWeather(parseWeatherArguments(completedArguments).city);

  const reasoning = await client.responses.create({
    model: reasoningScenarioModel,
    input: "Use low reasoning effort for this request.",
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: "low" },
  });
  expect(reasoning.id.length).toBeGreaterThan(0);
  expect(isManagedBridgeResponseId(reasoning.id)).toBe(expectBridge);
  assertNonEmptyArray(reasoning.output, "OpenAI Responses reasoning response was empty");
}

function assertOpenAiChatOutput(message: OpenAI.ChatCompletionMessage | undefined, error: string): void {
  if (!hasOpenAiChatOutput(message)) {
    throw new Error(error);
  }
}

function hasOpenAiChatOutput(message: OpenAI.ChatCompletionMessage | undefined): boolean {
  if (message === undefined) {
    return false;
  }
  const reasoning = Reflect.get(message, "reasoning_content");
  return (typeof message.content === "string" && message.content.trim().length > 0)
    || (typeof reasoning === "string" && reasoning.trim().length > 0)
    || (message.tool_calls?.length ?? 0) > 0;
}

function modelMode(model: unknown): string | undefined {
  if (model === null || typeof model !== "object" || !("mode" in model)) {
    return undefined;
  }
  return typeof model.mode === "string" ? model.mode : undefined;
}
