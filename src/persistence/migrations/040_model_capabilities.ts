export const migration = {
  version: 40,
  name: "model_capabilities",
  sql: [
    "CREATE TABLE model_capability_overrides (",
    "  account_id TEXT NOT NULL REFERENCES accounts(account_id),",
    "  model_id TEXT NOT NULL,",
    "  revision INTEGER NOT NULL CHECK (revision >= 1),",
    "  configuration_json TEXT,",
    "  updated_at_ms INTEGER NOT NULL,",
    "  PRIMARY KEY (account_id, model_id)",
    ");",
    "CREATE INDEX model_capability_overrides_configured",
    "  ON model_capability_overrides(account_id, model_id)",
    "  WHERE configuration_json IS NOT NULL;",
  ].join("\n"),
} as const;
