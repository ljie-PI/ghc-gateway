import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyFixtureManifests } from "../../scripts/tooling/fixtures.js";

const FIXTURE_ROOT = path.resolve("tests/fixtures");

describe("fixture family closure", () => {
  it("byte-verifies executable manifests without documentation metadata", async () => {
    const entries = await verifyFixtureManifests();
    const count = (family: string): number => entries.filter((entry) => entry.family === family).length;

    expect(entries).toHaveLength(53);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("source");
      expect(entry).not.toHaveProperty("owner");
    }
    expect(count("anthropic")).toBe(4);
    expect(count("responses-native")).toBe(4);
    expect(count("responses-bridge-request")).toBe(3);
    expect(count("responses-bridge-nonstream")).toBe(2);
    expect(count("responses-bridge-stream")).toBe(2);
    expect(count("responses-endpoint")).toBe(3);
    expect(count("protocol-conversion")).toBe(3);
    expect(entries.some((entry) => entry.caseId.startsWith("gateway-http-host."))).toBe(true);
    expect(entries.some((entry) => entry.caseId.startsWith("gateway-http."))).toBe(false);
  });

  it("rejects unregistered fixture families", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-fixture-family-"));
    try {
      await writeFile(path.join(root, "manifest.json"), JSON.stringify([{
        caseId: "unknown.case",
        family: "unregistered",
        input: "input.json",
        expected: "expected.json",
        encoder: "compact",
      }]));
      await expect(verifyFixtureManifests(root, false))
        .rejects.toThrow("family must name a registered fixture family");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale expected object instead of only parsing its manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-fixtures-test-"));
    await cp(FIXTURE_ROOT, root, { recursive: true });
    const expectedPath = path.join(root, "responses-native", "request", "preservation.expected.json");
    try {
      const original = await readFile(expectedPath, "utf8");
      await writeFile(expectedPath, original.replace("resolved", "stale"), "utf8");
      await expect(verifyFixtureManifests(root)).rejects.toThrow(/expected bytes are stale/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
