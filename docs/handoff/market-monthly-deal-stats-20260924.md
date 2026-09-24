# 인수인계: market_monthly_deal_stats

기준 시각: 2026-09-24 16:20 UTC
작성: Cursor 클라우드 에이전트. 이후 적재는 Claude 세션이 이어받는다.
이 세션의 적재 프로세스·개발 서버·타이머는 중지했다. 진행 중인 배치는 없었다(중간 롤백 없음). 새 배치는 시작하지 않았다.

## 작업

- 작업명: 실거래 월간 사전집계 `market_monthly_deal_stats`
- 브랜치: `cursor/market-precompute-6779`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/138 (draft, base `main`)
- 스크립트: `scripts/build-market-deal-stats.ts`
- 빌드: `src/lib/market/deal-stats-build.ts`, `src/lib/market/deal-stats.ts`
- 조회: `src/lib/market/deal-stats-query.ts`, `src/app/api/market-deal-stats/route.ts`
- 화면: `src/components/stats/TrendsDealPriceSection.tsx`, `src/components/stats/TrendsDealMixSection.tsx`, `src/components/stats/MarketTrendsPage.tsx`, `src/components/region/RegionJeonseSection.tsx`

실행 명령

```bash
npm run db:deal-stats -- --mode=full          # 전체 dry-run
npm run db:deal-stats -- --mode=full --apply  # 전체 적용
npm run db:deal-stats -- --apply              # 최근 13개월 (매일 갱신용, 미연결)
```

동 면적대 기본값은 `all`만 (`--dong-bands=all`). 신고 기한 30일이 지나지 않은 달은 만들지 않는다. 이 세션 기준 마지막 계약월은 `202607`.

## 대상 테이블과 범위

테이블: `market_monthly_deal_stats`만 씀. `transactions`, `sync_months`는 읽기만.

중지 직전 읽기 전용 건수 (2026-09-24 16:20 UTC):

| scope | 행 | 기간 |
|---|---:|---|
| dong | 377,906 | 201101–202607 |
| lawd | 139,787 | 201101–202607 |
| region | 9,419 | 201101–202607 |
| 합계 | 527,112 | |

이 세션이 마지막으로 끝낸 적용(`--mode=full --apply`, 로그 `/tmp/deal-stats-apply9.log`, EXIT 0, 383초) 직후 테이블은 458,549행이었다 (dong 326,782 / lawd 123,864 / region 7,903). 그 뒤 이 세션은 적재를 돌리지 않았다. 16:20 UTC 건수가 더 많은 것은 다른 쓰기가 이어졌다는 뜻이다. 지역별 완료 목록 파일은 없다.

체크포인트 파일·ID 없음. 체크포인트는 테이블 자체다. 같은 원천으로 다시 돌리면 기존 행은 update 0, remove 0 이다.

이 세션의 첫 dry-run (쓰기 없음, 347초): 계산 443,725 / insert 435,071 / unchanged 8,654 (당시 이미 있던 2011–2012) / update 0 / remove 0. 추정 73.9MB.

## 남은 범위

- 원천 `transactions`가 과거 월에 계속 늘고 있었다. 이 세션의 마지막 재실행에서 insert가 남은 해는 2020–2021뿐이었고 (insert 2,017, update 0, remove 0, unchanged 455,909), 이어서 넣은 적용은 insert 2,640 / update 0 이었다. 다른 해가 또 늘었으면 `--mode=full --apply` 한 번이 그 차이만 넣는다.
- 매일 최근 13개월 갱신은 sync 워크플로에 넣지 않았다. 제안 위치는 `.github/workflows/sync-molit.yml`에서 창고 sync가 실제로 끝난 다음 `npm run db:deal-stats -- --apply`.
- 전국(`scope=region`, `scope_key=all`)은 소속 시군구가 모두 모인 달만 만든다. 이 세션이 화면을 볼 때 전세는 202210부터였고 매매는 그 조건인 달이 2개였다. 행이 늘었으므로 이어받는 쪽에서 다시 셀 것.

## 실패·보류

- cron/CI 연결: 보류. 오너 지시가 보고만 하고 적용하지 말 것.
- 전국·수도권에서 시군구가 일부만 모인 달의 중위값 근사(가격대 분포 또는 건수 가중 평균): 보류. 지금은 그 달을 만들지 않고, 만든 달은 소속 실거래를 모아 줄 세운 중위값이다.
- 적재 실패로 멈춘 배치는 없다. 큰 배치(한 요청에 행을 많이 넣은 경우)가 응답 전에 오래 걸려 멈춘 것처럼 보인 적이 있어, 배치 크기는 스크립트 기본(한 문장 100행, 한 번에 5문장)으로 되돌려 두었다.

## 외부 API

- 적재 스크립트: MOLIT OpenAPI 호출 0. R-ONE 호출 0. Turso(libSQL)만 읽고 씀. 키 값은 이 문서에 없다.
- 개발 서버로 `/stats`를 열 때 R-ONE 호출이 있었으나 `RONE_API_KEY`가 없어 실패했다. 호출 횟수는 세지 않았다.
- 오늘 Turso 호출량은 전체 dry-run·apply를 여러 번 돌린 양이다. 정확한 횟수는 기록하지 않았다.

## 알려진 문제

- 중위값은 구별 중위가의 평균이 아니다. 여러 시군구 지역은 빌드 때 거래를 모아 계산한다. 화면 출처에 그렇게 적혀 있다.
- 동 상세 전세가율 그래프는 월별 매매 중위가 대비 전세 중위가다. 섹션 위 숫자와 단지 목록은 단지·면적 중앙값이라 숫자가 다를 수 있다.
- API `GET /api/market-deal-stats`. 이 세션에서 전국 cold 0.64초, warm 7ms, 강남구 cold 0.87초, 개포동 cold 0.47초. 캐시는 서버 6시간 + `s-maxage=3600`.
- Production 배포하지 않았다. PR은 draft다.
