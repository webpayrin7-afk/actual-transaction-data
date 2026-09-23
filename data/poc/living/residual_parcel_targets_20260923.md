# Residual parcel targets (2026-09-23)

The 2026-09-21 local AL_D002 extraction (source version 20260908) scanned every sido but kept only the
18,724 target PNUs known at that time. Complexes that still have no coordinates in Production:

- missing coordinates: 8,452
- exact PNU available (PNU_EXACT): 6,670 — only 28 of them are in the previous extract
- no usable PNU (LOT_PARSE_FAILED / INVALID_PNU / ambiguous): not included

`residual_parcel_targets_20260923.csv` (complex_id,pnu,sido_code; 6,670 rows; sha256 7cc59ee9d704ee09693251a0be4453f999c0af12e5c953e0873598df6f6b308b)

Re-run the same local extraction against the already downloaded `AL_D002_<sido>_20260908.zip` files with this
file as the target list (PNU field A1, EPSG:5186 → EPSG:4326, exact PNU only, PARCEL_REPRESENTATIVE_POINT), and upload
the resulting `national_parcel_representative_points.csv.gz` + summary. The cloud side then applies NULL-only fills
(`scripts/living/ingest-national-parcel-points.mjs`), SEMAS living delta and the school nearby delta.

Per sido: 12:1099 26:114 27:114 28:781 30:369 31:339 36:140 43:415 44:644 47:572 48:849 50:126 51:480 52:628
