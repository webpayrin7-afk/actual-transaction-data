-- Additive school metadata for incremental refresh and nearby delta.
-- Does not rewrite historical snapshots and does not store assignment geometry.
-- Complex coordinates are not written by this migration.

ALTER TABLE school_master ADD COLUMN coord_status TEXT;
ALTER TABLE school_master ADD COLUMN coord_source TEXT;
ALTER TABLE school_master ADD COLUMN coord_source_version TEXT;

CREATE TABLE IF NOT EXISTS school_snapshot_current (
  school_code TEXT NOT NULL,
  category TEXT NOT NULL,
  disclosure_year TEXT NOT NULL,
  source TEXT NOT NULL,
  snapshot_status TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  PRIMARY KEY (school_code, category)
);

CREATE TABLE IF NOT EXISTS school_category_year (
  category TEXT PRIMARY KEY,
  loaded_year TEXT NOT NULL,
  candidate_year TEXT,
  candidate_status TEXT,
  probed_scope TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_identity_hold_audit (
  scope_key TEXT NOT NULL,
  school_code TEXT NOT NULL,
  disclosure_year TEXT NOT NULL,
  classification TEXT NOT NULL,
  hold_count INTEGER NOT NULL,
  detail TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, school_code, classification)
);

CREATE TABLE IF NOT EXISTS school_identity_exclusions (
  school_code TEXT PRIMARY KEY,
  school_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  audited_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complex_nearby_materialization (
  complex_id TEXT PRIMARY KEY,
  coord_version TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  link_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('BUILDING', 'READY', 'NO_SCHOOLS_WITHIN_RADIUS')),
  materialized_at TEXT NOT NULL
);
