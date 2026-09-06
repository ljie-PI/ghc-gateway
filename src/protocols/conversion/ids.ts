import type { InferenceProtocol } from "./types.js";

export function managedConvertedResponseId(
  upstreamProtocol: InferenceProtocol,
  model: string,
  nonce: string,
): string {
  const payload = [
    "litellm:custom_llm_provider:github_copilot",
    `model_id:${model}`,
    `upstream_protocol:${upstreamProtocol}`,
    `response_id:${nonce}`,
  ].join(";");
  return `resp_${Buffer.from(payload, "utf8").toString("base64")}`;
}
