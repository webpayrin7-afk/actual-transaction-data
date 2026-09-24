# Handoff — National Building/Unit Missing-Only Closeout

**Stopped at:** 2026-09-24 (ZIPLAB stop request). No further batches started.
**Status at stop:** Background runner already finished its actionable queue (`completed: true`). Processes and tmux sessions killed. Lock released.

---

## 작업명

National missing-only building inventory + unit/area closeout (BUILDING agent)

- Exact Type V2 Core-ID publish is **FROZEN** — do not rerun or republish.

## Branch / commits

- Branch: `cursor/national-complex-building-topology-7f90`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/115
- Closeout runner commit: `980a49b`
- Start-gate refresh: `8bf5e2f`
- Frozen Exact Type V2 publish commit: `301600a`

## Scripts / commands

| Purpose | Path | Command |
|---|---|---|
| Closeout runner (detached) | `scripts/building-topology/national-closeout-runner.mts` | `npx tsx scripts/building-topology/national-closeout-runner.mts --daemon --apply --wave=all --batch=20 --max-api=3000` |
| npm alias | `package.json` → `building:national-closeout` | `npm run building:national-closeout -- --daemon --apply --wave=all` |
| Classify helpers (tested) | `src/lib/buildings/closeout-classify.ts` | used by tests |
| **DO NOT RUN** Exact V2 republish | `scripts/building-topology/publish-exact-type-v2.mts` | frozen |

Resume (only if intentionally continuing):

```bash
npx tsx scripts/building-topology/national-closeout-runner.mts --daemon --apply --wave=all --batch=20 --max-api=3000
```

Artifacts dir (lock/checkpoint/heartbeat/log):

`data/poc/building-topology/national-closeout/`

---

## Frozen Exact Type V2 baseline (read-only)

- Version: `building-unit-link|buildinghub-2026-08|exact-dong-v2-core-area-key`
- Exact complexes: **7,382**
- Exact links: **93,446**
- Inserts/updates at publish: 90,688 / 16
- Idempotent rerun: 0 / 0 / 0
- Commit: `301600a`
- Verified unchanged after closeout (no republish)

---

## Target tables (BUILDING-owned writes only)

Written / touched by closeout:

- `unit_type_stats` — WAVE1 mirror from Core (`INSERT OR IGNORE`, 6,881 rows)
- `complex_buildings` — title upsert path (WAVE2; **0** new residential inserts this run)
- `complex_building_checkpoint` — title/link status updates
- `unit_type_building_links` — attempted deterministic OUAC links only (**0** public EXACT inserts; all held `AMBIGUOUS_OR_NO_PUBLIC`)

**Not written (isolation):**

- `apt_complex_profile` and PROFILE fields (`household_count`, profile `building_count`, `approval_date`, `max_floor`, FAR, BCR, heating, parking)
- `apt_canonical_unit_types` (Core) — supply/unit gaps remain Core-owned
- Transactions / ranking / price / AC / V2 exact-link republish

---

## Coverage at stop (national 27,524)

| Metric | Count | % |
|---|---:|---:|
| Building inventory (any row) | 17,614 | 64.0% |
| Building residential EXACT | 17,295 | 62.8% |
| Unit types (Core) | 18,664 | 67.8% |
| Exclusive area | 18,664 | 67.8% |
| Supply area (`supply_cents > 0`) | 17,051 | 61.95% |
| Exact type↔building complexes | 7,382 | — |
| Exact type↔building links | 93,446 | — |
| AREA_SELECTOR_READY | 18,664 | 67.8% |
| SUPPLY_PYEONG_READY | 17,051 | 61.95% |

### By region (residential EXACT building / unit / supply over master total)

| Region | Building | Unit | Supply |
|---|---|---|---|
| SEOUL | 8095/8437 | 8437/8437 | 8023/8437 |
| GYEONGGI | 5442/6529 | 6528/6529 | 5341/6529 |
| INCHEON | 248/1093 | 243/1093 | 243/1093 |
| BUSAN | 403/1404 | 396/1404 | 384/1404 |
| DAEGU | 440/1151 | 434/1151 | 434/1151 |
| DAEJEON | 167/561 | 165/561 | 165/561 |
| GWANGJU | (see coverage-now.json) | | |
| ULSAN | 151/519 | 145/519 | 145/519 |
| SEJONG | 28/210 | 27/210 | 27/210 |
| GANGWON | 286/815 | 287/815 | 287/815 |
| CHUNGBUK | 287/756 | 284/756 | 284/756 |
| CHUNGNAM | 287/976 | 281/976 | 281/976 |
| JEONBUK | 181/851 | 188/851 | 188/851 |
| JEONNAM | 469/1646 | 456/1646 | 456/1646 |
| GYEONGBUK | 338/1006 | 334/1006 | 334/1006 |
| GYEONGNAM | 453/1395 | 439/1395 | 439/1395 |
| JEJU | 20/175 | 20/175 | 20/175 |

Full rollup: `data/poc/building-topology/national-closeout/coverage-now.json`

---

## Last checkpoint

