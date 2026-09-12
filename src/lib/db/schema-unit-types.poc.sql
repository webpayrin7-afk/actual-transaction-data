-- PoC proposal only. Do NOT apply to production in this PR.
-- 주택형 마스터 (transactions와 분리). Phase2: 건축물대장 전유+주거공용.

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
  unit_type_key TEXT PRIMARY KEY,              -- A14003105:84.98:109.26
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  kapt_code TEXT,
  complex_id TEXT REFERENCES apt_complexes(complex_id),
  supply_area_sqm REAL NOT NULL,               -- 전유 + 주거공용
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  residential_common_area_sqm REAL NOT NULL,
  household_count INTEGER,
  type_label TEXT,
  market_pyeong_label INTEGER,                 -- NULL 허용. round(supply/3.3) 자동금지
  mapping_confidence TEXT NOT NULL CHECK (
    mapping_confidence IN ('exact', 'grouped', 'ambiguous')
  ),
  source TEXT NOT NULL,
  source_updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unit_types_complex_norm
  ON apt_unit_types (lawd_cd, apt_name_norm);

CREATE INDEX IF NOT EXISTS idx_unit_types_kapt
  ON apt_unit_types (kapt_code);

-- exclusive → unit_type 해석 보조. transactions 수정 없음.
CREATE TABLE IF NOT EXISTS apt_unit_type_exclusive_aliases (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  exclusive_area_cents INTEGER NOT NULL,
  unit_type_key TEXT,
  market_pyeong_label INTEGER,
  mapping_status TEXT NOT NULL CHECK (
    mapping_status IN ('exact', 'multi', 'none')
  ),
  PRIMARY KEY (lawd_cd, apt_name_norm, exclusive_area_cents)
);
