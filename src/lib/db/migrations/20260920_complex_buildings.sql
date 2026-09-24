-- BUILDING topology: residential buildings, geometry, type household stats,
-- and official unit-type ↔ building links.
-- Additive. Does not alter Core canonical unit types, official_unit_area_cache,
-- price-position, ranking, or management-fee tables.

CREATE TABLE IF NOT EXISTS complex_buildings (
  building_id TEXT PRIMARY KEY,
  complex_id TEXT NOT NULL REFERENCES apt_complex_master(complex_id),
  official_building_key TEXT NOT NULL,
  mgm_bldrgst_pk TEXT,
  dong_label TEXT,
  dong_label_status TEXT NOT NULL,
  building_name TEXT,
  main_usage TEXT,
  main_usage_code TEXT,
  main_atch_type TEXT,
  residential_flag INTEGER NOT NULL DEFAULT 0,
  household_count INTEGER,
  floor_count INTEGER,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (official_building_key),
  CHECK (dong_label_status IN ('EXACT_DONG_LABEL', 'MISSING_DONG_LABEL')),
  CHECK (status IN ('EXACT', 'PARTIAL', 'AMBIGUOUS', 'NO_SOURCE')),
  CHECK (residential_flag IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_cb_complex
  ON complex_buildings (complex_id, residential_flag);

CREATE INDEX IF NOT EXISTS idx_cb_dong
  ON complex_buildings (complex_id, dong_label);

CREATE TABLE IF NOT EXISTS complex_building_geometry (
  building_id TEXT PRIMARY KEY REFERENCES complex_buildings(building_id),
  geometry_source TEXT NOT NULL,
  centroid_lat REAL,
  centroid_lng REAL,
  representative_lat REAL,
  representative_lng REAL,
  footprint_geojson TEXT,
  source_object_id TEXT,
  source_version TEXT,
  source_as_of TEXT NOT NULL DEFAULT '',
  geometry_status TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (geometry_status IN ('EXACT_FOOTPRINT', 'POINT_ONLY', 'NO_GEOMETRY'))
);

CREATE INDEX IF NOT EXISTS idx_cbg_status
  ON complex_building_geometry (geometry_status);

CREATE TABLE IF NOT EXISTS unit_type_stats (
  complex_id TEXT NOT NULL,
  unit_type_id TEXT NOT NULL,
  household_count INTEGER,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, unit_type_id),
  CHECK (status IN ('EXACT', 'PARTIAL', 'AMBIGUOUS', 'NO_SOURCE'))
);

CREATE INDEX IF NOT EXISTS idx_uts_status
  ON unit_type_stats (status);

CREATE TABLE IF NOT EXISTS unit_type_building_links (
  complex_id TEXT NOT NULL,
  unit_type_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  household_count INTEGER,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, unit_type_id, building_id),
  CHECK (status IN ('EXACT', 'PARTIAL', 'AMBIGUOUS', 'NO_SOURCE', 'TYPE_VARIANT_AMBIGUOUS')),
  CHECK (confidence IN ('exact', 'hold'))
);

CREATE INDEX IF NOT EXISTS idx_utbl_building
  ON unit_type_building_links (building_id);

CREATE INDEX IF NOT EXISTS idx_utbl_type
  ON unit_type_building_links (unit_type_id);

CREATE TABLE IF NOT EXISTS complex_building_parity (
  complex_id TEXT PRIMARY KEY REFERENCES apt_complex_master(complex_id),
  kapt_household_count INTEGER,
  unit_household_count INTEGER,
  type_household_sum INTEGER,
  building_household_sum INTEGER,
  parity_class TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK (parity_class IN ('PARITY', 'MINOR_SCOPE_DIFF', 'PARTIAL_SOURCE', 'MAJOR_MISMATCH', 'NO_SOURCE'))
);

CREATE TABLE IF NOT EXISTS complex_building_checkpoint (
  complex_id TEXT PRIMARY KEY,
  parcel_key TEXT NOT NULL DEFAULT '',
  pnu TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 9,
  title_status TEXT NOT NULL,
  building_status TEXT NOT NULL,
  geometry_status TEXT NOT NULL,
  link_status TEXT NOT NULL,
  title_total_count INTEGER NOT NULL DEFAULT 0,
  residential_count INTEGER NOT NULL DEFAULT 0,
  api_calls INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK (title_status IN (
    'PENDING', 'SUCCESS', 'EMPTY', 'NO_PARCEL', 'IDENTITY_AMBIGUOUS',
    'ERROR', 'QUOTA', 'SKIP_CACHED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_cbc_title
  ON complex_building_checkpoint (title_status, priority);

CREATE TABLE IF NOT EXISTS official_building_title_cache (
  parcel_key TEXT NOT NULL,
  page_no INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (parcel_key, page_no)
);
