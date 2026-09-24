# ZIPLAB 인수인계 — TRUE NATIONAL FULL-HISTORY SALE+RENT 중지

**중지 시각 (UTC):** 2026-09-24T16:19:40Z (SIGTERM → graceful save)  
**작업명:** TRUE NATIONAL FULL-HISTORY SALE + RENT (missing-only background closeout)  
**브랜치:** `cursor/tx-registration-status-1922`  
**PR:** https://github.com/webpayrin7-afk/actual-transaction-data/pull/131  
**동결 베이스라인 커밋:** `827f508` (2023+ AptTrade/등기 — 재스캔 금지)  
**러너 시작 커밋:** `3a006b1`

---

## 1. 스크립트 / 실행 명령

| 역할 | 경로 | 명령 |
|------|------|------|
| 범위 상수 | `src/lib/molit/full-history-range.ts` | SALE `201610`→current, RENT `202210`→current |
| shared lock/types | `src/lib/molit/full-history-shared.ts` | — |
| temporal lawd | `src/lib/molit/temporal-lawd/` | request lawd 플래너 재사용 |
| 매니페스트 생성 | `scripts/full-history/build-manifests.mts` | `npx tsx scripts/full-history/build-manifests.mts` |
| 백그라운드 러너 | `scripts/full-history/runner.mts` | `npx tsx scripts/full-history/runner.mts --daemon --apply=1 --concurrency=2 --sleep-ms=250 --first-batch=8` |
| 기동/재개 | `scripts/full-history/start.sh` | `bash scripts/full-history/start.sh` |
| 기동 검증 | same runner | `npx tsx scripts/full-history/runner.mts --verify-start=1` |

**재개 권장 순서**

1. `npx tsx scripts/full-history/build-manifests.mts` — `sync_months` 기준으로 COMPLETE/READY 재계산 (이미 적재된 cell은 FETCH에서 제외)
2. (선택) `data/poc/full-history/checkpoint.json`이 있으면 유지 — 중도 완료 맵 재사용. 없으면 매니페스트만으로도 missing-only 동작
3. `bash scripts/full-history/start.sh`

**중지 시 상태:** 프로세스·tmux 세션(`molit-full-history` 등) 종료됨. `run.lock` 해제됨. 신규 배치 시작 금지 요청 준수.

---

## 2. 대상 테이블 / 쓰기 범위

**허용 쓰기 (실제 수행):**

- `transactions` — deal_type `trade` | `rent` (missing insert / matched update)
- `sync_months` — deal_kind `trade` | `rent` (완료·빈 달 기록)

**금지 (미실시):** `apt_complex_master` mutation, Ranking/Price/UI, PROFILE/BUILDING/LIVING/SCHOOL/AC, rent에 rgstDate 적용 없음.

**등기(rgstDate):** 2023+ SALE 베이스라인만. 이번 full-history는 registration backfill 재시작 안 함.

---

## 3. 완료 범위 (중지 시점 체크포인트)

**체크포인트 파일:** `data/poc/full-history/checkpoint.json`  
**스냅샷(커밋용 요약):** `docs/handoff/full-history-stop-snapshot.json`  
**전체 completed 맵 스냅샷:** `docs/handoff/full-history-checkpoint-snapshot.json` (재개 시 `data/poc/full-history/checkpoint.json`으로 복사 가능)

| 항목 | 값 |
|------|-----|
| startedAt | 2026-09-23T05:40:06Z |
| updatedAt / stop | 2026-09-24T16:19:40Z |
| cursor | 2352 / pending queue 25181 |
| completed cells | 2350 |
| failed cells | 3 |
| API calls (이번 러너) | 2354 |
| inserted | 231,517 |
| updated | 0 |
| unchanged | 410,234 |
| deleted | 0 |
| identityConflicts | 0 |
| saleCells done (러너) | 1807 |
| rentCells done (러너) | 543 |
| emptyComplete | 0 |
| sleepMs at stop | 750 (timeout 백오프 후) |
| last priority/source/region/ym | P2 / RENT / busan / 202508 |

### 매니페스트 기준 (기동 시 2026-09-23 빌드)

| Source | earliest→current | expected | complete before | READY(missing) |
|--------|------------------|----------|-----------------|----------------|
| SALE | 201610→202609 (120mo) | 30,480 | 14,035 | 16,445 (pre-2023 missing 15,459) |
| RENT | 202210→202609 (48mo) | 12,192 | 3,456 | 8,736 |

- requestable lawds: **254** (+ documented NODATA `28720`)
- P0 Seoul/GG rent: 기동 시 이미 COMPLETE → 러너는 P1(경기 pre-2023 SALE)부터 진행
- 러너 완료 cell 접두: SALE 대부분 `41xxxx`(경기), RENT `26xxxx`(부산) 진행 중 중지

