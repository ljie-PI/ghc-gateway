export const TOOL_RESULT_ERROR_MARKER = "[ghc-gateway:tool-result-error]";

export const UNSUPPORTED_IMAGE_REPLACEMENT = "[Unsupported Image]";

export const TOOL_RESULT_MEDIA_REPLACEMENT =
  "[ghc-gateway: tool result media moved to the following user message]";

export function toolResultMediaReference(callId: string): string {
  return `[ghc-gateway: media output of tool call ${callId}]`;
}
