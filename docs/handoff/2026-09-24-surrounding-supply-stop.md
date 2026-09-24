# Handoff — 주변 공급 작업 중지

작성: 2026-09-24 (Asia/Seoul 기준 세션 종료 시점)
후속: Claude 세션 인수

## 작업명
COMPLEX DETAIL 「주변 공급」 복구 / 런칭 (청약홈 APT + 주거용 오피스텔)

## 브랜치 / PR
- Branch: `cursor/surrounding-supply-resume-86be`
- Base: `main`
- Commit: `65217ff` — feat(apt): restore sigungu nearby supply on complex detail
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/124
- 참고 원본: PR #86 / `cursor/phase72-complex-detail-v1-ui-d2df` / known commit `2bd048d`

## 스크립트 경로와 실행 명령
- 단위 테스트: `scripts/test-nearby-supply.ts`
  - 실행: `npm run test:nearby-supply` 또는 `npx tsx scripts/test-nearby-supply.ts`
- 서버 모듈: `src/lib/complex-detail/applyhome-nearby-sales.ts`
- 정규화: `src/lib/complex-detail/nearby-supply.ts`
- API: `src/app/api/complex-nearby-sales/route.ts`
- UI: `src/components/apt/ComplexNearbySalesSection.tsx` (단지상세 `AptDetailPage` 거래이력 아래 마운트)
- 적재/동기화 스크립트: 이번 작업에서 **사용·실행하지 않음** (`db:sync*` 등 미실행)

## 대상 테이블
- DB write = 0 / schema change = 0 / Turso write = 0
- 대상 적재 테이블: 없음 (서버 fetch + `revalidate=86400` 캐시만)

## 완료 범위
- 기능 복구·정규화·UI·테스트·typecheck·lint·`next build` 완료
- 대표 QA (잠실엘스 / 시군구 송파구, live Applyhome):
  - 상태: AVAILABLE, 카드 1건
  - 힐스테이트 송파더그리드 / OFFICETEL / 1,393실 / 입주 예정 2031.01
  - 주소: 서울특별시 송파구 장지동 909
  - 중복 없음; 경쟁률 필드 없음(officetel + match 0)
- 시군구별 “적재 완료 건수” 개념 없음. 런타임에 `HSSPLY_ADRES LIKE {sigungu}` 로 조회

## 마지막 체크포인트
- 파일: 위 소스 + `scripts/test-nearby-supply.ts`
- ID/커밋: `65217ff`
- 체크포인트 파일(배치 offset 등): 없음

## 남은 범위
- SH / 뉴홈 production adapter: NO-GO 유지 (공식 안정 API 없음). 이번 범위 제외
- Preview/프로덕션 배포: 하지 않음
- PR #124 리뷰·머지: 후속 세션

## 실패·보류 목록과 사유
- SH/뉴홈: 보류 (적합 공식 API 부재)
- 경쟁률: optional. APT만 시도, 입주 예정/오피스텔은 skip. 실패해도 섹션 전체는 유지
- 물리 반경(1km)·도보권: 의도적으로 미구현. 의미는 SIGUNGU_SCOPE
- 배치 적재 실패 목록: 해당 없음 (배치 미실행)

## 사용한 외부 API와 오늘 호출량
- Applyhome OpenAPI (공공데이터포털 ocloud):
  - `getAPTLttotPblancDetail`
  - `getUrbtyOfctlLttotPblancDetail`
  - `getAPTLttotPblancCmpet` (검증·선택적)
- 키 이름만: `MOLIT_API_KEY` (값 기록 금지 / 클라이언트 미노출)
- 오늘(이 세션) 대략 호출:
  - 계약/필터 프로브: 약 10회대 (페이지당 small perPage)
  - 송파구 목록 전체: APT 1페이지(5건) + 오피스텔 1페이지(16건)
  - 그리드 단건 상세 + competition 1회
  - live QA `fetchNearbySalesBySigungu("송파구")` 1회 (APT list + officetel list; competition은 입주예정이라 skip)
  - 모델 타입 API(`getAPTLttotPblancMdl` / officetel mdl): 런칭 코드 경로에서 **미호출**
- 정확한 포털 일일 쿼터 잔여: 이 환경에서 조회 불가

## 알려진 문제·주의점
- 「주변」UI 제목은 유지하되 실 의미는 동일 시군구. 반경 표현 금지
- 오피스텔 접수일은 `RCEPT_*` 비어 있고 `SUBSCRPT_RCEPT_*` 사용
- ocloud `matchCount` vs `totalCount` 혼동 주의 (LIKE 필터는 matchCount)
- 과거 입주월·도시형생활주택은 feed에서 제외
- 사용자-facing에 API 키/SERVICE_KEY/공공데이터 미설정 카피 금지
- 이 세션에서 적재 루프·타이머·백그라운드 배치는 **애초에 가동하지 않았음**. 중지 시점에 구독(timer 포함) 0건, tsx/sync 프로세스 0건

## 중지 조치 (2026-09-24)
1. 실행 중 적재·타이머·반복 작업: 없음 → 신규 배치 미시작
2. 진행 중 배치: 없음 → 롤백 불필요
3. cursor-subscriptions: 활성 구독 0
4. 메시지 큐: queued 0
5. 본 handoff 커밋·푸시 후 Claude 세션으로 이관
