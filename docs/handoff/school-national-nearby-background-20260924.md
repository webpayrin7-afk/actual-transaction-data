# Handoff — National SCHOOL Nearby Background Closeout

**Stopped at:** 2026-09-24T16:19:45Z (SIGTERM, graceful; no rollback)  
**Work name:** `[SCHOOL] NATIONAL SCHOOL NEARBY BACKGROUND FULL CLOSEOUT`  
**Branch:** `cursor/national-school-backfill-6d70`  
**PR:** https://github.com/webpayrin7-afk/actual-transaction-data/pull/116  

## Scripts / commands

| Role | Path | Command |
|------|------|---------|
| Detached start | `scripts/school-national-background-start.sh` | `bash scripts/school-national-background-start.sh` |
| Runner (write) | `scripts/school-national-background-runner.ts` | `npx tsx scripts/school-national-background-runner.ts --write` |
| Status | same | `npx tsx scripts/school-national-background-runner.ts --status` |
| Core helpers | `src/lib/school-national/national-runner.ts` | — |
| Nearby math (reuse) | `src/lib/school-national/nearby-delta.ts` | 1500m haversine, parcel-rep coord version |
| Unit tests | `scripts/test-school-national-runner.ts` | `npx tsx scripts/test-school-national-runner.ts` |
| Prior 8505 delta (done) | `scripts/school-nearby-delta-8505.ts` | historical; do not re-run as live handoff |

**Resume after Claude takeover:** same start script. Single-run lock at `data/poc/school-national/runner/runner.lock.json` (cleared on stop). Runtime dir is gitignored.

## Target tables (SCHOOL-owned writes only)

- `complex_nearby_schools`
- `complex_nearby_materialization`

**Do not write:** `apt_complex_master` / LIVING coords, `school_master`, `school_detail_snapshots`, assignment tables, PROFILE/BUILDING/TRANSACTION/AC/UI.

## Completion snapshot (DB at stop)

| Metric | Count |
|--------|------:|
| Canonical complexes | 27,524 |
| Coordinate-ready (IDENTITY-READY parcel point) | 22,130 |
| Nearby materialized | 22,130 |
| Nearby links | 327,579 |
| School master | 12,706 |
| School detail snapshots | 89,280 |
| Remaining WAIT_COORDINATE (approx) | 5,394 |

### By region (nearby / coord_ready / canon)

| Region | Nearby | Coord-ready | Canon |
|--------|------:|----------:|------:|
| SEOUL | 8,364 | 8,364 | 8,437 |
| GYEONGGI | 5,592 | 5,592 | 6,529 |
| INCHEON | 971 | 971 | 1,093 |
| BUSAN | 1,231 | 1,231 | 1,404 |
| DAEGU | 976 | 976 | 1,151 |
| DAEJEON | 513 | 513 | 561 |
| GWANGJU | 1,134 | 1,134 | 1,646 |
| ULSAN | 445 | 445 | 519 |
| SEJONG | 84 | 84 | 210 |
| GANGWON | 341 | 341 | 815 |
| CHUNGBUK | 357 | 357 | 756 |
| CHUNGNAM | 509 | 509 | 976 |
| JEONBUK | 269 | 269 | 851 |
| GYEONGBUK | 512 | 512 | 1,006 |
| GYEONGNAM | 689 | 689 | 1,395 |
| JEJU | 143 | 143 | 175 |

Note: At runner start (2026-09-23) baseline was nearby/coord **19,072**. While this runner idled on LIVING dependency polls, coord-ready+nearby grew to **22,130** (parity preserved). This process recorded **0** new relation inserts in its progress file; growth is attributable to concurrent LIVING (and/or other) work outside this runner’s write path—verify before assuming this runner applied those deltas.

## Last checkpoint

| Item | Value |
|------|--------|
| Progress | `data/poc/school-national/runner/progress.json` — `terminal_state=STOPPED`, `wave=IDLE_WAIT` |
| Checkpoint | `data/poc/school-national/runner/checkpoint.json` — `completed_ids=[]`, `retry_ids=[]` |
| Manifest | `data/poc/school-national/runner/target-manifest.json` (built at start; may be stale vs current 22,130) |
| Log | `data/poc/school-national/runner/runner.log.jsonl` — last event `signal SIGTERM` |
| Lock | cleared (no live PID) |
| Start snapshot (committed) | `data/poc/school-national/national-background-start.json` |

## Remaining scope

1. **WAIT_COORDINATE (~5,394):** no school API; wait for LIVING parcel coordinates (`PARCEL_REPRESENTATIVE_POINT`), then materialize nearby missing-only.
2. **LIVING follow:** poll every **15 minutes** (`DEPENDENCY_POLL_MS=900000`). Discover via DB (`coord-ready` without `complex_nearby_materialization`) and optional handoff file `data/poc/living/school-coordinate-ready-manifest.json` (do **not** treat historical `school-delta-newly-coordinate-ready.json` as live handoff).
3. **Final sweep:** when LIVING writes `data/poc/living/runner-terminal.json` with `status=COMPLETE|TERMINAL`, runner runs one missing-only sweep then exits `COMPLETE`.
4. **Detail missing-only (P4):** not started; nearby-linked BASIC was complete at start. No SchoolInfo refetch unless true gaps.
5. **Assignment / 배정:** HOLD — nearby ≠ assignment. Do not invent 배정학교.

## Failures / holds

- `retry_ids`: empty  
- `failed.jsonl`: none created  
- EXISTING_READY at start: **0** (already covered)  
- Held on LIVING coordinates for remaining national gap  

## External APIs (this runner)

- **None.** `external_calls=0` for the entire background session.  
- School master/detail reuse only; no SchoolInfo / NEIS acquisition in this closeout runner.  
- (Keys: not used / not logged.)

## Known issues / cautions

1. **Missing-only:** never rebuild the ~22k already-materialized nearby set unless `coord_version` changes (parcel-rep rebuild).
2. **Historical 8505 artifact** must not be re-queued as LIVING handoff (fixed in runner; only `school-coordinate-ready-manifest.json`).
3. **Long idle gap** in log (~00:16 → 16:19) with few dependency-check lines — host/session may have paused sleeps; on resume, rebuild manifest and re-scan DB for gaps.
4. Progress `coverage` fields can lag; always re-query Turso for truth before reporting FINAL.
5. Ownership: SCHOOL must not mutate LIVING coordinates or other agents’ tables.
6. UI / CORE “PILOT_ONLY” school UI is out of scope for this data job.

## Next for Claude session

1. Confirm no school runner PID; start with `bash scripts/school-national-background-start.sh` if continuing.  
2. Re-query coord-ready vs nearby; process any missing-only delta first.  
3. Continue LIVING follow until WAIT_COORDINATE drains or LIVING terminal + final sweep.  
4. Emit `[SCHOOL — NATIONAL SCHOOL FULL CLOSEOUT FINAL]` when done.
