import {
  executeChat, executeMessages, executeResponses,
  type SdkClients, type SdkMode, type SdkProtocol, type SdkProtocolResult,
} from "./client.js";
import {
  FORECAST_COMPARE_PROMPT, FORECAST_TOOL_ANTHROPIC, FORECAST_TOOL_OPENAI, FORECAST_TOOL_RESPONSES,
  MIXED_WEATHER_PROMPT, PARALLEL_WEATHER_PROMPT, REASONING_EFFORT, REASONING_PROMPT, WEATHER_PROMPT, WEATHER_RESPONSES_PROMPT,
  WEATHER_RESULT, type TextScenario,
} from "./scenarios.js";

// Official SDK request definitions shared by replay acceptance and corpus recording. Recording
// sends the native (downstream === upstream) forms through the gateway; replay sends all nine.

const WEATHER_DESCRIPTION = "Get weather for city";
const WEATHER_SCHEMA = { type: "object", properties: { city: { type: "string" } }, required: ["city"] as string[] } as const;
const CLOSED_WEATHER_SCHEMA = { ...WEATHER_SCHEMA, additionalProperties: false } as const;
const RESPONSES_WEATHER_TOOL = {
  type: "function", name: "get_weather", description: WEATHER_DESCRIPTION, parameters: CLOSED_WEATHER_SCHEMA, strict: true,
} as const;

/** Tool definitions for the two-step weather roundtrip. */
export const WEATHER_TOOLS = {
  chat: { type: "function", function: { name: "get_weather", description: WEATHER_DESCRIPTION, parameters: WEATHER_SCHEMA } },
  responses: RESPONSES_WEATHER_TOOL,
  messages: { name: "get_weather", description: WEATHER_DESCRIPTION, input_schema: WEATHER_SCHEMA },
} as const;

/** Closed-schema tool definitions for the parallel and mixed image/tool calls. */
export const STRICT_WEATHER_TOOLS = {
  chat: { type: "function", function: { name: "get_weather", description: WEATHER_DESCRIPTION, parameters: CLOSED_WEATHER_SCHEMA, strict: true } },
  responses: RESPONSES_WEATHER_TOOL,
  messages: { name: "get_weather", description: WEATHER_DESCRIPTION, input_schema: CLOSED_WEATHER_SCHEMA },
} as const;

export async function executeTextScenario(
  clients: SdkClients,
  downstream: SdkProtocol,
  target: { readonly protocol: SdkProtocol; readonly model: string },
  scenario: TextScenario,
  mode: SdkMode,
  imageBase64: string | undefined,
): Promise<SdkProtocolResult> {
  const { model } = target;
  const dataUrl = `data:image/jpeg;base64,${imageBase64}`;
  // Native long text carries explicit reasoning options; converted requests stay portable.
  const nativeLongText = scenario.id === "plain-text" && downstream === target.protocol;
  switch (downstream) {
  case "chat":
    return { protocol: downstream, result: await executeChat(clients.openai, {
      model,
      max_tokens: 4_000,
      ...(nativeLongText ? { reasoning_effort: "low" as const } : {}),
      messages: [
        ...(scenario.system === undefined ? [] : [{ role: "system" as const, content: scenario.system }]),
        {
          role: "user",
          content: imageBase64 === undefined ? scenario.prompt : [
            { type: "text", text: scenario.prompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
          ],
        },
      ],
    }, mode) };
  case "messages":
    return { protocol: downstream, result: await executeMessages(clients.anthropic, {
      model,
      max_tokens: 4_000,
      ...(scenario.system === undefined ? {} : { system: scenario.system }),
      messages: [{
        role: "user",
        content: imageBase64 === undefined ? scenario.prompt : [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
          { type: "text", text: scenario.prompt },
        ],
      }],
    }, mode) };
  case "responses":
    return { protocol: downstream, result: await executeResponses(clients.openai, {
      model,
      max_output_tokens: 4_000,
      ...(nativeLongText ? { reasoning: { effort: "low" as const } } : {}),
      ...(scenario.system === undefined ? {} : { instructions: scenario.system }),
      input: imageBase64 === undefined ? scenario.prompt : [{
        role: "user",
        content: [
          { type: "input_text", text: scenario.prompt },
          { type: "input_image", image_url: dataUrl, detail: "auto" },
        ],
      }],
    }, mode) };
  }
}

export async function executeReasoning(clients: SdkClients, downstream: SdkProtocol, model: string): Promise<SdkProtocolResult> {
  switch (downstream) {
  case "chat": return { protocol: downstream, result: await executeChat(clients.openai, {
    model, messages: [{ role: "user", content: REASONING_PROMPT }], reasoning_effort: REASONING_EFFORT,
  }, "nonstream") };
  case "messages": return { protocol: downstream, result: await executeMessages(clients.anthropic, {
    model, max_tokens: 1_024, messages: [{ role: "user", content: REASONING_PROMPT }],
    // Adaptive thinking is otherwise omitted or skipped; summarized display supplies public thinking.
    thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: REASONING_EFFORT },
  }, "nonstream") };
  case "responses": return { protocol: downstream, result: await executeResponses(clients.openai, {
    model, input: REASONING_PROMPT, reasoning: { effort: REASONING_EFFORT }, max_output_tokens: 1_024,
  }, "nonstream") };
  }
}

