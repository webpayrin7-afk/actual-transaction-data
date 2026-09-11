# 주택형 마스터 Phase 5 — Production Pilot

production DB: **pilot master tables only**.
transactions 수정 / 전국 backfill / 단지상세 전면 UI 개편 **금지**.

## Dry-run → Write

| table | rows |
| --- | ---: |
| apt_complex_classifications | 6 |
| apt_unit_types | 94 |
| apt_pyeong_groups | 32 |
| apt_unit_type_group_links | 94 |

## Pilot 검증 결과

| 단지 | role | class | 거래수 | old→new 신고가 | 비고 |
| --- | --- | --- | ---: | --- | --- |
| hangang-daewoo | A | auto-safe | 266 | 9→81 (+72) | 49/50 분리 OK |
| parkrio | A | auto-safe | 2661 | 11→227 (+216) |  |
| banpo-xi | A | auto-safe | 1056 | 17→191 (+174) |  |
| jamsil-els | B | group-safe-label-unknown | 1647 | 9→162 (+153) | label-null UI OK |
| mokdong-7 | C | ambiguous | 672 | 8→8 (+0) | exclusive fallback OK |
| eunma | D | registry-abnormal | 1124 | 2→2 (+0) | exclusive fallback OK |

## 신고가 규칙 (A/B)

- 동일 complex + market group
- 이전 계약일 prior max **초과**만 true
- 동률 false
- 취소 거래는 warehouse에 없음
- 거래 상세 exclusive_area 유지

## 재현

```bash
npx tsx scripts/phase5-pilot-seed.ts
npx tsx scripts/phase5-pilot-seed.ts --write
npx tsx scripts/phase5-pilot-verify.ts
npx tsx scripts/test-unit-type-phase5.ts
npx tsc --noEmit
```

## A allowlist 확대 가능 여부

**조건부 가능.** Phase4 auto-safe + market-group 신고가 검증된 단지만 소량 추가.
B는 label null 유지한 채 group 신고가 가능. C/D·전국 backfill은 여전히 불가.
