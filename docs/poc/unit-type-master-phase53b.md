# Phase 5.3b — prior-max baseline production integration (prep)

**Status:** code ready · **WRITE=0 to production** · screenshots=0  
**Scope:** schema + read-path + fixture + gate + tests only (no UI / selector changes)

## Goal

Compute A/B market-group 신고가 as:

```
priorMax = max(baseline prior-max, prior-day warehouse market-group max)
```

without full historical trade backfill.

## Schema

Table `apt_pyeong_group_baselines` (soft key → `apt_pyeong_groups.group_key`):

| column | meaning |
|--------|---------|
| `group_key` | PK / soft FK |
| `complex_key` | complex |
| `baseline_until` | warehouse start date (baseline window end) |
| `prior_max_amount` | pre-warehouse MOLIT max |
| `prior_max_deal_date` | date of that max |
| `source` / `computed_at` | provenance |
| `confidence` / `completeness` | quality markers |

DDL in `src/lib/db/schema.sql` and `ensureUnitTypeSchema`.

## Fixture (19 rows)

`data/poc/phase53b/apt-pyeong-group-baselines.fixture.json`

Hangang / Parkrio / Banpo-Xi / Jamsil-Els — Phase 5.3 baselines.  
`seedBaselinesFromFixtureLocalOnly` refuses remote Turso URLs.

## Read path

- `markSingogaMarketGroupPriorExceed(trades, groups, initialPriorMax?)`
- `applyPilotSingoga({ ..., baselinePriorMax, env })` applies baselines **only** when gate open
- C/D still use `markSingogaExclusiveAllTimeMax` (baselines ignored)
- `src/lib/molit/apt.ts` loads baselines from DB only when gate open

## Production activation gate (Phase 5.4a separation)

Independent switches:

1. `ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1` — **rollout**: baseline 신고가 path ON
2. `POST_WH_SINGOGA_GAPS_CLEARED=1` — **migration-completion only**: allows *future* consideration of removing legacy/full-history fallback. Does **not** enable baseline path.

Defaults: both unset → baseline path OFF. Legacy fallback code retained regardless of ENABLE.

Blocker list for POST_WH: `POST_WH_SINGOGA_GAP_BLOCKERS` in `baseline-gate.ts`.

## Tests

```bash
npx tsx scripts/test-unit-type-phase5.ts
npx tsx scripts/test-unit-type-phase53b.ts
```

Covers: Phase 5.3 equivalence, baseline diff=0, Hangang 49/50 split, A/B rules, C/D exclusive unchanged, gate default OFF, local seed only.

## Production load (approved 5.3b)

- Wrote **19/19** rows to `apt_pyeong_group_baselines` only
- Read-back: group_key / prior_max_amount / prior_max_deal_date / baseline_until / confidence / completeness = **19/19 match**
- Feature flags **unchanged / OFF**:
  - `ENABLE_MARKET_GROUP_BASELINE_SINGOGA` unset/0
  - `POST_WH_SINGOGA_GAPS_CLEARED` unset
- Post-write production read-only verify (`scripts/phase53b-verify-production-readonly.ts`):
  - warehouse+baseline vs full-history **diff=0** on all 4 pilots
  - MOLIT 2016+ + baseline vs full-history **diff=0**

## Safety

- baselines table write only (19 rows)
- no historical transaction backfill
- no transactions mutation
- no nationwide rollout
- no UI / selector changes
- flags not activated
