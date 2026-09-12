import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReplayManifest, parseReplayManifestText, validateReplayCorpus, validateReplayScenarios } from "../../src/replay/server.js";
import { createReplayScenarios } from "../sdk/replay_scenarios.js";

const corpusDirectory = path.resolve("tests/sdk/corpus");
const aggregateGolden = "dbb0561d508ce51dc4fefcda26cc56d65cfc2c0e6b50534dc43519a34d664c19";

describe("shared SDK replay corpus", () => {
  it("validates all immutable bytes and assigns every exchange to one registered scenario", async () => {
    const manifest = parseReplayManifestText(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8"));
    await expect(validateReplayCorpus(corpusDirectory, manifest.exchanges)).resolves.toBeUndefined();
    expect(manifest.exchanges).toHaveLength(45);
    expect(new Set(manifest.exchanges.map((exchange) => exchange.response.bodyFile)).size).toBe(45);
    const tuples = manifest.exchanges.map((exchange) => [exchange.caseId, exchange.response.bodyFile, exchange.response.bodySha256]);
    expect(createHash("sha256").update(JSON.stringify(tuples)).digest("hex")).toBe(aggregateGolden);
    const catalogue = validateReplayScenarios(manifest.exchanges, await createReplayScenarios(manifest));
    expect(catalogue).toHaveLength(30);
    expect(catalogue.flatMap((scenario) => scenario.steps)).toHaveLength(45);
    expect(new Set(catalogue.flatMap((scenario) => scenario.steps.map((step) => step.caseId))).size).toBe(45);
    expect(JSON.parse(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8"))).not.toHaveProperty("responseSets");
    for (const exchange of manifest.exchanges) {
      expect(exchange).not.toHaveProperty("selection");
      expect(exchange.request).not.toHaveProperty("canonicalBodySha256");
      expect(exchange).not.toHaveProperty("session");
    }
  });

  it("strictly rejects malformed JSON, unknown and retired manifest fields", async () => {
    const source = JSON.parse(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8"));
    expect(() => parseReplayManifestText("{private malformed")).toThrow(/^invalid replay configuration$/u);
    for (const mutate of [
      (value: typeof source) => { value.schemaVersion = 2; },
      (value: typeof source) => { value.exchanges.push(value.exchanges[0]); },
      (value: typeof source) => { value.responseSets = []; },
      (value: typeof source) => { value.exchanges[0].selection = "explicit"; },
      (value: typeof source) => { value.exchanges[0].session = { marker: "private" }; },
      (value: typeof source) => { value.exchanges[0].request.canonicalBodySha256 = "a".repeat(64); },
      (value: typeof source) => { value.exchanges[0].response.private = true; },
      (value: typeof source) => { value.exchanges[0].response.headers.authorization = "private-header"; },
      (value: typeof source) => { value.exchanges[0].response.headers["x-test"] = "private\u0000header"; },
    ]) {
      const invalid = structuredClone(source);
      mutate(invalid);
      expect(() => parseReplayManifest(invalid)).toThrow(/^invalid replay configuration$/u);
    }
  });
});
