# Phase 6.0 — Apartment Master v1 (architecture + dry-run)

Local-only. **No production writes. No migrations executed.**

## Identity audit (current)

| Surface | Key | Grain |
|---|---|---|
| `transactions` | `(lawd_cd, apt_name_norm)` | warehouse complex |
| `apt_catalog` | `(apt_name_norm, gu)` | autocomplete (no lawd) |
| Phase 5 pilot | `complex_key` slug | hand-authored 6 complexes |
| Phase 5.8–5.11 PoC | `lawd:apt_name_norm` | Seoul/Gyeonggi scan |
| Market typeKey | `apt_norm\|lawd\|dong\|area100` | listing type |

**Problems:** name-only is not unique; pilot slug ≠ warehouse; catalog ignores lawd; rename splits history; Phase 5 children soft-join on `complex_key` without FK.

**Recommendation:** opaque immutable `complex_id`. Map MOLIT / parcel / registry / map keys through `apt_complex_source_links`.

## Proposed schema

See `schema_proposal.sql`:

- `apt_complex_master` — core identity + address + identity_status
- `apt_complex_source_links` — `(source, source_key) → complex_id`
- `apt_complex_enrichment_state` — generic `(complex_id, domain)` status with `data_version` (lazy insert preferred)

Domains: `BUILDING_REGISTRY`, `GEO`, `UNIT_GROUP`, `SINGOGA_BASELINE`, `SCHOOL`, `FLOORPLAN`.

## Incremental processing

| Case | Mechanism |
|---|---|
| Missing-only | `WHERE domain=? AND status != 'READY'` |
| Version refresh | `WHERE domain=? AND data_version < :target` |
| Full rescan | explicit job sets `STALE` or bumps required version |
| Write minimization | lazy status rows; no high-frequency dirty queue |

## Phase 5 integration (conceptual only)

Keep `complex_key` temporarily. Add nullable `complex_id` later + resolve via MOLIT source link. Do not migrate classifications / groups / baselines in 6.0.

## Building registry

Optional enrichment. Acquire only when a feature needs it, identity is PARCEL-EXACT, status ≠ READY, in controlled batches, cache READY, no refetch of unchanged READY.

Classifier may still require registry — leave semantics unchanged; model as `BUILDING_REGISTRY` domain dependency of `UNIT_GROUP`.

## Dry-run artifacts

- `report.json`
- `bootstrap_manifest_sample.json`
- `bootstrap_identity_status.jsonl`

Run: `python3 scripts/phase60_apartment_master_dryrun.py`
