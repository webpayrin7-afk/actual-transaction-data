-- PoC schema only. Do NOT apply to production in this PR.
-- Phase 3: separate official unit types from market pyeong groups.

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

-- Official building-ledger housing types (전유 + 주거공용).
CREATE TABLE IF NOT EXISTS apt_unit_types (
  unit_type_key TEXT PRIMARY KEY,                 -- e.g. A14003105:84.98:117.13
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  kapt_code TEXT,
  complex_id TEXT REFERENCES apt_complexes(complex_id),
  supply_area_sqm REAL NOT NULL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  residential_common_area_sqm REAL NOT NULL,
  household_count INTEGER,
  type_label TEXT,
  mapping_confidence TEXT NOT NULL CHECK (
    mapping_confidence IN ('exact', 'grouped', 'ambiguous')
  ),
  exclusive_includes_partial_common INTEGER NOT NULL DEFAULT 0, -- 은마 등
  source TEXT NOT NULL,
  source_updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unit_types_complex
  ON apt_unit_types (lawd_cd, apt_name_norm);

CREATE INDEX IF NOT EXISTS idx_unit_types_kapt
  ON apt_unit_types (kapt_code);

-- User-facing market groups. May merge multiple official unit types.
CREATE TABLE IF NOT EXISTS apt_pyeong_groups (
  group_key TEXT PRIMARY KEY,                     -- e.g. A14003105:G2:ex84.94-84.98
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  kapt_code TEXT,
  complex_id TEXT REFERENCES apt_complexes(complex_id),
  market_label INTEGER,                           -- NULL allowed; never invent
  display_fallback TEXT,                          -- e.g. "전용 59.98~60.00㎡ · 공급 81.60~82.31㎡"
  supply_area_min REAL NOT NULL,
  supply_area_max REAL NOT NULL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  household_count INTEGER,
  confidence TEXT NOT NULL CHECK (
    confidence IN ('exact', 'grouped', 'ambiguous')
  ),
  source TEXT NOT NULL,
  source_updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pyeong_groups_complex
  ON apt_pyeong_groups (lawd_cd, apt_name_norm);

-- unit type → market group membership
CREATE TABLE IF NOT EXISTS apt_unit_type_group_links (
  unit_type_key TEXT NOT NULL REFERENCES apt_unit_types(unit_type_key),
  group_key TEXT NOT NULL REFERENCES apt_pyeong_groups(group_key),
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  PRIMARY KEY (unit_type_key, group_key)
);

-- exclusive → mapping helper for trades (transactions remain untouched)
CREATE TABLE IF NOT EXISTS apt_unit_type_exclusive_aliases (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  exclusive_area_cents INTEGER NOT NULL,
  unit_type_key TEXT,
  group_key TEXT,
  market_label INTEGER,
  mapping_status TEXT NOT NULL CHECK (
    mapping_status IN ('exact', 'multi', 'none')
  ),
  PRIMARY KEY (lawd_cd, apt_name_norm, exclusive_area_cents)
);
