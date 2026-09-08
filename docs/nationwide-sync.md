# 전국 MOLIT 실거래 sync 운영 가이드

## 원칙

- 사용자 request path = **DB READ ONLY** (MOLIT 호출 금지)
- unchanged row → WRITE 0 (dirty-check 유지)
- 전국 historical full backfill는 write quota 위험 시 **실행 금지**
- `scope=all` = 서울·경기 (기존 Actions 호환)
- `scope=nationwide` = 전국 leaf LAWD (~249)

## Region source

- `src/lib/constants/nationwide-lawd.json` — 시군구 5자리 leaf
- `src/lib/constants/nationwide-extra-regions.ts` — 서울·경기 외 RegionDef
- `src/lib/constants/regions-registry.ts` — SEOUL/GYEONGGI + EXTRA → `ALL_REGIONS`

## 정상 daily sync (기존)

GitHub Actions `sync-molit.yml`:

```bash
npx tsx scripts/sync-molit.ts \
  --scope=all --trade-months=2 --rent-months=2 \
  --concurrency=2 --skip-existing=0 --only-changed=1
```

## Plan (write 없음)

```bash
npx tsx scripts/sync-molit.ts --scope=nationwide --trade-months=3 --plan=1
```

## 안전 가드 CLI

| Flag | 의미 |
|------|------|
| `--scope=nationwide` | 전국 LAWD |
| `--codes=26110,26350` | 명시 코드만 |
| `--max-regions=N` | 앞에서 N개만 |
| `--max-months=N` | 최근 N개월만 |
| `--from-month=202601 --to-month=202603` | 월 범위 |
| `--plan=1` | dry plan, no write |
| `--discovery=0` | INSERT 시 `first_seen_at=NULL` (오늘의 시장 오염 방지) |
| `--skip-existing=1` | sync_months 있는 cell skip (resume) |
| `--only-changed=1` | row_count+maxDealDate 동일 시 write skip |
| `--concurrency=2` | bounded (max 8) |

## Historical backfill 권장 순서

1. `--plan=1`로 cell 수 확인
2. 신규 지역 1곳 × 최근 1개월, `--discovery=0`
3. 동일 scope 재실행 → INSERT~0 확인
4. 전국 **최근 1~3개월**만, `--discovery=0 --skip-existing=1`
5. quota 여유 시 과거로 progressive (`--from-month/--to-month`)

## first_seen / 오늘의 시장

- 정상 daily: `--discovery=1` (기본) → 신규 INSERT에 first_seen 설정
- 의도적 backfill: `--discovery=0` → first_seen NULL → home discovery feed 제외
- first_seen 의미를 계약일로 위조하지 않음

## Checkpoint / resume

`sync_months(lawd_cd, year_month, deal_kind)` — write가 있는 cell만 갱신.  
`--skip-existing=1`로 이미 적재된 cell 건너뛰기.

## Pagination / timeout / retry

- 모든 page 수집 (`numOfRows=1000`, page 상한 100)
- fetch timeout 30s
- 429/503 최대 3회 backoff

## 비용 추정

```bash
npx tsx scripts/estimate-nationwide.ts
```

DB 밀도 기반 추정 (API 키 불필요).
