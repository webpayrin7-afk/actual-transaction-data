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

## Production activation gate

Both required:

1. `ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1`
2. `POST_WH_SINGOGA_GAPS_CLEARED=1`

Until Codex confirms Banpo 4 + Jamsil 1 warehouse repairs, (2) stays unset → baseline singoga stays OFF.

Blocker list: `POST_WH_SINGOGA_GAP_BLOCKERS` in `baseline-gate.ts`.

## Tests

```bash
npx tsx scripts/test-unit-type-phase5.ts
npx tsx scripts/test-unit-type-phase53b.ts
```

Covers: Phase 5.3 equivalence, baseline diff=0, Hangang 49/50 split, A/B rules, C/D exclusive unchanged, gate default OFF, local seed only.

## Safety

- no production DB write
- no historical transaction backfill
- no transactions mutation
- no nationwide rollout
- no UI / selector changes
