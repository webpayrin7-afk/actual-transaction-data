-- Canonical unit type + supply area master.
-- Additive. Does not alter apt_unit_types, apt_pyeong_groups, ranking, or price position.
-- Identity is complex_id + exclusive cents + supply cents. A missing supply uses supply_cents -1.

CREATE TABLE IF NOT EXISTS apt_canonical_unit_types (
  unit_type_id TEXT PRIMARY KEY,
  complex_id TEXT NOT NULL,
  exclusive_area REAL NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  supply_area REAL,
  supply_cents INTEGER NOT NULL,
  supply_pyeong REAL,
  display_pyeong_label TEXT,
  type_name TEXT,
  household_count INTEGER,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  formula TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (complex_id, exclusive_cents, supply_cents),
  CHECK (status IN ('EXACT_SINGLE', 'EXACT_MULTI_RESOLVABLE', 'AMBIGUOUS_MULTI', 'NO_SOURCE'))
);

CREATE INDEX IF NOT EXISTS idx_acut_complex
  ON apt_canonical_unit_types (complex_id, exclusive_cents);

CREATE TABLE IF NOT EXISTS apt_unit_exclusive_pairs (
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  exclusive_area REAL NOT NULL,
  trade_count INTEGER NOT NULL,
  trade_count_12m INTEGER NOT NULL,
  trade_count_3y INTEGER NOT NULL,
  latest_trade_date TEXT NOT NULL DEFAULT '',
  resolution_status TEXT NOT NULL,
  supply_variant_count INTEGER NOT NULL,
  observed_from TEXT NOT NULL,
  PRIMARY KEY (complex_id, exclusive_cents)
);

CREATE INDEX IF NOT EXISTS idx_auep_status
  ON apt_unit_exclusive_pairs (resolution_status);

CREATE TABLE IF NOT EXISTS apt_unit_supply_conflicts (
  conflict_id TEXT PRIMARY KEY,
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  held_supply_area REAL NOT NULL,
  held_supply_cents INTEGER NOT NULL,
  held_source TEXT NOT NULL,
  held_source_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ausc_complex
  ON apt_unit_supply_conflicts (complex_id, exclusive_cents);

CREATE TABLE IF NOT EXISTS apt_unit_acquisition_manifest (
  complex_id TEXT PRIMARY KEY,
  sido TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  bjdong_cd TEXT NOT NULL DEFAULT '',
  apt_name TEXT NOT NULL,
  jibun TEXT NOT NULL DEFAULT '',
  kapt_code TEXT NOT NULL DEFAULT '',
  unresolved_pair_count INTEGER NOT NULL,
  no_source_pair_count INTEGER NOT NULL,
  ambiguous_pair_count INTEGER NOT NULL,
  blocker_class TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auam_blocker
  ON apt_unit_acquisition_manifest (blocker_class);
