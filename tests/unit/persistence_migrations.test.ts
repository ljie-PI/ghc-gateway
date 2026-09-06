import { SqliteDatabase as Database } from "../../src/persistence/sqlite.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateMigrationManifest,
  MigrationGenerateError,
  writeMigrationManifest,
} from "../../scripts/tooling/generate_migrations.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import { migration as responsesUnknownProtocolMigration } from "../../src/persistence/migrations/021_responses_unknown_protocol.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import {
  applyMigrations,
  embedMigration,
  MigrationError,
} from "../../src/persistence/migrations.js";

const nowMs = (): number => 1_700_000_000_000;

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-db-"));
  return path.join(dir, "state.db");
}

describe("migrations", () => {
  it("releases the database file when opening fails during migration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ghc-gateway-failed-open-"));
    try {
      expect(() => openDatabase({
        path: path.join(directory, "state.db"),
        migrations: [embedMigration({ version: 1, name: "invalid", sql: "CREATE TABLE broken (" })],
        nowMs,
      })).toThrow(MigrationError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps deferred write acquisition until the transaction first accesses the database", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ghc-gateway-deferred-"));
    const dbPath = path.join(directory, "state.db");
    const first = openDatabase({ path: dbPath, migrations: [] });
    let second: ReturnType<typeof openDatabase> | undefined;
    try {
      first.exec("CREATE TABLE sample (value TEXT)");
      second = openDatabase({ path: dbPath, migrations: [] });
      const writeSecond = second.prepare("INSERT INTO sample VALUES (?)");
      first.transaction(() => {
        writeSecond.run("other connection");
        first.prepare("INSERT INTO sample VALUES (?)").run("transaction");
      })();
      expect(first.prepare("SELECT value FROM sample").all()).toEqual([
        { value: "other connection" },
        { value: "transaction" },
      ]);
    } finally {
      second?.close();
      first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens WAL/FULL/FK with documented busy timeout and journal limits", async () => {
    const database = openDatabase({
      path: await tempDbPath(),
      migrations: [embedMigration(runtimeConfigMigration)],
      nowMs,
    });
    try {
      expect(String(database.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      expect(Number(database.pragma("synchronous", { simple: true }))).toBe(2);
      expect(Number(database.pragma("foreign_keys", { simple: true }))).toBe(1);
      expect(Number(database.pragma("busy_timeout", { simple: true }))).toBe(1000);
      expect(Number(database.pragma("wal_autocheckpoint", { simple: true }))).toBe(1000);
      expect(Number(database.pragma("journal_size_limit", { simple: true }))).toBe(67_108_864);
      const row = database.prepare("SELECT version, name FROM schema_migrations").get() as {
        version: number;
        name: string;
      };
      expect(row).toEqual({ version: 1, name: "runtime_config" });
    } finally {
      closeDatabase(database);
    }
  });

  it("is idempotent for a current database and upgrades an older one", async () => {
    const dbPath = await tempDbPath();
    const first = openDatabase({
      path: dbPath,
      migrations: [embedMigration(runtimeConfigMigration)],
      nowMs,
    });
    closeDatabase(first);

    const extra = embedMigration({
      version: 10,
      name: "accounts",
      sql: "CREATE TABLE accounts_probe (id INTEGER PRIMARY KEY);",
    });
    const upgraded = openDatabase({
      path: dbPath,
      migrations: [embedMigration(runtimeConfigMigration), extra],
      nowMs,
    });
    try {
      const versions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>;
      expect(versions.map((row) => row.version)).toEqual([1, 10]);
      expect(upgraded.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'accounts_probe'").get()).toEqual({
        ok: 1,
      });
    } finally {
      closeDatabase(upgraded);
    }
  });

  it("applies a later lower reserved version after a higher version exists", () => {
    const database = new Database(":memory:");
    const first = embedMigration(runtimeConfigMigration);
    const high = embedMigration({
      version: 20,
      name: "telemetry",
      sql: "CREATE TABLE telemetry_probe (id INTEGER PRIMARY KEY);",
    });
    const low = embedMigration({
      version: 10,
      name: "accounts",
      sql: "CREATE TABLE accounts_probe (id INTEGER PRIMARY KEY);",
    });
    applyMigrations(database, [first, high], nowMs);
    applyMigrations(database, [first, low, high], nowMs);
    const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual([1, 10, 20]);
    database.close();
  });

  it("rejects checksum drift and unknown applied versions", () => {
    const database = new Database(":memory:");
    const first = embedMigration(runtimeConfigMigration);
    applyMigrations(database, [first], nowMs);
    database.prepare("UPDATE schema_migrations SET checksum = 'drift' WHERE version = 1").run();
    expect(() => applyMigrations(database, [first], nowMs)).toThrow(MigrationError);
    database.close();

    const unknown = new Database(":memory:");
    applyMigrations(unknown, [first], nowMs);
    unknown.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (99, 'future', 'abc', 1)",
    ).run();
    expect(() => applyMigrations(unknown, [first], nowMs)).toThrow(/unknown/u);
    unknown.close();
  });

  it("rolls back a failed migration", () => {
    const database = new Database(":memory:");
    const first = embedMigration(runtimeConfigMigration);
    applyMigrations(database, [first], nowMs);
    const bad = embedMigration({
      version: 10,
      name: "bad",
      sql: "CREATE TABLE ok_probe (id INTEGER PRIMARY KEY); CREATE TABLE",
    });
    expect(() => applyMigrations(database, [first, bad], nowMs)).toThrow(MigrationError);
    const versions = database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }]);
    expect(database.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'ok_probe'").get()).toBeUndefined();
    database.close();
  });

  it("preserves existing usage while adding an unknown Responses attribution", () => {
    const database = new Database(":memory:");
    const base = [
      embedMigration(runtimeConfigMigration),
      embedMigration(telemetryMigration),
      embedMigration(responsesHistoryMigration),
    ];
    applyMigrations(database, base, nowMs);
    database.prepare(
      `INSERT INTO usage_buckets VALUES (
        1, 'github.com/1', 'openai_responses_bridge', 'gpt', 'success',
        1, 0, 2, 3, 0, 4, 4
      )`,
    ).run();

    applyMigrations(database, [...base, embedMigration(responsesUnknownProtocolMigration)], nowMs);
    database.prepare(
      `INSERT INTO usage_buckets VALUES (
        1, 'unbound', 'openai_responses_unknown', 'unresolved', 'client_error',
        1, 1, 0, 0, 0, 0, 0
      )`,
    ).run();

    expect(database.prepare(
      "SELECT protocol, request_count FROM usage_buckets ORDER BY protocol",
    ).all()).toEqual([
      { protocol: "openai_responses_bridge", request_count: 1 },
      { protocol: "openai_responses_unknown", request_count: 1 },
    ]);
    database.close();
  });
});

