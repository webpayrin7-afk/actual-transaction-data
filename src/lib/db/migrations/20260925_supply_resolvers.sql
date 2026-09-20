-- Additive resolver + cohort classification. Does not alter ranking or transactions.

CREATE TABLE IF NOT EXISTS transaction_supply_resolvers (
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  building_dong TEXT NOT NULL DEFAULT '',
  floor TEXT NOT NULL DEFAULT '',
  supply_cents INTEGER NOT NULL,
  supply_area REAL NOT NULL,
  supply_pyeong REAL NOT NULL,
  resolver_level TEXT NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (complex_id, exclusive_cents, building_dong, floor)
);

CREATE INDEX IF NOT EXISTS idx_tsr_level
  ON transaction_supply_resolvers (resolver_level);

CREATE TABLE IF NOT EXISTS apt_exclusive_pair_cohort (
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  cohort_status TEXT NOT NULL,
  cohort_label TEXT NOT NULL DEFAULT '',
  variant_count INTEGER NOT NULL,
  PRIMARY KEY (complex_id, exclusive_cents)
);
