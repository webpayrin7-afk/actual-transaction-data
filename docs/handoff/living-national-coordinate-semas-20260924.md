# Handoff — LIVING national coordinate + SEMAS living snapshots

**Stopped at (UTC):** 2026-09-24T16:22:22Z  
**Work name:** LIVING — national parcel coordinate recovery + SEMAS living snapshots (missing-only backfill)  
**Branch:** `cursor/living-national-snapshots-5774`  
**PR:** https://github.com/webpayrin7-afk/actual-transaction-data/pull/117  
**Last commits on this branch (relevant):** `4561d99` (runner self-test), `c2caa8f` (background runner), earlier parcel ingest / SEMAS delta commits through `a166257`

---

## Scripts and how to run

| Role | Path | Command |
|------|------|---------|
| Background missing-only runner (STOPPED) | `scripts/living/run-national-coordinate-backfill.py` | `bash scripts/living/start-national-coordinate-backfill.sh` → `python3 -u scripts/living/run-national-coordinate-backfill.py --daemon --max-cycles=12` |
| National AL_D002 package ingest (NULL fill only) | `scripts/living/ingest-national-parcel-points.mjs` | `node scripts/living/ingest-national-parcel-points.mjs --input=data/poc/living/national_parcel_representative_points.csv.gz` then `--commit` |
| Local PNU join (Seoul/Busan/Daegu extracts) | `scripts/living/recover-parcel-coordinates.py` | `python3 scripts/living/recover-parcel-coordinates.py` |
| SEMAS materialize | `scripts/living/materialize-complex-living.py` | `python3 -u scripts/living/materialize-complex-living.py --zip data/cache/semas/semas_20260630.full.zip --complexes <new.jsonl> --out-db <out.db> --report-dir <dir> --publication-count <N>` |
| SEMAS apply to Turso | `scripts/living/apply-living-snapshots.ts` | `npx tsx scripts/living/apply-living-snapshots.ts --commit --local=<out.db> --batch=80` |
| Parcel NULL fill (legacy EXACT_PRIMARY) | `scripts/living/apply-parcel-coordinates.mjs` | `node scripts/living/apply-parcel-coordinates.mjs --commit --safe=<jsonl>` |
| Tests | `package.json` `test:living` | `npm run test:living` |

**Semantics (frozen):** `PARCEL_REPRESENTATIVE_POINT` only. No geocoding, building centroid, or guessed points.  
**SEMAS version:** `SEMAS_2026Q2` / snapshot `living_v1`. Radii 500m and 1000m. PARK = HOLD / NO_SOURCE.

---

## Target tables (this agent’s ownership)

**Allowed / used**

- `apt_complex_master.latitude` / `longitude` (NULL fill only)
- `complex_parcel_coordinates` (provenance)
- `complex_living_snapshots`
- `complex_living_readiness`
- `complex_living_publications`
- `living_category_rules`

**Not written by this work**

- SCHOOL, PROFILE, BUILDING-owned, TRANSACTION, AC, ranking, price-position, supply

---

## Production coverage at stop (canonical master = 27,524)

| Region (sido_code) | Master | Coordinate-ready | Missing |
|--------------------|-------:|-----------------:|--------:|
| 서울 11 | 8,437 | 8,364 | 73 |
| 경기 41 | 6,529 | 5,592 | 937 |
| 인천 28 | 1,093 | 971 | 122 |
| 부산 26 | 1,404 | 1,231 | 173 |
| 대구 27 | 1,151 | 976 | 175 |
| 대전 30 | 561 | 513 | 48 |
| 전남광주통합 12 | 1,646 | 1,134 | 512 |
| 울산 31 | 519 | 445 | 74 |
| 세종 36 | 210 | 84 | 126 |
| 강원 51 | 815 | 341 | 474 |
| 충북 43 | 756 | 357 | 399 |
| 충남 44 | 976 | 509 | 467 |
| 전북 52 | 851 | 269 | 582 |
| 경북 47 | 1,006 | 512 | 494 |
| 경남 48 | 1,395 | 689 | 706 |
| 제주 50 | 175 | 143 | 32 |
| **NATIONAL** | **27,524** | **22,130** | **5,394** |

**Living (SEMAS_2026Q2 / living_v1)**

- COMPLETE readiness: **22,130**
- NO_COORDINATE: **5,394**
- Distinct complexes with 500m snapshots: **22,130**
- Distinct complexes with 1000m snapshots: **22,130**
- National living ready ≈ **80.4%** (22,130 / 27,524)

Note: Between this branch’s last documented fill (~19,072 ready) and stop, production ready/living rose to 22,130. The Cursor background runner on this branch recorded **0** additional coordinate fills (see checkpoint). Extra fills likely came from another concurrent session; do not assume all deltas are from `run-national-coordinate-backfill.py`.

---

## Last checkpoint (this runner)

