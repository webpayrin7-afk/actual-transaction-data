-- PROPOSAL ONLY. Do not apply in this phase.
-- No score, weight, threshold, or component-breakdown columns.
-- Existing apt_pyeong_groups / apt_complex_profile / market_stats_* are unchanged.
--
-- Reuse for reads:
--   transactions              one snapshot, already cancellation-resolved at ingest
--   apt_complex_master        immutable complex_id, lawd, dong
--   apt_complex_profile       household_count + source (not building_count as a score input)
--   apt_complex_source_links  KAPT / MOLIT / parcel provenance
--
-- Not reusable as the ranking store:
--   market_stats_daily*       region-day aggregates, no complex, no area band, single as_of overwrite
--   apt_pyeong_groups         per-complex unit clusters, different semantics from a regional band
--
-- History: unlike market_stats_meta (single overwritten as_of), ranking rows are
-- append-only per calculation_run_id. A later snapshot must not replace an older as_of.
-- Re-running the same calculation_run_id is an idempotent upsert of the same values.

CREATE TABLE IF NOT EXISTS ranking_feature_snapshots (
  calculation_run_id TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  region_scope TEXT NOT NULL CHECK (region_scope IN ('gu', 'dong')),
  region_code TEXT NOT NULL,
  area_band TEXT NOT NULL,
  area_band_version TEXT NOT NULL,
  period TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  source_window_start TEXT NOT NULL,
  source_window_end TEXT NOT NULL,
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
  recent_3m_median_deal_amount REAL,
  previous_3m_median_deal_amount REAL,
  profile_source TEXT,
  profile_source_key TEXT,
  profile_as_of TEXT,
  profile_confidence TEXT,
  feature_version TEXT NOT NULL,
  ranking_version TEXT NOT NULL,
  transaction_count INTEGER NOT NULL,
  eligible_input INTEGER NOT NULL,
  exclusion_reason TEXT,
  calculated_at TEXT NOT NULL,
  PRIMARY KEY (calculation_run_id, complex_id, region_scope, region_code, area_band)
);

CREATE TABLE IF NOT EXISTS region_complex_rankings (
  calculation_run_id TEXT NOT NULL,
  region_scope TEXT NOT NULL CHECK (region_scope IN ('gu', 'dong')),
  region_code TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  area_band TEXT NOT NULL,
  period TEXT NOT NULL,
  rank INTEGER,
  region_total INTEGER,
  confidence_bucket TEXT,
  eligible INTEGER NOT NULL,
  exclusion_reason TEXT,
  ranking_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  public_display_metrics_json TEXT NOT NULL,
  PRIMARY KEY (
    calculation_run_id,
    region_scope,
    region_code,
    complex_id,
    area_band,
    period
  )
);

-- public_display_metrics_json may contain only:
--   median_price_per_sqm, median_deal_amount, trade_count, latest_deal_date
-- It must not contain weights, thresholds, percentiles, or score components.
