# ZIPLAB Handoff — 2026-09-24 Stop

**Stopped at:** 2026-09-24 (this Cloud Agent VM)  
**Reason:** ZIPLAB stop request — subsequent loads continue in a Claude session.  
**This VM ingest status:** no living/coordinate/price-position/backfill loops were running; no new batches started. Stale LIVING `runner.lock` (pid 22350, not alive on this VM) removed; progress/checkpoint artifacts left intact for resume.

---

## 1. Price Position V3 — published (DONE)

| Field | Value |
| --- | --- |
| Work | Region representative pyeong price V3 publish |
| Branch | `cursor/price-position-v3-latest-audit-db5b` |
| PR | https://github.com/webpayrin7-afk/actual-transaction-data/pull/132 |
| Base | `cursor/sample-confidence-v2-db5b` |
| Scripts | `scripts/region-ranking/build-price-position-v3.mts` |
| Lib | `src/lib/region-ranking/price-position-v3.ts`, `price-position-v21.ts` (`regionPriceMode: LATEST_ACTIVE`), `price-position-read.ts` |
| Run | `npx tsx scripts/region-ranking/build-price-position-v3.mts` (dry-run) / `--apply` (publish) |
| Version | `price-position-v3` · snapshot `price-position-v3\|2026-09-17` |
| Fingerprint | `v3\|latest-active\|equal-complex-weight\|median-of-complex-means\|soft-stale\|…` |
| Tables | `complex_region_price_position` |
| Rows | ~10940–10942 (first publish 10940; +2 live warehouse growth on one re-apply) |
| Public pointer | `PRICE_POSITION_PUBLIC_VERSION = price-position-v3` |
| Preserved | v2.3 / v2.3.1 / v2.3.2 untouched |
| Trend | Unchanged (sample-confidence-v2); same-source V2.3.2 regression gate |
| Checkpoint | Report: `/tmp/building-hub-bulk/external-evidence/v3-publish-report.json` · bodies `/tmp/v3-bodies/` |
| Coverage note | Publish “918 regional ok” ≠ audit “6442”; 6442 is V2.3.2 `referenceMonth`-keyed denominator. Reconciliation: `PASS_REPORTING_ONLY` (artifact `/tmp/building-hub-bulk/external-evidence/v3-coverage-reconcile.json`) |

**Do not:** overwrite/delete older PP snapshots; change trend methodology; UI redesign in CORE.

---

## 2. Complex detail completeness audit (DONE, read-only)

| Field | Value |
| --- | --- |
| Work | National complex-detail data completeness matrix |
| Script (ephemeral) | `/tmp/complex-detail-completeness-audit.cjs` (not committed) |
| Artifact | `/tmp/building-hub-bulk/external-evidence/complex-detail-completeness-audit.json` |
| Universe | master 27524 · Seoul 8437 · Gyeonggi 6529 |
| Verdict | `TARGETED_BACKFILL_REQUIRED` |
| Writes | DB 0 · external API 0 |

**Launch gaps (priority):** Gyeonggi profile ≈empty; Seoul chip2+ sparse; KAPT/fee missing; Ranking/PP V3 API-ready but AptDetail UI not wired; school materialization PILOT_ONLY.

---

## 3. LIVING national coordinate backfill — STOPPED / handoff

| Field | Value |
| --- | --- |
| Work | Missing-only national parcel coordinates + living handoff |
| Authoritative branch | `cursor/living-national-snapshots-5774` |
| Script | `scripts/living/run-national-coordinate-backfill.py` |
| Start | `bash scripts/living/start-national-coordinate-backfill.sh` |
| Last argv | `scripts/living/run-national-coordinate-backfill.py --daemon --max-cycles=12` |
| Last pid | 22350 (not running on this VM at stop time) |
| Runtime dir (sample/stale on this VM) | `/tmp/living-map/data/poc/living/runner/` and branch `data/cache/living-runner/` / `data/poc/living/runner/` |
| Tables | `apt_complex_master` (lat/lng), `complex_parcel_coordinates`, living snapshots/readiness |

### Coverage checkpoint (last known)

| Metric | Count |
| --- | --- |
| Canonical | 27524 |
| Coordinate ready | 19072 |
| Missing | 8452 |
| `HAS_PNU_NO_GEOMETRY` | 7680 |
| `AMBIGUOUS_PARCEL` | 758 |
| `NO_PNU_IDENTITY_GAP` | 14 |
| Seoul missing (PNU no geom) | 73 |
| Gyeonggi missing | 937 |
| Wave | WAVE1_LOCAL then WAVE2_EXTERNAL probe |
| Wave1 fills (residual) | 0 |
| Coord added this runner cycle | 0 |

**Checkpoint files:** `progress.json`, `start-summary.json`, `runner.lock` (removed as stale on this VM), `checkpoint.json` / `heartbeat.jsonl` / `target-manifest.jsonl` when present under living-runner cache on the living agent host.

**Last progress markers:** `current_region=50`, `current_complex_id=cx_fe516cc013aae6d4`, `processed=772`, `remaining=7680`.

### Remaining / blockers

1. **7680 `HAS_PNU_NO_GEOMETRY`** — exact PNU exists; AL_D002 geometry not joined. VWorld `www.vworld.kr` + `api.vworld.kr` returned **HTTP 502** (temporary host outage). Official endpoint still documented on data.go.kr `15045882`.
2. Local AL_D002_20260908-derived Seoul/Busan/Daegu full point CSVs do **not** contain residual PNUs (exact miss; not a join-bug). Same vintage re-join will not unlock those proven misses.
3. Prefer: wait for VWorld recovery → download **newer** daily AL_D002 sido ZIPs → `PARCEL_REPRESENTATIVE_POINT` (point_on_surface) join → apply. Optional: expanded re-extract from offline Windows archives `C:\data\cadastre\2026-09\` if still present.
4. **Do not** use Naver/Kakao/Google geocode, building centroid, or dong centroid.
5. Leave **AMBIGUOUS 758** and **IDENTITY 14** as separate cohorts.

### External API (coordinate path)

| Source | Today on this stop VM |
| --- | --- |
| VWorld AL_D002 download / catalog / WFS | Probe only; **502** — no successful downloads |
| Call volume (this audit VM) | Small probe set only (catalog, fileNo 4604/4612, portal, WFS GetCapabilities) — **0 successful geometry downloads** |
| Keys | None used / do not embed keys in handoffs |

Fallback audit artifact: conversation CORE parcel geometry fallback; sample join under `/tmp/living-audit/` (ephemeral).

---

## 4. Other notes for Claude session

- **No production app deploy** from these CORE tasks; PP V3 snapshot publish already done earlier.
- **Ranking V3 / Transaction / AC / Supply / School / Living / 3D** — do not collide; living coord unlock enables school nearby later without school writes in the geometry step.
- Price Position public read already points to V3; UI integration still pending (label `지역 대표 평당가`, no SAME_MONTH “2026.09 거래 기준” copy).
- Untracked dirs often present in worktrees: `scripts/national-coordinates/`, `scripts/national-master/` — do not commit unless intentional.

## 5. Resume commands (when Claude continues)

```bash
# Living coordinates (only after VWorld healthy or local archives ready)
bash scripts/living/start-national-coordinate-backfill.sh
# or
python3 scripts/living/run-national-coordinate-backfill.py --daemon --max-cycles=12

# Price Position V3 (already published; dry-run only unless intentional)
npx tsx scripts/region-ranking/build-price-position-v3.mts
```

**Stop confirmation:** this agent will not start further ingest batches on this VM.
