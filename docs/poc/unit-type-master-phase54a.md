# Phase 5.4a — baseline integration + gate separation

**Status:** code ready · production flags unchanged · screenshots=0

## Goal

1. Land baseline production read path (from Phase 5.3b) on main.
2. Separate rollout vs migration-completion switches so staged ENABLE is possible.

## Gate model

| Flag | Role | ENABLE effect |
|------|------|----------------|
| `ENABLE_MARKET_GROUP_BASELINE_SINGOGA` | Rollout | `=1` → baseline path may load/apply prior-max |
| `POST_WH_SINGOGA_GAPS_CLEARED` | Migration completion | Does **not** enable baseline. Signals future fallback-retirement eligibility only |

Legacy/full-history safety fallback remains in code in this phase (no removal).

## Flag matrix

| ENABLE | POST_WH | baseline path | fallback code |
|--------|---------|---------------|---------------|
| 0 | 0 | OFF | retained |
| 0 | 1 | OFF | retained |
| 1 | 0 | ON | retained |
| 1 | 1 | ON | retained (retirement allowed later, not done here) |

## Production safety (this phase)

- Do **not** set ENABLE or POST_WH in production
- No transactions write / baseline reload / backfill / nationwide / UI

## Tests

```bash
npx tsx scripts/test-unit-type-phase53b.ts
npx tsx scripts/phase53c-gated-baseline-verify.ts   # optional full 4-pilot
```
