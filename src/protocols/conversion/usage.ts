import type { SemanticUsage } from "./types.js";

export interface PartialMessagesUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

export function mergeMessagesUsage(
  current: Readonly<SemanticUsage>,
  update: Readonly<PartialMessagesUsage>,
): SemanticUsage {
  const cacheReadTokens = update.cacheReadTokens ?? current.cacheReadTokens;
  const cacheWriteTokens = update.cacheWriteTokens ?? current.cacheWriteTokens;
  const currentNoncache = Math.max(
    0,
    current.inputTokens - current.cacheReadTokens - current.cacheWriteTokens,
  );
  return {
    inputTokens: (update.inputTokens ?? currentNoncache) + cacheReadTokens + cacheWriteTokens,
    outputTokens: update.outputTokens ?? current.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: current.reasoningTokens,
  };
}
