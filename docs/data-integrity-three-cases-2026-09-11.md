# 집랩 3개 사례 검증 — 2026-09-11

Production에는 SELECT/스키마 조회만 실행했다. MOLIT는 캐시 없이 지정 월을 읽었다. API 결과는 수정 브랜치의 실제 GET 핸들러를 production warehouse에 연결해 실행한 결과이며, 배포된 서버나 브라우저 화면 검증으로 간주하지 않는다. UI 결과는 현재 컴포넌트의 면적·기간·거래유형 필터와 URL 전달 경로 검증이다. 원격 repository의 자동 DDL을 제거하고 감사 스크립트에서 비조회 SQL을 차단했다.

## 단계별 결과

| 대상 | Warehouse | Repository | 지역 API | 상세 API | UI 필터 |
|---|---|---|---|---|---|
| 이촌코오롱(A) 2026-08-07 25억 | 존재 | 동일 ID 존재 | 동일 ID 존재 | 동일 ID 존재 | 기존 기본 84.78㎡에서는 제외, 59.82㎡ 선택 시 존재. 수정 링크는 해당 면적 전달 |
| 한강(대우) 2025-03-08 18.5억 | 없음 | 없음 | 없음 | 없음 | 60㎡ 직접 선택해도 없음 |
| 한강(대우) 2025-03-15 19.3억 | 없음 | 없음 | 없음 | 없음 | 60㎡ 직접 선택해도 없음 |
| 서울 중구 남산타운 8/13·8/16 | 존재 | 존재 | 동일 ID 존재 | 존재(전체 3,416건) | 존재 |
| 서울역센트럴자이 8/1·8/6 | 존재 | 존재 | 동일 ID 존재 | 존재(전체 1,507건) | 해당 면적 선택 시 존재 |
| 삼성사이버빌리지 8/3 | 존재 | 존재 | 동일 ID 존재 | 존재(전체 584건) | 84.93㎡ 선택 시 존재 |
| 서울 중구 롯데캐슬 | 전체 2,210건 | 2,210건 | 8월 지역 query 전월세 15건 | 2,210건 | API에 전체 이력 있음; 8월 매매 없음 |

## 1. 이촌코오롱(A)

- `lawd_cd=11170`, `gu=용산구`, `dong=이촌동`, `jibun=412`.
- 8/7 매매: `deal_type=trade`, `deal_amount=250000`만원, `exclusive_area=59.82`, `floor=14`, `apt_name=이촌코오롱(A)`, `apt_name_norm=이촌코오롱(a)`.
- warehouse ID: `trade-11170-2026-08-07-이촌코오롱(A)-이촌동-412-14-250000-0-59.82`.
- 8/7 전세: `deal_type=rent`, `deal_amount=54000`, `exclusive_area=59.82`, `floor=4`, `monthly_rent=0`; 이름·정규화명·LAWD는 위와 동일.
- 전세 ID: `rent-11170-2026-08-07-이촌코오롱(A)-이촌동-4-54000-0-59.82-96`.
- MOLIT 매매 원천 34행 전체에서 해당 25억 매매 확인. `cdealType=''`, `cdealDay=''`: **조회 시점 현재 유효, 취소·stale로 판정할 근거 없음**. 전월세 원천에서도 5.4억 확인.
- 전체 warehouse 877건 = repository 877건 = 상세 API 877건. exact match에 의한 누락 없음.
- 노출 원인: 지역 거래 링크가 면적을 잃고 상세 기본값 84.78㎡로 진입. 링크에 정규화 면적을 추가했다.
- 신고가 원인: 상세가 전체 기간 최고가와 같은 모든 거래를 표시했다. 기존 지역 함수 `priorTypeMaxAmount`/`typeRecordHigh`를 공유하도록 변경. 최초 양수 거래도 최초 기록으로 인정하며 같은 계약일은 선후를 알 수 없어 prior에서 제외한다.
- **8/7은 이전 동일 면적 최고가도 250000만원이므로 신고가 false**. 수정 후 지역 API `singogaKind=null`과 상세 `isSingoga=false` 일치.

