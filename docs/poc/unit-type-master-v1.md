# 집랩 주택형/공급면적 마스터 v1 (한강(대우) PoC)

작성 기준: 실조회 + Turso 실거래 대조. 문서만의 추정 금지.

## 1. 공급면적 확보 가능한 공식 source

| Source | 실조회 결과 | 단지식별 | 공급㎡ | 전용㎡ | 타입명(A/B/C) | 세대수 | 평형/주택형 ID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **K-apt 웹 detail** `getKaptInfo_detail.do?kaptCode=` | ✅ 한강대우 `A14003105` 200 OK | ✅ kaptCode/이름/주소/사용승인 | ❌ | △ 전용면적 **구간** 세대수만 | ❌ | ✅ 총 834 / 구간 206·357·271 | ❌ |
| **공공데이터포털 AptBasisInfo / AptList** | ❌ 현재 에이전트 `MOLIT_API_KEY`로 호출 시 `SERVICE_KEY_IS_NOT_REGISTERED` 또는 `NO_OPENAPI_SERVICE_ERROR` | (미사용 가능) | 문서상 주택형별 공급㎡ **미제공** (기본정보·전용면적구간 세대) | 구간만 | ❌ | ✅ | ❌ |
| **국토부 실거래(MOLIT RTMS)** | DB 적재분 사용 | lawd_cd + apt_name_norm + jibun | ❌ | ✅ exclusive_area만 | ❌ (aptDong 미적재) | ❌ | ❌ |
| **건축물대장(전유/공용면적) API** | ❌ 동일 키로 미승인/실패 | 지번 기반 가능(이론) | △ 전유+주거공용 합산 시 공급 근사 가능 | ✅ 전유 | △ 호별 | △ | ❌ |
| **청약홈 주택형별 분양정보(파일)** | 신규분양 중심. 2000년 입주 한강대우는 **이력 분양공고 부재 가능성 큼** | 공고번호 | ✅(신규) | △ | ✅(신규) | ✅ | ✅ |
| **한국부동산원 단지식별정보(파일)** | 메타 확인(다운로드 미실시) | 단지고유번호 | ❌ | ❌ | ❌ | ✅ | ❌ |

**결론 (공식):**
- 지금 키/권한으로는 **단지별 주택형 × 공급면적**을 공식 API로 확정 수집 불가.
- K-apt는 단지 identity + 전용면적 **구간 세대수**만 확인.
- 전국 확장의 1순위 후보: (1) 공공데이터포털 **공동주택 기본/목록 API 활용신청**, (2) **건축물대장 전유·공용면적**으로 공급면적 재구성, (3) 청약홈은 신규분양 보조.

## 2. 실제 확인한 필드 (한강대우 K-apt)

- Endpoint: `https://www.k-apt.go.kr/kaptinfo/getKaptInfo_detail.do?kaptCode=A14003105`
- `kaptName=한강대우`, `kaptCode=A14003105`, `kaptdaTCnt=834`, `kaptDongCnt=10`, `kaptUsedate=2000-03-31`
- 주소: 지번 `서울특별시 용산구 이촌동 415`, 도로명 `이촌로 181`
- `resultMap_kapt_areacnt`:
  - areaGbn 2 → 206세대 (전용 ≤60㎡ 구간으로 해석)
  - areaGbn 3 → 357세대 (60~85)
  - areaGbn 4 → 271세대 (85초과)
- **공급면적 / 타입명 / 타입별 전용㎡ 목록 없음**

원본: `data/poc/hangang-daewoo-kapt-detail.json`

## 3. 한강(대우) 주택형 목록 (PoC)

실거래명: `한강(대우)` / `lawd_cd=11170` / `dong=이촌동` / `jibun=415`  
K-apt명: `한강대우` / `A14003105`

### 3-A. Turso 실거래 exclusive_area 분포 (실측)

| exclusive_area | trade | rent | 비고 |
| --- | ---: | ---: | --- |
| 59.98 | 6 | 21 | |
| 60 | 80 | 160 | |
| 84.94 | 4 | 15 | |
| 84.98 | 114 | 186 | |
| 134.13 | 38 | 79 | |
| 135.27 | 5 | 19 | |
| 135.5 | 10 | 15 | |
| 135.87 | 9 | 10 | |

### 3-B. 공급㎡ 매핑 (상업 공개 화면 교차검증 — 공식 미확정)

공개 단지 화면(휙 등)에서 관측된 구조 (크롤링 구현 없음, 구조 조사):

| 평형그룹(공급÷3.3 반올림) | 공급㎡ | 전용㎡(화면) | 타입 | 세대(화면) |
| --- | --- | --- | --- | ---: |
| 24 | 81.6~81.8 | ~60 | 81A/81B | 206 |
| 33 | 109.3~117.1 | ~85 | 109A/109B/117 | 357 |
| 49 | 163.3 | ~134 | 163 | 156 |
| 50 | 164.9~166.7 | ~135~136 | 164B/165A/166C | 115 |

K-apt 구간 세대(206/357/271)와 화면의 (206 / 357 / 156+115=271)가 **일치** → 단지 identity·규모는 공식 데이터와 정합.

⚠️ 공급㎡·타입명 숫자는 **공식 API로 미확정**. PoC fixture에 `verification=commercial_crosscheck`로 표기.

