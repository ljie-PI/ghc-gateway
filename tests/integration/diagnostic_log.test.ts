import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlLogger } from "../../src/daemon/logger.js";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ghcg-diagnostics-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("protected diagnostic file namespace", () => {
  it("isolates gateway and diagnostic records and pruning", async () => {
    const root = await temporaryDirectory();
    const now = 1_700_000_000_000;
    const gateway = new JsonlLogger(root, () => now);
    const diagnostics = new JsonlLogger(root, () => now, { channel: "diagnostics" });
    expect(() => diagnostics.write({ prompt: "PRIVATE" })).toThrow("typed writer");
    gateway.write({ category: "gateway_started" });
    diagnostics.writeDiagnostic({ schemaVersion: 1, ts: now, event: "diagnostics_started" });
    expect(readFileSync(path.join(root, "gateway.jsonl"), "utf8")).not.toContain("diagnostics_started");
    expect(readFileSync(path.join(root, "diagnostics.jsonl"), "utf8")).not.toContain("gateway_started");
    const oldGateway = path.join(root, "gateway.1.0.jsonl");
    const oldDiagnostics = path.join(root, "diagnostics.1.0.jsonl");
    for (const name of [oldGateway, oldDiagnostics]) {
      writeFileSync(name, "old\n", { mode: 0o600 });
      const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
      utimesSync(name, old, old);
    }
    diagnostics.writeDiagnostic({ schemaVersion: 1, ts: now, event: "diagnostics_started" });
    expect(readdirSync(root)).toContain("gateway.1.0.jsonl");
    expect(readdirSync(root)).not.toContain("diagnostics.1.0.jsonl");
  });

  it("recovers diagnostic pruning without touching gateway transaction names", async () => {
    const root = await temporaryDirectory();
    const now = 1_700_000_000_000;
    const old = path.join(root, "diagnostics.1.0.jsonl");
    writeFileSync(old, "old\n", { mode: 0o600 });
    const date = new Date(now - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, date, date);
    expect(() => new JsonlLogger(root, () => now, {
      channel: "diagnostics", onAfterPruneRename: () => { throw new Error("synthetic crash"); },
    })).toThrow("synthetic crash");
    expect(readdirSync(root)).toContain(".diagnostics-prune-state.json");
    new JsonlLogger(root, () => now);
    expect(readdirSync(root)).toContain(".diagnostics-prune-state.json");
    new JsonlLogger(root, () => now, { channel: "diagnostics" });
    expect(readdirSync(root)).toEqual([]);
  });
});
