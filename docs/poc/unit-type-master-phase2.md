# 주택형 마스터 PoC 2단계 — 한강(대우) / A14003105

production write 없음. transactions·selector·신고가 production 로직 변경 없음.

## 공식 필드 조합

- API: `BldRgstHubService/getBrExposPubuseAreaInfo`
- 키: `sigunguCd=11170`, `bjdongCd=12900`, `bun=0415`, `ji=0000`
- **공급면적 = 전유 + 주거공용**
  - 전유: 전유 ∧ 주건축물 ∧ 아파트
  - 주거공용: 공용 ∧ 주건축물 ∧ `etcPurps` ∈ 계단|엘리베이터|복도|현관|대피소 (지하대피소 포함)
- **제외:** 부속 주차장·노인정·보육·관리·주민공동·경비·기계전기 등
- 수집: 7,506행 / 세대 **834** (= K-apt)

## unit type 목록 (공식)

| supply | exclusive | common | hh | market label | note |
| --- | ---: | ---: | ---: | --- | --- |
| 81.60 | 59.98 | 21.62 | 19 | 24/25 혼재 → null | naive 25 |
| 81.81 | 60.00 | 21.81 | 184 | 24/25 혼재 → null | |
| 82.28 | 60.00 | 22.28 | 1 | null | rare/grouped |
| 82.31 | 60.00 | 22.31 | 2 | null | rare/grouped |
| 109.26 | 84.98 | 24.28 | 293 | **33** | |
| 109.56 | 84.94 | 24.62 | 24 | **33** | |
| 117.13 | 84.98 | 32.15 | 40 | **33** | 동일 전용·다른 공급 |
| 163.34 | 134.13 | 29.21 | 156 | **49** | |
| 164.89 | 135.27 | 29.62 | 24 | **50** | |
| 165.08 | 135.87 | 29.21 | 44 | **50** | |
| 166.73 | 135.50 | 31.23 | 47 | **50** | |

## 시장 평형 라벨

- `round(supply/3.3)`만으로 확정 불가: 81.x→25이나 공개 표기는 24/25 혼재.
- 109~117 → 33평 (117 naive=35이지만 시장은 33 그룹).
- 163.34 → 49 / 164.9~166.7 → 50.
- **결론:** `market_pyeong_label` 별도 컬럼 필요. 81.x는 NULL.

## 49/50 분리

가능. exclusive만으로 분리:
- 134.13 → 49 (supply 163.34)
- 135.27 / 135.50 / 135.87 → 50

## 실거래 매핑 (266건, read-only)

| | type-level | pyeong-level |
| --- | ---: | ---: |
| exact | 72 | 180 |
| multi | 194 | 0 |
| none | 0 | 86 (81.x 라벨 null) |

type multi: `60`→3 supply, `84.98`→109.26 & 117.13. 임의 배정 금지.

## 신고가 PoC (한강만)

| 방식 | 신고가 건수 |
| --- | ---: |
| exclusive-only | 85 |
| supply-pyeong (33/49/50만, 81.x 제외) | 56 |
| only exclusive | 31 |
| only supply-pyeong | 2 |

동률=false, 취소 제외, ambiguous/라벨미확정 제외.

## 추천 스키마

`src/lib/db/schema-unit-types.poc.sql`

핵심: `unit_type_key`, `supply_area_sqm`, `exclusive_area_min/max`, `residential_common_area_sqm`, `household_count`, `market_pyeong_label`, `mapping_confidence`, `source`.

## 전국 확장

- **조건부 가능:** 지번→건축물대장 전유/공용 페이지네이션 + 주거공용 etcPurps 규칙.
- 리스크: API 레이트리밋/503, 단지별 etcPurps 편차, 시장 평형은 단지별 큐레이션.
- K-apt만으로는 타입별 공급㎡ 불가 → 대장 조합이 1순위.

## 재현

```bash
python3 scripts/poc_hangang_bld_unit_types.py
npx tsx scripts/poc-export-hangang-trades.ts
npx tsx scripts/poc-hangang-unit-types.ts
```