| Item | Value |
|---|---|
| Checkpoint file | `data/poc/building-topology/national-closeout/checkpoint.json` |
| Progress file | `data/poc/building-topology/national-closeout/progress.json` |
| Heartbeat | `data/poc/building-topology/national-closeout/heartbeat.json` (`phase: done`) |
| Cursor | **1332 / 1332** (actionable queue exhausted) |
| Last complex ID | `cx_fff5be86f19faafe` |
| Completed flag | `true` |
| Wave1 checkpoint | `checkpoint-wave1.json` / `progress-wave1.json` (unit_type_stats project: 6,881 inserts, apiCalls 0) |
| Lock | released (`run.lock` absent) |

Manifest: `data/poc/building-topology/national-closeout/missing_inventory.json`  
Applied ops log: `data/poc/building-topology/national-closeout/applied.jsonl`  
Runner log: `data/poc/building-topology/national-closeout/runner.log`

---

## What this run did

1. **WAVE1 local (0 external API)**  
   - Projected Core `apt_canonical_unit_types` → BUILDING `unit_type_stats` (**6,881** rows).  
   - Attempted deterministic type↔building links where OUAC had dong+ho: **0** public EXACT inserts (581 resolutions `AMBIGUOUS_OR_NO_PUBLIC`, held).

2. **WAVE2 title (existing BldRgstHub title pipeline, force refresh)**  
   - Seoul/Gyeonggi EMPTY building-inventory retries.  
   - **1,133** live title API page-calls attributed in progress (`apiCalls: 1133`).  
   - Applied TITLE_FETCH ops: 1,206 recorded; status **EMPTY** for all sampled results → **0** new residential building inserts.

---

## Remaining gaps (for next Claude session)

Manifest missing counts at stop:

| Gap | Count |
|---|---:|
| Building (no residential EXACT) | 10,229 |
| Unit type (no Core types) | 8,860 |
| Supply area (`supply_cents > 0` absent) | 10,473 |
| Type↔building exact link absent | 20,142 |

Actionable for this runner was only **1,332** (TITLE_FETCH 1,133 + ATTEMPT_LINK 199). Rest classified terminal / skip:

- **NO_PARCEL / IDENTITY_GAP** — large national share (title checkpoint `NO_PARCEL` ≈ 8,766 historically)
- **title_EMPTY** outside P0 retry or after force-refresh still empty
- **title_non_residential_only** — SUCCESS/SKIP_CACHED but residential_flag 0
- **SUPPLY_AREA_UNAVAILABLE** — Core has exclusive but `supply_cents = -1` (sentinel); **do not invent** supply pyeong from exclusive㎡
- **ouac_missing_dong_ho** — BuildingHubBulk OUAC (~17k complexes) has **0** dong/ho rows; cannot deterministic-link without local unit-grain evidence (filtered bulk / compact package path)

### Failures / holds

- `failed_targets.jsonl`: **none** (0 failures)
- Link holds: **251** (progress) / applied link resolutions all non-public
- Title force-refresh: reconfirmed EMPTY (no inventory gain)

---

## External API / call volume

| API | Use | Calls this closeout |
|---|---|---:|
| 건축물대장 표제부 `BldRgstHubService/getBrTitleInfo` (data.go.kr) | WAVE2 EMPTY title force-refresh | **1133** (`progress.apiCalls`) |
| Exact V2 / Core join | not run | 0 |
| GIS / VWorld / NSDI | not used this job | 0 |

Env used: `MOLIT_API_KEY` (value not recorded). Cap was `--max-api=3000`.

---

## Known issues / cautions

1. **Do not republish Exact Type V2** — frozen at 7,382 / 93,446.
2. **Do not write PROFILE-owned fields** — PROFILE agent projects separately.
3. **Do not write Core `apt_canonical_unit_types`** from BUILDING — unit/supply % for CORE audit will not move until Core/supply pipeline fills them; BUILDING only mirrors to `unit_type_stats`.
4. **Never invent supply** from exclusive area (`84㎡ → 33평` forbidden). Core uses `supply_cents = -1` as unavailable.
5. **BuildingHubBulk OUAC lacks dong/ho** — link expansion needs the local filtered unit bulk / compact exact package evidence, not OUAC area-only rows.
6. **Title EMPTY retries exhausted for P0** — live force-refresh did not create residential buildings; further title API churn is low value without new parcel identity.
7. **44GB raw BuildingHUB rescan** — still forbidden unless parent 표제부 PK proven missing; prefer filtered 2026-08 artifacts.
8. Runner single-run lock + checkpoint already implemented; if restarting, reclaim only stale lock (no live PID).

---

## Suggested next steps (Claude session)

1. Treat Exact V2 as frozen; measure remaining building/supply gaps vs `coverage-now.json`.
2. For supply/unit Core gaps: hand off to Core/supply owner or reuse official supply evidence only — not BUILDING invent.
3. For type↔building expansion: only when new deterministic local evidence (dong+ho or compact V2-class area keys) appears; no fuzzy links.
4. For building inventory: new official identity/parcel sources required for NO_PARCEL / persistent EMPTY — do not spam title API.
