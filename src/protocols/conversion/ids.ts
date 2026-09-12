import type { InferenceProtocol } from "./types.js";

export function isGatewayManagedResponseId(id: string): boolean {
  if (!id.startsWith("resp_")) {
    return false;
  }
  try {
    return Buffer.from(id.slice("resp_".length), "base64").toString("utf8").startsWith("litellm:custom_llm_provider:");
  } catch {
    return false;
  }
}

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
