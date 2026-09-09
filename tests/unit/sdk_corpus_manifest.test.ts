import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReplayManifest, validateReplayCorpus } from "../../src/replay/server.js";

const corpusDirectory = path.resolve("tests/sdk/corpus");

describe("shared SDK replay corpus", () => {
  it("validates byte integrity and stores three upstream five-step response/expectation sets only once", async () => {
    const manifest = parseReplayManifest(JSON.parse(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8")));
    await expect(validateReplayCorpus(corpusDirectory, manifest.exchanges)).resolves.toBeUndefined();
    expect(manifest.exchanges).toHaveLength(45);
    expect(new Set(manifest.exchanges.map((exchange) => exchange.response.bodyFile)).size).toBe(45);
    expect(manifest.responseSets.map((set) => set.targetProtocol).sort()).toEqual(["chat", "messages", "responses"]);
    const exchanges = new Map(manifest.exchanges.map((exchange) => [exchange.caseId, exchange]));
    for (const set of manifest.responseSets) {
      expect(set.id).toBe(`cosplay-shoot-planning.${set.targetProtocol}`);
      expect(set.exchangeIds).toEqual([1, 2, 3, 4, 5].map((step) => `replay.${set.targetProtocol}.coherent-session.turn-${step}`));
      for (const [index, id] of set.exchangeIds.entries()) {
        const exchange = exchanges.get(id)!;
        expect(exchange.targetProtocol).toBe(set.targetProtocol);
        expect(exchange.selection).toBe("explicit");
        expect(exchange.request).not.toHaveProperty("canonicalBodySha256");
        expect(exchange).not.toHaveProperty("session");
        expect(exchange).not.toHaveProperty("origin");
        if (index === 1) {
          expect(exchange.downstreamExpectation?.expectedToolCalls).toHaveLength(2);
          expect(exchange.downstreamExpectation?.toolCallsCount).toBe(2);
        } else {
          expect(exchange.downstreamExpectation?.textSha256).toMatch(/^[a-f0-9]{64}$/u);
        }
      }
    }
    // Historical timestamps/bytes are not evidence of capture authenticity.
    expect(manifest.exchanges.filter((exchange) => exchange.selection === undefined)).toHaveLength(30);
  });

  it("rejects incomplete, duplicate and unresolved shared-set ownership without contentful diagnostics", async () => {
    const source = JSON.parse(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8"));
    for (const mutate of [
      (value: typeof source) => { value.schemaVersion = 1; },
      (value: typeof source) => { value.exchanges.push(value.exchanges[0]); },
      (value: typeof source) => { value.responseSets[0].exchangeIds = []; },
      (value: typeof source) => { value.responseSets[0].exchangeIds[0] = "private-missing-reference"; },
      (value: typeof source) => { value.responseSets[0].exchangeIds[1] = value.responseSets[0].exchangeIds[0]; },
      (value: typeof source) => { value.responseSets.pop(); },
      (value: typeof source) => { value.responseSets[0].targetProtocol = "messages"; },
      (value: typeof source) => { value.responseSets.push(value.responseSets[0]); },
      (value: typeof source) => { value.exchanges[0].request.canonicalBodySha256 = "a".repeat(64); },
      (value: typeof source) => { value.exchanges[0].response.headers.authorization = "private-header"; },
      (value: typeof source) => { value.exchanges[0].response.headers["x-test"] = "private\u0000header"; },
    ]) {
      const invalid = structuredClone(source);
      mutate(invalid);
      expect(() => parseReplayManifest(invalid)).toThrow(/^invalid replay configuration$/u);
    }
  });
});
