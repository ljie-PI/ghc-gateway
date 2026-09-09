import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import {
  executeChat, executeMessages, executeResponses,
  type SdkClients, type SdkProtocol, type SdkProtocolResult as SessionResult, type SdkToolCall as ForecastCall,
} from "./client.js";
import {
  FORECAST_COMPARE_PROMPT, FORECAST_TOOL_ANTHROPIC, FORECAST_TOOL_OPENAI, FORECAST_TOOL_RESPONSES,
  PARIS_RESULT, SESSION_AUDIT_PROMPT, SESSION_IMAGE_PROMPT, SESSION_SHOT_LIST_PROMPT,
  SESSION_SYNTHESIS_PROMPT, SESSION_SYSTEM, TOKYO_RESULT,
} from "./scenarios.js";

export const SESSION_PROMPTS = [
  SESSION_IMAGE_PROMPT, FORECAST_COMPARE_PROMPT, SESSION_SYNTHESIS_PROMPT,
  SESSION_SHOT_LIST_PROMPT, SESSION_AUDIT_PROMPT,
] as const;
export type SessionTurn = 1 | 2 | 3 | 4 | 5;
export const SESSION_TURNS: readonly SessionTurn[] = [1, 2, 3, 4, 5];
export function forecastResults(calls: readonly ForecastCall[]): { id: string; content: string }[] {
  return ["Tokyo", "Paris"].map((city) => {
    const call = calls.find((candidate) => (candidate.arguments as { location: { city: string } }).location.city === city);
    if (call === undefined) throw new Error("Missing forecast call binding");
    return { id: call.id, content: city === "Tokyo" ? TOKYO_RESULT : PARIS_RESULT };
  });
}

/** The test owns explicit native histories; the delivered client helper owns SDK execution. */
export function createSessionDriver(clients: SdkClients, protocol: SdkProtocol, model: string, imageBase64: string) {
  const dataUrl = `data:image/jpeg;base64,${imageBase64}`;
  const chat: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: SESSION_SYSTEM }];
  const messages: Anthropic.MessageParam[] = [];
  const input: OpenAI.Responses.ResponseInput = [];
  return async (turn: SessionTurn, calls: readonly ForecastCall[]): Promise<SessionResult> => {
    const prompt = SESSION_PROMPTS[turn - 1]!;
    const results = turn === 3 ? forecastResults(calls) : [];
    const mode = turn === 1 ? "nonstream" : "stream";
    switch (protocol) {
    case "chat": {
      chat.push(...results.map(({ id, content }) => ({ role: "tool" as const, tool_call_id: id, content })));
      chat.push({ role: "user", content: turn === 1
        ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl, detail: "auto" } }]
        : prompt });
      const result = await executeChat(clients.openai, {
        model, messages: chat, max_tokens: 3_000,
        ...(turn >= 2 ? { tools: [FORECAST_TOOL_OPENAI] } : {}),
        ...(turn === 2 ? { tool_choice: "auto", parallel_tool_calls: true } : {}),
      }, mode);
      const message = result.response.choices[0]!.message;
      chat.push({ role: "assistant", content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });
      return { protocol, result };
    }
    case "messages": {
      messages.push({ role: "user", content: [
        ...results.map(({ id, content }) => ({ type: "tool_result" as const, tool_use_id: id, content })),
        { type: "text", text: prompt },
        ...(turn === 1 ? [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: imageBase64 } }] : []),
      ] });
      const result = await executeMessages(clients.anthropic, {
        model, system: SESSION_SYSTEM, messages, max_tokens: 3_000, thinking: { type: "disabled" },
        ...(turn >= 2 ? { tools: [FORECAST_TOOL_ANTHROPIC] } : {}),
        ...(turn === 2 ? { tool_choice: { type: "auto", disable_parallel_tool_use: false } } : {}),
      }, mode);
      messages.push({ role: "assistant", content: result.response.content });
      return { protocol, result };
    }
    case "responses": {
      input.push(...results.map(({ id, content }) => ({ type: "function_call_output" as const, call_id: id, output: content })));
      input.push({ role: "user", content: [
        { type: "input_text", text: prompt },
        ...(turn === 1 ? [{ type: "input_image" as const, image_url: dataUrl, detail: "auto" as const }] : []),
      ] });
      const result = await executeResponses(clients.openai, {
        model, instructions: SESSION_SYSTEM, input, max_output_tokens: 3_000,
        ...(turn >= 2 ? { tools: [FORECAST_TOOL_RESPONSES] } : {}),
        ...(turn === 2 ? { tool_choice: "auto", parallel_tool_calls: true } : {}),
      }, mode);
      // Explicit portable history, not previous_response_id, response-only logprobs, or opaque reasoning state.
      for (const item of result.response.output) {
        if (item.type === "message") input.push({ type: "message", id: item.id, status: item.status, role: "assistant", content: item.content.flatMap((part) =>
          part.type === "output_text" ? [{ type: "output_text" as const, text: part.text, annotations: part.annotations }] : []) });
        if (item.type === "function_call") input.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments });
      }
      return { protocol, result };
    }
    }
  };
}
