import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReplayManifest, parseReplayManifestText, validateReplayCorpus, validateReplayScenarios } from "../support/replay/server.js";
import { createReplayScenarios } from "../sdk/replay_scenarios.js";

const corpusDirectory = path.resolve("tests/sdk/corpus");
const corpusTreeGolden = "cebf3e4671156e8c48a7135bdc9c648975d5c27b";
const manifestBlobGolden = "693c514fece630719c7bdea5fa1060b25d59ec89";
const aggregateGolden = "469a2f00177ee5784c5171ab581c291f539aeeef3900ab23625ba2d5758418fa";

function gitObjectHash(type: "blob" | "tree", bytes: Buffer): Buffer {
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest();
}

async function gitTreeHash(directory: string): Promise<Buffer> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(`${left.name}${left.isDirectory() ? "/" : ""}`)
    .compare(Buffer.from(`${right.name}${right.isDirectory() ? "/" : ""}`)));
  const encoded: Buffer[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory() && !entry.isFile()) throw new Error("unsupported corpus entry");
    const objectId = entry.isDirectory()
      ? await gitTreeHash(entryPath)
      : gitObjectHash("blob", await readFile(entryPath));
    encoded.push(Buffer.from(`${entry.isDirectory() ? "40000" : "100644"} ${entry.name}\0`), objectId);
  }
  return gitObjectHash("tree", Buffer.concat(encoded));
}

describe("shared SDK replay corpus", () => {
  it("keeps the entire recorded corpus and manifest byte-identical to the base tree", async () => {
    const manifestBytes = await readFile(path.join(corpusDirectory, "manifest.json"));
    expect(gitObjectHash("blob", manifestBytes).toString("hex")).toBe(manifestBlobGolden);
    expect((await gitTreeHash(corpusDirectory)).toString("hex")).toBe(corpusTreeGolden);
  });

  it("validates all immutable bytes and assigns every exchange to one registered scenario", async () => {
    const manifest = parseReplayManifestText(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8"));
    await expect(validateReplayCorpus(corpusDirectory, manifest.exchanges)).resolves.toBeUndefined();
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.exchanges).toHaveLength(45);
    expect(new Set(manifest.exchanges.map((exchange) => exchange.response.bodyFile)).size).toBe(45);
    const tuples = manifest.exchanges.map((exchange) => [exchange.caseId, exchange.response.bodyFile, exchange.response.bodySha256]);
    expect(createHash("sha256").update(JSON.stringify(tuples)).digest("hex")).toBe(aggregateGolden);
    expect(manifest.exchanges.filter((exchange) => exchange.selection === "explicit")).toHaveLength(15);
    expect(manifest.responseSets).toHaveLength(3);

    const catalogue = validateReplayScenarios(manifest.exchanges, await createReplayScenarios(manifest));
    expect(catalogue).toHaveLength(30);
    expect(catalogue.flatMap((scenario) => scenario.steps)).toHaveLength(45);
    expect(new Set(catalogue.flatMap((scenario) => scenario.steps.map((step) => step.caseId)))).toEqual(
      new Set(manifest.exchanges.map((exchange) => exchange.caseId)),
    );
    expect(catalogue.some((scenario) => manifest.responseSets.some((set) => set.id === scenario.scenarioId))).toBe(false);
  });

  it("strictly rejects malformed JSON, unknown fields, and invalid historical metadata", async () => {
    const source = JSON.parse(await readFile(path.join(corpusDirectory, "manifest.json"), "utf8"));
    expect(() => parseReplayManifestText("{private malformed")).toThrow(/^invalid replay configuration$/u);
    for (const mutate of [
      (value: typeof source) => { value.schemaVersion = 3; },
      (value: typeof source) => { value.private = true; },
      (value: typeof source) => { value.exchanges.push(value.exchanges[0]); },
      (value: typeof source) => { value.exchanges[0].session = { marker: "private" }; },
      (value: typeof source) => { value.exchanges[30].selection = "legacy"; },
      (value: typeof source) => { value.exchanges[0].request.canonicalBodySha256 = "a".repeat(64); },
      (value: typeof source) => { value.exchanges[0].response.private = true; },
      (value: typeof source) => { value.exchanges[0].response.headers.authorization = "private-header"; },
      (value: typeof source) => { value.exchanges[0].response.headers["x-test"] = "private\u0000header"; },
      (value: typeof source) => { value.responseSets[0].private = true; },
      (value: typeof source) => { value.responseSets[0].exchangeIds = []; },
      (value: typeof source) => { value.responseSets[0].exchangeIds[0] = "private-missing-reference"; },
      (value: typeof source) => { value.responseSets[0].exchangeIds[1] = value.responseSets[0].exchangeIds[0]; },
      (value: typeof source) => { value.responseSets[0].targetProtocol = "messages"; },
      (value: typeof source) => { value.responseSets.push(value.responseSets[0]); },
      (value: typeof source) => { value.responseSets.pop(); },
    ]) {
      const invalid = structuredClone(source);
      mutate(invalid);
      expect(() => parseReplayManifest(invalid)).toThrow(/^invalid replay configuration$/u);
    }
  });
});
