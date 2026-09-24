-- Additive living-amenity snapshots. Does not alter school, fee, supply, ranking,
-- price-position, or building tables.
--
-- Coordinate semantics of apt_complex_master.latitude/longitude used here:
-- PARCEL_REPRESENTATIVE_POINT (complex representative point, not building centroid).
-- Distance is straight-line haversine, not walking distance.
-- A new SEMAS quarter is a new source_version. Rows for older versions stay.

CREATE TABLE IF NOT EXISTS complex_living_snapshots (
  complex_id TEXT NOT NULL,
  radius_m INTEGER NOT NULL,
  product_category TEXT NOT NULL,
  product_subcategory TEXT NOT NULL,
  facility_count INTEGER NOT NULL CHECK (facility_count >= 0),
  quality_status TEXT NOT NULL,
  coordinate_semantics TEXT NOT NULL,
  distance_metric TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  built_at TEXT NOT NULL,
  PRIMARY KEY (
    complex_id,
    radius_m,
    product_category,
    product_subcategory,
    source_version,
    snapshot_version
  )
);

CREATE INDEX IF NOT EXISTS idx_living_snap_lookup
  ON complex_living_snapshots (
    source_version,
    snapshot_version,
    complex_id,
    radius_m
  );

-- One row per complex for a source/snapshot version.
-- COMPLETE: counts exist (including real zeros).
-- NO_COORDINATE / INVALID_COORDINATE: no count rows. Never store 0 for these.
CREATE TABLE IF NOT EXISTS complex_living_readiness (
  complex_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  coordinate_semantics TEXT,
  built_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, source_version, snapshot_version)
);

CREATE TABLE IF NOT EXISTS complex_living_publications (
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  built_at TEXT NOT NULL,
  complex_count INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (source_version, snapshot_version)
);

CREATE TABLE IF NOT EXISTS living_category_rules (
  rule_version TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_category_code TEXT NOT NULL,
  source_category_name TEXT NOT NULL,
  product_category TEXT NOT NULL,
  product_subcategory TEXT NOT NULL,
  PRIMARY KEY (rule_version, source_provider, source_category_code)
);