## 4. 공급㎡ / 전용㎡ / 평형 매핑 (실거래 연결 규칙)

평형 라벨은 **검증된 공급면적 + 마스터 명시 `pyeong_group`** 일 때만.
`round(supply/3.3)` 자동 계산은 참고용 — 예: 81.8㎡ → 25(자동) vs 현장 표기 24평형.
전용÷3.3 평형 생성 금지.

| pyeong_group | supply range | MOLIT exclusive members | exclusive-only 매핑 |
| --- | --- | --- | --- |
| 24 | 81.6~81.8 | 59.98, 60.00 | ✅ unique band |
| 33 | 109.3~117.1 | 84.94, 84.98 | ✅ unique band |
| 49 | 163.3 | 134.13 | ✅ unique |
| 50 | 164.9~166.7 | 135.27, 135.50, 135.87 | ✅ 49와 분리 가능 / 타입 A·B·C는 exclusive만으로 **비확정** |

**전용 135㎡대를 하나로 합치면 안 됨:** 49(공급163) vs 50(공급165~) 분리 유지.

## 5. 전용면적만으로 매핑 불가능한 타입?

- **있음.** 동일 평형그룹 내 A/B/C(예: 81A vs 81B, 165A vs 166C)는 exclusive만으로 구분 불가.
- 실거래 DB에 `aptDong`(동) 미저장 → 동·호 기반 타입 확정도 현재 불가.
- 규칙: exclusive가 여러 `supply_area`에 매칭되면 `mapping_status=ambiguous`, UI에 가짜 평형 확정 표시 금지.

## 6. 추천 DB 구조

기존 `transactions`에 공급면적 컬럼 강제 삽입하지 않음.

```sql
-- 제안만. production write 없음.
CREATE TABLE apt_complexes (
  complex_id TEXT PRIMARY KEY,           -- 내부 ID
  lawd_cd TEXT NOT NULL,                 -- 11170
  apt_name_norm TEXT NOT NULL,           -- 한강(대우)
  kapt_code TEXT,                        -- A14003105
  jibun TEXT,
  road_address TEXT,
  source TEXT NOT NULL,
  source_updated_at TEXT
);

CREATE TABLE apt_unit_types (
  type_id TEXT PRIMARY KEY,
  complex_id TEXT NOT NULL,
  type_name TEXT,                        -- 81A 등 nullable
  supply_area_sqm REAL,                  -- null 허용
  exclusive_area_sqm REAL NOT NULL,      -- 대표값(센터)
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  pyeong_group INTEGER,                  -- supply 검증 시에만
  household_count INTEGER,
  verification TEXT NOT NULL,            -- official | commercial_crosscheck | inferred
  source TEXT NOT NULL,
  source_updated_at TEXT,
  UNIQUE (complex_id, type_name, exclusive_area_min, exclusive_area_max, supply_area_sqm)
);

CREATE TABLE apt_unit_type_exclusive_aliases (
  complex_id TEXT NOT NULL,
  exclusive_area_cents INTEGER NOT NULL, -- round(area*100)
  type_id TEXT,                          -- null if ambiguous
  mapping_status TEXT NOT NULL,          -- unique | ambiguous | unmatched
  PRIMARY KEY (complex_id, exclusive_area_cents)
);
```

Join: `(lawd_cd, apt_name_norm[, jibun])` → complex → alias → type.  
float 동등 비교 금지 → `exclusive_area_cents`.

## 7. 전국 확장 가능성/제약

가능:
- K-apt code 목록 + 단지 메타는 공개 detail로 다수 확보 가능(단, ToS/부하 주의, OpenAPI 활용신청 권장).
- 건축물대장 전유/공용으로 공급면적 재구성 경로가 공식적으로 가장 유력.

제약:
- 현재 서비스키로 AptBasis/건축물대장 미사용.
- 상업 포털 대량 스크래핑 금지(약관·robots·법적 리스크) → 구조 조사만.
- 실거래에 동/타입 없어 exclusive collision 시 ambiguous 필수.
- 청약홈은 구축 단지 커버리지 부족.

## 8. 다음 구현 단계

1. 공공데이터포털에 **공동주택 목록/기본정보 + 건축물대장 전유공용면적** 활용신청.
2. 한강대우 지번(415)으로 건축물대장 전유부 샘플 수집 → 공급≈전유+주거공용 검증.
3. `apt_complexes` / `apt_unit_types` 테이블 마이그레이션(별도 PR, prod write 전 dry-run).
4. 면적 selector: 공급 검증 시에만 `N평형 / 공급 · 전용`, 없으면 `전용 a~b㎡형`.
5. 신고가: 공급평형 매핑 `unique`인 거래만 pyeong_group 기준 재계산 PoC → 이후 production.

## 9. 이번 PR 산출물

- `docs/poc/unit-type-master-v1.md` (본 문서)
- `data/poc/hangang-daewoo-*.json`
- `src/lib/apt/unit-type-master.ts` (모델·매핑·표시·한강 PoC)
- `scripts/poc-hangang-unit-types.ts` (Turso 대조 + 신고가 그룹 소속 산출)
- production DB write / selector / 신고가 로직 변경 없음
