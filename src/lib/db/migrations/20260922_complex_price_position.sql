-- Complex-detail price position snapshot.
-- Additive read model. Does not alter region ranking or overview metrics.
-- Versioned by snapshot_id. A later as-of inserts a new snapshot_id.
-- One row refresh is an upsert on (snapshot_id, complex_id, area_band).

CREATE TABLE IF NOT EXISTS complex_region_price_position (
  snapshot_id TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  area_band TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  area_band_version TEXT NOT NULL,
  reference_month TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, complex_id, area_band)
);

CREATE INDEX IF NOT EXISTS idx_crpp_complex_band
  ON complex_region_price_position (complex_id, area_band, snapshot_id);