| Item | Value |
|------|--------|
| Dir | `data/cache/living-runner/` (gitignored cache; recreate via scripts if needed) |
| Checkpoint file | `data/cache/living-runner/checkpoint.json` |
| Progress | `data/cache/living-runner/progress.json` |
| Heartbeat | `data/cache/living-runner/heartbeat.jsonl` (175 lines at stop) |
| Manifest | `data/cache/living-runner/target-manifest.jsonl` (8,452 rows = missing at runner start) |
| Milestone | `data/cache/living-runner/seoul-gyeonggi-milestone.json` |
| Lock | Removed on stop (`runner.lock` deleted) |
| PID | Was 22350; process killed after SIGTERM during inter-cycle sleep |

**Checkpoint summary at stop**

- wave: `WAVE2_EXTERNAL`
- started_at: `2026-09-23T05:07:36Z`
- updated_at: `2026-09-24T00:16:04Z` (last successful segment before sleep)
- filled_ids: **0**
- completed_ids: **772** (758 AMBIGUOUS + 14 IDENTITY_GAP)
- terminals on remaining HAS_PNU_NO_GEOMETRY: **FAILED_RETRYABLE** (7,680) — VWorld AL_D002 download unreachable
- segments_completed: 11
- vworld_ok: false

**Classification of the 8,452 missing at runner start**

- HAS_PNU_NO_GEOMETRY: 7,680 (Seoul 73, Gyeonggi 937, rest national)
- AMBIGUOUS_PARCEL: 758
- NO_PNU_IDENTITY_GAP: 14

---

## Remaining work

1. **Seoul 73 / Gyeonggi 937** — exact jibun → PNU exists; official AL_D002 geometry not in local extracts; VWorld `downloadResourceFile` returned 502 / empty reply throughout WAVE2.
2. **~5,394 national NO_COORDINATE** at stop (includes Seoul/Gyeonggi gaps plus other sidos). Re-export missing from Turso before any new pass; do not reuse the stale 8,452 manifest blindly.
3. **Living delta** — for each newly coordinate-ready complex only: materialize SEMAS_2026Q2 500m+1000m, apply idempotently. Do not rebuild existing same-coordinate / same-version snapshots.
4. **School handoff** — append-only path: `data/poc/living/school-coordinate-ready.jsonl` (and earlier `school-delta-newly-coordinate-ready.json`). This agent does **not** write SCHOOL tables.
5. **Unresolved backlog from national package summary** — PNU_NOT_FOUND 1,006 · INVALID_GEOMETRY 10 · master without reproducible exact PNU (large identity gap). No inventing coordinates.

---

## External APIs used (no key values)

| Host / API | Purpose | This runner’s call volume |
|------------|---------|---------------------------|
| `www.vworld.kr` `downloadResourceFile.do` (ds_id=20171128DS00002, sido fileNo) | Official AL_D002 SHP download probe | **480** HTTP attempts; **320** retries; **263** counted as 5xx-class; **0** 429; **0** successful downloads |
| Turso / libSQL (`TURSO_DATABASE_URL`) | Production read/write for master + living tables | Batch DB writes during prior ingest/apply; runner stop had no new fills |
| data.go.kr / SEMAS zip | Local cache only: `data/cache/semas/semas_20260630.full.zip` | No re-download in runner |

**Do not** introduce Naver/Kakao geocoders or building centroids as parcel points.

---

## Known issues / cautions

1. **VWorld is the blocker** for the remaining exact-PNU / no-geometry set. Host was 502 / `RemoteDisconnected` for the entire daemon window. Do not invent points while waiting.
2. **Runner sleep ignored mid-sleep SIGTERM** until sleep ended; stop used SIGKILL after checkpoint was already persisted. Next start: `bash scripts/living/start-national-coordinate-backfill.sh` (single-run lock).
3. **Manifest at `target-manifest.jsonl` is stale vs current missing** — rebuild from live `apt_complex_master` where lat/lng NULL.
4. **Concurrent agents** may have filled coordinates/living outside this runner; always re-census before claiming credit or overwriting. Never overwrite existing positive verified coordinates; conflict → HOLD.
5. **Gwangju/Jeonnam** are one master sido (`12` 전남광주통합특별시). Do not double-count as separate 광주 + 전남.
6. **Idempotency:** same SEMAS_2026Q2 + same coordinate → snapshot apply should be 0 inserts / 0 updates.
7. Cache under `data/cache/` is gitignored (living-runner, semas zip, parcel zips). POC evidence under `data/poc/living/` is on the branch.
8. UI / deploy / merge were out of scope for this work.

---

## Suggested next step for Claude session

1. Re-census Turso coordinate + living completeness.  
2. If AL_D002 SHP becomes available: exact-PNU join → NULL fill only → SEMAS missing-only delta → append school handoff.  
3. If host still down: leave SOURCE_UNAVAILABLE / FAILED_RETRYABLE; no guessed coordinates.  
4. Resume command when ready: `bash scripts/living/start-national-coordinate-backfill.sh`
