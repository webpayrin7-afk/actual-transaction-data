# Handoff — Gyeonggi AC historical fee closeout (STOPPED)

Stopped at: 2026-09-24T16:19Z (UTC)  
Reason: ZIPLAB stop request; subsequent loads continue in a Claude session.

## Work name

[AC] GYEONGGI AC HISTORICAL FULL CLOSEOUT — complete for sido `41` (경기도).  
No next province started.

## Branch / PR

- Branch: `cursor/mgmt-fee-canonical-dryrun-20260919`
- Worktree: `/tmp/cursor-worktrees/mgmt-fee-canonical`
- Repo: `webpayrin7-afk/actual-transaction-data`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/100
- Tip commits (Gyeonggi closeout):
  - `daf2cf0` Apply Gyeonggi final COMPLETE fees and refresh national capacity
  - `20f1865` Add Gyeonggi final acquire artifacts and apply script
  - `2cd9547` Retry transient network fetch failures during Gyeonggi fee acquisition
  - `d4f2707` Freeze the Gyeonggi management-fee closeout cohort of 1150 complexes

## Scripts and commands

Acquire (already terminal; do not re-run unless intentionally redoing):

```bash
cd /tmp/cursor-worktrees/mgmt-fee-canonical   # or repo checkout of the branch
./node_modules/.bin/tsx scripts/mgmt-fee-canonical/run-gyeonggi-final.mts
```

Apply (INSERT-only COMPLETE; second `--commit` is idempotent no-op):

```bash
./node_modules/.bin/tsx scripts/mgmt-fee-canonical/apply-gyeonggi-final.mts          # precheck
./node_modules/.bin/tsx scripts/mgmt-fee-canonical/apply-gyeonggi-final.mts --commit
```

National capacity / recon (read inventory + rewrite capacity JSON):

```bash
./node_modules/.bin/tsx scripts/mgmt-fee-canonical/report-national-ac-capacity.mts
```

Related paths:

- `scripts/mgmt-fee-canonical/run-gyeonggi-final.mts`
- `scripts/mgmt-fee-canonical/apply-gyeonggi-final.mts`
- `scripts/mgmt-fee-canonical/report-national-ac-capacity.mts`
- `scripts/mgmt-fee-canonical/op-checkpoint.ts` (OpCheckpointStore)
- Fee contract preserved: phase26 / REFERENCE_CATALOG, `choosePublishedPeriod`, INSERT-only COMPLETE, workers=1, sleep≥1s

## Target table

- `apt_complex_mgmt_fee_monthly` (canonical fee rows)
- Identity links were **not** rewritten in the fee apply step (identity expansion already done earlier)

## Completed scope

### Gyeonggi (sido 41) — DONE

| Metric | Value |
|--------|------:|
| Frozen cohort selected | 1150 |
| COMPLETE (published months acquired + applied) | 1080 |
| NO_PUBLISHED_MONTH (terminal, not stored) | 70 |
| PARTIAL / MISSING / FAILED / IDENTITY_CONFLICT | 0 |
| Exact identities | 1152 |
| Fee-covered (exact) | 1082 (= 2 prior + 1080 new) |
| Never attempted (exact) | 0 |
| Reconciliation | **1152 = 1082 + 70 + 0** |

### Seoul (sido 11) — preserved, DONE earlier

| Metric | Value |
|--------|------:|
| Exact | 1080 |
| Fee-covered | 889 |
| Terminal NO_PUBLISHED | 191 |
| Never | 0 |
| Reconciles | true |

### National snapshot (after Gyeonggi apply)

| Metric | Value |
|--------|------:|
| Exact | 14790 |
| Fee-covered complexes | 2810 |
| Terminal NO_PUBLISHED | 261 |
| Never attempted | 11719 |
| Fee table rows / complexes | **2923 / 2810** |

Capacity artifact: `data/poc/mgmt-fee-canonical/national-kapt-identity/national-ac-capacity.json`  
(generated_at ≈ 2026-09-23T05:35:59Z)

## Last checkpoint / artifacts

| File | Role |
|------|------|
| `data/poc/mgmt-fee-canonical/gyeonggi-final-cohort.json` | Frozen cohort (sha `b217a2d8032fcd277152b6656fb04025a1af6196acdf2add923d374ccc1db714`) |
| `data/poc/mgmt-fee-canonical/gyeonggi-final-op-checkpoint.json` | Op checkpoint (sha `f36830429f5bcd0b0ef532a08b0022ed74eee59934e27e0a40c029618018bcde`, 32610 records) |
| `data/poc/mgmt-fee-canonical/gyeonggi-final-segment-state.json` | Segment state: segments_completed=11, unfinished=0 |
| `data/poc/mgmt-fee-canonical/gyeonggi-final-dryrun.json` | Dry-run gate **PASS** (sha `c510c7919dd0f1aed10130bea0560cb99e9d21b4d0555104a2c43969ae6277f6`) |
| `data/poc/mgmt-fee-canonical/gyeonggi-final-apply-result.json` | Apply **PASS**, inserted 1080 |
| `data/poc/mgmt-fee-canonical/gyeonggi-final-identity-guard.json` | 1150/1150 pass, conflicts 0 |
| `/tmp/fee-gyeonggi-final.log` | Acquire log; ends with `GYEONGGI_COHORT_TERMINAL` / `LOOP_DONE` |

