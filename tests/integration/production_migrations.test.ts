import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOOPBACK_HOST, type StartupConfig } from "../../src/config/startup_config.js";
import { createProductionApplicationContext } from "../../src/main.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { MIGRATION_MANIFEST } from "../../src/persistence/generated_migrations.js";

const EXPECTED_VERSIONS = [1, 10, 20, 21, 30, 40];

async function createStartup(): Promise<StartupConfig> {
  return {
    host: LOOPBACK_HOST,
    port: 31_400,
    dataDir: await mkdtemp(path.join(tmpdir(), "ghc-gateway-production-db-")),
    logLevel: "info",
  };
}

describe("production migration manifest", () => {
  it.each([
    { name: "fresh", seedFirstMigration: false },
    { name: "migrated within new v1", seedFirstMigration: true },
  ])("opens a $name production database", async ({ seedFirstMigration }) => {
    const startup = await createStartup();
    if (seedFirstMigration) {
      const firstMigration = MIGRATION_MANIFEST[0];
      if (firstMigration === undefined) {
        throw new Error("production migration manifest is empty");
      }
      const database = openDatabase({
        path: path.join(startup.dataDir, "state.db"),
        migrations: [firstMigration],
      });
      closeDatabase(database);
    }

    const application = await createProductionApplicationContext(startup);
    try {
      const rows = application.database?.prepare(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      ).all() as Array<{ version: number; checksum: string }> | undefined;
      expect(rows?.map((row) => row.version)).toEqual(EXPECTED_VERSIONS);
      expect(rows?.map((row) => row.checksum)).toEqual(MIGRATION_MANIFEST.map((migration) => migration.checksum));
      expect(application.database?.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'responses_history_state'",
      ).get()).toEqual({ name: "responses_history_state" });
      expect(application.database?.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_capability_overrides'",
      ).get()).toEqual({ name: "model_capability_overrides" });
    } finally {
      await application.close?.();
    }
  });
});
