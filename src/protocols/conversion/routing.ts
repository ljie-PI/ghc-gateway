import type { InferenceProtocol } from "./types.js";

const PRIORITIES: Readonly<Record<InferenceProtocol, readonly InferenceProtocol[]>> = {
  chat: ["responses", "messages"],
  messages: ["chat", "responses"],
  responses: ["chat", "messages"],
};

export function protocolTargets(
  source: InferenceProtocol,
  protocols: readonly InferenceProtocol[],
): readonly InferenceProtocol[] {
  if (protocols.includes(source)) return [source];
  return PRIORITIES[source].filter((target) => protocols.includes(target));
}
