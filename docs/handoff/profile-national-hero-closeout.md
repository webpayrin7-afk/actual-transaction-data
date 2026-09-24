# Handoff — PROFILE National HERO Closeout

## 작업명
PROFILE — National Complex Profile Background Full Closeout  
(Seoul+Gyeonggi P0 → national continuation, missing-only / NULL_SAFE_FILL)

## 상태
**STOPPED** — runner already terminal `COMPLETE` (`wave=DONE`) before stop request.  
No live processes, no timer subscriptions, no new batches started.  
Rollback not performed.

## 브랜치 / PR
- Branch: `cursor/seoul-hero-profile-safe-fill-5254`
- Base: `main`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/122
- Latest closeout commit (pre-handoff): `e4c0dae`

## 스크립트 경로 · 실행 명령

| 용도 | 경로 | 명령 |
|---|---|---|
| Detached start | `scripts/profile-national-background-start.sh` | `bash scripts/profile-national-background-start.sh` |
| Daemon | `scripts/profile-national-background-runner.ts` | `npx tsx scripts/profile-national-background-runner.ts --run` |
| Manifest init | same | `npx tsx scripts/profile-national-background-runner.ts --init-manifest` |
| Status | same | `npx tsx scripts/profile-national-background-runner.ts --status` |
| Watchdog | `scripts/profile-national-watchdog.sh` | started by start script |
| Shared lib | `scripts/profile-national-lib.ts` | — |
| Unit tests | `scripts/test-profile-national-background.ts` | `npx tsx scripts/test-profile-national-background.ts` |
| After metrics | `scripts/profile-national-closeout-metrics.ts` | `npx tsx scripts/profile-national-closeout-metrics.ts` |
| Idempotency check | `scripts/profile-national-idempotency-check.ts` | `npx tsx scripts/profile-national-idempotency-check.ts` |

Env: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (and existing KAPT / BuildingHub keys already used by lib — do not log key values).

## 대상 테이블 (PROFILE-owned writes only)
- `apt_complex_profile` (NULL_SAFE_FILL inserts/updates)
- `apt_complex_source_links` (exact KAPT link upsert; `match_tier` column must not be used)
- Read-only reuse: `apt_complex_master`, building inventory / `complex_buildings`, caches under `data/poc/profile-national/cache/`

Do **not** write: TRANSACTION, Ranking, Price Position, AC, Supply, School, Living, 3D, UI, BUILDING methodology tables.

## 완료 범위

### Runner progress (`data/poc/profile-national/progress.json`)
- Terminal: `COMPLETE` / `wave=DONE`
- Started: `2026-09-23T05:06:51.829Z` → Done: `2026-09-23T21:38:25.950Z` (~16.5h)
- Manifest targets processed: 27,191 incomplete at start (universe 27,524)
- completed counter: 27,361 · remaining: 0
- success: 20,883 · conflict: 353 · no_source: 8,635 · failed: 134 · ambiguous: 2,042
- local_completed (Wave1): 9,259 · api_completed: 27,359
- writes: inserted 14,533 · updated 6,350 · deleted 0

### DB coverage after (`data/poc/profile-national/final-report.json`)

National 27,524 — profile_rows 22,670 · hh 14,424 · bld 13,145 · ap 12,102 · mf 22,608 · FAR 5,567 · BCR 5,556 · heat 9,771 · parking/hh 13,510

| Region | total | profile_rows | household | building | approval | max_floor |
|---|---:|---:|---:|---:|---:|---:|
| SEOUL | 8437 | 8131 | 2991 | 2344 | 1928 | 8121 |
| GYEONGGI | 6529 | 5476 | 3827 | 3195 | 2565 | 5452 |
| INCHEON | 1093 | 673 | 545 | 545 | 545 | 671 |
| BUSAN | 1404 | 893 | 682 | 682 | 682 | 889 |
| DAEGU | 1151 | 905 | 761 | 761 | 762 | 904 |
| DAEJEON | 561 | 413 | 364 | 364 | 364 | 413 |
| ULSAN | 519 | 398 | 365 | 365 | 365 | 397 |
| SEJONG | 210 | 166 | 158 | 158 | 158 | 166 |
| GANGWON | 815 | 646 | 548 | 548 | 548 | 642 |
| CHUNGBUK | 756 | 593 | 505 | 505 | 505 | 589 |
| CHUNGNAM | 976 | 741 | 639 | 639 | 639 | 739 |
| JEONBUK | 851 | 605 | 542 | 542 | 542 | 605 |
| GYEONGBUK | 1006 | 792 | 671 | 671 | 671 | 789 |
| GYEONGNAM | 1395 | 1090 | 934 | 934 | 935 | 1085 |
| JEJU | 175 | 126 | 120 | 120 | 120 | 126 |
| GWANGJU_JEONNAM (combined) | 1646 | 1022 | 772 | 772 | 773 | 1020 |

