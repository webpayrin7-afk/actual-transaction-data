-- National school master, category snapshots, and nearby links.
-- Assignment / attendance-zone / school-district tables are intentionally absent (HOLD).
-- Writes are limited to the tables in this file. Complex coordinates are read-only.

CREATE TABLE IF NOT EXISTS school_master (
  school_code TEXT PRIMARY KEY,
  school_name TEXT NOT NULL,
  school_level TEXT NOT NULL CHECK (school_level IN ('elementary', 'middle', 'high')),
  establishment_type TEXT,
  gender_type TEXT,
  sido TEXT,
  sigungu TEXT,
  sido_code TEXT,
  sgg_code TEXT,
  address TEXT,
  road_address TEXT,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL CHECK (status IN ('operating', 'closed')),
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  neis_code TEXT,
  attribution TEXT NOT NULL,
  license_note TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_school_master_region
  ON school_master (sido, school_level);

CREATE INDEX IF NOT EXISTS idx_school_master_sgg
  ON school_master (sgg_code, school_level);

CREATE TABLE IF NOT EXISTS school_detail_snapshots (
  school_code TEXT NOT NULL,
  category TEXT NOT NULL,
  disclosure_year TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  raw_json TEXT,
  attribution TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (school_code, category, disclosure_year, source)
);

CREATE INDEX IF NOT EXISTS idx_school_snapshot_category
  ON school_detail_snapshots (category, status);

CREATE TABLE IF NOT EXISTS school_data_status (
  school_code TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  disclosure_year TEXT,
  detail TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (school_code, category)
);

CREATE INDEX IF NOT EXISTS idx_school_data_status_category
  ON school_data_status (category, status);

CREATE TABLE IF NOT EXISTS school_fetch_checkpoint (
  scope_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  disclosure_year TEXT,
  category TEXT,
  http_status INTEGER,
  result_code TEXT,
  row_count INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  rate_limits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complex_nearby_schools (
  complex_id TEXT NOT NULL,
  school_code TEXT NOT NULL,
  distance_m REAL NOT NULL,
  school_level TEXT NOT NULL,
  rank_by_distance INTEGER NOT NULL,
  source_as_of TEXT NOT NULL,
  distance_basis TEXT NOT NULL CHECK (distance_basis = 'PARCEL_REPRESENTATIVE_POINT'),
  classification TEXT NOT NULL CHECK (classification = 'NEARBY_SCHOOL'),
  PRIMARY KEY (complex_id, school_code)
);

CREATE INDEX IF NOT EXISTS idx_complex_nearby_level
  ON complex_nearby_schools (complex_id, school_level, rank_by_distance);