## 2. 한강(대우)

- MOLIT 202503 매매 원천 299행 전체에서 두 거래 모두 확인. 둘 다 `apt_name=한강(대우)`, `lawd_cd=11170`, `dong=이촌동`, `jibun=415`, `exclusive_area=60`, `floor=19`, `cdealType=''`, `cdealDay=''`.
- 3/8: 185000만원, 등기일 `25.08.22`; 3/15: 193000만원, 등기일 `25.06.27`.
- warehouse에는 같은 날짜·주소·금액 조건으로도 없음. 과거 명칭/정규화명 차이가 아니라 **historical ingestion/completeness 누락**이다.
- `sync_months.row_count=299`인데 실제 해당 월 매매는 78행(자연키 73개). 원천 유효 자연키는 271개, warehouse 대비 누락 201개. 기존 78행 중 원천에 없는 행 3개, 나머지 자연키 중복 5개. 이 값은 용산구 202503 trade 한 셀만의 영향 범위이며 다른 월로 일반화하지 않는다.
- 그중 한강(대우) 누락은 6개: 3/3 84.98㎡ 235000, 3/8 60㎡ 185000, 3/14 84.98㎡ 240000, 3/15 60㎡ 193000, 3/20 135.27㎡ 241000, 3/21 84.98㎡ 225000(만원).
- 코드 결함: 월 완료 메타데이터를 첫 배치에 저장하고 80문장씩 별도 커밋해 후속 배치 실패 시 일부 행만 남을 수 있었다. 같은 건수·최신 계약일이면 행 비교를 생략하는 동기화 조건도 정정/동일 건수 누락을 숨길 수 있었다. 월 전체 원자적 커밋과 기존 행 단위 diff로 수정했다.
- 두 번째 배치 실패 주입 테스트에서 전체 롤백을 검증했다. 실제 과거 작업의 실패 로그가 없으므로 당시 실패 시각·네트워크 원인까지 확정한 것은 아니다. 기존 월 건너뛰기 정책과 최근 4개월 rolling 범위 때문에 202503은 자동 복구되지 않는다.

## 3. 서울 중구

- `seoul-jung → 11140` 매핑 정상. 표본 4개 단지의 전체 warehouse 행 수와 상세 API 행 수 일치. 해당 표본에서 alias/exact match 누락을 확인하지 못했다.
- 서울 중구 202503 원천에 등장하는 단지 38개 모두 중구 warehouse 매매 이력이 있었다. 이 검사는 그 월 전체 이력의 완전성을 인증한 것이 아니다.
- 최근조회는 `regionSlug`를 저장하므로 시도 식별정보를 복원할 수 있다. 그러나 저장돼 있던 `regionLabel='중구'`를 그대로 재사용했다. 유효한 slug가 있으면 읽기·쓰기 시 지역명을 다시 만들도록 변경했고, 전국 시도 레이블도 적용했다. 기존 v1 저장값 `중구`가 `서울 중구`로 표시되는 테스트 통과.
- `gu`만으로 지역을 추정하는 자동완성/구명 기반 catalog에는 전국 중복 구명의 구조적 충돌 가능성이 있다. 이번 표본에서 잘못된 상세 URL의 실증은 없으므로 임의 alias 결합이나 검색 재설계는 하지 않았다. repository의 LAWD 격리 테스트는 통과.
- **사용자가 본 '실거래 전체 없음' 단지는 이름/URL이 제공되지 않아 재현·원인 확정 미완료**. 표시 문제와 같은 원인이라고 결론 내리지 않았다.

## Production repair 제안 — 실행하지 않음

이촌코오롱 8/7은 삭제·정정 대상 아님. 중구 표본에도 repair 근거 없음. 한강(대우)는 원천에 존재하는 누락 거래의 복구가 필요하다.

