import { mkdtemp } from "node:fs/promises";
import { readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlLogger, LOG_FILE_BYTES, StderrLogger, type WindowsLogSecurity } from "../../src/daemon/logger.js";

const testWindowsSecurity: WindowsLogSecurity = {
  restrict() {},
  assertDirectory() {},
  assertFile() {},
};

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
    const logger = new JsonlLogger(dir, () => 1_700_000_000_000, testWindowsSecurity);
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

  it.runIf(process.platform === "win32")("rechecks Windows security for an existing log before every append", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-windows-security-"));
    const security: WindowsLogSecurity = {
      restrict: vi.fn(),
      assertDirectory: vi.fn(),
      assertFile: vi.fn(),
    };
    const logger = new JsonlLogger(path.join(root, "logs"), () => 1_700_000_000_000, security);
    logger.write({ category: "first" });
    const afterFirst = vi.mocked(security.assertFile).mock.calls.length;
    logger.write({ category: "second" });
    expect(vi.mocked(security.assertFile).mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it.runIf(process.platform === "win32")("fails closed when an existing log becomes unsafe before append", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-windows-unsafe-"));
    const security: WindowsLogSecurity = {
      restrict: vi.fn(),
      assertDirectory: vi.fn(),
      assertFile: vi.fn(),
    };
    const logger = new JsonlLogger(path.join(root, "logs"), () => 1_700_000_000_000, security);
    logger.write({ category: "first" });
    vi.mocked(security.assertFile).mockImplementation(() => {
      throw new Error("unsafe log");
    });

    expect(() => logger.write({ category: "second" })).toThrow("unsafe log");
    const active = path.join(root, "logs", "gateway.jsonl");
    const content = readFileSync(active, "utf8");
    expect(content).toContain("first");
    expect(content).not.toContain("second");
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
