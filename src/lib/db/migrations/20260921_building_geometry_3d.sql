-- BUILDING V2: official footprints, height/floors, 3D readiness,
-- derived household-count semantics, provider compatibility.
-- Additive. Does not alter Core canonical unit types, parcel coordinates,
-- living snapshots, school, management fee, ranking, or price-position.

CREATE TABLE IF NOT EXISTS building_3d_source_links (
  complex_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_complex_id TEXT NOT NULL DEFAULT '',
  provider_building_id TEXT NOT NULL DEFAULT '',
  provider_object_id TEXT NOT NULL DEFAULT '',
  geometry_version TEXT NOT NULL DEFAULT '',
  provider_geometry_version TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'EMPTY',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (building_id, provider, provider_object_id),
  CHECK (status IN ('EMPTY', 'LINKED', 'STALE', 'UNVERIFIED'))
);

CREATE INDEX IF NOT EXISTS idx_b3d_complex
  ON building_3d_source_links (complex_id, provider);

CREATE TABLE IF NOT EXISTS building_3d_provider_capabilities (
  provider TEXT PRIMARY KEY,
  supports_footprint INTEGER,
  supports_height INTEGER,
  supports_3d_object INTEGER,
  supports_sunlight INTEGER,
  supports_datetime_shadow INTEGER,
  embed_allowed INTEGER,
  commercial_use_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  cache_allowed INTEGER,
  source_version TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK (commercial_use_status IN ('UNVERIFIED', 'NO', 'YES'))
);

CREATE TABLE IF NOT EXISTS unit_type_household_counts (
  complex_id TEXT NOT NULL,
  unit_type_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  supply_cents INTEGER,
  household_count INTEGER,
  count_status TEXT NOT NULL,
  ui_safe INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, unit_type_id),
  CHECK (count_status IN (
    'EXACT_VARIANT_COUNT',
    'EXACT_SINGLE_VARIANT_COUNT',
    'EXCLUSIVE_GROUP_ONLY',
    'PARTIAL_UNIT_EVIDENCE',
    'COUNT_CONFLICT',
    'NO_SOURCE'
  )),
  CHECK (ui_safe IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_uthc_status
  ON unit_type_household_counts (count_status, ui_safe);

CREATE TABLE IF NOT EXISTS unit_exclusive_group_counts (
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  household_count INTEGER,
  variant_count INTEGER NOT NULL DEFAULT 0,
  count_status TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, exclusive_cents),
  CHECK (count_status IN (
    'EXACT_VARIANT_COUNT',
    'EXACT_SINGLE_VARIANT_COUNT',
    'EXCLUSIVE_GROUP_ONLY',
    'PARTIAL_UNIT_EVIDENCE',
    'COUNT_CONFLICT',
    'NO_SOURCE'
  ))
);

CREATE TABLE IF NOT EXISTS gis_building_source_manifest (
  manifest_id TEXT PRIMARY KEY,
  source_dataset TEXT NOT NULL,
  source_version TEXT NOT NULL DEFAULT '',
  source_date TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  crs TEXT NOT NULL DEFAULT '',
  feature_count INTEGER,
  valid_geometry_count INTEGER,
  license_attribution TEXT NOT NULL DEFAULT '',
  wfs_fallback_used INTEGER NOT NULL DEFAULT 0,
  acquisition_status TEXT NOT NULL,
  local_path TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (wfs_fallback_used IN (0, 1))
);

CREATE TABLE IF NOT EXISTS compact_extractor_spec (
  spec_id TEXT PRIMARY KEY,
  required INTEGER NOT NULL DEFAULT 1,
  artifact_name TEXT NOT NULL,
  expected_size TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (required IN (0, 1))
);