Last acquire IDs: cohort terminal at unfinished=0; last segment size 4 then `segment_done segments=11 terminal=1150`.

## Remaining scope (for Claude session)

Do **not** auto-start. Suggested next province-sized historical closeouts among never-attempted exact (from capacity `by_sido`, never>0):

| sido | name | exact | fee | no_pub | never |
|------|------|------:|----:|-------:|------:|
| 12 | 전남광주통합특별시 | 1646 | 0 | 0 | 1646 |
| 27 | 대구광역시 | 1151 | 0 | 0 | 1151 |
| 28 | 인천광역시 | 1093 | 0 | 0 | 1093 |
| 47 | 경상북도 | 1006 | 0 | 0 | 1006 |
| 26 | 부산광역시 | 1404 | 411 | 0 | 993 |
| 44 | 충청남도 | 976 | 0 | 0 | 976 |
| 48 | 경상남도 | 1395 | 428 | 0 | 967 |
| 52 | 전북특별자치도 | 851 | 0 | 0 | 851 |
| 51 | 강원특별자치도 | 815 | 0 | 0 | 815 |
| 43 | 충청북도 | 756 | 0 | 0 | 756 |
| 30 | 대전광역시 | 561 | 0 | 0 | 561 |
| 31 | 울산광역시 | 519 | 0 | 0 | 519 |
| 36 | 세종특별자치시 | 210 | 0 | 0 | 210 |
| 50 | 제주특별자치도 | 175 | 0 | 0 | 175 |

National never remaining: **11719**.

Busan/Gyeongnam already have partial fee coverage from earlier waves; remaining never is still large.

## Failures / holds

- Acquire classification failures: **none** (FAILED/PARTIAL/MISSING/IDENTITY_CONFLICT = 0).
- Apply: PASS; second `--commit` = `IDEMPOTENT_NOOP` (0/0/0).
- Gate acquisition (`BLOCKED_CHECKPOINT_LOST`): **untouched** — do not reopen in this stream.
- Seoul historical fee waves: **closed** — do not restart.
- Gyeonggi NO_PUBLISHED_MONTH (70): terminal for this closeout; not inserted into DB (by design).

## External API (no key values)

- MOLIT KAPT fee V3 ops via catalog (`REFERENCE_CATALOG` / probe `getHsmpCleaningCostInfoV3`).
- Gyeonggi acquire totals (this cohort run):
  - api_calls: **32610**
  - retries: **31**
  - timeouts: **30**
  - http_429: **0**
  - http_5xx: **1**
- Apply phase: **0** fee API calls (rebuild from checkpoint only).
- Env used (names only): `MOLIT_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.

## Known issues / cautions

1. **Mid-segment hang**: acquire often stalled ~20–45 min on `ep_poll` with stale log; recovery was SIGTERM of `/exec-daemon/node` child only; bash loop resumed on exit≠2. New province runners should keep the same auto-resume loop + stall watchdog.
2. **PROCESS_BUDGET / segment pause**: runner exits 0 after budget → `GYEONGGI_SEGMENT_PAUSE`; loop resumes. Do not treat exit 0 mid-cohort as terminal unless `GYEONGGI_COHORT_TERMINAL` (or province-equivalent) is logged.
3. **Fetch retry**: transient `TypeError: fetch failed` / AbortError / TimeoutError are retryable (`2cd9547`). Keep that behavior for new runners.
4. **Capacity NO_PUB accounting**: `report-national-ac-capacity.mts` loads terminal NO_PUB from Seoul + Gyeonggi segment-state files. New provinces must be added there after closeout or never/no_pub will be mislabeled.
5. **Do not mutate** Seoul `seoul-*-*` artifacts or Gate checkpoint.
6. **Fee contract**: INSERT-only COMPLETE months; never store NO_PUBLISHED as fee rows; workers=1; sleep≥1s.
7. **Stop state (this handoff)**: progress timer unsubscribed; fee tmux sessions killed (`fee-wave1`, `mgmt-fee-reconcile`); no `run-gyeonggi-final` / apply process running; no new batch started.

## Stop checklist

- [x] Acquire LOOP_DONE / cohort terminal
- [x] Apply PASS + idempotent verify
- [x] Timers unsubscribed
- [x] Background fee tmux sessions killed
- [x] No new province batch started
- [x] This handoff committed on the working branch
