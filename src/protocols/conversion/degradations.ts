export const CONVERSION_DEGRADATION_RULES = [
  "cache.control_omitted",
  "continuation.history_omitted",
  "reasoning.budget_coarsened",
  "reasoning.presentation_omitted",
  "reasoning.state_omitted",
  "sampling.top_k_omitted",
  "messages.extensions_omitted",
  "chat.extensions_omitted",
  "responses.extensions_omitted",
  "messages.leading_user_synthesized",
  "request.option_omitted",
  "tools.history_omitted",
  "tools.parallel_control_omitted",
] as const;

export type ConversionDegradationRule = typeof CONVERSION_DEGRADATION_RULES[number];

export interface ConversionDegradationRecorder {
  add(rule: ConversionDegradationRule): unknown;
}

export class ConversionDegradationCollector implements ConversionDegradationRecorder {
  private readonly rules = new Set<ConversionDegradationRule>();

  constructor(initial: Iterable<ConversionDegradationRule> = []) {
    for (const rule of initial) this.rules.add(rule);
  }

  add(rule: ConversionDegradationRule): void {
    this.rules.add(rule);
  }

  values(): readonly ConversionDegradationRule[] {
    return CONVERSION_DEGRADATION_RULES.filter((rule) => this.rules.has(rule));
  }
}

export function canonicalizeConversionDegradations(
  rules: Iterable<ConversionDegradationRule>,
): readonly ConversionDegradationRule[] {
  return new ConversionDegradationCollector(rules).values();
}
