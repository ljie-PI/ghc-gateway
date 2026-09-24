import { describe, expect, it } from "vitest";
import {
  parseWireJson,
  serializeWireJson,
  isWireJsonArray,
  isWireJsonObject,
  type WireJson,
  type WireJsonObject,
} from "../../src/serialization/wire_json.js";
import { decodeResponsesRequest } from "../../src/protocols/openai_responses/decoder.js";

const LIMITS = { maxBytes: 4096, maxDepth: 16 } as const;

function objectFromJson(json: string): WireJsonObject {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect((value as { kind?: string }).kind).toBe("object");
  return value as WireJsonObject;
}

function numberLexeme(value: WireJson | undefined): string | undefined {
  return typeof value === "object" && value !== null && value.kind === "number"
    ? value.lexeme
    : undefined;
}

describe("Responses request decoder", () => {
  it("treats unusable routing values as absent instead of rejecting them", () => {
    for (const json of ["{}", "{\"model\":null}", "{\"model\":4}", "{\"model\":\"\",\"input\":\"hi\"}"]) {
      expect(decodeResponsesRequest(objectFromJson(json)).model).toBeUndefined();
    }
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"model\":\"other\"}")).model).toBe("gpt");
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"stream\":false,\"stream\":true}")).stream).toBe(false);
  });

  it("applies stream default without coercing preserved fields", () => {
    const decoded = decodeResponsesRequest(objectFromJson([
      "{\"metadata\":{\"temperature\":0.7},",
      "\"model\":\"gpt-4.1\",",
      "\"input\":{\"type\":\"message\",\"content\":\"hi\"},",
      "\"previous_response_id\":null,",
      "\"store\":null}",
    ].join("")));

    expect(decoded.model).toBe("gpt-4.1");
    expect(decoded.stream).toBe(false);
    expect(decoded.store).toBeUndefined();
    expect(decoded.previousResponseId).toBeUndefined();
    expect(isWireJsonObject(decoded.input)).toBe(true);
    expect(decoded.body.members.map((member) => member.key)).toEqual([
      "metadata",
      "model",
      "input",
      "previous_response_id",
      "store",
    ]);
  });

  it("reads stream and continuation controls without coercing the body", () => {
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"stream\":true}")).stream).toBe(true);
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"store\":false}")).store).toBe(false);
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"previous_response_id\":\"resp_1\"}"))
      .previousResponseId).toBe("resp_1");
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"previous_response_id\":\" resp_1 \"}"))
      .previousResponseId).toBe(" resp_1 ");
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"previous_response_id\":\"\"}"))
      .previousResponseId).toBeUndefined();
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"stream\":\"true\"}")).stream).toBe(false);
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"stream\":null}")).stream).toBe(false);
    const rawStore = decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"store\":{\"raw\":true}}"));
    expect(rawStore.store).toBeUndefined();
    expect(rawStore.body.members[1]?.key).toBe("store");
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"previous_response_id\":8}"))
      .previousResponseId).toBeUndefined();
  });

  it("forwards duplicate members, nested duplicates and number lexemes unchanged", () => {
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"metadata\":{},\"metadata\":{}}")).body.members)
      .toHaveLength(3);

    const decoded = decodeResponsesRequest(objectFromJson([
      "{\"metadata\":{\"a\":-0,\"a\":1e+6,\"nested\":[9007199254740993]},",
      "\"model\":\"gpt\",",
      "\"temperature\":0.70}",
    ].join("")));

    expect(decoded.body.members.map((member) => member.key)).toEqual([
      "metadata",
      "model",
      "temperature",
    ]);
    const firstMetadata = decoded.body.members[0]?.value as WireJsonObject;
    const nested = firstMetadata.members[2]?.value;
    expect(numberLexeme(firstMetadata.members[0]?.value)).toBe("-0");
    expect(numberLexeme(firstMetadata.members[1]?.value)).toBe("1e+6");
    expect(isWireJsonArray(nested)).toBe(true);
    if (isWireJsonArray(nested)) {
      expect(numberLexeme(nested.items[0])).toBe("9007199254740993");
    }
    expect(numberLexeme(decoded.body.members[2]?.value)).toBe("0.70");
    expect(new TextDecoder().decode(serializeWireJson(decoded.body))).toBe([
      "{\"metadata\":{\"a\":-0,\"a\":1e+6,\"nested\":[9007199254740993]},",
      "\"model\":\"gpt\",",
      "\"temperature\":0.70}",
    ].join(""));
  });
});
