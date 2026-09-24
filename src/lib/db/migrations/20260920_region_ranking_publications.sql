-- Active publication pointer for one region board.
-- Public reads use this pointer. They do not choose a row by time.

CREATE TABLE IF NOT EXISTS region_ranking_publications (
  region_scope TEXT NOT NULL,
  region_code TEXT NOT NULL,
  area_band TEXT NOT NULL,
  period TEXT NOT NULL,
  active_ranking_run_id TEXT NOT NULL,
  feature_run_id TEXT NOT NULL,
  ranking_version TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (region_scope, region_code, area_band, period)
);
