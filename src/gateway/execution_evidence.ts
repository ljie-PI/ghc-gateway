import type { InferenceProtocol } from "../protocols/conversion/types.js";

export const UPSTREAM_PROTOCOL_HEADER = "x-ghcg-upstream-protocol";

export function withUpstreamProtocol(
  response: Response,
  protocol: InferenceProtocol,
): Response {
  response.headers.set(UPSTREAM_PROTOCOL_HEADER, protocol);
  return response;
}
