# Phase 5.1 — market-group 신고가 정합성 감사

**Status:** HOLD (allowlist 확대 보류)  
**Safety:** production write 없음 · pilot master 변경 없음 · screenshots=0  
**Artifacts:** `data/poc/phase51/singoga-audit.json`, `data/poc/phase51/external-crosscheck.json`  
**Scripts:** `scripts/phase51-singoga-audit.ts`, `scripts/phase51-external-crosscheck.ts` (read-only)

## 1. 알고리즘 재계산

생산 코드 `markSingogaMarketGroupPriorExceed` + `typeRecordHigh`
(`src/lib/unit-type/singoga.ts`, `src/lib/region/market-insight.ts`):

- `current > priorMax` 만 true
- 동률 false
- `priorMax === 0` → false (**첫 거래 제외**)
- 동일 계약일은 당일 이전(`deal_date < D`) max만 prior로 사용 (임의 시각 순서 없음)

| 단지 | trades | groups | excl areas | first 포함 | first 제외 | excl prior-exceed | excl all-time max | Phase5 보고 |
|------|-------:|-------:|-----------:|-----------:|-----------:|------------------:|------------------:|------------:|
| 한강(대우) | 266 | 4 | 8 | 85 | **81** | 87 | 9 | 81 ✓ |
| 파크리오 | 2661 | 5 | 9 | 234 | **227** | 361 | 11 | 227 ✓ |
| 반포자이 | 1056 | 7 | 15 | 199 | **191** | 306 | 17 | 191 ✓ |
| 잠실엘스 | 1647 | 3 | 5 | 167 | **162** | 219 | 9 | 162 ✓ |

재계산 결과 = production 플래그 = Phase5 verify. **알고리즘 정상.**

## 2. 첫 거래 정책

| | 포함 | 제외(현행) |
|--|-----:|----------:|
| 한강 | 85 | 81 |
| 파크 | 234 | 227 |
| 반포 | 199 | 191 |
| 잠실 | 167 | 162 |

**추천: exclude (현행 유지).**  
사유: “이전 최고가 갱신”이 없으면 신고가가 성립하지 않음. 아파트미(타입 신고가·이전최고 비교)·호갱노노(최고가 돌파) 관행도 첫 관측을 신고가로 세지 않음. include는 group 수만큼 기계적 가산.

## 3. 동일 계약일

정책대로 prior는 **해당일 이전**만 사용. 같은 날 prior max를 넘는 거래는 **각각** 신고가.

사례 수: 한강 1 · 파크 15 · 반포 3 · 잠실 8.

예: 한강 33평형 `2025-07-08` prior 25억, 두 건 모두 27.1억 → 둘 다 true.  
반포 35평형 `2025-07-10` prior 46억, 50억·47.5억 → 둘 다 true.

임의 선후관계 버그 없음. multi-exceed는 정책 결과이지 HOLD 사유가 아님.

## 4. History completeness

| 단지 | 준공(대략) | warehouse 최초 | gap |
|------|----------:|---------------:|----:|
| 한강(대우) | 2000 | 2016-10-29 | 16y |
| 파크리오 | 2008 | 2016-10-01 | 8y |
| 반포자이 | 2009 | 2016-10-01 | 7y |
| 잠실엘스 | 2008 | 2016-10-03 | 8y |

초기 창에서 “창고 시작 후 첫 상승”이 신고가로 잡힘 (파크·반포·잠실 early-month RH 존재). **전체 MOLIT history 대비 false early record-high 위험.**  
→ early-window 신뢰도 **낮음**.

## 5. 외부 교차검증

- 최종 기준: MOLIT warehouse.
- 아파트미/호갱노노 live scrape는 이 환경에서 apt2.me Tomcat 오류로 불가.
- 대신 **전용면적 prior-exceed**를 타입/평형 신고가 근사로 사용 + 공개 뉴스/실거래 목록 spot-check.

**2020+ confusion (우리 MG vs 타입 proxy):**

| 단지 | TT | TF | FT | FF | either-true 일치율 |
|------|---:|---:|---:|---:|-------------------:|
| 한강 | 39 | 0 | 8 | 111 | 83% |
| 파크 | 102 | 0 | 62 | 1244 | 62% |
| 반포 | 88 | 0 | 53 | 356 | 62% |
| 잠실 | 70 | 0 | 29 | 714 | 71% |

- **TF ≈ 0:** MG가 true면 타입 proxy도 true (MG가 더 엄격).
- **FT > 0 (체계적):** 타입별로는 신고가이나 group 공유 max에 막혀 MG false → `grouping_diff`.
- 공개 spot-check (한강 28.8억 2025-07-12, 반포 50억/47.5억 2025-07-10): **전부 TT**.

불일치 분류: `grouping_diff` (주), `history_start_gap` (초기창), `same_day_policy` (당일 다건을 서비스가 1건만 칠 수 있음).

## 6. 신고가 “증가” 원인 (9→81 등)

Phase5의 exclusive 숫자는 **all-time max equality**(면적당 현재 최고가 동률 전부 true ≈ 면적 수)였다.

| 단지 | excl all-time | MG prior-exceed | Δ | 해석 |
|------|-------------:|----------------:|--:|------|
| 한강 | 9 | 81 | +72 | 시계열 peak 갱신 누적 |
| 파크 | 11 | 227 | +216 | 동일 |
| 반포 | 17 | 191 | +174 | 동일 |
| 잠실 | 9 | 162 | +153 | 동일 |

**apples-to-apples (exclusive prior-exceed vs MG):** MG가 **더 적음** (−6 / −134 / −115 / −57).  
면적 병합 → 공유 prior max → 타입별 peak 일부가 억제 (위 FT).

### group별 분해 (MG first-exclude)

**한강 81:** 24+27+19+11 (2~3면적 병합 group에서만 prior 대비 −1~−3)  
**파크 227:** 31+69+55+42+30 — 감소 집중: 26평 −46, 33평 −88 (3면적 병합)  
**반포 191:** 38+47+34+28+5+24+15 — 감소 집중: 35평 −42, 60평 −17, 50평 −12  
**잠실 162:** 61+72+29 — 감소 전부 중간 group(84.8~84.97 3면적) −57

## 7. 이상 / HOLD 판정

| 항목 | 결과 |
|------|------|
| 같은 날 순서 버그 | 없음 |
| history 시작점 | **문제 (HOLD)** |
| group 잘못 합침 | 감사 범위에서 명백한 오합침 증거 없음 (FT는 설계상 병합 효과) |
| 외부 반복 불일치 | grouping_diff(FT)는 설명 가능·체계적; 알고리즘 오류 아님 |

**A/B allowlist 확대: HOLD**  
조건: warehouse를 준공/거래가능 시점까지 backfill하거나, early-window 신고가 discount/비표시 정책 후 재감사.

## 8. 완료 보고 요약

| 항목 | 결론 |
|------|------|
| 신고가 알고리즘 | **정상** (수정 불필요) |
| 첫 거래 정책 | **exclude 추천** (현행) |
| 동일일 처리 | prior=전일까지 max; 다건 exceed 각각 true — 의도대로 |
| 외부 교차검증 | spot TT; 타입 proxy either-true 일치 ~62–83%; 불일치는 주로 grouping_diff(FT) |
| 4단지 증가 원인 | all-time-max UI → prior-exceed 시계열 누적 (면적 병합은 오히려 건수 감소) |
| allowlist 확대 | **HOLD** (history incompleteness) |
