-- Residual identity, conflict classification, and incremental supply checkpoint.
-- Additive. Does not alter price position, ranking, or verified supply values.

CREATE TABLE IF NOT EXISTS apt_supply_identity_residual (
  complex_id TEXT PRIMARY KEY,
  prior_class TEXT NOT NULL,
  status TEXT NOT NULL,
  pnu TEXT NOT NULL DEFAULT '',
  identity_source TEXT NOT NULL DEFAULT '',
  lawd_cd TEXT NOT NULL DEFAULT '',
  bjdong_cd TEXT NOT NULL DEFAULT '',
  plat_gb_cd TEXT NOT NULL DEFAULT '',
  bun TEXT NOT NULL DEFAULT '',
  ji TEXT NOT NULL DEFAULT '',
  api_class TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asir_status
  ON apt_supply_identity_residual (status);

CREATE TABLE IF NOT EXISTS apt_supply_conflict_class (
  conflict_id TEXT PRIMARY KEY,
  class TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ascc_class
  ON apt_supply_conflict_class (class);

CREATE TABLE IF NOT EXISTS apt_supply_incremental_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_bulk_source_month TEXT NOT NULL,
  last_processed_source_version TEXT NOT NULL,
  bulk_sha256 TEXT NOT NULL DEFAULT '',
  complexes_changed INTEGER NOT NULL DEFAULT 0,
  pending_api_residuals INTEGER NOT NULL DEFAULT 0,
  conflicts_requiring_review INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
