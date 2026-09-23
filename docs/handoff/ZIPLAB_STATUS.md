# ZIPLAB 인수인계 현황판

기준 시각: 2026-09-23 19:23 UTC · 작성: Cursor 데이터 감시(Auto/Composer) · living `cursor/vworld-watch-6779`

이 문서는 Claude Max(Opus)와 Cursor(Composer)가 같은 현황을 보고 이어서 작업하기 위한 한 장짜리 현황판이다. 작업을 넘겨받으면 이 문서부터 읽고, 상태가 바뀌면 이 문서를 갱신한다.

## 0. 역할 분담 (오너 결정 2026-09-23)

| 영역 | 담당 |
|---|---|
| 주요 기능 구상·구현, UI/UX 판단 | Claude Max (Opus) |
| 데이터 적재·백필·반복 배치 | Cursor 클라우드 에이전트, **Composer 2.5 모델만** (Opus 금지) |

공통 규칙
- Production 배포 금지(오너 별도 지시 전까지). PR은 draft로 올리고 병합은 오너가 한다.
- 비밀값(키, 토큰) 출력 금지. DB는 Turso(libsql) Production 하나다 — 쓰기 작업은 dry-run → 건수 확인 → 적용 → 재실행 0건 확인.
- 데이터 쓰기는 "비어 있는 것만 채우기(missing-only / NULL-only)"가 기본. 추정값·퍼지 조인 금지.
- 화면 작업은 `docs/design/ziplab-ui-policy-v2.md` 12장이 기준.
- Next.js 16: `AGENTS.md` 안내대로 `node_modules/next/dist/docs/` 확인 후 작성.

## 1. 화면(UI) — PR [#127](https://github.com/webpayrin7-afk/actual-transaction-data/pull/127)

브랜치 `cursor/ziplab-ui-policy-v2-6779` → base `cursor/advancement-ratio-viz-b2d5` (draft). Claude Max 담당 — 이 감시 에이전트는 UI 브랜치를 건드리지 않음.

남은 것 / 알려진 문제
- 단지 상세 "주변 생활 › 학교" 탭: 네이버 지도 401 뒤 페이지 오류(인증 문제, 범위 밖).
- `scripts/test-loan-limit.ts`, `scripts/test-region-ranking-ui.ts` — base에서도 동일 실패(기존 문제).
- 파생 테이블 주기 갱신 필요(크론 없음): `npx tsx scripts/materialize-region-price-index.ts`, `npx tsx scripts/materialize-region-jeonse.ts` (전월세 백필 완료 후).

## 2. 데이터 적재 현황

실행 위치: Cursor VM tmux. 워크트리 `/home/ubuntu/wt/<이름>`.

| 작업 | 브랜치 / PR | 상태 (19:23Z) | 재개 |
|---|---|---|---|
| 전월세 과거 이력 2011-01~2022-09 (서울 25구) | tmux `rent-backfill` | **완료** jobs=3525 written=3515 ins=1,976,686. SUMMARY fail=10이었으나 해당 월칸 transactions 행 존재 → skip-existing 재시도 no-op | — |
| 전세가율 시리즈 rematerialize (서울 25구) | living `data/poc/region-jeonse/` | **완료** index 2,925행(25구×117월, **201612~202608**; 이전 60월/202109~). 매매 원천이 ~201610부터라 2011까지는 미확장. `test-region-jeonse` PASS (matchesLive) | `npx tsx scripts/materialize-region-jeonse.ts` |
| 매매·전월세 전국 전체 이력 missing-only | `cursor/tx-registration-status-1922` / PR #131 | **7,221/24,243**, ins=1,614,160, fail=5 · incheon RENT | `cd /home/ubuntu/wt/tx && bash scripts/full-history/start.sh` |
| 관리비 시·도 확장 | `cursor/mgmt-fee-provinces-6779` | **인천 ACQUIRING** COMPLETE 715 + NO_PUB 55 / 1,093 (~70%), api~21,710, seg 19→. 부산 PENDING | `cd /home/ubuntu/wt/fee && bash scripts/mgmt-fee-canonical/start-provinces.sh` |
| 좌표 잔여 → SEMAS 생활 → 학교 | `cursor/vworld-watch-6779` / PR #135 | **완료(이번 배치)** coords 19,072→**22,130** (+3,058) · living +238,524 snaps · school +35,612 links. 잔여 NULL ~5,394 / exact-PNU 재추출 ~3,612는 오너 PC | `scripts/living/local-extract-residual-parcels.py` |
| 학교 잔여 델타 | `cursor/school-residual-delta-6779` / PR #134 | **완료** — 3,058 materialized, +35,612 nearby links (36 NO_SCHOOLS_WITHIN_RADIUS). assignment HOLD | — |
| VWorld 감시 | `cursor/vworld-watch-6779` / PR #135 | 502 — 대기 (마지막 19:13Z) | `bash scripts/living/vworld-watch.sh` |
| 건축물 동·세대 | PR #115 | **완료** | — |
| 단지 기본정보(HERO) | PR #122 | 원 에이전트 쪽에서 계속 | `bash scripts/profile-national-background-start.sh` |
| 주변 공급(청약홈) | PR #124 | 완료 | — |

주요 수치 (19:23Z Production)
- `region_jeonse_index` 2,925행 / 25구 / 201612~202608 (송파 asOf 202608 전세가율 0.396).
- 단지 마스터 27,524. 좌표·생활 readiness COMPLETE **22,130** (80.4%). NO_COORDINATE living stub 5,394.
- 관리비 2,923행/2,810단지(인천 적용 전). 전국 거래 백필 진행 중.

## 3. 오너 결정 대기

1. 좌표 잔여 ~3,612(exact-PNU): 로컬 AL_D002에서 `pnu_not_found` 다수(부산·대구). 최신 시·도 지적도 zip 필요 여부 조사 후 요청 예정.
2. 관리비 부산·경남: 예전 "공개 월 없음" 단지를 2026-07~09로 재조회함(기본값 유지 중).
3. PR #101, #120 닫기(UI #127로 대체).

## 4. 참고 경로

- UI 정책: `docs/design/ziplab-ui-policy-v2.md`
- 오너 PC용 지적도 잔여 추출: `scripts/living/local-extract-residual-parcels.py` (`cursor/vworld-watch-6779`)
- 잔여 적용 보고: `data/poc/living/residual-living-delta-apply.json`, `residual-living-delta-report/`
- 학교 델타: `data/poc/school-national/nearby-delta-3058-apply.json`
