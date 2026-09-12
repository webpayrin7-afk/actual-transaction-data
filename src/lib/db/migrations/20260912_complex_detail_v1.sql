-- Phase 7.1 Complex Detail v1 sample enrichment foundation
-- Durable feature tables keyed by complex_id. Sample-only loads now; bulk-ready.

CREATE TABLE IF NOT EXISTS apt_complex_profile (
  complex_id TEXT PRIMARY KEY REFERENCES apt_complex_master(complex_id),
  household_count INTEGER,
  building_count INTEGER,
  approval_date TEXT,
  heating_type TEXT,
  management_type TEXT,
  parking_total INTEGER,
  parking_per_household REAL,
  far_ratio REAL,
  bcr_ratio REAL,
  max_floor INTEGER,
  land_area_sqm REAL,
  total_area_sqm REAL,
  structure_type TEXT,
  main_purpose TEXT,
  source TEXT NOT NULL,
  source_version TEXT,
  raw_meta_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acp_approval
  ON apt_complex_profile (approval_date);

-- Monthly management-fee fact table (schema only until provider API is usable).
-- Amounts are complex-level monthly totals as published by the provider unless
-- per_area_* columns are populated from an official unit basis.
CREATE TABLE IF NOT EXISTS apt_complex_mgmt_fee_monthly (
  complex_id TEXT NOT NULL REFERENCES apt_complex_master(complex_id),
  period_yyyymm TEXT NOT NULL,
  common_fee INTEGER,
  individual_fee INTEGER,
  long_term_repair_reserve INTEGER,
  total_fee INTEGER,
  per_area_common_fee REAL,
  per_area_total_fee REAL,
  area_basis_sqm REAL,
  household_basis INTEGER,
  amount_basis TEXT,
  source TEXT NOT NULL,
  source_version TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, period_yyyymm)
);

CREATE INDEX IF NOT EXISTS idx_acmfm_period
  ON apt_complex_mgmt_fee_monthly (period_yyyymm);