export interface WeatherRoundtrip {
  readonly first: SdkProtocolResult;
  readonly second: SdkProtocolResult;
}

/** Call get_weather, then return its result in a second buffered request. */
export async function executeWeatherRoundtrip(
  clients: SdkClients,
  downstream: SdkProtocol,
  upstream: SdkProtocol,
  model: string,
): Promise<WeatherRoundtrip> {
  switch (downstream) {
  case "chat": {
    const first = await executeChat(clients.openai, {
      model, messages: [{ role: "user", content: WEATHER_PROMPT }], tools: [WEATHER_TOOLS.chat],
    }, "nonstream");
    const message = first.response.choices[0]?.message;
    const call = message?.tool_calls?.[0];
    if (message === undefined || call === undefined) throw new Error("Expected a weather tool call");
    const second = await executeChat(clients.openai, {
      model,
      messages: [
        { role: "user", content: WEATHER_PROMPT },
        message,
        { role: "tool", tool_call_id: call.id, content: WEATHER_RESULT },
      ],
    }, "nonstream");
    return { first: { protocol: downstream, result: first }, second: { protocol: downstream, result: second } };
  }
  case "messages": {
    const first = await executeMessages(clients.anthropic, {
      model, max_tokens: 1_024, messages: [{ role: "user", content: WEATHER_PROMPT }], tools: [WEATHER_TOOLS.messages],
    }, "nonstream");
    const call = first.response.content.find((block) => block.type === "tool_use");
    if (call === undefined) throw new Error("Expected a weather tool call");
    const second = await executeMessages(clients.anthropic, {
      model,
      max_tokens: 1_024,
      messages: [
        { role: "user", content: WEATHER_PROMPT },
        { role: "assistant", content: [call] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: WEATHER_RESULT }] },
      ],
    }, "nonstream");
    return { first: { protocol: downstream, result: first }, second: { protocol: downstream, result: second } };
  }
  case "responses": {
    const first = await executeResponses(clients.openai, upstream === "responses"
      ? { model, input: WEATHER_PROMPT, tools: [WEATHER_TOOLS.responses] }
      : { model, input: WEATHER_RESPONSES_PROMPT, tools: [WEATHER_TOOLS.responses], tool_choice: { type: "function", name: "get_weather" } },
    "nonstream");
    const call = first.response.output.find((item) => item.type === "function_call");
    if (call === undefined) throw new Error("Expected a weather tool call");
    const output = { type: "function_call_output" as const, call_id: call.call_id, output: WEATHER_RESULT };
    // Copilot rejects upstream-owned previous_response_id continuation, so the native cell resends
    // explicit history; converted cells exercise gateway-owned continuation.
    const second = await executeResponses(clients.openai, upstream === "responses"
      ? { model, input: [{ role: "user", content: WEATHER_PROMPT }, call, output] }
      : {
        model,
        previous_response_id: first.response.id,
        input: upstream === "messages"
          ? [{ role: "user", content: [{ type: "input_text", text: "Use the tool result for the original task." }] }, output]
          : [output],
      }, "nonstream");
    return { first: { protocol: downstream, result: first }, second: { protocol: downstream, result: second } };
  }
  }
}

