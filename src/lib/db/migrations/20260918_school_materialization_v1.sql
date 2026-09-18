-- School materialization schema (PREPARED — do not apply to Production in dry-run).
-- Naming aligned with apt_complex_* warehouse style.
-- Production write requires explicit WRITE PHASE approval.

CREATE TABLE IF NOT EXISTS school_master (
  school_code TEXT PRIMARY KEY,           -- NEIS SD_SCHUL_CODE when known
  school_name TEXT NOT NULL,
  school_level TEXT NOT NULL,              -- elementary | middle | high
  establishment TEXT,
  lat REAL,
  lng REAL,
  facility_school_id TEXT,                -- 한국교육시설안전원 학교ID (B…)
  source_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_attendance_zones (
  zone_id TEXT PRIMARY KEY,               -- HAKGUDO_ID
  zone_name TEXT NOT NULL,
  school_code TEXT,                       -- designated school when resolved
  zone_type TEXT NOT NULL,                -- single | joint
  hakgudo_gb TEXT,
  source_base_date TEXT,
  source_ref TEXT,
  version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_districts (
  district_id TEXT PRIMARY KEY,           -- HAKGUDO_ID
  district_name TEXT NOT NULL,
  school_level TEXT NOT NULL,              -- middle | high
  source_base_date TEXT,
  source_ref TEXT,
  version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_district_members (
  district_id TEXT NOT NULL,
  school_code TEXT NOT NULL,
  membership_type TEXT,                   -- official | derived
  source_version TEXT NOT NULL,
  PRIMARY KEY (district_id, school_code)
);

CREATE TABLE IF NOT EXISTS complex_school_areas (
  complex_id TEXT NOT NULL,
  school_level TEXT NOT NULL,              -- elementary | middle | high
  area_type TEXT NOT NULL,                 -- attendance_zone | district
  area_id TEXT,                           -- zone_id / district_id
  resolution_method TEXT,
  resolution_status TEXT NOT NULL,
  source_version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, school_level, area_type)
);

CREATE TABLE IF NOT EXISTS complex_nearby_schools (
  complex_id TEXT NOT NULL,
  school_level TEXT NOT NULL,
  school_code TEXT NOT NULL,
  distance_m REAL NOT NULL,
  rank INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  source_version TEXT NOT NULL,
  PRIMARY KEY (complex_id, school_level, school_code)
);

CREATE INDEX IF NOT EXISTS idx_complex_nearby_rank
  ON complex_nearby_schools (complex_id, school_level, rank);

CREATE INDEX IF NOT EXISTS idx_complex_school_areas_status
  ON complex_school_areas (school_level, resolution_status);
