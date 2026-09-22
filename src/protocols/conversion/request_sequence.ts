import {
  ConversionContractError,
  type SemanticRequest,
} from "./types.js";

export type RequestSequenceViolation =
  | "reasoning_round_order"
  | "message_round_order"
  | "tool_call_round_order"
  | "duplicate_call_id"
  | "tool_result_binding"
  | "incomplete_round";

export class RequestSequenceTracker<TBinding> {
  private readonly calls = new Set<string>();
  private readonly openCalls = new Map<string, TBinding>();
  private resultsStarted = false;

  constructor(private readonly reject: (violation: RequestSequenceViolation) => never) {}

  observeMessage(role: "system" | "developer" | "user" | "assistant"): void {
    if (this.openCalls.size > 0 && (role !== "assistant" || this.resultsStarted)) {
      this.reject("message_round_order");
    }
  }

  observeReasoning(): void {
    if (this.resultsStarted) {
      this.reject("reasoning_round_order");
    }
  }

  observeToolCall(callId: string, binding: TBinding): void {
    if (this.openCalls.size > 0 && this.resultsStarted) {
      this.reject("tool_call_round_order");
    }
    if (this.calls.has(callId)) {
      this.reject("duplicate_call_id");
    }
    this.calls.add(callId);
    this.openCalls.set(callId, binding);
  }

  observeToolResult<TResult>(callId: string, validateBinding: (binding: TBinding) => TResult): TResult {
    if (!this.calls.has(callId) || !this.openCalls.has(callId)) {
      this.reject("tool_result_binding");
    }
    const result = validateBinding(this.openCalls.get(callId) as TBinding);
    this.openCalls.delete(callId);
    this.resultsStarted = this.openCalls.size > 0;
    return result;
  }

  finish(): void {
    if (this.openCalls.size > 0) {
      this.reject("incomplete_round");
    }
  }
}

export function validateSemanticBindings(request: Readonly<SemanticRequest>): void {
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (names.has(tool.name)) {
      throw new ConversionContractError("invalid_request", "REQ-TOOL-DUPLICATE-NAME");
    }
    names.add(tool.name);
  }
  if (request.toolChoice?.kind === "tool" && !names.has(request.toolChoice.name)) {
    throw new ConversionContractError("invalid_request", "REQ-TOOL-CHOICE-MISSING");
  }
  if ((request.toolChoice?.kind === "required" || request.toolChoice?.kind === "tool") && names.size === 0) {
    throw new ConversionContractError("invalid_request", "REQ-TOOL-CHOICE-EMPTY");
  }
  if (request.parallelToolCalls !== undefined && names.size === 0) {
    throw new ConversionContractError("invalid_request", "REQ-TOOL-PARALLEL-EMPTY");
  }

  const ruleIds: Readonly<Record<RequestSequenceViolation, string>> = {
    reasoning_round_order: "REQ-REASONING-ROUND-ORDER",
    message_round_order: "REQ-TOOL-ROUND-ORDER",
    tool_call_round_order: "REQ-TOOL-ROUND-ORDER",
    duplicate_call_id: "REQ-TOOL-DUPLICATE-CALL-ID",
    tool_result_binding: "REQ-TOOL-RESULT-BINDING",
    incomplete_round: "REQ-TOOL-ROUND-INCOMPLETE",
  };
  const sequence = new RequestSequenceTracker<true>((violation) => {
    throw new ConversionContractError("invalid_request", ruleIds[violation]);
  });
  for (const item of request.items) {
    if (item.type === "reasoning") {
      sequence.observeReasoning();
    } else if (item.type === "message") {
      sequence.observeMessage(item.role);
    } else if (item.type === "tool_call") {
      sequence.observeToolCall(item.callId, true);
    } else {
      sequence.observeToolResult(item.callId, () => undefined);
    }
  }
  sequence.finish();
}
