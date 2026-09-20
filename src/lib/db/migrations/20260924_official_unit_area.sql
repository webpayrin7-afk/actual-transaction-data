-- Official unit-area cache and acquisition checkpoint.
-- Additive. Does not alter transactions, ranking, or existing unit-type values.

CREATE TABLE IF NOT EXISTS official_unit_area_cache (
  complex_id TEXT NOT NULL,
  source_unit_id TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  pnu TEXT NOT NULL,
  source_building_id TEXT NOT NULL,
  dong TEXT NOT NULL,
  floor TEXT NOT NULL,
  ho TEXT NOT NULL,
  exclusive_area REAL,
  residential_common_area REAL,
  other_common_area REAL,
  explicit_supply_area REAL,
  contract_area REAL,
  source_key TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (complex_id, source_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_ouac_pnu
  ON official_unit_area_cache (pnu);

CREATE TABLE IF NOT EXISTS official_unit_area_checkpoint (
  complex_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  page_cursor INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ouack_status
  ON official_unit_area_checkpoint (status);
