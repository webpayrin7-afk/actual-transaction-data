# Phase 5.2 — 신고가 history completeness (dry-run)

**Status:** DRY-RUN 완료 · **실제 write BLOCKED** (별도 승인 필요)  
**Safety:** Turso write 0 · pilot master 변경 0 · screenshots=0 · 2006 이전 외부보강 금지

## Scope

| 단지 | apt_name_norm | lawd | 거래가능 | required start `max(2006-01, occ)` | warehouse 최초 |
|------|---------------|------|----------|-------------------------------------|----------------|
| 한강(대우) | `한강(대우)` | 11170 | 2000-03 | **2006-01** | 2016-10 |
| 파크리오 | `파크리오` | 11710 | 2008-08 | **2008-08** | 2016-10 |
| 반포자이 | `반포자이` | 11650 | 2009-03 | **2009-03** | 2016-10 |
| 잠실엘스 | `잠실엘스` | 11710 | 2008-09 | **2008-09** | 2016-10 |

## Method (read-only)

1. Unique `(lawd, ym)` cells only for the three pilot lawds (11710 shared).
2. `fetchOneTradeForSync` → existing `resolveActiveTrades` (no new parser).
3. Exact `normalizeAptName` match (`반포자이` ≠ `신반포자이`).
4. Diff with `naturalKeyFromTx` + `isSameTransactionContent` (= `replaceMonthTransactions` semantics).
5. **No SQL writes.**

## Dry-run results (to 2026-09)

| 단지 | 필요개월 | source active | warehouse(window) | insert | update | delete | unchanged | pre-WH source |
|------|--------:|-------------:|------------------:|-------:|-------:|-------:|-----------:|--------------:|
| 한강(대우) | 249 | 625 | 263 | 363 | 0 | 1 | 262 | 358 |
| 파크리오 | 218 | 5190 | 2661 | 2539 | 0 | 10 | 2651 | 2539 |
| 반포자이 | 211 | 2638 | 1044 | 1604 | 0 | 10 | 1034 | 1547 |
| 잠실엘스 | 217 | 3547 | 1647 | 1908 | 0 | 8 | 1639 | 1908 |
| **합계** | **678 cells** | **12000** | **5615** | **6414** | **0** | **29** | **5586** | **6352** |

### API estimate

- Unique lawd×month cells: **678** (11170:249 · 11650:211 · 11710:218)
- Dry-run fetch: **0 errors**, ~59s @ concurrency 5
- Pagination estimate: **~682** HTTP GETs (≈1 page/cell for these ranges)
- Write (if approved) re-fetches same cells unless separately cached

### Notes

- Almost all missing rows are **pre-2016-10** official MOLIT trades (history gap).
- `update=0`: overlapping identities match content.
- `delete=29`: warehouse rows absent from current active source (cancel-resolved or identity drift) — full-cell replace would remove them unless `skipDelete`.
- Approving write uses **full lawd-month** atomic replace (existing path): other apts in 용산/서초/송파 for those months also upsert. No other lawds. No C/D pilots.

## Write path (blocked until approval)

```bash
npx tsx scripts/sync-molit.ts \
  --codes=11170,11650,11710 \
  --from-month=<per-lawd start> --to-month=<end> \
  --rent-months=0 --discovery=0 \
  --skip-existing=0 --only-changed=0
```

Unchanged cells: no unnecessary write (row-level diff).

## After write (future)

1. history first deal date  
2. market-group prior-exceed 신고가 recount  
3. exclusive prior-exceed compare  
4. early-window false 신고가 cleared?  
5. A/B allowlist HOLD lift decision  

## Artifacts

- `scripts/phase52-history-completeness-dryrun.ts`
- `data/poc/phase52/history-completeness-dryrun.json`
