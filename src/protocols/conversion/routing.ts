import type { InferenceProtocol } from "./types.js";

const PRIORITIES: Readonly<Record<InferenceProtocol, readonly InferenceProtocol[]>> = {
  chat: ["responses", "messages"],
  messages: ["chat", "responses"],
  responses: ["chat", "messages"],
};

const REASONING_PARAMETERS: Readonly<Record<InferenceProtocol, readonly string[]>> = {
  chat: ["reasoning_effort"],
  messages: ["output_config.effort", "output_config"],
  responses: ["reasoning", "reasoning.effort"],
};

export function protocolTargets(
  source: InferenceProtocol,
  protocols: readonly InferenceProtocol[],
): readonly InferenceProtocol[] {
  if (protocols.includes(source)) return [source];
  return PRIORITIES[source].filter((target) => protocols.includes(target));
}

export function supportsReasoningParameter(
  target: InferenceProtocol,
  supportedParameters: readonly string[] | null,
): boolean {
  return REASONING_PARAMETERS[target].some((parameter) => supportedParameters?.includes(parameter) === true);
}
