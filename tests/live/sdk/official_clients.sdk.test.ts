import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions/completions";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorStatus,
  assertNonEmptyArray,
  assertLiveRequestPlan,
  expectCancelledStream,
  getWeather,
  LIVE_MAX_INFERENCE_CALLS,
  LIVE_REQUEST_TIMEOUT_MS,
  LIVE_ROUTES,
  type LiveConfiguration,
  LiveCallLedger,
  type LiveManagedState,
  type LiveRouteKey,
  parseManagedConvertedResponseId,
  parseWeatherArguments,
  PNG_BASE64,
  PNG_DATA_URL,
  readLiveConfiguration,
  readLiveManagedState,
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
const OUTPUT_TOKENS = 64;
const PASS_CALLS: Readonly<Record<LiveRouteKey, number>> = {
  c_to_c: 1,
  c_to_m: 1,
  c_to_r: 2,
  m_to_c: 1,
  m_to_m: 1,
  m_to_r: 1,
  r_to_c: 1,
  r_to_m: 2,
  r_to_r: 2,
};

describe("guarded live official SDK protocol matrix", () => {
  let configuration: LiveConfiguration;
  let initialState: LiveManagedState;
  let openai: OpenAI;
  let anthropic: Anthropic;
  let ledger: LiveCallLedger;

  beforeAll(async () => {
    configuration = readLiveConfiguration();
    initialState = await readLiveManagedState(configuration);
    ledger = new LiveCallLedger(LIVE_MAX_INFERENCE_CALLS);
    const guardedFetch = ledger.fetch(configuration.baseUrl);
    openai = new OpenAI({
      apiKey: "local-gateway",
      baseURL: `${configuration.baseUrl}/v1`,
      fetch: guardedFetch,
      maxRetries: 0,
      timeout: LIVE_REQUEST_TIMEOUT_MS,
      logLevel: "off",
    });
    anthropic = new Anthropic({
      apiKey: "local-gateway",
      baseURL: configuration.baseUrl,
      fetch: guardedFetch,
      maxRetries: 0,
      timeout: LIVE_REQUEST_TIMEOUT_MS,
      logLevel: "off",
    });

    let openAiModels: Awaited<ReturnType<OpenAI["models"]["list"]>>;
    let anthropicModels: Awaited<ReturnType<Anthropic["models"]["list"]>>;
    try {
      openAiModels = await openai.models.list();
      anthropicModels = await anthropic.models.list();
    } catch (error: unknown) {
      throw safeLiveFailure("model_catalog", error);
    }
    const openAiIds = new Set(openAiModels.data.map((model) => model.id));
    const anthropicIds = new Set(anthropicModels.data.map((model) => model.id));
    for (const route of LIVE_ROUTES) {
      const selection = configuration.routes[route.key];
      if (selection.kind === "unavailable") {
        continue;
      }
      const visible = route.source === "messages" ? anthropicIds : openAiIds;
      if (!visible.has(selection.modelId)) {
        throw new Error(`${route.envPrefix} is absent from the selected downstream SDK catalog`);
      }
    }
    recordLiveStatus("managed_gateway", "passing", [], {
      managed: initialState.managed,
      port: initialState.port,
      inference_call_limit: LIVE_MAX_INFERENCE_CALLS,
      request_timeout_ms: LIVE_REQUEST_TIMEOUT_MS,
      sdk_retries: 0,
      concurrency: 1,
    });
  });

  afterAll(async () => {
    if (configuration === undefined || initialState === undefined || ledger === undefined) {
      return;
    }
    const restored = await readLiveManagedState(configuration);
    if (restored.accounts.defaultAccountId !== initialState.accounts.defaultAccountId) {
      throw new Error("live SDK suite changed the managed gateway default account");
    }
    recordLiveStatus("call_ledger", "passing", [], { ...ledger.snapshot() });
    recordLiveStatus("managed_gateway_restoration", "passing", [], {
      default_account_unchanged: true,
      managed: restored.managed,
      port: restored.port,
    });
  });

  it("executes Chat -> Chat with bounded image input", async () => {
    await runLiveRoute("c_to_c", async (model) => {
      const request: ChatCompletionCreateParamsNonStreaming = {
        model,
        max_completion_tokens: OUTPUT_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Inspect this synthetic PNG and return one short text block." },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        }],
      };
      assertPlan("c_to_c", model, request);
      const completion = await openai.chat.completions.create(request);
      expect(completion.id.length).toBeGreaterThan(0);
      expect(completion.choices.length).toBeGreaterThan(0);
    });
  });

  it("executes Chat -> Responses with a two-request tool round", async () => {
    await runLiveRoute("c_to_r", async (model) => {
      const userMessage = {
        role: "user",
        content: "Call get_weather once with city Tokyo.",
      } as const;
      const firstRequest: ChatCompletionCreateParamsNonStreaming = {
        model,
        max_completion_tokens: OUTPUT_TOKENS,
        messages: [userMessage],
        tools: [OPENAI_CHAT_WEATHER_TOOL],
        tool_choice: OPENAI_CHAT_WEATHER_CHOICE,
      };
      assertPlan("c_to_r", model, firstRequest);
      const first = await openai.chat.completions.create(firstRequest);
      const toolCall = first.choices[0]?.message.tool_calls?.[0];
      if (toolCall?.type !== "function") {
        throw new Error("Chat -> Responses did not return a function tool call");
      }
      expect(toolCall.id.length).toBeGreaterThan(0);
      expect(toolCall.function.name).toBe("get_weather");
      const weather = getWeather(parseWeatherArguments(toolCall.function.arguments).city);
      const secondRequest: ChatCompletionCreateParamsNonStreaming = {
        model,
        max_completion_tokens: OUTPUT_TOKENS,
        messages: [
          userMessage,
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: toolCall.id,
              type: "function",
              function: toolCall.function,
            }],
          },
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(weather),
          },
        ],
        tools: [OPENAI_CHAT_WEATHER_TOOL],
      };
      assertPlan("c_to_r", model, secondRequest);
      const second = await openai.chat.completions.create(secondRequest);
      expect(second.id.length).toBeGreaterThan(0);
      expect(second.choices.length).toBeGreaterThan(0);
    });
  });

  it("executes Chat -> Messages with a forced tool call", async () => {
    await runLiveRoute("c_to_m", async (model) => {
      const request: ChatCompletionCreateParamsNonStreaming = {
        model,
        max_completion_tokens: OUTPUT_TOKENS,
        messages: [{ role: "user", content: "Call get_weather once with city Tokyo." }],
        tools: [OPENAI_CHAT_WEATHER_TOOL],
        tool_choice: OPENAI_CHAT_WEATHER_CHOICE,
      };
      assertPlan("c_to_m", model, request);
      const completion = await openai.chat.completions.create(request);
      const toolCall = completion.choices[0]?.message.tool_calls?.[0];
      if (toolCall?.type !== "function") {
        throw new Error("Chat -> Messages did not return a function tool call");
      }
      expect(toolCall.id.length).toBeGreaterThan(0);
      expect(toolCall.function.name).toBe("get_weather");
      getWeather(parseWeatherArguments(toolCall.function.arguments).city);
    });
  });

  it("executes Messages -> Chat with multi-turn input", async () => {
    await runLiveRoute("m_to_c", async (model) => {
      const request: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: OUTPUT_TOKENS,
        system: "Return one short content block.",
        messages: [
          { role: "user", content: "Synthetic turn one." },
          { role: "assistant", content: "Synthetic acknowledgement." },
          { role: "user", content: "Synthetic turn two." },
        ],
      };
      assertPlan("m_to_c", model, request);
      const message = await anthropic.messages.create(request);
      expect(message.id.length).toBeGreaterThan(0);
      assertNonEmptyArray(message.content, "Messages -> Chat returned no content blocks");
    });
  });

  it("executes Messages -> Messages as a complete event stream", async () => {
    await runLiveRoute("m_to_m", async (model) => {
      const request: MessageCreateParamsStreaming = {
        model,
        max_tokens: OUTPUT_TOKENS,
        messages: [{ role: "user", content: "Return one short content block." }],
        stream: true,
      };
      assertPlan("m_to_m", model, request);
      const stream = await anthropic.messages.create(request);
      let eventCount = 0;
      let sawMessageStop = false;
      for await (const event of stream) {
        eventCount += 1;
        sawMessageStop ||= event.type === "message_stop";
      }
      expect(eventCount).toBeGreaterThan(0);
      expect(sawMessageStop).toBe(true);
    });
  });

  it("executes Messages -> Responses with image and forced tool input", async () => {
    await runLiveRoute("m_to_r", async (model) => {
      const request: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: OUTPUT_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Inspect this synthetic PNG, then call get_weather for Tokyo." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
          ],
        }],
        tools: [ANTHROPIC_WEATHER_TOOL],
        tool_choice: ANTHROPIC_WEATHER_CHOICE,
      };
      assertPlan("m_to_r", model, request);
      const message = await anthropic.messages.create(request);
      const toolUse = message.content.find((block) => block.type === "tool_use");
      if (toolUse === undefined) {
        throw new Error("Messages -> Responses did not return a tool_use block");
      }
      expect(toolUse.id.length).toBeGreaterThan(0);
      expect(toolUse.name).toBe("get_weather");
      getWeather(parseWeatherArguments(toolUse.input).city);
    });
  });

  it("executes Responses -> Chat with a forced tool call", async () => {
    await runLiveRoute("r_to_c", async (model) => {
      const request: ResponseCreateParamsNonStreaming = {
        model,
        input: "Call get_weather once with city Tokyo.",
        max_output_tokens: OUTPUT_TOKENS,
        tools: [RESPONSES_WEATHER_TOOL],
        tool_choice: RESPONSES_WEATHER_CHOICE,
      };
      assertPlan("r_to_c", model, request);
      const response = await openai.responses.create(request);
      assertConvertedResponsesRoute(response.id, model, "chat");
      const toolCall = response.output.find((item) => item.type === "function_call");
      if (toolCall === undefined) {
        throw new Error("Responses -> Chat did not return a function call");
      }
      expect(toolCall.call_id.length).toBeGreaterThan(0);
      expect(toolCall.name).toBe("get_weather");
      getWeather(parseWeatherArguments(toolCall.arguments).city);
    });
  });

  it("executes Responses -> Messages with a scoped two-request tool round", async () => {
    await runLiveRoute("r_to_m", async (model) => {
      const firstRequest: ResponseCreateParamsNonStreaming = {
        model,
        input: "Call get_weather once with city Tokyo.",
        max_output_tokens: OUTPUT_TOKENS,
        tools: [RESPONSES_WEATHER_TOOL],
        tool_choice: RESPONSES_WEATHER_CHOICE,
      };
      assertPlan("r_to_m", model, firstRequest);
      const first = await openai.responses.create(firstRequest);
      assertConvertedResponsesRoute(first.id, model, "messages");
      const toolCall = first.output.find((item) => item.type === "function_call");
      if (toolCall === undefined) {
        throw new Error("Responses -> Messages did not return a function call");
      }
      expect(toolCall.call_id.length).toBeGreaterThan(0);
      expect(toolCall.name).toBe("get_weather");
      const weather = getWeather(parseWeatherArguments(toolCall.arguments).city);
      const secondRequest: ResponseCreateParamsNonStreaming = {
        model,
        previous_response_id: first.id,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Use the synthetic tool result for the original task." }],
          },
          {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: JSON.stringify(weather),
          },
        ],
        max_output_tokens: OUTPUT_TOKENS,
      };
      const second = await openai.responses.create(secondRequest);
      assertConvertedResponsesRoute(second.id, model, "messages");
      assertNonEmptyArray(second.output, "Responses -> Messages tool result returned no output items");
    });
  });

  it("executes Responses -> Responses stream and bounded cancellation", async () => {
    await runLiveRoute("r_to_r", async (model) => {
      const request: ResponseCreateParamsStreaming = {
        model,
        input: "Return one short output item.",
        max_output_tokens: OUTPUT_TOKENS,
        stream: true,
      };
      assertPlan("r_to_r", model, request);
      const stream = await openai.responses.create(request);
      let responseId: string | undefined;
      let eventCount = 0;
      let sawCompleted = false;
      for await (const event of stream) {
        eventCount += 1;
        if (event.type === "response.completed") {
          sawCompleted = true;
          responseId = event.response.id;
        }
      }
      expect(eventCount).toBeGreaterThan(0);
      expect(sawCompleted).toBe(true);
      if (responseId === undefined || responseId.length === 0) {
        throw new Error("native Responses stream omitted its response ID");
      }
      expect(parseManagedConvertedResponseId(responseId)).toBeNull();

      const cancellationRequest: ResponseCreateParamsStreaming = {
        model,
        input: "Produce several short output items.",
        max_output_tokens: OUTPUT_TOKENS,
        stream: true,
      };
      assertPlan("r_to_r", model, cancellationRequest);
      const cancelled = await openai.responses.create(cancellationRequest);
      await expectCancelledStream(cancelled, () => cancelled.controller.abort());
      expect(cancelled.controller.signal.aborted).toBe(true);
    });
  });

  async function runLiveRoute(
    routeKey: LiveRouteKey,
    operation: (modelId: string) => Promise<void>,
  ): Promise<void> {
    const route = LIVE_ROUTES.find((item) => item.key === routeKey);
    if (route === undefined) {
      throw new Error(`unknown live route ${routeKey}`);
    }
    const selection = configuration.routes[routeKey];
    if (selection.kind === "unavailable") {
      recordLiveStatus(routeKey, "not_available", [], {
        expected_upstream: route.target,
        reason: selection.reason,
        inference_calls: 0,
      });
      return;
    }
    if (selection.kind === "unsupported") {
      const before = ledger.snapshot().inferenceCalls;
      try {
        await ledger.run(routeKey, async () => await runUnsupportedProbe(routeKey, selection.modelId));
      } catch (error: unknown) {
        const status = apiErrorStatus(error);
        const inferenceCalls = ledger.snapshot().inferenceCalls - before;
        if (status === selection.expectedStatus && inferenceCalls === 1) {
          recordLiveStatus(routeKey, "unsupported", [selection.modelId], {
            expected_upstream: route.target,
            http_status: status,
            inference_calls: inferenceCalls,
          });
          return;
        }
        throw safeLiveFailure(routeKey, error);
      }
      throw new Error(`${route.envPrefix}_UNSUPPORTED_MODEL unexpectedly completed successfully`);
    }
    const before = ledger.snapshot().inferenceCalls;
    try {
      await ledger.run(routeKey, async () => await operation(selection.modelId));
    } catch (error: unknown) {
      throw safeLiveFailure(routeKey, error);
    }
    const inferenceCalls = ledger.snapshot().inferenceCalls - before;
    if (inferenceCalls !== PASS_CALLS[routeKey]) {
      throw new Error(`live route ${routeKey} used an unexpected downstream request count`);
    }
    recordLiveStatus(routeKey, "passing", [selection.modelId], {
      expected_upstream: route.target,
      inference_calls: inferenceCalls,
    });
  }

  function assertPlan(
    routeKey: LiveRouteKey,
    modelId: string,
    body: unknown,
  ): void {
    assertLiveRequestPlan(
      routeKey,
      modelId,
      body,
      initialState.models.items,
      configuration.accountId,
    );
  }

  async function runUnsupportedProbe(
    routeKey: LiveRouteKey,
    modelId: string,
  ): Promise<void> {
    const route = LIVE_ROUTES.find((candidate) => candidate.key === routeKey);
    if (route === undefined) {
      throw new Error(`unknown live route ${routeKey}`);
    }
    if (route.source === "chat") {
      const request: ChatCompletionCreateParamsNonStreaming = {
        model: modelId,
        max_completion_tokens: 16,
        messages: [{ role: "user", content: "Return one short synthetic text block." }],
      };
      assertPlan(routeKey, modelId, request);
      await openai.chat.completions.create(request);
      return;
    }
    if (route.source === "messages") {
      const request: MessageCreateParamsNonStreaming = {
        model: modelId,
        max_tokens: 16,
        messages: [{ role: "user", content: "Return one short synthetic content block." }],
      };
      assertPlan(routeKey, modelId, request);
      await anthropic.messages.create(request);
      return;
    }
    const request: ResponseCreateParamsNonStreaming = {
      model: modelId,
      max_output_tokens: 16,
      input: "Return one short synthetic output item.",
    };
    assertPlan(routeKey, modelId, request);
    await openai.responses.create(request);
  }
});

function assertConvertedResponsesRoute(
  id: string,
  modelId: string,
  expectedUpstream: "chat" | "messages",
): void {
  const parsed = parseManagedConvertedResponseId(id);
  if (parsed === null) {
    throw new Error("converted Responses result did not use a managed route ID");
  }
  expect(parsed.modelId).toBe(modelId);
  expect(parsed.upstreamProtocol).toBe(expectedUpstream);
  expect(parsed.responseId.length).toBeGreaterThan(0);
}

function safeLiveFailure(check: string, error: unknown): Error {
  const status = apiErrorStatus(error);
  return new Error(status === null
    ? `live check ${check} failed without a safe HTTP status`
    : `live check ${check} failed with HTTP status ${status}`);
}
