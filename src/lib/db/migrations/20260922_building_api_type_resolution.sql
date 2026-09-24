-- BUILDING V3: API read indexes/snapshot + type↔building resolution stats.
-- Additive. Does not alter Core canonical unit types, parcel coordinates,
-- living snapshots, school, management fee, ranking, or price-position.

CREATE INDEX IF NOT EXISTS idx_utbl_complex_status
  ON unit_type_building_links (complex_id, status);

CREATE INDEX IF NOT EXISTS idx_uthc_complex
  ON unit_type_household_counts (complex_id);

CREATE INDEX IF NOT EXISTS idx_cb_api
  ON complex_buildings (complex_id, residential_flag, status);

CREATE INDEX IF NOT EXISTS idx_cbg_building
  ON complex_building_geometry (building_id, geometry_status);

CREATE TABLE IF NOT EXISTS unit_building_resolution_stats (
  complex_id TEXT PRIMARY KEY,
  physical_units INTEGER NOT NULL DEFAULT 0,
  building_linked_units INTEGER NOT NULL DEFAULT 0,
  exact_variant_building INTEGER NOT NULL DEFAULT 0,
  exact_single_building INTEGER NOT NULL DEFAULT 0,
  exclusive_group_only INTEGER NOT NULL DEFAULT 0,
  ambiguous_type INTEGER NOT NULL DEFAULT 0,
  ambiguous_building INTEGER NOT NULL DEFAULT 0,
  no_canonical_type INTEGER NOT NULL DEFAULT 0,
  no_building_identity INTEGER NOT NULL DEFAULT 0,
  public_exact_links INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complex_building_api_snapshot (
  complex_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  building_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
