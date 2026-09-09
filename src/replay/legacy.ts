import type { ReplayExchangeRecord } from "./types.js";

/** Compatibility for existing independent SDK cases only, never selected scenarios. */
export function independentRequestMatches(exchange: ReplayExchangeRecord, rawText: string): boolean {
  const isMixed = exchange.caseId.includes(".mixed-image-tool.");
  const isParallel = exchange.caseId.includes(".parallel-tools.");
  const isPlainImage = exchange.caseId.includes(".image.");
  const isPlainText = exchange.caseId.includes(".plain-text.");
  const isToolResult = exchange.caseId.includes(".tool-result.");
  const isToolCall = exchange.caseId.includes(".tool-call.");
  const isReasoning = exchange.caseId.includes(".reasoning-effort.");

  const hasVision = rawText.includes("image");
  const hasToolResult = rawText.includes("function_call_output") || rawText.includes("tool_result") || rawText.includes("\"role\":\"tool\"");
  const hasTools = /"tools"\s*:/u.test(rawText);
  const hasParallel = rawText.includes("Paris") || rawText.includes("twice") || rawText.includes("simultaneously");
  const hasReasoning = rawText.includes("quantum") || rawText.includes("reasoning_effort") || rawText.includes("output_config");
  const isLongText = rawText.includes("production HTTP gateway should enforce separate connection");

  if (isPlainText) return isLongText && !hasVision && !hasTools && !hasToolResult;
  if (isReasoning) return hasReasoning && !isLongText;
  if (isMixed) return hasVision && hasTools && !hasToolResult;
  if (isParallel) return hasParallel && hasTools && !hasToolResult;
  if (isPlainImage) return hasVision && !hasTools;
  if (isToolResult) return hasToolResult;
  if (isToolCall) return hasTools && !hasToolResult && !hasVision && !hasParallel;
  return !hasVision && !hasTools && !hasToolResult && !hasReasoning && !isLongText;
}

