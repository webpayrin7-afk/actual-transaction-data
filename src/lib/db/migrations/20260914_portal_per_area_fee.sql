-- Phase 2.6 — portal per-area management fee columns (minimal additive).
-- Safe to re-run: ADD COLUMN ignored if already present via script checks.

-- per_area_individual_fee / per_area_reserve_fee / area_basis / fee_status
-- applied by scripts/phase26-jamsil-els-portal-fee-ingest.mts via ALTER TABLE
-- when missing. Documented here for schema history.

-- ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN per_area_individual_fee REAL;
-- ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN per_area_reserve_fee REAL;
-- ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN area_basis TEXT;
-- ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN fee_status TEXT;
