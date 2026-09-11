-- PoC proposal only. Do NOT apply to production in this PR.
-- 주택형 마스터 (transactions와 분리)

CREATE TABLE IF NOT EXISTS apt_complexes (
  complex_id TEXT PRIMARY KEY,
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  apt_name_display TEXT NOT NULL DEFAULT '',
  kapt_code TEXT,
  jibun TEXT,
  road_address TEXT,
  source TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  UNIQUE (lawd_cd, apt_name_norm, jibun)
);

CREATE TABLE IF NOT EXISTS apt_unit_types (
  type_id TEXT PRIMARY KEY,
  complex_id TEXT NOT NULL REFERENCES apt_complexes(complex_id),
  type_name TEXT,
  supply_area_sqm REAL,
  exclusive_area_sqm REAL NOT NULL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  pyeong_group INTEGER,
  household_count INTEGER,
  verification TEXT NOT NULL CHECK (
    verification IN ('official', 'commercial_crosscheck', 'inferred')
  ),
  source TEXT NOT NULL,
  source_updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unit_types_complex
  ON apt_unit_types (complex_id);

CREATE TABLE IF NOT EXISTS apt_unit_type_exclusive_aliases (
  complex_id TEXT NOT NULL,
  exclusive_area_cents INTEGER NOT NULL,
  type_id TEXT,
  pyeong_group INTEGER,
  mapping_status TEXT NOT NULL CHECK (
    mapping_status IN ('unique', 'ambiguous', 'unmatched')
  ),
  PRIMARY KEY (complex_id, exclusive_area_cents)
);
