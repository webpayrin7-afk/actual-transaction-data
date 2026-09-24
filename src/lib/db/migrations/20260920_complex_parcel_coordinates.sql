-- Provenance for official parcel representative points.
-- Additive. Does not change living category rules, school, supply, ranking,
-- price-position, or building tables.
-- latitude/longitude on apt_complex_master stay the canonical living coordinate.
-- This table records source identity for coordinates filled from cadastral PNU joins.

CREATE TABLE IF NOT EXISTS complex_parcel_coordinates (
  complex_id TEXT PRIMARY KEY,
  pnu TEXT NOT NULL,
  latitude TEXT NOT NULL,
  longitude TEXT NOT NULL,
  coordinate_semantics TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  coordinate_source TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parcel_coord_pnu
  ON complex_parcel_coordinates (pnu);
