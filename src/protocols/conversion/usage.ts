import type { SemanticUsage } from "./types.js";

// Retain raw snapshots: outputTokens alone cannot distinguish a nested subset
// from a separately billed Chat reasoning counter on a later partial update.
export interface ChatUsageCounters {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly detailedReasoningTokens?: number | undefined;
  readonly separateReasoningTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

export function mergeChatUsageCounters(
  current: Readonly<ChatUsageCounters>,
  update: Readonly<ChatUsageCounters>,
): ChatUsageCounters {
  return {
    promptTokens: update.promptTokens ?? current.promptTokens,
    completionTokens: update.completionTokens ?? current.completionTokens,
    detailedReasoningTokens: update.detailedReasoningTokens ?? current.detailedReasoningTokens,
    separateReasoningTokens: update.separateReasoningTokens ?? current.separateReasoningTokens,
    cacheReadTokens: update.cacheReadTokens ?? current.cacheReadTokens,
    cacheWriteTokens: update.cacheWriteTokens ?? current.cacheWriteTokens,
  };
}

export function chatUsageFromCounters(counters: Readonly<ChatUsageCounters>): SemanticUsage {
  const separateReasoning = counters.detailedReasoningTokens === undefined
    ? counters.separateReasoningTokens ?? 0
    : 0;
  return {
    inputTokens: counters.promptTokens ?? 0,
    outputTokens: (counters.completionTokens ?? 0) + separateReasoning,
    cacheReadTokens: counters.cacheReadTokens ?? 0,
    cacheWriteTokens: counters.cacheWriteTokens ?? 0,
    reasoningTokens: counters.detailedReasoningTokens ?? separateReasoning,
  };
}

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
