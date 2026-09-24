import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeWireJson } from "../../src/serialization/canonical_json.js";
import {
  DEFAULT_WIRE_JSON_MAX_BYTES,
  WireJsonError,
  duplicateMemberNames,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonErrorCode,
  type WireJsonObject,
  type WireJsonParseLimits,
} from "../../src/serialization/wire_json.js";
import {
  verifyFixtureManifests,
  type FixtureManifestEntry,
} from "../../scripts/tooling/fixtures.js";

const FIXTURE_ROOT = path.resolve("tests/fixtures/wire-json");
const DEFAULT_LIMITS: WireJsonParseLimits = { maxBytes: 1024, maxDepth: 8 };

interface ErrorExpectation {
  readonly code: WireJsonErrorCode;
  readonly maxBytes: number;
  readonly maxDepth: number;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decodeAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

async function loadFixtureBytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURE_ROOT, relativePath)));
}

function parseErrorExpectation(bytes: Uint8Array): ErrorExpectation {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as ErrorExpectation;
  return parsed;
}

function expectWireJsonError(run: () => unknown, code: WireJsonErrorCode): WireJsonError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WireJsonError);
    const typed = error as WireJsonError;
    expect(typed.code).toBe(code);
    expect(typed.cause === undefined || typed.cause !== null).toBe(true);
    return typed;
  }
  throw new Error(`expected WireJsonError ${code}`);
}

function asObject(value: WireJson): WireJsonObject {
  expect(isWireJsonObject(value)).toBe(true);
  return value as WireJsonObject;
}

describe("WireJson", () => {
  it("exports the 32 MiB default byte limit", () => {
    expect(DEFAULT_WIRE_JSON_MAX_BYTES).toBe(33_554_432);
  });

  it("rejects oversized input before inspecting bytes", () => {
    let inspected = false;
    const bytes = new Proxy(new Uint8Array([0x7b, 0x7d]), {
      get(target, property, receiver) {
        if (property === "byteLength") {
          return 33_554_433;
        }
        inspected = true;
        return Reflect.get(target, property, receiver);
      },
    });

    expectWireJsonError(
      () => parseWireJson(bytes, { maxBytes: DEFAULT_WIRE_JSON_MAX_BYTES, maxDepth: 8 }),
      "byte_limit",
    );
    expect(inspected).toBe(false);
  });

  it("preserves number lexemes without JavaScript number conversion", () => {
    const value = asObject(parseWireJson(encodeUtf8("{\"n\":-0,\"x\":9007199254740993}"), DEFAULT_LIMITS));
    const n = memberValues(value, "n")[0];
    const x = memberValues(value, "x")[0];
    expect(isWireJsonNumber(n)).toBe(true);
    expect(isWireJsonNumber(x)).toBe(true);
    if (isWireJsonNumber(n) && isWireJsonNumber(x)) {
      expect(n.lexeme).toBe("-0");
      expect(x.lexeme).toBe("9007199254740993");
    }
  });

  it("keeps duplicate members available to protocol decoders", () => {
    const value = asObject(parseWireJson(encodeUtf8("{\"a\":1,\"a\":2}"), DEFAULT_LIMITS));
    expect(duplicateMemberNames(value)).toEqual(["a"]);
    const values = memberValues(value, "a");
    const first = values[0];
    const second = values[1];
    expect(values).toHaveLength(2);
    expect(isWireJsonNumber(first) && first.lexeme).toBe("1");
    expect(isWireJsonNumber(second) && second.lexeme).toBe("2");
  });

  it("round-trips compact bytes and leaves no trailing LF or BOM", () => {
    const input = encodeUtf8("{\"a\":[null,false,0,\"\"]}");
    const parsed = parseWireJson(input, DEFAULT_LIMITS);
    const serialized = serializeWireJson(parsed);
    expect(serialized).toEqual(input);
    expect(serialized[0]).not.toBe(0xef);
    expect(serialized[serialized.length - 1]).not.toBe(0x0a);
    expect(parseWireJson(serialized, DEFAULT_LIMITS)).toEqual(parsed);
  });

  it("fails malformed JSON, invalid UTF-8, and depth limits with typed errors", () => {
    expectWireJsonError(() => parseWireJson(encodeUtf8(""), DEFAULT_LIMITS), "malformed_json");
    expectWireJsonError(() => parseWireJson(encodeUtf8("truee"), DEFAULT_LIMITS), "malformed_json");
    expectWireJsonError(() => parseWireJson(new Uint8Array([0xff]), DEFAULT_LIMITS), "invalid_utf8");
    expectWireJsonError(
      () => parseWireJson(encodeUtf8("[[[]]]"), { maxBytes: 16, maxDepth: 2 }),
      "depth_limit",
    );
  });
});

describe("wire-json fixtures", () => {
  it("matches every golden encoder case", async () => {
    const entries = (await verifyFixtureManifests(FIXTURE_ROOT)) as readonly FixtureManifestEntry[];
    expect(entries.map((entry) => entry.caseId)).toEqual([
      "wire-json.scalar.null-false-zero-empty",
      "wire-json.number.negative-zero",
      "wire-json.number.exponent",
      "wire-json.number.large-lexeme",
      "wire-json.object.member-order",
      "wire-json.object.integer-like-keys",
      "wire-json.object.duplicate-keys",
      "wire-json.unicode.escaped-equivalent-keys",
      "wire-json.unicode.surrogates",
      "wire-json.canonicalize.code-point-sort",
      "wire-json.compact.pretty-input",
      "wire-json.invalid.malformed",
      "wire-json.invalid.utf8",
      "wire-json.limits.depth",
      "wire-json.limits.bytes",
    ]);

    for (const entry of entries) {
      const input = await loadFixtureBytes(entry.input);
      const expected = await loadFixtureBytes(entry.expected);

      if (entry.encoder === "error") {
        const spec = parseErrorExpectation(expected);
        expectWireJsonError(
          () => parseWireJson(input, { maxBytes: spec.maxBytes, maxDepth: spec.maxDepth }),
          spec.code,
        );
        continue;
      }

      const parsed = parseWireJson(input, { maxBytes: Math.max(input.byteLength, 1024), maxDepth: 8 });
      const actual = entry.encoder === "canonical"
        ? canonicalizeWireJson(parsed)
        : serializeWireJson(parsed);
      expect(decodeAscii(actual), entry.caseId).toBe(decodeAscii(expected));
      expect(actual, entry.caseId).toEqual(expected);
    }
  });
});
