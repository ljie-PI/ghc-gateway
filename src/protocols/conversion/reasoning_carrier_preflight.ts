import { GatewayFailureError, invalidRequestFailure } from "../../gateway/failures.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import {
  RESPONSES_CHAT_CONVERSION_VERSION,
  RESPONSES_MESSAGES_CONVERSION_VERSION,
} from "../openai_responses/history.js";
import {
  isReasoningCarrier,
  ReasoningCarrierError,
  type ReasoningCarrierBinding,
  type ReasoningCarrierRecord,
  type ReasoningCarrierStore,
} from "./reasoning_carriers.js";
import type { InferenceProtocol } from "./types.js";

export interface ReasoningCarrierClaim {
  readonly binding: ReasoningCarrierBinding;
  readonly tokens: readonly string[];
}

export function claimReasoningCarriers(
  body: WireJsonObject,
  wireProtocol: InferenceProtocol,
  accountId: string,
  store: ReasoningCarrierStore,
): ReasoningCarrierClaim | undefined {
  try {
    const tokens = [...new Set(reasoningCarrierTokens(body, wireProtocol))];
    if (tokens.length === 0) return undefined;
    const binding = store.claim(tokens[0] as string, accountId, wireProtocol);
    for (const token of tokens.slice(1)) {
      if (!sameBinding(binding, store.claim(token, accountId, wireProtocol))) unavailable();
    }
    return { binding, tokens };
  } catch (error: unknown) {
    if (error instanceof ReasoningCarrierError) unavailable();
    throw error;
  }
}

/** A carrier claim pins the model it was issued for; a request naming another model is ambiguous. */
export function assertCarrierModel(
  requestedModel: string | undefined,
  claim: Readonly<ReasoningCarrierClaim> | undefined,
): void {
  if (requestedModel !== undefined && claim !== undefined && requestedModel !== claim.binding.modelId) {
    throw reasoningCarrierFailure("REQ-CARRIER-MODEL");
  }
}

export function reasoningCarrierFailure(ruleId: "REQ-CARRIER-UNAVAILABLE" | "REQ-CARRIER-MODEL"): GatewayFailureError {
  return invalidRequestFailure(ruleId, { source: "converter", phase: "convert" });
}

export function resolveReasoningCarriers(
  claim: Readonly<ReasoningCarrierClaim> | undefined,
  expected: Readonly<ReasoningCarrierBinding>,
  store: ReasoningCarrierStore,
): ReadonlyMap<string, ReasoningCarrierRecord> | undefined {
  if (claim === undefined) return undefined;
  try {
    if (!sameBinding(claim.binding, expected)) unavailable();
    return new Map(claim.tokens.map((token) => [token, store.resolve(token, expected)]));
  } catch (error: unknown) {
    if (error instanceof ReasoningCarrierError) unavailable();
    throw error;
  }
}

export function carrierBinding(input: Readonly<{
  accountId: string;
  modelId: string;
  endpoint: string;
  sourceProtocol: InferenceProtocol;
  wireProtocol: InferenceProtocol;
}>): ReasoningCarrierBinding {
  return {
    accountId: input.accountId,
    modelId: input.modelId,
    upstreamOrigin: upstreamOrigin(input.endpoint),
    sourceProtocol: input.sourceProtocol,
    wireProtocol: input.wireProtocol,
    conversionVersion: conversionVersion(input.wireProtocol, input.sourceProtocol),
  };
}

export function conversionVersion(
  wireProtocol: InferenceProtocol,
  sourceProtocol: InferenceProtocol,
): string {
  if (wireProtocol === "responses" && sourceProtocol === "chat") return RESPONSES_CHAT_CONVERSION_VERSION;
  if (wireProtocol === "responses" && sourceProtocol === "messages") return RESPONSES_MESSAGES_CONVERSION_VERSION;
  if (sourceProtocol === "responses" && wireProtocol === "chat") return "chat-responses-v1";
  if (sourceProtocol === "responses" && wireProtocol === "messages") return "messages-responses-v1";
  unavailable();
}

export function reasoningCarrierTokens(body: WireJsonObject, protocol: InferenceProtocol): readonly string[] {
  if (protocol === "chat") return chatCarrierTokens(body);
  if (protocol === "messages") return messagesCarrierTokens(body);
  return responsesCarrierTokens(body);
}

function chatCarrierTokens(body: WireJsonObject): string[] {
  const output: string[] = [];
  for (const message of arrayItems(one(body, "messages"))) {
    if (!isWireJsonObject(message)) continue;
    for (const item of arrayItems(one(message, "reasoning_items"))) {
      if (!isWireJsonObject(item)) continue;
      addCarrier(output, one(item, "encrypted_content"));
    }
  }
  return output;
}

function messagesCarrierTokens(body: WireJsonObject): string[] {
  const output: string[] = [];
  for (const message of arrayItems(one(body, "messages"))) {
    if (!isWireJsonObject(message)) continue;
    for (const block of arrayItems(one(message, "content"))) {
      if (!isWireJsonObject(block)) continue;
      const type = one(block, "type");
      if (type === "thinking") addCarrier(output, one(block, "signature"));
      if (type === "redacted_thinking") addCarrier(output, one(block, "data"));
    }
  }
  return output;
}

function responsesCarrierTokens(body: WireJsonObject): string[] {
  const output: string[] = [];
  const input = one(body, "input");
  const items = isWireJsonArray(input) ? input.items : input === undefined ? [] : [input];
  for (const item of items) {
    if (!isWireJsonObject(item) || one(item, "type") !== "reasoning") continue;
    addCarrier(output, one(item, "encrypted_content"));
  }
  return output;
}

function addCarrier(output: string[], value: WireJson | undefined): void {
  if (typeof value === "string" && isReasoningCarrier(value)) output.push(value);
}

function arrayItems(value: WireJson | undefined): readonly WireJson[] {
  return isWireJsonArray(value) ? value.items : [];
}

function one(object: WireJsonObject, key: string): WireJson | undefined {
  const values = memberValues(object, key);
  return values.length === 1 ? values[0] : undefined;
}

function sameBinding(left: Readonly<ReasoningCarrierBinding>, right: Readonly<ReasoningCarrierBinding>): boolean {
  return left.accountId === right.accountId
    && left.modelId === right.modelId
    && left.upstreamOrigin === right.upstreamOrigin
    && left.sourceProtocol === right.sourceProtocol
    && left.wireProtocol === right.wireProtocol
    && left.conversionVersion === right.conversionVersion;
}

function upstreamOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch (error: unknown) {
    throw new GatewayFailureError({ kind: "internal", source: "converter", phase: "convert", cause: error });
  }
}

function unavailable(): never {
  throw reasoningCarrierFailure("REQ-CARRIER-UNAVAILABLE");
}
