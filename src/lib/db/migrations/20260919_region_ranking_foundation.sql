-- Region ranking foundation schema. Additive only.
-- Creates empty tables. Existing tables and rows stay as they are.
-- No weight, threshold, percentile, or component-score columns.
--
-- ranking_feature_snapshots stores one raw feature row per complex.
-- region_scope is not part of that key. Dong and gu cohorts are built at rank time.
--
-- region_complex_rankings stores a public result for one ranking_run_id.
-- feature_run_id is a reference only. Config values are not stored.
-- Re-applying this file is CREATE IF NOT EXISTS. It does not replace older run ids.
-- A later writer may upsert the same primary key and must keep other run ids.
--
-- public_display_metrics_json may contain only:
--   median_price_per_sqm, median_deal_amount, trade_count, latest_deal_date

CREATE TABLE IF NOT EXISTS ranking_feature_snapshots (
  feature_run_id TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  bjdong_cd TEXT NOT NULL,
  area_band TEXT NOT NULL,
  area_band_version TEXT NOT NULL,
  period TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  source_window_start TEXT NOT NULL,
  source_window_end TEXT NOT NULL,
  recent_window_start TEXT NOT NULL,
  recent_window_end TEXT NOT NULL,
  previous_window_start TEXT NOT NULL,
  previous_window_end TEXT NOT NULL,
  median_price_per_sqm REAL,
  median_deal_amount REAL,
  trade_count INTEGER NOT NULL,
  household_count INTEGER,
  turnover REAL,
  active_month_count INTEGER NOT NULL,
  latest_deal_date TEXT,
  recent_3m_trade_count INTEGER NOT NULL,
  previous_3m_trade_count INTEGER NOT NULL,
  recent_3m_median_price_per_sqm REAL,
  previous_3m_median_price_per_sqm REAL,
  feature_version TEXT NOT NULL,
  profile_source TEXT,
  profile_confidence TEXT,
  eligible_input INTEGER NOT NULL,
  exclusion_reason TEXT,
  calculated_at TEXT NOT NULL,
  PRIMARY KEY (feature_run_id, complex_id, area_band, period)
);

CREATE INDEX IF NOT EXISTS idx_rfs_feature_lawd
  ON ranking_feature_snapshots (feature_run_id, lawd_cd);

CREATE INDEX IF NOT EXISTS idx_rfs_feature_dong
  ON ranking_feature_snapshots (feature_run_id, bjdong_cd);

CREATE TABLE IF NOT EXISTS region_complex_rankings (
  ranking_run_id TEXT NOT NULL,
  region_scope TEXT NOT NULL CHECK (region_scope IN ('gu', 'dong')),
  region_code TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  area_band TEXT NOT NULL,
  period TEXT NOT NULL,
  feature_run_id TEXT NOT NULL,
  "rank" INTEGER,
  region_total INTEGER,
  confidence_bucket TEXT,
  eligible INTEGER NOT NULL,
  exclusion_reason TEXT,
  ranking_version TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  public_display_metrics_json TEXT NOT NULL,
  PRIMARY KEY (
    ranking_run_id,
    region_scope,
    region_code,
    complex_id,
    area_band,
    period
  )
);

CREATE INDEX IF NOT EXISTS idx_rcr_feature_run
  ON region_complex_rankings (feature_run_id);

CREATE INDEX IF NOT EXISTS idx_rcr_region_lookup
  ON region_complex_rankings (region_scope, region_code, area_band, period);