1. 이 코드 배포 후 원천 `11170/202503/trade` 한 셀만 새로 읽고 취소 처리를 적용해 자연키/본문 diff를 다시 산출한다.
2. 한강(대우) 6건만 승인 대상에 올리려면 원천 행의 자연키 allowlist를 명시하고 기존 행을 보존하는 단지 한정 ingest가 필요하다. 부분 복구 후 해당 월 전체를 완전하다고 표시하면 안 된다. 수동 SQL INSERT는 사용하지 않는다.
3. 대안인 해당 **한 셀 전체** 복구는 다른 단지까지 201개 누락 및 중복·extras 8행에 영향을 주므로 별도 범위 승인이 필요하다. extras는 자동 취소라고 단정하지 않고 원천 개별 확인 후 처리한다. broad backfill/R2 전체 재검증은 제안하지 않는다.
4. 원천 재조회 후 승인된 자연키만, discovery=0, 기존 first_seen/discovery 유지, 원자적 commit, 쓰기 상한을 적용한다. 이 조사에서는 preview 외에도 production mutation 경로를 실행하지 않았다.

동일한 before/after SELECT:

```sql
-- 현재 두 행 모두 없음. 복구 후 각 1행, 정확한 가격/면적/층/주소 확인.
SELECT id, lawd_cd, year_month, deal_type, deal_date,
       apt_name, apt_name_norm, gu, dong, jibun,
       exclusive_area, deal_amount, floor, first_seen_at, discovery_at
FROM transactions
WHERE lawd_cd='11170' AND year_month='202503' AND deal_type='trade'
  AND apt_name_norm='한강(대우)' AND dong='이촌동' AND jibun='415'
  AND exclusive_area=60 AND floor=19
  AND ((deal_date='2025-03-08' AND deal_amount=185000)
    OR (deal_date='2025-03-15' AND deal_amount=193000));

-- 현재 reported=299, actual=78. 부분 복구만으로 completeness를 선언하지 않는다.
SELECT s.row_count AS reported,
       (SELECT COUNT(*) FROM transactions t
        WHERE t.lawd_cd=s.lawd_cd AND t.year_month=s.year_month
          AND t.deal_type=s.deal_kind) AS actual
FROM sync_months s
WHERE s.lawd_cd='11170' AND s.year_month='202503' AND s.deal_kind='trade';

-- 8/7을 비교할 이전 동일 면적 최고가: 현재 250000만원.
SELECT MAX(deal_amount) AS prior_max
FROM transactions
WHERE lawd_cd='11170' AND apt_name_norm='이촌코오롱(a)'
  AND deal_type='trade' AND ROUND(exclusive_area*100)=5982
  AND deal_date<'2026-08-07';
```

복구 후 같은 감사 스크립트 `--pipeline`으로 두 행이 repository → region GET → apt-detail GET에 존재하고 60㎡ UI 필터를 통과하는지 재검증한다. 현재는 production을 수정하지 않아 두 행의 노출도 미복구 상태다.

## 검증 및 파일

- 통과: `test-three-case-integrity`, `test-region-market-insight`, `test-sync-dirty-check`, `test-trade-resolve`, `test-full-history-serving`, `npx tsc --noEmit`.
- full build / screenshot QA 미실행.
- 제품 코드: `src/lib/db/repository.ts`, `src/lib/molit/apt.ts`, `src/lib/molit/service.ts`, `src/lib/region/market-insight.ts`, `src/lib/complexes/recent-views.ts`, `src/components/RegionDailyStatus.tsx`.
- 관리/검증: `scripts/sync-molit.ts`, `scripts/probe-three-cases.ts`, `scripts/test-three-case-integrity.ts`, `scripts/test-region-market-insight.ts`.
- 작업 시작 시 깨끗한 tree, 기존 브랜치에서 origin 대비 앞선 `d63b597` 보존. `git fetch origin` 후 origin/main과 origin/codex/lab-design-system-v1이 모두 현재 이력에 포함됨을 확인. 별도 `codex/data-integrity-three-cases` 브랜치에서 작업.
