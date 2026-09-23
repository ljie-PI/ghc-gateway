import type { ServerResponse } from "node:http";

/** Protocol-native models used by the recorded corpus, its recorder and offline replay. */
export const REPLAY_MODELS = {
  chat: "gemini-3.8-flash",
  responses: "gpt-6-astra",
  messages: "claude-opus-5.5",
} as const;

/**
 * Fixed upstream catalog served during both recording and replay, so the gateway plans
 * identical requests in each mode. Tool, parallel-tool and vision support mirror the live
 * catalog for these models; it intentionally advertises no portable reasoning.
 */
const SUPPORTS = { capabilities: { supports: { streaming: true, tool_calls: true, parallel_tool_calls: true, vision: true } } } as const;

export const REPLAY_CATALOG = {
  data: [
    { id: REPLAY_MODELS.chat, name: "Gemini 3.8 Flash", vendor: "Google", model_picker_enabled: true, ...SUPPORTS,
      model_info: { supported_endpoints: ["/chat/completions"], supported_parameters: ["temperature", "top_p", "response_format"], max_input_tokens: 128_000, max_output_tokens: 64_000, chat_output_token_field: "max_tokens" } },
    { id: REPLAY_MODELS.responses, name: "GPT-6 Astra", vendor: "OpenAI", model_picker_enabled: true, ...SUPPORTS,
      model_info: { supported_endpoints: ["/responses"], supported_parameters: ["temperature", "top_p", "response_format"], max_input_tokens: 128_000, max_output_tokens: 128_000 } },
    { id: REPLAY_MODELS.messages, name: "Claude Opus 5.5", vendor: "Anthropic", model_picker_enabled: true, ...SUPPORTS,
      model_info: { supported_endpoints: ["/messages"], supported_parameters: ["temperature", "top_p"], max_input_tokens: 128_000, max_output_tokens: 16_000, default_output_tokens: 4_096 } },
  ],
} as const;

export function serveReplayCatalog(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(REPLAY_CATALOG));
}
