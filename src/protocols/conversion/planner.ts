import { ModelCapabilityUnavailableError } from "../../copilot/model_capabilities.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import type { WireJsonObject } from "../../serialization/wire_json.js";
import { PROTOCOL_REQUEST_CODECS } from "./request_codecs.js";
import {
  ConversionContractError,
  type ConversionPlanningInput,
  type EncodedConversionRequest,
  type InferenceProtocol,
  type ProtocolExecutionPlan,
  type SemanticRequest,
} from "./types.js";

const PRIORITIES: Readonly<Record<InferenceProtocol, readonly InferenceProtocol[]>> = {
  chat: ["responses", "messages"],
  messages: ["chat", "responses"],
  responses: ["chat", "messages"],
};

export function planProtocolExecution(input: Readonly<ConversionPlanningInput>): ProtocolExecutionPlan {
  const protocols = input.capability.protocols.value;
  if (protocols === null) {
    throw new GatewayFailureError({
      kind: "unsupported_semantics",
      cause: new ModelCapabilityUnavailableError(),
    });
  }

  if (input.forcedTarget === undefined && protocols.includes(input.source)) {
    return Object.freeze({
      kind: "native",
      source: input.source,
      target: input.source,
      stream: input.stream,
    });
  }
  if (input.forcedTarget === input.source && protocols.includes(input.source)) {
    return Object.freeze({
      kind: "native",
      source: input.source,
      target: input.source,
      stream: input.stream,
    });
  }

  const candidates = input.forcedTarget === undefined
    ? PRIORITIES[input.source].filter((target) => protocols.includes(target))
    : protocols.includes(input.forcedTarget)
      ? [input.forcedTarget]
      : [];
  if (candidates.length === 0) {
    throw unsupportedFailure();
  }

  let decoded: SemanticRequest;
  try {
    decoded = PROTOCOL_REQUEST_CODECS[input.source].decode(input.body);
    validateSemanticBindings(decoded);
  } catch (error: unknown) {
    throw contractFailure(error);
  }

  let lastUnsupported: ConversionContractError | undefined;
  for (const target of candidates) {
    if (target === input.source) {
      return Object.freeze({
        kind: "native",
        source: input.source,
        target,
        stream: input.stream,
      });
    }
    try {
      const request = PROTOCOL_REQUEST_CODECS[target].encode(decoded, {
        resolvedModel: input.resolvedModel,
        capability: input.capability,
      });
      return Object.freeze({
        kind: "converted",
        source: input.source,
        target,
        stream: input.stream,
        requestModel: input.resolvedModel,
        request,
      });
    } catch (error: unknown) {
      if (error instanceof ConversionContractError && error.kind === "unsupported_semantics") {
        lastUnsupported = error;
        continue;
      }
      throw contractFailure(error);
    }
  }
  throw new GatewayFailureError({
    kind: "unsupported_semantics",
    source: "converter",
    phase: "convert",
    cause: lastUnsupported,
  });
}

export function prepareConvertedRequest(
  source: InferenceProtocol,
  target: InferenceProtocol,
  body: WireJsonObject,
  resolvedModel: string,
  capability: ConversionPlanningInput["capability"],
): EncodedConversionRequest {
  try {
    const decoded = PROTOCOL_REQUEST_CODECS[source].decode(body);
    validateSemanticBindings(decoded);
    return PROTOCOL_REQUEST_CODECS[target].encode(decoded, { resolvedModel, capability });
  } catch (error: unknown) {
    throw contractFailure(error);
  }
}

function validateSemanticBindings(request: Readonly<SemanticRequest>): void {
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

  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of request.items) {
    if (item.type === "tool_call") {
      if (calls.has(item.callId)) {
        throw new ConversionContractError("invalid_request", "REQ-TOOL-DUPLICATE-CALL-ID");
      }
      calls.add(item.callId);
      continue;
    }
    if (item.type === "tool_result") {
      if (!calls.has(item.callId) || results.has(item.callId)) {
        throw new ConversionContractError("invalid_request", "REQ-TOOL-RESULT-BINDING");
      }
      results.add(item.callId);
    }
  }
}

function contractFailure(error: unknown): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (error instanceof ConversionContractError) {
    return new GatewayFailureError({
      kind: error.kind,
      source: "converter",
      phase: "convert",
      cause: error,
    });
  }
  return new GatewayFailureError({
    kind: "internal",
    source: "converter",
    phase: "convert",
    cause: error,
  });
}

function unsupportedFailure(): GatewayFailureError {
  return new GatewayFailureError({
    kind: "unsupported_semantics",
    source: "converter",
    phase: "convert",
  });
}
