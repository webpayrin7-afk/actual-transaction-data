# 인수인계 — 단지 속성 채우기 2차 중지

기준 시각: 2026-09-24 16:20 UTC. 적재 프로세스는 여기서 종료했다. 캐시 파일은 롤백하지 않았다. DB에 2차 쓰기는 없다.

## 작업

- 작업명: apt_complex_profile NULL만 채우기 (용적률·건폐율·주차·세대수·난방·복도유형) + K-apt 정확 연결
- 브랜치: `cursor/complex-profile-fill-6779`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/139 (draft, 병합은 오너)
- 스크립트:
  - `scripts/profile-fill/fill-complex-profile.mts`
  - `scripts/profile-fill/link-kapt.mts` (연결. 아직 실행 안 함)
  - `scripts/profile-fill/rules.ts`, `scripts/profile-fill/kapt-match.ts`
- 실행 명령:
  - 1차(완료): `./node_modules/.bin/tsx scripts/profile-fill/fill-complex-profile.mts fetch|plan|apply --min-weight 1`
  - 2차(조회 중 중지): `./node_modules/.bin/tsx scripts/profile-fill/fill-complex-profile.mts fetch --max-weight 0`
  - 이어서 할 명령(시작하지 말 것, 다음 세션): 같은 `fetch --max-weight 0` 재실행(캐시 있는 건 건너뜀) → `plan --max-weight 0` → 건수 확인 → `apply --max-weight 0` → plan 재실행 0
  - K-apt 연결: `link-kapt.mts list` → `address` → `plan`(건수 보고) → `apply` → 새 코드만 bass/dtl 조회 후 profile plan/apply

## 대상 테이블

- `apt_complex_profile` (NULL만. `corridor_type` 컬럼은 1차 apply 때 추가됨)
- `apt_complex_source_links` (`source='KAPT'`, PK `(source, source_key)`). 2차에서는 아직 INSERT 없음

## 완료 범위

1차 — 최근 3년 매매(`trade_count_3y > 0`, 13,400단지). apply 끝, 재실행 plan 문장 0.

- 쓴 단지 3,552 (INSERT 195, UPDATE 3,357), rowsAffected 3,552
- corridor_type 2,613 / far 1,328 / bcr 1,341 / household 434 / parking 272 / parking_per_household 254 / heating 201
- 적재 후 채워진 단지: far 6,895 / bcr 6,897 / parking_total 13,923 / parking_per_household 13,764 / household 14,424→14,858 / heating 9,972 / corridor_type 2,613
- 프로필 행 22,670 → 22,865
- 충돌 1,024 (주차 678, 세대수 346). 같은 필지 보류 1
- 기록: `data/poc/profile/apply.json`, `plan.json`(재실행 0), `conflicts.json`, `gap-report.json`

2차 — `fetch --max-weight 0` (매매 없음 14,124단지, hub 필지 8,525, 기존 K-apt bass 12,117, dtl 4,958). plan/apply 전에 프로세스를 멈춤. DB 변경 없음.

- 마지막 로그(`/tmp/profile-hub-max0.log`, 세션 종료로 VM 밖에 안 남음): calls 33,400 / retries 5,820 / failed 207 / http503 0 / http429 0 / quotaStop 기록 전에 kill
- 디스크 체크포인트(남김):
  - `data/profile-fill-cache/hub/` 파일 24,066 (필지당 recap, 총괄 없으면 title)
  - `data/profile-fill-cache/kapt/` 파일 14,708 (bassOk 14,708, dtlOk 5,410)
- 캐시는 gitignore. 이 VM에만 있다.

## 남은 범위

- 2차 plan/apply 안 함. 캐시된 매매 없는 단지의 빈 칸은 아직 DB에 없다.
- 실패 207건은 캐시에 없다. 같은 fetch를 다시 돌리면 그 건만 재시도한다. 실패 사유는 1차 때와 같이 일시적 `bad-json`이 대부분이었다. 일일 쿼터 메시지는 없었다.
- K-apt 신규 연결(list → address → plan → apply)은 코드만 있고 호출 0.
- 연결 없음으로 남은 난방·복도(1차 기준, 3년 매매 단지 K-apt 없음 9,696)는 그대로다.
- 용적률이 비어 있고 매매가 없는 필지(1차 진단 약 12,684) 조회는 위 hub 캐시에 일부 포함. DB 반영 전이다.

## 외부 API (오늘 이 작업 호출, 키 없음)

같은 `MOLIT_API_KEY` (공공데이터포털).

- 건축HUB `BldRgstHubService` `getBrRecapTitleInfo`, `getBrTitleInfo`
- K-apt `AptBasisInfoServiceV5` `getAphusBassInfoV5`, `getAphusDtlInfoV5`
- `AptListService4/getSidoAptList4` 는 연결 스크립트용. 아직 0회

호출량(프로세스 카운터, 재시도 포함):

- 1차 최근 매매 조회: 약 17,700 + 깨진 44건 재시도 38
- 2차 `--max-weight 0` 조회: 중지 시점 33,400 (retries 5,820, failed 207)
- 같은 날 앞서 공급면적 작업(`cursor/supply-area-fill-6779`)이 같은 키로 약 35,000회를 더 썼다. 포털 일일 합계는 그 합이다.

## 주의

- NULL만. 기존 값 덮어쓰기·행 삭제 금지. 건축HUB와 K-apt 숫자가 다르면 쓰지 않는다.
- 여러 동 표제부: 용적률·건폐율은 값이 모두 같을 때만. 세대수·주차는 모든 동에 숫자가 있을 때만 합산.
- K-apt 연결은 법정동 10자리+본번·부번 일치, 또는 도로명 완전 일치. 후보가 둘이면 연결하지 않는다. 단지명 유사도 금지. 기존 KAPT 행은 UPDATE 하지 않는다.
- `parking_per_household` 는 공식 주차÷공식 세대수일 때만, 소수 4자리, derived=true.
- 우선순위 가중치는 `apt_unit_exclusive_pairs.trade_count_3y` (매매). 전월세만 있는 단지는 1차에 없다.
- Production 배포 금지. PR은 draft.
