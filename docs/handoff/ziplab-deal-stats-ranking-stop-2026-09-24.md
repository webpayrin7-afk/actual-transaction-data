# ZIPLAB handoff — deal-stats / ranking queue (세션 중지)

작성: 2026-09-24 · Claude 세션이 이후 적재 이어받음  
상태: **적재·백그라운드 프로세스 전부 중지 완료** (신규 배치 미개시)

## 작업명

매매 gap fill 이후 큐: (0) gap 확인 → (1) `market_monthly_deal_stats` full 재계산 → (2) Ranking V4 전국 ALL/12M 발행 → (3) 서울 as-of를 전국과 `2026-07-31`로 정렬 · PR 범위 축소(#127 base)

## 브랜치 / PR

| 항목 | 값 |
|---|---|
| 작업 브랜치 | `cursor/ziplab-deal-stats-ranking-09e8` |
| base | `cursor/ziplab-ui-policy-v2-6779` (PR #127) |
| PR | [#143](https://github.com/webpayrin7-afk/actual-transaction-data/pull/143) **MERGED** (이전 #142도 동일 브랜치로 MERGED) |
| 관련(이전) | `cursor/ziplab-trade-sync-gaps-09e8` — gap fill 스크립트 |

## 스크립트 경로 · 실행 명령

```bash
# 매매 공백 export / 백필 (이미 완료)
npm run db:export-trade-gaps
npm run db:sync:trade-gaps -- --dry-run=1
npm run db:sync:trade-gaps

# 월간 사전집계
npm run db:deal-stats -- --mode=full
npm run db:deal-stats -- --mode=full --apply

# 전국 ALL/12M (비서울 insert-only)
npm run db:ranking:nationwide-all
npm run db:ranking:nationwide-all -- --apply --as-of=2026-07-31

# 서울 as-of 정렬 (publications UPDATE 허용)
npx tsx scripts/region-ranking/launch-nationwide-all.mts --scope=seoul --as-of=2026-07-31
npx tsx scripts/region-ranking/launch-nationwide-all.mts --scope=seoul --as-of=2026-07-31 --apply
```

주요 경로:

- `scripts/sync-molit.ts` (`--gaps-file=`)
- `scripts/export-trade-sync-gaps.ts` / `scripts/verify-trade-gap-fill.ts`
- `scripts/build-market-deal-stats.ts`
- `scripts/region-ranking/launch-nationwide-all.mts`
- 헬퍼(new): `src/lib/region-ranking/{features,run-identity,snapshot}.ts`

## 대상 테이블

| 테이블 | 작업 |
|---|---|
| `sync_months` / `transactions` | 매매 gap fill (discovery_at=NULL) |
| `market_monthly_deal_stats` | full 재계산 (insert/update/remove 허용은 이 단계만) |
| `ranking_feature_snapshots` | 전국·서울 ALL/12M 새 feature_run 추가 (구 스냅샷 삭제 안 함) |
| `region_ranking_publications` | 비서울 INSERT 141 · 서울 UPDATE 25 (포인터만) |

## 완료 범위 · 체크포인트

### Gap fill (완료)

- 32 lawd · **1,065** sync 셀 · 추가 거래 **228,973**
- 재실행 `jobs=0`
- CSV: `data/sync-gaps/trade-gaps.csv`
- 산출: `/opt/cursor/artifacts/trade_gap_fill_verify.json` (환경에 있을 수 있음)

### deal-stats (부분 안정)

- dry-run 최초 insert **1,632** → 다회 apply
- **2023–2026 창: insert/update/remove = 0** (안정)
- 2016–2018: 원천 `transactions` 동시 증가로 absolute 0 불가였음 → **판단 보류로 중단**
- region 완결 월: `all`/`capital` **45** (`202301`–`202609`)

### Ranking V4 ALL/12M (완료)

| 범위 | feature_run_id | pubs | as_of |
|---|---|---|---|
| 비서울 | `486ebed0c6d1f8fafaa87b058a5ed4800c4fdeeaf0cbf9791b8b36e955dd215f` | insert **141** | `2026-07-31` |
| 서울 25구 | `13855c61201511888948b5debedf1dc423ea7025b4508ad45e73d26420434a5d` | update **25** | `2026-07-31` |

- 전국 ALL/12M pubs **166** = `ziplab-ranking-v4` @ `2026-07-31` (서울·경기 gu-leaders asOf 일치 확인됨)
- 구 서울 스냅샷 run `59e2c1c7…` **삭제하지 않음** (롤백용 유지)
- 산출 JSON:
  - `data/poc/region-ranking/nationwide-all-dry-run.json`
  - `data/poc/region-ranking/nationwide-all-apply.json`
  - `data/poc/region-ranking/seoul-all-asof-align-dry-run.json`
  - `data/poc/region-ranking/seoul-all-asof-align-apply.json`
- 마지막 커밋: `ebcc879` (`feat(ranking): align Seoul ALL/12M as-of to 2026-07-31`)

### 시·도별 (전국 dry-run 기준, 비서울 발행)

gyeonggi 42 · busan 16 · daegu 8 · daejeon 5 · incheon 5 · ulsan 5 · sejong 1 · jeju 2 · chungbuk 11 · chungnam 14 · gyeongbuk 15 · gyeongnam 17 · (자격 0 구 23)

## 남은 범위

1. **deal-stats absolute 0**: 2016–2018 원천이 다른 작업과 겹치면 재실행 insert가 남을 수 있음. gap-year(2023+)만 0 확정된 상태.
2. **미발행 구**: V4 자격 0인 23구 · master 없는 lawd · 광주(`29`)/전남(`46`) 등 master 공백.
3. **59/84/114 · dong scope**: 이번 범위 밖 (ALL/12M · gu만).
4. **gap 범위 외**: 원 32곳 밖 4 lawd · 223개월 (`51xxx` 등).

## 실패 · 보류

| 항목 | 사유 |
|---|---|
| deal-stats 전 구간 재실행 0 | 2016–2018 warehouse 동시 증가 |
| 서울 1위 변경 8구 | as-of·풀 ALL 재계산으로 의도된 변동 (광진·도봉·노원·은평·강서·영등포·관악·서초) |
| PR #142/#143 | 이미 MERGED — 추가 적재 없음 |

## 외부 API · 오늘 호출량

| API | 용도 | 비고 |
|---|---|---|
| MOLIT (국토부 실거래) | gap fill sync | 이번 중지 시점에는 **추가 호출 없음** (gap fill은 이전 세션에서 완료·재실행 0). 키/토큰은 기록하지 않음 |
| Turso (libsql) Production | 읽기·쓰기 | 랭킹/deal-stats만 DB |

랭킹 발행·deal-stats는 **외부 HTTP API 없음** (창고 집계만).

## 알려진 문제 · 주의점

1. PR은 **#127 버전 UI/API를 사용**해야 함. 이 브랜치에서 gu-leaders/map/deal-stats lib를 다시 덮지 말 것.
2. 서울 publications `ON CONFLICT DO UPDATE`는 `--scope=seoul`에서만 허용. 전국 모드는 기존 행 skip.
3. V4는 **읽기 시점 점수화** — feature snapshot + publication 포인터만 있으면 됨. `region_complex_rankings` 미작성.
4. 세대수: 스크립트는 `COALESCE(profile, unit_type_household_counts)` 사용. V4 읽기도 unit HH fallback.
5. Production 배포·병합은 오너. 비밀값 출력 금지.
6. 이 세션에서 tmux `ziplab-*` 세션·worker는 **전부 kill** 함. 새 배치 시작하지 말 것.

## 중지 시각

2026-09-24 — 활성 `tsx`/sync 프로세스 없음 · tmux ziplab 세션 전부 종료 · 신규 적재 미개시
