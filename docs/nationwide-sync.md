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

## 정상 daily sync

GitHub Actions `sync-molit.yml` + `src/lib/molit/sync-policy.ts`:

- 매매 rolling **4개월** (당월+직전 3) — 늦게 공개된 과거 계약 커버
- 전월세 rolling **2개월** 유지
- `--skip-existing=0 --only-changed=1` (API는 다시 읽되 unchanged transaction WRITE=0)
- 매매는 `cdealType=O` 해제 row를 active에서 제외하고, 동일 identity의 정상 row를 XML 순서와 무관하게 선택
- 15분 sentinel probe는 당월만. 하루 **2회**(06:00/18:00 KST)는 probe와 관계없이 rolling sync 강제.
- 15분 sentinel probe는 당월만. 하루 **2회**(06:00/18:00 KST)는 probe와 관계없이 rolling sync 강제.
- 23:00 KST cron은 유지하되 강제하지 않음(당월 sentinel 변화가 있을 때만 rolling).

```bash
npx tsx scripts/sync-molit.ts \
  --scope=all --trade-months=4 --rent-months=2 \
  --concurrency=2 --skip-existing=0 --only-changed=1
```

READ ONLY 검증:

```bash
npx tsx scripts/test-late-report-ingestion.ts
npx tsx scripts/simulate-late-report-coverage.ts
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
| `--discovery=0` | INSERT 시 `discovery_at=NULL` (확인일 피드 제외). `first_seen_at`는 audit로 기록 |
| `--skip-existing=1` | sync_months 있는 cell skip (resume) |
| `--only-changed=1` | row_count+maxDealDate 동일 시 write skip |
| `--concurrency=2` | bounded (max 8) |

## Historical backfill 권장 순서

1. `--plan=1`로 cell 수 확인
2. 신규 지역 1곳 × 최근 1개월, `--discovery=0`
3. 동일 scope 재실행 → INSERT~0 확인
4. 전국 **최근 1~3개월**만, `--discovery=0 --skip-existing=1`
5. quota 여유 시 과거로 progressive (`--from-month/--to-month`)

## first_seen / discovery_at / 오늘의 시장

날짜 축을 섞지 않는다.

- `deal_date`: 실제 계약일
- `first_seen_at`: warehouse가 identity를 처음 확보한 시각 (internal audit)
- `discovery_at`: 사용자가 "새로 확인된 거래"로 보는 시각 (Home / Region Section2–3)

- 정상 daily: `--discovery=1` (기본) → INSERT `first_seen_at=now`, `discovery_at=now`
- 의도적 backfill/correction: `--discovery=0` → INSERT `first_seen_at=now`, `discovery_at=NULL`
- existing UPDATE: 두 timestamp 모두 보존. unchanged WRITE 0
- `discovery_at` 컬럼이 아직 없는 production: `--discovery=0`은 legacy대로 `first_seen_at=NULL`
- first_seen / discovery 의미를 계약일로 위조하지 않음
- 기존 bulk `first_seen` history를 확인일로 복사하지 않음 (가짜 history 금지)

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
