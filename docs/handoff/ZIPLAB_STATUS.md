# ZIPLAB 인수인계 현황판

기준 시각: 2026-09-23 11:50 UTC · 작성: Cursor 클라우드 에이전트(UI 담당, 브랜치 `cursor/ziplab-ui-policy-v2-6779`)

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
- 화면 작업은 `docs/design/ziplab-ui-policy-v2.md` 12장이 기준. 360/390/430/1280px DOM 점검(가로 넘침 0, 13px 미만은 배지·축만). 스크린샷·녹화 산출물 금지(오너 요청 시 제외).
- Next.js 16: `AGENTS.md` 안내대로 `node_modules/next/dist/docs/` 확인 후 작성.

## 1. 화면(UI) — PR [#127](https://github.com/webpayrin7-afk/actual-transaction-data/pull/127)

브랜치 `cursor/ziplab-ui-policy-v2-6779` → base `cursor/advancement-ratio-viz-b2d5` (draft).

완료
- 공통 UI 정책: `docs/design/ziplab-ui-policy-v2.md` §3(글자: 12px는 배지·축만, 10~11px 금지, 보조 13px), §12(시장 현황 기준 공통 패턴·컴포넌트 목록·체크리스트).
- 공통 컴포넌트 `src/components/ui/`: `LabSection`, `LabSectionHeader`, `LabSubsectionHeader`, `LabStickySectionNav`(titleRow 옵션), `LabMoreButton`(목록 5개 제한), `LabListRow`, `LabTextLink`, `LabStatTiles`, `LabStackedBar`, `LabTag`, `LabEmphasisChip`, `LabTabs`(count). `PageHeader`는 뒤로가기 옆 제목·메타 묶음.
- 기준 페이지: `/region/[slug]?tab=stats` 시장 현황(지역 시세 평당가, 동네별 시세, 전세가율·갭, 거래 동향/시장 온도, 신고가, 랭킹 V4, 예산으로 찾기, 입주 예정, 지역 거래 내역, 스티키 섹션 탭).
- 전 페이지 적용: 홈, 단지별 조회, 지역 조회, 시장 동향, 대출 계산기, 금리비교, 도구, 학군, 정보 페이지, 지역 단지 탐색, 동 단지 목록, 단지 상세(+거래내역), 실거래 검색(`/transactions`, 더보기 › 도구로 이동, 옛 `?tab=search` 리다이렉트).
- PR #101, #120(단지 상세 옛 타이포)은 이 PR로 대체됨 → 오너가 닫으면 됨.

남은 것 / 알려진 문제
- 단지 상세 "주변 생활 › 학교" 탭: 네이버 지도 401 뒤 페이지 오류(인증 문제, 범위 밖).
- `scripts/test-loan-limit.ts`, `scripts/test-region-ranking-ui.ts`(지역 코드 단언) — base 브랜치에서도 동일 실패(기존 문제).
- 거래내역 전체 페이지는 30건 로딩 구조라 5개 규칙 예외, 업종 구성(100% 구성표) 예외.
- 파생 테이블 주기 갱신 필요(크론 없음): `npx tsx scripts/materialize-region-price-index.ts`, `npx tsx scripts/materialize-region-jeonse.ts`.

확인 링크(임시 터널, 이 VM이 켜져 있을 때만): `https://introducing-playlist-dress-ottawa.trycloudflare.com/`

## 2. 데이터 적재 현황

실행 위치: 아래 "tmux"는 Cursor VM 안의 세션이다. VM이 재시작되면 멈추므로 "재개" 명령으로 다시 띄운다. 워크트리는 `/home/ubuntu/wt/<이름>`(각 브랜치 체크아웃).