HERO buckets after (`after-hero-buckets.json`): FULL 592 · GOOD 9,974 · PARTIAL 12,102 · NO_PROFILE 4,856  
(before from initial manifest: FULL 333 · GOOD 1,036 · PARTIAL 6,763 · NO_PROFILE 19,392)

Launch core chips (0+1 weak): 12,243 → 8,418

## 마지막 체크포인트
- File: `data/poc/profile-national/checkpoint.json`
- `wave`: `DONE`
- `cursor`: `27512`
- `done_ids` length: 36,450
- `updated_at`: `2026-09-23T21:38:25.950Z`
- Last complex id in progress: `cx_ffc5475d48b2900b` (GWANGJU_JEONNAM)
- Also: `progress.json`, `final-report.json`, `seoul-gyeonggi-milestone.json`, `target-manifest.jsonl`, `retry-queue.jsonl`, `runner.log`, `watchdog.log`
- Lock: released (`runner.lock` marked stopped_for_handoff)

## 남은 범위
1. **NO_PROFILE ~4,856** — no deterministic official source/identity under current rules (do not guess).
2. **Seoul weak chips** still high (~5,709 with 0–1 core chips) — mostly lacking exact KAPT / BuildingHub identity.
3. **Non-capital FAR/BCR ≈ 0** outside Seoul/Gyeonggi under current official endpoints (KAPT FAR/BCR intentionally not applied).
4. **Retry queue 173** — deferred FAILED_RETRYABLE / watchdog skips (see below); optional later pass only with same NULL_SAFE_FILL rules.

## 실패 · 보류 목록 · 사유
- `data/poc/profile-national/retry-queue.jsonl` (173 lines):
  - ~145 `LibsqlError` / SQLITE lock / unknown (Turso contention during long run)
  - 21 `watchdog_stale_skip` (progress stalled >~15m on one complex; complex marked done and skipped)
  - 3+ `TimeoutError` / `complex_timeout_90s`
  - assorted manual/hang skip notes from earlier recoveries
- progress counters: failed 134 · conflict 353 · ambiguous 2,042 · no_source 8,635
- Policy holds (by design): no FAR/BCR from KAPT; no building-row COUNT/SUM → profile household/building_count; parking conflicts stay NULL (e.g. Jamsil Els).

## 외부 API · 호출량 (키 값 기재 금지)
- **KAPT** open API V5 basic/detail (existing PROFILE pipeline)
- **BuildingHub** `getBrRecapTitleInfo` (official building register recap)
- Approx external HTTP calls across ~27 daemon sessions: **~43,609** (sum of per-session api counters; last session alone reported 874 at DONE)
- Observed during run: http429 ≈ 0 overall; intermittent http5xx / timeouts; auto reconnect + sleep backoff
- Local-only Wave1: 0 external calls (complex_buildings max_floor)

## 알려진 문제 · 주의점
1. Event-loop stalls ignore in-process Promise timeouts → **external watchdog required** (`scripts/profile-national-watchdog.sh`). Do not run Wave2 long without it.
2. KAPT V5 response shape is `body.item` (singular), not `body.items.item`. Prefer `hoCnt` when `kaptdaCnt=0`.
3. Source-link INSERT must **not** use nonexistent `match_tier` column.
4. `remaining` can hit 0 slightly before loop drain if completed counter ≥ total_targets; trust `wave=DONE` / `terminal=COMPLETE`.
5. Gwangju+Jeonnam tracked as combined region key `GWANGJU_JEONNAM` (lawd prefixes 12/29/46) — do not mix with TRANSACTION historical-lawd issues.
6. Large untracked runtime artifacts: `cache/` (~96MB), `target-manifest.jsonl` (~14MB), `checkpoint.json` — keep local for resume; not all committed.
7. Idempotency sample (empty candidate bags on filled profiles): insert 0 / update 0 / delete 0. Jamsil Els regression held.
8. Resume command if ever needed (not requested now): `bash scripts/profile-national-background-start.sh` with live lock check; only after reading checkpoint `wave`.

## Claude 세션 인수 시
- Do not restart national runner unless explicitly asked.
- Prefer reading `final-report.json` + `after-hero-buckets.json` + `retry-queue.jsonl` before any new PROFILE writes.
- Any follow-up should remain missing-only / NULL_SAFE_FILL on PROFILE-owned tables only.
