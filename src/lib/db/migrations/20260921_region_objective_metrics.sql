-- Objective 3-month metrics for region overview.
-- Additive. Does not alter ranking scores or household profiles.

CREATE TABLE IF NOT EXISTS region_objective_metrics (
  metric_run_id TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  transaction_as_of TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  trade_count_3m INTEGER NOT NULL,
  latest_deal_date TEXT,
  median_price_per_sqm_3m REAL,
  calculated_at TEXT NOT NULL,
  PRIMARY KEY (metric_run_id, complex_id)
);

CREATE INDEX IF NOT EXISTS idx_rom_asof_complex
  ON region_objective_metrics (transaction_as_of, complex_id);
