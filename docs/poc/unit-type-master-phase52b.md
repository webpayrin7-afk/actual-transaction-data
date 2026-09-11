# Phase 5.2b — full-history 신고가 READ-ONLY

**Status:** complete · **WRITE=0** · screenshots=0  
**Artifact:** `data/poc/phase52b/fullhistory-singoga-readonly.json`  
**Script:** `scripts/phase52b-fullhistory-singoga-readonly.ts`

## Method

- Fetch: `fetchOneTradeForSync` → `resolveActiveTrades`
- Groups: Phase5 `apt_pyeong_groups` (read-only)
- Rules: market-group / exclusive prior-exceed · first excluded · ties false · same-day = prior-day max only
- Compare: full MOLIT window vs warehouse 2016+

## Headline

| 단지 | full trades | wh trades | full MG | wh MG | whTrue→fullFalse | of which 2020+ |
|------|------------:|----------:|--------:|------:|-----------------:|---------------:|
| 한강(대우) | 625 | 263 | 101 | 80 | 7 | **0** |
| 파크리오 | 5190 | 2661 | 261 | 227 | 23 | **0** |
| 반포자이 | 2638 | 1044 | 240 | 190 | 25 | **4** |
| 잠실엘스 | 3547 | 1647 | 186 | 162 | 8 | **0** |

Fetch: 678 lawd×month cells · 0 errors · ~175s.

## 2020+ impact

Material flips exist: **반포자이 4건** (2025–2026). Examples:

- 2025-02-18 84.982㎡ 415000 · wh prior 410000 → full prior 415000 (tie / already seen)
- 2025-07-10 84.943㎡ 475000 · wh prior 460000 → full prior 480000
- 2026-06-20 132.439㎡ 615000 · wh prior 605000 → full prior 620000
- 2026-07-20 59.971㎡ 373000 · wh prior 370000 → full prior 380000

한강/파크/잠실: 2020+ flip **0** (false 신고가 concentrated in 2016–2017 early window).

## Prior max before warehouse (examples)

- 한강 33평: prior already 99,500 @ 2016-09-28 before WH start
- 파크 53평: prior already 200,000 @ 2010-04-09
- 반포 35평: prior already 169,000 @ 2016-09-30
- 잠실 84㎡대: prior already 118,000 @ 2009-08-14

## Verdict

1. **History gap materially affects 신고가** — yes (63 warehouse-true / full-false overall; **4 in 2020+** on 반포자이).
2. **A/B allowlist HOLD lift?** → **HOLD** (recent flip exists; historical authority incomplete).
3. **Production historical backfill needed?** → **YES** (reuse existing monthly sync path after explicit write approval; no new ingest path).