describe("generate_migrations", () => {
  it("embeds all reserved modules and writes a static TypeScript manifest", async () => {
    const migrations = await generateMigrationManifest();
    expect(migrations).toEqual([
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(responsesUnknownProtocolMigration),
      embedMigration(responsesHistoryMigration),
    ]);
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-manifest-"));
    const manifestPath = path.join(dir, "generated_migrations.ts");
    await writeMigrationManifest(migrations, manifestPath);
    const written = await readFile(manifestPath, "utf8");
    expect(written).toContain("export const MIGRATION_MANIFEST =");
    for (const migration of migrations) {
      expect(written).toContain(migration.checksum);
      expect(written).toContain(`"version": ${migration.version}`);
    }
  });

  it("rejects filename/export mismatch, duplicates, and reserved-owner violations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-mig-"));
    await writeFile(path.join(dir, "001_wrong.ts"), "export const migration = { version: 1, name: 'x', sql: 'SELECT 1' };\n");
    await expect(generateMigrationManifest(dir)).rejects.toBeInstanceOf(MigrationGenerateError);

    const mismatch = await mkdtemp(path.join(tmpdir(), "ghc-gateway-mig-"));
    await writeFile(
      path.join(mismatch, "001_runtime_config.ts"),
      "export const migration = { version: 2, name: 'runtime_config', sql: 'SELECT 1' };\n",
    );
    await expect(generateMigrationManifest(mismatch)).rejects.toThrow(/mismatch/u);

    const unknown = await mkdtemp(path.join(tmpdir(), "ghc-gateway-mig-"));
    await writeFile(path.join(unknown, "002_extra.ts"), "export const migration = { version: 2, name: 'extra', sql: 'SELECT 1' };\n");
    await expect(generateMigrationManifest(unknown)).rejects.toThrow(/not reserved/u);
  });
});