export async function executeParallelWeather(clients: SdkClients, downstream: SdkProtocol, model: string): Promise<SdkProtocolResult> {
  switch (downstream) {
  case "chat": return { protocol: downstream, result: await executeChat(clients.openai, {
    model, messages: [{ role: "user", content: PARALLEL_WEATHER_PROMPT }], tools: [STRICT_WEATHER_TOOLS.chat],
  }, "nonstream") };
  case "messages": return { protocol: downstream, result: await executeMessages(clients.anthropic, {
    model, max_tokens: 1_024, messages: [{ role: "user", content: PARALLEL_WEATHER_PROMPT }], tools: [STRICT_WEATHER_TOOLS.messages],
  }, "nonstream") };
  case "responses": return { protocol: downstream, result: await executeResponses(clients.openai, {
    model, input: PARALLEL_WEATHER_PROMPT, tools: [STRICT_WEATHER_TOOLS.responses],
  }, "nonstream") };
  }
}

export async function executeMixedImageTool(
  clients: SdkClients,
  downstream: SdkProtocol,
  model: string,
  imageBase64: string,
): Promise<SdkProtocolResult> {
  switch (downstream) {
  case "chat": return { protocol: downstream, result: await executeChat(clients.openai, {
    model,
    messages: [{ role: "user", content: [
      { type: "text", text: MIXED_WEATHER_PROMPT },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ] }],
    tools: [STRICT_WEATHER_TOOLS.chat],
  }, "nonstream") };
  case "messages": return { protocol: downstream, result: await executeMessages(clients.anthropic, {
    model,
    max_tokens: 1_024,
    messages: [{ role: "user", content: [
      { type: "text", text: MIXED_WEATHER_PROMPT },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
    ] }],
    tools: [STRICT_WEATHER_TOOLS.messages],
  }, "nonstream") };
  case "responses": return { protocol: downstream, result: await executeResponses(clients.openai, {
    model,
    input: [{ role: "user", content: [
      { type: "input_text", text: MIXED_WEATHER_PROMPT },
      { type: "input_image", image_url: `data:image/jpeg;base64,${imageBase64}`, detail: "auto" },
    ] }],
    tools: [STRICT_WEATHER_TOOLS.responses],
    tool_choice: { type: "function", name: "get_weather" },
  }, "nonstream") };
  }
}

/** Stream exactly two nested multi-parameter forecast calls. */
export async function executeForecastTools(clients: SdkClients, downstream: SdkProtocol, model: string): Promise<SdkProtocolResult> {
  switch (downstream) {
  case "chat": return { protocol: downstream, result: await executeChat(clients.openai, {
    model, messages: [{ role: "user", content: FORECAST_COMPARE_PROMPT }],
    tools: [FORECAST_TOOL_OPENAI], tool_choice: "auto", parallel_tool_calls: true, max_tokens: 4_000,
  }, "stream") };
  case "messages": return { protocol: downstream, result: await executeMessages(clients.anthropic, {
    model, max_tokens: 4_000, messages: [{ role: "user", content: FORECAST_COMPARE_PROMPT }],
    tools: [FORECAST_TOOL_ANTHROPIC], tool_choice: { type: "auto", disable_parallel_tool_use: false },
  }, "stream") };
  case "responses": return { protocol: downstream, result: await executeResponses(clients.openai, {
    model, input: FORECAST_COMPARE_PROMPT, tools: [FORECAST_TOOL_RESPONSES],
    tool_choice: "auto", parallel_tool_calls: true, max_output_tokens: 4_000,
  }, "stream") };
  }
}
