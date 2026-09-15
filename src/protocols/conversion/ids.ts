import type { InferenceProtocol } from "./types.js";

const RESPONSE_ID_PREFIX = "resp_";
const MANAGED_RESPONSE_NAMESPACE = "ghc-gateway:managed_response;";
const LEGACY_MANAGED_RESPONSE_NAMESPACE = Buffer.from(
  "bGl0ZWxsbTpjdXN0b21fbGxtX3Byb3ZpZGVyOg==",
  "base64",
).toString("utf8");

export function isGatewayManagedResponseId(id: string): boolean {
  if (!id.startsWith(RESPONSE_ID_PREFIX)) {
    return false;
  }
  try {
    const decoded = Buffer.from(id.slice(RESPONSE_ID_PREFIX.length), "base64").toString("utf8");
    return decoded.startsWith(MANAGED_RESPONSE_NAMESPACE)
      || decoded.startsWith(LEGACY_MANAGED_RESPONSE_NAMESPACE);
  } catch {
    return false;
  }
}

export function managedConvertedResponseId(
  upstreamProtocol: InferenceProtocol,
  model: string,
  nonce: string,
): string {
  return encodeManagedResponseId([
    "provider:github_copilot",
    `model_id:${model}`,
    `upstream_protocol:${upstreamProtocol}`,
    `response_id:${nonce}`,
  ]);
}

export function managedUpstreamResponseId(
  provider: string,
  model: string,
  upstreamResponseId: string,
): string {
  return encodeManagedResponseId([
    `provider:${provider}`,
    `model_id:${model}`,
    `response_id:${upstreamResponseId}`,
  ]);
}

function encodeManagedResponseId(fields: readonly string[]): string {
  const payload = `${MANAGED_RESPONSE_NAMESPACE}${fields.join(";")}`;
  return `${RESPONSE_ID_PREFIX}${Buffer.from(payload, "utf8").toString("base64")}`;
}
