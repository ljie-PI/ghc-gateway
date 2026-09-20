import { mkdtemp } from "node:fs/promises";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLogger, LOG_FILE_BYTES, StderrLogger } from "../../src/daemon/logger.js";

describe("daemon JSONL logger", () => {
  it("uses the startup threshold while preserving error lifecycle records", async () => {
    const chunks: string[] = [];
    const logger = new StderrLogger({ write: (chunk) => chunks.push(chunk) }, () => 1, "warn");
    logger.write({ level: "trace", category: "trace_event" });
    logger.write({ level: "debug", category: "debug_event" });
    logger.write({ level: "info", category: "gateway_started" });
    logger.write({ level: "warn", category: "warning_event" });
    logger.write({ level: "error", category: "shutdown_timeout" });
    expect(chunks.map((chunk) => JSON.parse(chunk) as { level: string; category: string })).toEqual([
      { ts: 1, level: "warn", category: "warning_event" },
      { ts: 1, level: "error", category: "shutdown_timeout" },
    ]);
  });

  it("sanitizes records, caps line size, and rotates at 10 MiB", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-"));
    const dir = path.join(root, "logs");
    const logger = new JsonlLogger(dir, () => 1_700_000_000_000);
    logger.write({ protocol: "anthropic", token: "SECRET", prompt: "CANARY" });
    const active = path.join(dir, "gateway.jsonl");
    const first = readFileSync(active, "utf8");
    expect(first).toContain("anthropic");
    expect(first).not.toContain("SECRET");
    expect(first).not.toContain("CANARY");

    logger.write({ protocol: "n".repeat(70_000) });
    const after = readFileSync(active, "utf8");
    expect(after).toContain("log_line_truncated");

    const chunk = "x".repeat(64 * 1024 - 200);
    const writes = Math.ceil(LOG_FILE_BYTES / (64 * 1024)) + 2;
    for (let index = 0; index < writes; index += 1) {
      logger.write({ protocol: chunk });
    }
    const names = readdirSync(dir);
    expect(names.some((name) => /^gateway\.\d+\.\d+\.jsonl$/u.test(name))).toBe(true);
    expect(names.length).toBeLessThanOrEqual(5);
  });

  it.runIf(process.platform === "win32")("trusts inherited Windows log permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-windows-inherited-"));
    const dir = path.join(root, "logs");
    const active = path.join(dir, "gateway.jsonl");
    mkdirSync(dir);
    writeFileSync(active, `${JSON.stringify({ ts: 1, category: "first" })}\n`);

    const logger = new JsonlLogger(dir, () => 1_700_000_000_000);
    logger.write({ category: "second" });

    const content = readFileSync(active, "utf8");
    expect(content).toContain("first");
    expect(content).toContain("second");
  });

  it("rejects a linked log directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-link-"));
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

    expect(() => new JsonlLogger(link)).toThrow(/regular directory/u);
  });

  it("does not delete a replacement selected-path object while pruning", async () => {
    const now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-race-"));
    const dir = path.join(root, "logs");
    const rotated = path.join(dir, "gateway.1.0.jsonl");
    const displaced = path.join(dir, "displaced.jsonl");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(rotated, "original\n", { mode: 0o600 });
    utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    let replaced = false;

    new JsonlLogger(dir, () => now, {
      onBeforePrune: (file) => {
        if (file !== rotated || replaced) return;
        renameSync(file, displaced);
        writeFileSync(file, "replacement\n", { mode: 0o600 });
        replaced = true;
      },
    });

    expect(replaced).toBe(true);
    expect(readFileSync(rotated, "utf8")).toBe("replacement\n");
    expect(readFileSync(displaced, "utf8")).toBe("original\n");
  });

  it("recovers a prune that crashes after the candidate rename", async () => {
    const now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-crash-"));
    const dir = path.join(root, "logs");
    const rotated = path.join(dir, "gateway.1.0.jsonl");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(rotated, "old\n", { mode: 0o600 });
    utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));

    expect(() => new JsonlLogger(dir, () => now, {
      onAfterPruneRename: () => {
        throw new Error("simulated crash");
      },
    })).toThrow("simulated crash");
    expect(readdirSync(dir)).toContain(".gateway-prune-state.json");
    expect(readdirSync(dir)).toContain(".gateway-prune-commit.json");
    expect(readdirSync(dir).some((name) => /^\.gateway-prune-[0-9a-f-]+\.jsonl$/u.test(name))).toBe(true);

    new JsonlLogger(dir, () => now);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("discards an exact partial state temporary without scanning similar names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-partial-state-"));
    const dir = path.join(root, "logs");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(path.join(dir, ".gateway-prune-state.json.tmp"), "{\"version\":", { mode: 0o600 });
    writeFileSync(path.join(dir, ".gateway-prune-state.json.tmp.unrelated"), "unrelated\n", { mode: 0o600 });

    new JsonlLogger(dir, () => 1_700_000_000_000);

    expect(readdirSync(dir)).toEqual([".gateway-prune-state.json.tmp.unrelated"]);
  });

  it("recovers a partial commit temporary through the durable prepared record", async () => {
    const now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-partial-commit-"));
    const dir = path.join(root, "logs");
    const rotated = path.join(dir, "gateway.1.0.jsonl");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(rotated, "old\n", { mode: 0o600 });
    utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    expect(() => new JsonlLogger(dir, () => now, {
      onPruneCheckpoint: (checkpoint) => {
        if (checkpoint === "candidate-renamed") throw new Error("simulated crash");
      },
    })).toThrow("simulated crash");
    writeFileSync(path.join(dir, ".gateway-prune-commit.json.tmp"), "{\"version\":", { mode: 0o600 });

    new JsonlLogger(dir, () => now);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("recovers crashes at each durable prune publication checkpoint", async () => {
    const checkpoints = [
      "state-temporary",
      "state-published",
      "candidate-renamed",
      "commit-temporary",
      "commit-published",
      "candidate-unlinked",
    ] as const;
    for (const checkpoint of checkpoints) {
      const now = 1_700_000_000_000;
      const root = await mkdtemp(path.join(tmpdir(), `ghc-gateway-log-prune-${checkpoint}-`));
      const dir = path.join(root, "logs");
      const rotated = path.join(dir, "gateway.1.0.jsonl");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(rotated, "old\n", { mode: 0o600 });
      utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));

      expect(() => new JsonlLogger(dir, () => now, {
        onPruneCheckpoint: (observed) => {
          if (observed === checkpoint) throw new Error(`crash at ${checkpoint}`);
        },
      })).toThrow(`crash at ${checkpoint}`);

      new JsonlLogger(dir, () => now);
      expect(readdirSync(dir), checkpoint).toEqual([]);
    }
  });

  it("fails closed for conflicting final and temporary prune records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-conflict-"));
    const dir = path.join(root, "logs");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(path.join(dir, ".gateway-prune-state.json"), "{}\n", { mode: 0o600 });
    writeFileSync(path.join(dir, ".gateway-prune-state.json.tmp"), "{}\n", { mode: 0o600 });

    expect(() => new JsonlLogger(dir)).toThrow(/temporary conflicts/u);
    expect(readdirSync(dir).sort()).toEqual([
      ".gateway-prune-state.json",
      ".gateway-prune-state.json.tmp",
    ]);
  });

  it("fails closed for a malformed complete prune temporary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-malformed-temp-"));
    const dir = path.join(root, "logs");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(path.join(dir, ".gateway-prune-state.json.tmp"), "{}\n", { mode: 0o600 });

    expect(() => new JsonlLogger(dir)).toThrow("invalid log prune state");
    expect(readdirSync(dir)).toEqual([".gateway-prune-state.json.tmp"]);
  });

  it("does not recover-delete a quarantine entry mutated after rename", async () => {
    const now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-injected-"));
    const dir = path.join(root, "logs");
    const rotated = path.join(dir, "gateway.1.0.jsonl");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(rotated, "old\n", { mode: 0o600 });
    utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    expect(() => new JsonlLogger(dir, () => now, {
      onAfterPruneRename: () => {
        throw new Error("simulated crash");
      },
    })).toThrow("simulated crash");
    const candidateName = readdirSync(dir).find((name) => /^\.gateway-prune-[0-9a-f-]+\.jsonl$/u.test(name));
    expect(candidateName).toBeDefined();
    const candidate = path.join(dir, candidateName ?? "missing");
    appendFileSync(candidate, "injected\n");

    expect(() => new JsonlLogger(dir, () => now)).toThrow(/changed during recovery/u);
    expect(readFileSync(candidate, "utf8")).toBe("old\ninjected\n");
    expect(readdirSync(dir)).toContain(".gateway-prune-state.json");
  });

  it("recovers a prior prune before the next write", async () => {
    const now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-write-recovery-"));
    const dir = path.join(root, "logs");
    let crash = false;
    const logger = new JsonlLogger(dir, () => now, {
      onAfterPruneRename: () => {
        if (crash) throw new Error("simulated crash");
      },
    });
    const rotated = path.join(dir, "gateway.1.0.jsonl");
    writeFileSync(rotated, "old\n", { mode: 0o600 });
    utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    crash = true;
    expect(() => logger.write({ category: "first" })).toThrow("simulated crash");

    crash = false;
    logger.write({ category: "recovered" });

    expect(readdirSync(dir)).toEqual(["gateway.jsonl"]);
    expect(readFileSync(path.join(dir, "gateway.jsonl"), "utf8")).toContain("recovered");
  });

  it("preserves a selected file mutated in place before its prune rename", async () => {
    const now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-mutation-"));
    const dir = path.join(root, "logs");
    const rotated = path.join(dir, "gateway.1.0.jsonl");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(rotated, "original\n", { mode: 0o600 });
    utimesSync(rotated, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));

    new JsonlLogger(dir, () => now, {
      onBeforePrune: (file) => {
        if (file === rotated) appendFileSync(file, "mutation\n");
      },
    });

    expect(readFileSync(rotated, "utf8")).toBe("original\nmutation\n");
    expect(readdirSync(dir)).toEqual(["gateway.1.0.jsonl"]);
  });

  it("only probes exact prune recovery names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-prune-enumeration-"));
    const dir = path.join(root, "logs");
    mkdirSync(dir, { mode: 0o700 });
    const unrelated = Array.from({ length: 64 }, (_, index) => `.gateway-prune-${index}`);
    for (const name of unrelated) writeFileSync(path.join(dir, name), "unrelated\n", { mode: 0o600 });
    const unreferenced = ".gateway-prune-00000000-0000-4000-8000-000000000000.jsonl";
    writeFileSync(path.join(dir, unreferenced), "unrelated\n", { mode: 0o600 });
    const oldQuarantine = path.join(dir, ".gateway-prune-deadbeef");
    mkdirSync(oldQuarantine, { mode: 0o700 });
    writeFileSync(path.join(oldQuarantine, "candidate.jsonl"), "unrelated\n", { mode: 0o600 });

    new JsonlLogger(dir, () => 1_700_000_000_000);

    expect(readdirSync(dir).sort()).toEqual([...unrelated, unreferenced, ".gateway-prune-deadbeef"].sort());
    expect(readFileSync(path.join(oldQuarantine, "candidate.jsonl"), "utf8")).toBe("unrelated\n");
  });

  it.skipIf(process.platform === "win32")("protects JSONL files, rotates before overflow, and applies count and age retention", async () => {
    let now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-protected-"));
    const dir = path.join(root, "logs");
    const logger = new JsonlLogger(dir, () => now);
    const active = path.join(dir, "gateway.jsonl");
    const chunk = "x".repeat(64 * 1024 - 200);

    for (let index = 0; index < 200; index += 1) {
      now += 1;
      logger.write({ protocol: chunk });
      expect(statSync(active).size).toBeLessThanOrEqual(LOG_FILE_BYTES);
    }

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(active).mode & 0o777).toBe(0o600);
    const rotated = readdirSync(dir).filter((name) => name !== "gateway.log");
    expect(rotated.length).toBeGreaterThan(0);
    expect(rotated.length).toBeLessThanOrEqual(4);

    const old = path.join(dir, rotated[0] ?? "missing");
    utimesSync(old, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    logger.write({ category: "retention" });
    expect(readdirSync(dir)).not.toContain(path.basename(old));
  });
});
