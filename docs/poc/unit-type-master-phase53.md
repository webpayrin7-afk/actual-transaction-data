# Phase 5.3 — historical prior-max baseline PoC

**Status:** complete · **WRITE=0** · screenshots=0  
**Artifact:** `data/poc/phase53/prior-max-baseline-poc.json`  
**Script:** `scripts/phase53-prior-max-baseline-poc.ts`

## Goal

Store only per market-group `prior_max_amount` + `prior_max_deal_date` from MOLIT **before** warehouse start, so 2016+ market-group 신고가 matches full MOLIT history **without** inserting ~6,414 historical trades.

## Method

- Fetch: `fetchOneTradeForSync` → `resolveActiveTrades`
- Groups: Phase5 `apt_pyeong_groups` (read-only)
- Baseline: per group `max(amount)` where `dealDate < warehouseStartDate`
- Post-WH prior: `max(baseline, prior-day same-group max)`
- Rules: first excluded · `current > priorMax` · ties false · same-day = prior-day only · cancelled excluded

## Baselines (19 rows)

| 단지 | WH start | groups | example prior_max |
|------|----------|-------:|-------------------|
| 한강(대우) | 2016-10-29 | 4 | 33평 99,500 @ 2016-09-28 |
| 파크리오 | 2016-10-01 | 5 | 33평 109,500 @ 2016-09-20 |
| 반포자이 | 2016-10-01 | 7 | 35평 169,000 @ 2016-09-30 |
| 잠실엘스 | 2016-10-03 | 3 | 84㎡대 118,000 @ 2009-08-14 |

## full-history vs baseline

| Axis | Compared | Diff | Identical? |
|------|---------:|-----:|:----------:|
| **MOLIT 2016+ + baseline vs full history** | 5,648 | **0** | **YES** |
| Warehouse + baseline vs full history | matched WH rows | 5 | NO |

Per complex (MOLIT path diffs): 한강 0 · 파크 0 · 반포 0 · 잠실 0.

## 반포자이 2020+ flip 4건

**Not corrected by pre-warehouse baseline (0/4).**

Root cause = **post-warehouse MOLIT trades missing from warehouse** (not pre-2016 history):

| Flip | WH prior | Full prior | Missing MOLIT trade (absent in WH) |
|------|--------:|----------:|------------------------------------|
| 2025-02-18 / 415000 / 84.982 | 410000 | 415000 | 2025-01-25 / 415000 / 84.943 |
| 2025-07-10 / 475000 / 84.943 | 460000 | 480000 | 2025-06-14 / 480000 / 84.943 |
| 2026-06-20 / 615000 / 132.439 | 605000 | 620000 | 2026-03-09 / 620000 / 132.439 |
| 2026-07-20 / 373000 / 59.971 | 370000 | 380000 | 2025-07-10 / 380000 / 59.98 |

## Write savings

| Metric | Value |
|--------|------:|
| Baseline storage rows | **19** |
| Measured pre-WH MOLIT trades avoided | 6,352 |
| Cited Phase5.2 historical backfill | 6,414 |
| Rows saved vs measured | 6,333 (~99.7%) |
| Rows saved vs cited | 6,395 |

## Verdict

1. **Historical baseline PoC:** **PASS** — 신고가 true/false 100% identical on MOLIT 2016+ stream vs full history (0/5648 diffs).
2. **Banpo 2020+ flips:** **FAIL** under baseline alone — need warehouse sync gap-fill (~4 missing prior-setting trades), not historical backfill.
3. **Production applicable?**
   - Historical backfill **replacement** with 19 baseline rows: **YES** (math proven; schema/write still needs separate approval — this PoC is WRITE=0).
   - Banpo HOLD lift / full warehouse-path parity: **NO** until post-2016 warehouse completeness is fixed.
4. Safety: production write 금지 · schema 변경 금지 · master 변경 금지 · screenshots=0.