### 시도·지역별 (러너 completed 기준 대략)

| 구간 | 완료 cell | 비고 |
|------|-----------|------|
| 경기 SALE (P1, prefix 41) | 1807 | pre-2023 historical sale 진행분 |
| 부산 RENT (P2, prefix 26) | 543 | national rent 진행 중 중지 |
| 서울 SALE P1 / 전국 나머지 | 미착수 또는 매니페스트 COMPLETE | 재개 시 매니페스트 재빌드 후 READY만 |

정확한 lawd×month 목록은 checkpoint `completed` 맵 참조.

---

## 4. 남은 범위

- 러너 큐 잔여 대략 **~22,831** cell (`25181 - 2350`)
- SALE: 전국 pre-2023 잔여 + (매니페스트 READY 기준)  
- RENT: 부산 이후 전국 P2 잔여 + 비수도권  
- P3 national pre-2023 sale 대부분 잔여  
- `28720`: TRUE_NODATA — FETCH 금지(HOLD/NODATA_CONFIRMED)

재개 전 **반드시** `build-manifests.mts`로 READY 재계산할 것 (sync_months 반영).

---

## 5. 실패·보류 목록

| key | class | error | at |
|-----|-------|-------|-----|
| `trade\|41570\|201912` | timeout | The operation was aborted due to timeout | 2026-09-23T12:48:07Z |
| `trade\|41550\|201912` | other | fetch failed | 2026-09-23T12:48:49Z |
| `rent\|26200\|202506` | timeout | The operation was aborted due to timeout | 2026-09-24T16:19:22Z |

재시도: runner `failed` + `retry-queue.jsonl`(있으면). timeout/429는 sleep 자동 증가 로직 있음.

**보류**

- Incheon `28720` documented NODATA  
- 2023-01+ SALE COMPLETE: FROZEN — 재호출 금지  
- registration national backfill: 재시작 금지

---

## 6. 외부 API / 호출량

- **API:** MOLIT 공공데이터포털 AptTrade(매매) + AptRent(임대차) — 동일 `MOLIT_API_KEY` (키 값 기재 금지)
- **엔드포인트 rate:** 코드상 키·쿼터 공유 → sale∥rent 동시 폭주 금지, concurrency≤2
- **이번 러너 호출량:** apiCalls **2354** (약 35시간 wall, 2026-09-23 05:40 → 09-24 16:19 UTC)
- 일별 포털 쿼터 한도는 포털 콘솔에서 확인 (여기 미기록)

---

## 7. 알려진 문제·주의점

1. **빈 달:** `replaceMonthTransactions`는 tx write 없으면 `sync_months` 미기록 → 러너가 rows=0일 때 `ensureEmptySync`로 보완. emptyComplete 카운트는 중지 시 0(해당 경로 거의 미사용).
2. **체크포인트 vs sync_months:** 내구성 skip은 sync_months. checkpoint는 재개 가속. VM 이전 시 `docs/handoff/full-history-checkpoint-snapshot.json` → `data/poc/full-history/checkpoint.json` 복사 후 start.
3. **로그 중복 줄:** tmux/stdout 이중 기록으로 progress 라인이 두 번씩 찍힐 수 있음(동작 무해).
4. **백오프:** timeout 후 sleepMs 250→750까지 상승한 채 중지됨. 재개 시 기본 250부터 다시 시작.
5. **다른 적재:** `rgst-national-backfill` / `rgst-rolling-refresh` / expand tmux는 이미 EXIT:0 또는 이번에 세션 종료. 등기 재적재 시작하지 말 것.
6. **canonical mutation = 0** 유지 필수.
7. UI / Ranking / AC / Supply / School / Living / Building / 3D 수정 금지.

---

## 8. 우선순위 샤드 (재개 시 동일)

- P0: Seoul+Gyeonggi RENT  
- P1: Seoul+Gyeonggi pre-2023 SALE  
- P2: national RENT  
- P3: national pre-2023 SALE  

중지 시점: **P2 RENT busan 202508** 근처.

---

## 9. 테스트 (기동 시 통과)

- `scripts/test-full-history-runner.ts`
- `scripts/test-temporal-lawd-crosswalk.ts`
- `scripts/test-trade-resolve.ts`
- `scripts/test-sync-dirty-check.ts`
- lint touched / `tsc --noEmit`

---

**인수 후 다음 액션:** 매니페스트 재빌드 → start.sh로 백그라운드 재개 → 실패 3건 selective retry → 완료 시 `[TRANSACTION — TRUE NATIONAL FULL-HISTORY FINAL]` 보고.
