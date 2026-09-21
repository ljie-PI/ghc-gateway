import { describe, expect, it } from "vitest";
import { parseWireJson, isWireJsonObject } from "../../src/serialization/wire_json.js";
import {
  carrierBinding,
  claimReasoningCarriers,
  resolveReasoningCarriers,
} from "../../src/protocols/conversion/reasoning_carrier_preflight.js";
import type {
  ReasoningCarrierBinding,
  ReasoningCarrierRecord,
  ReasoningCarrierStore,
} from "../../src/protocols/conversion/reasoning_carriers.js";
import { ReasoningCarrierError } from "../../src/protocols/conversion/reasoning_carriers.js";

const token = "ghcg-rsn-v1:responses_item:chat:01234567-89ab-4def-8123-456789abcdef";
const binding: ReasoningCarrierBinding = {
  accountId: "github.com/1",
  modelId: "gpt",
  upstreamOrigin: "https://api.example",
  sourceProtocol: "responses",
  wireProtocol: "chat",
  conversionVersion: "chat-responses-v1",
};

describe("reasoning carrier preflight", () => {
  it("claims only documented Chat carrier slots and resolves the selected binding", () => {
    const record = carrierRecord(token);
    const store = carrierStore(binding, record);
    const body = object({
      messages: [{
        role: "assistant",
        content: token,
        reasoning_items: [{ type: "reasoning", encrypted_content: token }],
      }],
    });
    const claim = claimReasoningCarriers(body, "chat", binding.accountId, store);
    expect(claim).toEqual({ binding, tokens: [token] });
    expect(resolveReasoningCarriers(claim, binding, store)).toEqual(new Map([[token, record]]));
  });

  it("fails before conversion when claimed model, origin, protocol, or version differs", () => {
    const record = carrierRecord(token);
    const store = carrierStore(binding, record);
    const claim = claimReasoningCarriers(object({
      messages: [{ role: "assistant", reasoning_items: [{ type: "reasoning", encrypted_content: token }] }],
    }), "chat", binding.accountId, store);
    for (const expected of [
      { ...binding, modelId: "other" },
      { ...binding, upstreamOrigin: "https://other.example" },
      { ...binding, sourceProtocol: "messages" as const },
      { ...binding, conversionVersion: "chat-responses-v2" },
    ]) {
      expect(() => resolveReasoningCarriers(claim, expected, store)).toThrowError(/invalid_request/u);
    }
  });

  it("derives source-bound conversion versions", () => {
    expect(carrierBinding({
      accountId: "a",
      modelId: "m",
      endpoint: "https://api.example/v1",
      sourceProtocol: "messages",
      wireProtocol: "responses",
    })).toMatchObject({ upstreamOrigin: "https://api.example", conversionVersion: "responses-messages-v2" });
  });

  it("fails closed for an unknown gateway carrier version in a documented slot", () => {
    const store = {
      ...carrierStore(binding, carrierRecord(token)),
      claim: () => { throw new ReasoningCarrierError(); },
    };
    expect(() => claimReasoningCarriers(object({
      messages: [{
        role: "assistant",
        reasoning_items: [{
          type: "reasoning",
          encrypted_content: "ghcg-rsn-v2:responses_item:chat:01234567-89ab-4def-8123-456789abcdef",
        }],
      }],
    }), "chat", binding.accountId, store)).toThrowError(/invalid_request/u);
  });
});

function carrierStore(bindingValue: ReasoningCarrierBinding, record: ReasoningCarrierRecord): ReasoningCarrierStore {
  return {
    claim: () => bindingValue,
    resolve: () => record,
    create: () => record,
    promote: () => undefined,
    discard: () => undefined,
    clearAccount: () => undefined,
    clearAll: () => undefined,
    setTtlDays: () => undefined,
  };
}

function carrierRecord(value: string): ReasoningCarrierRecord {
  return {
    token: value,
    sourceKind: "responses_item",
    state: "complete",
    payload: object({ kind: "responses_item", state: { type: "reasoning", summary: [] } }),
    projection: object({ type: "reasoning", text: "" }),
    storedBytes: 1,
  };
}

function object(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const parsed = parseWireJson(bytes, { maxBytes: bytes.byteLength, maxDepth: 32 });
  if (!isWireJsonObject(parsed)) throw new Error("expected object");
  return parsed;
}
