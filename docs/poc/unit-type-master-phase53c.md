# Phase 5.3c — gated baseline-path verification (read-only)

**Status:** PASS · production write=0 · flags unchanged · screenshots=0

## Goal

Verify that the `ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1` judgment path
(warehouse stream + `apt_pyeong_group_baselines`) matches full-history
MOLIT judgment for the 4 pilots — without flipping production flags.

## Method

Script: `scripts/phase53c-gated-baseline-verify.ts`

1. Leave production env untouched (`ENABLE_…` unset, `POST_WH_…` unset).
2. Confirm `applyPilotSingoga` does **not** apply baselines under real env.
3. Dual-compute:
   - **full-history:** all MOLIT-active trades, no baseline seed
   - **baseline-path:** warehouse trades + production baseline prior-max seed
4. Also check pure algorithm: post-WH MOLIT + baseline vs full-history.
5. Classify each matched trade: exact / explainable / unexplained.

## Result (copy of artifact summary)

| pilot | compared | exact | explainable | unexplained |
|-------|----------|-------|-------------|-------------|
| 한강(대우) | 262 | 261 | 1 | 0 |
| 파크리오 | 2651 | 2651 | 0 | 0 |
| 반포자이 | 1051 | 1042 | 9 | 0 |
| 잠실엘스 | 1639 | 1639 | 0 | 0 |

- `molitAlgorithmDiffTotal` = 0 (post-WH MOLIT + baseline ≡ full history)
- explainable = warehouse missing MOLIT-active prior trades (coverage gap);
  신고가 boolean still aligned on those rows; increase amount/rate differ
- unexplained = 0 → **PASS**

Artifact: `data/poc/phase53c/gated-baseline-verify.json`

## Special checks

- 한강(대우) 49/50: separate groups G3 (134.13) / G4 (135.27–135.87)
- 반포자이 prior repair 4/4 present in warehouse + MOLIT
- 파크리오 84: single group G3 (84.79–84.97)
- 잠실엘스 84: single group G2 (84.80–84.97)

## Safety

- no production write / transactions write / baseline reload / backfill
- no feature-flag mutation; `POST_WH_SINGOGA_GAPS_CLEARED` not set/used
- no nationwide run / UI change