| 작업 | 브랜치 / PR | 상태 (11:45Z) | 재개 |
|---|---|---|---|
| 전월세 과거 이력 2011-01~2022-09 (서울 25구 우선) | 스크립트 `scripts/sync-molit.ts` (tmux `rent-backfill`, /workspace) | 2,675/3,525 월칸, 124.6만 행, 실패 0, 약 1.3시간 남음 | 이후: `src/lib/region/region-jeonse.ts` 시리즈를 전체 기간으로 확장 → `scripts/materialize-region-jeonse.ts` 재실행 → `test-region-jeonse.ts` |
| 매매·전월세 전국 전체 이력 missing-only | `cursor/tx-registration-status-1922` / PR #131 | 1,125/24,243 셀, 32만 행, 실패 2 (tmux `molit-full-history`, `/home/ubuntu/wt/tx`) | `cd /home/ubuntu/wt/tx && bash scripts/full-history/start.sh` |
| 관리비 시·도 확장 (인천→부산→대구→광주전남→대전→울산→세종→강원→충북→충남→전북→경북→경남→제주) | `cursor/mgmt-fee-provinces-6779` (PR #100 계열) | 인천 수집 중 120/1,093, 429 0, 적용 0 (tmux `fee-provinces`) | `cd /home/ubuntu/wt/fee && bash scripts/mgmt-fee-canonical/start-provinces.sh` · 시·도별 dry-run PASS 시 자동 적용 |
| 좌표 잔여 (오너 PC 추출 3,005 PNU → 3,058 단지) → SEMAS 생활 → 주변 학교 | `cursor/vworld-watch-6779` (PR #117 계열) | Composer 에이전트 적용 중 (bc-bac159c8) · 적용 후 좌표 약 22,130/27,524 예상 | 입력: `data/poc/living/national_parcel_representative_points_residual_20260923_expanded.csv.gz` |
| VWorld 감시 (AL_D002 복구 시 좌표→생활→학교 자동) | `cursor/vworld-watch-6779` | 미국 AWS IP 차단 추정(502) — 대기 (tmux `vworld-watch`, `/home/ubuntu/wt/living`) | `bash scripts/living/vworld-watch.sh` (복구 절차는 그 브랜치 보고 참고) |
| 건축물 동·세대 missing-only | `cursor/national-complex-building-topology-7f90` / PR #115 | **완료** (1,332/1,332, 남은 대상은 원천 없음) | — |
| 단지 기본정보(HERO) 전국 | `cursor/seoul-hero-profile-safe-fill-5254` / PR #122 | 원 에이전트 VM에서 계속 기록 중(apt_complex_profile updated_at 확인) | `bash scripts/profile-national-background-start.sh` |
| 주변 학교 전국 | `cursor/national-school-backfill-6d70` / PR #116 | 좌표 있는 단지 전부 완료, 새 좌표 따라감 | `bash scripts/school-national-background-start.sh` |
| 주변 공급(청약홈) | `cursor/surrounding-supply-resume-86be` / PR #124 | 완료, DB 쓰기 없음 | — |
| 코어 데이터 감사 | `cursor/advancement-ratio-viz-b2d5` / PR #96 | 완료 (지적도 대체 경로 감사) | — |

주요 수치
- 단지 마스터 27,524. 좌표 19,072(69.3%, 잔여 반영 전). 관리비 2,923행/2,810단지. 전국 거래 약 598만 행.
- 서울 지역 시세 평당가(`region_price_index`): 송파 2026.09 = 7,178만원/평.

## 3. 오너 결정 대기

1. 좌표를 끝내 못 찾는 단지: 필지번호 미확정 약 1,780(지번 해석 실패·중복), 20260908판에 없는 약 3,600(부산·대구 거의 전부 → 필지번호 오류 가능성 조사 필요). 조사 후 최신 판 지적도가 필요하면 해당 시·도 zip만 다운로드 요청 예정.
2. 관리비 부산·경남: 예전 웨이브에서 "공개 월 없음"이던 단지를 2026-07~09로 재조회함(기본값 유지 중).
3. PR #101, #120 닫기.

## 4. 참고 경로

- UI 정책: `docs/design/ziplab-ui-policy-v2.md`
- 오너 PC용 지적도 잔여 추출 스크립트: `scripts/living/local-extract-residual-parcels.py` (브랜치 `cursor/vworld-watch-6779`)
- 지역 시장 현황 API: `/api/region-price-trend`, `/api/region-market-detail`, `/api/region-seoul-rank`, `/api/region-budget`, `/api/region-jeonse`, 랭킹 V4 `src/lib/region-ranking/ranking-v4.ts`
