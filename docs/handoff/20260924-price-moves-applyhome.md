# 인수인계 — 신고가·하락 기록 + 청약홈 사본

작업 중지 시점: 2026-09-24. 진행 중 배치 없음. 로컬 루프·타이머·백그라운드 적재 프로세스는 꺼 둠. 중간 롤백 없음.

## 작업

- 작업명: 신고가·하락 기록(`market_price_moves`) 30일 과거분 + 매일 갱신, 청약홈(odcloud) 사본 하루 1회 갱신
- 브랜치: `cursor/price-moves-daily-refresh-b1de`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/141 (draft, 오너 승인 전 병합 금지)
- Production 배포: 하지 않음

## 스크립트

신고가·하락

- 경로: `scripts/build-price-moves.ts` (`src/lib/market/price-moves-build.ts`, `src/lib/db/migrations/20260925_market_price_moves.sql`)
- dry-run: `npm run db:price-moves -- --days=30`
- 적용: `npm run db:price-moves -- --days=30 --apply`
- 날짜 한 칸: `npm run db:price-moves -- --from=YYYY-MM-DD --to=YYYY-MM-DD --apply`
- 매일(워크플로, sync가 실제로 끝난 뒤만): `npm run db:price-moves -- --days=2 --apply`

청약홈

- 경로: `scripts/applyhome/sync-applyhome.ts` (`src/lib/applyhome/fetch.ts`, `src/lib/applyhome/lawd-match.ts`, `src/lib/db/migrations/20260926_applyhome.sql`)
- dry-run: `npx tsx scripts/applyhome/sync-applyhome.ts`
- 적용: `npx tsx scripts/applyhome/sync-applyhome.ts --apply`
- 매일(워크플로): 스케줄의 KST 06:00 틱만 (UTC 21:00, 분 < 15). MOLIT sync 여부와 무관. `workflow_dispatch`에서는 돌지 않음.

워크플로 파일: `.github/workflows/sync-molit.yml` (main에는 아직 없음. 이 PR이 병합되기 전에는 스케줄이 이 단계를 실행하지 않음)

## 대상 테이블과 완료 범위

쓰기는 아래 테이블만. 시도·시군구별 완료 건수는 나누지 않았고, 전국을 확인일(KST) 기준으로 집계했다.

### `market_price_moves`

- 완료 범위: 확인일 2026-08-26 ~ 2026-09-24 (30일)
- dry-run 합계: 5,756행
- 대량 적재(처음 확인 매매 20,000건 초과)로 건너뛴 날: 없음. 최다 2026-09-22, 확인 매매 1,184건
- 0건인 날: 08-26 ~ 09-08, 09-10, 09-13
- 건수 있는 날 (확인 매매 / 신고가 / 하락): 09-09 692/107/382, 09-11 596/100/319, 09-12 592/94/298, 09-14 25/9/11, 09-15 1111/155/639, 09-16 648/103/341, 09-17 648/103/347, 09-18 632/127/297, 09-19 604/91/308, 09-20 24/7/2, 09-21 37/6/16, 09-22 1184/197/655, 09-23 742/118/388, 09-24 794/157/379
- 같은 30일 재적용: 30일 모두 `inserted` 0
- 마지막 체크포인트: 파일 체크포인트 없음. DB의 `seen_date` 2026-09-24까지가 마지막. 재실행 로그는 VM의 `/tmp/price-moves-rerun.log` (`ALL_DONE fail=0`)

### `applyhome_notices` / `applyhome_models` / `applyhome_competition`

- 이번 세션에서는 `--apply`를 돌리지 않음. dry-run 두 번 모두 원천과 동일.
- notices: insert 0 / update 0 / unchanged 2,884
- models: insert 0 / update 0 / unchanged 14,746
- competition: insert 0 / update 0 / unchanged 55,062
- `lawd_cd` 매칭 2,766, 미매칭 118 (주소 이름 정확 일치만)
- 마지막 체크포인트: 행 키는 `house_manage_no`(공고·주택형), 경쟁률은 `house_manage_no|model_no|rank_code|reside_code`. 별도 커서 파일 없음.

## 남은 범위

- 2026-09-25(KST) 이후 확인분은 이 세션에서 적재하지 않음. 매일 단계는 PR 병합 후 워크플로가 담당.
- 청약홈 미매칭 118건은 실패가 아니라 주소가 법정 시군구 이름과 정확히 맞지 않아 `lawd_cd`가 null인 공고.

## 실패·보류

- `--days=30 --apply` 한 프로세스 적용은 두 번 모두 DB 읽기 `ETIMEDOUT`으로 요약 출력 전에 끊김. 이미 들어간 행은 롤백하지 않음. 같은 스크립트를 날짜별로 `--apply` 해 2026-08-26 ~ 2026-09-24를 채움. 날짜별 패스에서 새로 들어간 것은 09-22 853행, 09-23 4행, 09-24 5행(앞선 중단된 전체 적용이 그 전 날짜를 이미 씀). 이어서 30일 재적용은 전부 `inserted` 0.
- 보류: PR #141 draft. 오너 승인 전 병합 금지. Production 배포 금지.
- 실패한 날짜로 남아 있는 구간은 없음.

## 외부 API (오늘 이 세션)

- 청약홈 odcloud `https://api.odcloud.kr/api` (`ApplyhomeInfoDetailSvc` 공고·주택형, `ApplyhomeInfoCmpetRtSvc` 경쟁률). 인증은 GitHub secret `MOLIT_API_KEY`와 동일한 환경 변수. 키 값은 기록하지 않음.
- 호출: dry-run 2회. 페이지 크기 1,000. 1회당 공고 3 + 주택형 15 + 경쟁률 56 = 74요청. 합계 148요청. `--apply` 호출은 없음. 재시도 건수는 로그에 없음.
- 신고가·하락 적재는 Turso만 사용. 국토부 OpenAPI는 호출하지 않음.

## 알려진 문제·주의점

- `market_price_moves` 전체 30일을 한 프로세스로 `--apply` 하면 약 30분 안팎에서 `ETIMEDOUT`이 난다. 이어서 할 때는 `--from`/`--to`로 하루씩. `INSERT OR IGNORE`라 다시 돌려도 기존 행은 유지된다.
- 대량 적재일(기본 20,000건)은 insert 전에 건너뛰지만, 이력 조회 자체는 한 뒤 건너뛴다.
- 청약홈 단계는 `success() || failure()`라 probe/sync 실패와 무관하게 06:00 틱에서 돈다. 취소된 job에서는 돌지 않는다.
- 스크립트 파일은 `cursor/ziplab-ui-policy-v2-6779`와 같은 내용이다. 그 브랜치와 이 PR을 둘 다 병합하면 같은 경로가 겹친다.
- 다른 테이블 쓰기 금지. `applyhome_*`는 바뀐 행만 upsert(`payload_hash`).
