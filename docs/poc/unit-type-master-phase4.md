# 주택형 마스터 PoC Phase 4 — Production Readiness Gate

production DB write / selector / 신고가 production / 전국 backfill **금지**.

## 결론 (한 줄)

**전국 backfill 아직 불가.**  
`exclusive ≤ 1㎡` 클러스터는 **후보 생성용**일 뿐이며, confidence gate를 통과한 단지(allowlist)만 단계 적용.

## 핵심 원칙

1. exclusive ≤1㎡ grouping = **candidate generation only**
2. 최종 group/label은 confidence gate 통과 후에만 production 사용
3. **"평형 이름을 모른다" ≠ "같은 group인지 모른다"** 를 분리
4. 임의 평형 숫자 생성 금지

## 4등급 분류

| 등급 | 코드 | 의미 | 신고가 | UI |
| --- | --- | --- | --- | --- |
| A | `auto-safe` | 대장 정상 + 매핑 안정 + 라벨 대체로 확정 | market group 가능 | `33평형` + 공급/전용 범위 |
| B | `group-safe-label-unknown` | group은 확실, 24/25·33/34 등 label만 불확실 | market group 가능 | 공급/전용 범위만 |
| C | `ambiguous` | group 충돌·매핑 약함·unknown 공용·outlier 과다 | exclusive 유지 | `전용 76.79㎡형` |
| D | `registry-abnormal` | 일부공유면적포함 등 대장 구조 이상 | exclusive 유지 | `전용 76.79㎡형` |

### Gate 임계값 (PoC)

- **D**: partial_common_ratio ≥ 0.50 **또는** ledger↔trade 전용 세대커버 < 0.20
- **C**: ambiguous_group_ratio ≥ 0.30 **또는** group exact map < 0.80 **또는** (unknown common ≥ 0.40 & residential common < 0.40) **또는** outlier_ratio ≥ 0.20
- **B**: 위 통과 + label_confidence < 0.70
- **A**: 나머지

### 라벨 vs 그룹

- `vote_conflict`(33/34 등), `small_24_25_zone` → **label null**, group confidence는 유지 → **B 후보**
- `supply_span_conflict`, `exclusive_includes_partial_common` → group 자체 ambiguous → **C/D**

## 은마형 규칙

`공유면적|일부공유` 전유 표기 자동 탐지 시:

- 일반 전유+공용 공식 적용 금지
- 공란 공용 가산 금지
- supply/label 자동 확정 금지
- 단지 전체 **registry-abnormal** (소수 정상 타입이 있어도 자동승격 금지)

## 공용면적 분류

키워드 allowlist만 믿지 않고 `etcPurps` 분포를 수집:

- **residential**: 계단/엘리베이터/승강기/복도/현관/홀/대피소/벽체/발코니초과
- **non-residential**: 주차/관리/경로당/주민공동/기계전기 등
- **unknown**: 그 외·공란

unknown 비중이 크고 residential 비중이 낮으면 confidence 하향(C).

## Outlier

동일 exclusive candidate 안에서:

- 세대 비중 < 10% **그리고** |supply − weighted median| > 8㎡ → outlier
- 대표 group 계산에서 제외 가능
- raw unit type은 보존(삭제 금지)

## 신고가 production gate

변경 **가능** 조건:

- complex ∈ {A, B}
- trade가 high-confidence group에 exact 매핑
- ambiguous=false

label이 null이어도(B) group이 high면 market-group 신고가 허용.

C/D는 기존 exclusive_area 신고가 유지.

## UI fallback

```
A: 33평형
   공급 109~117㎡ · 전용 84~85㎡

B: 공급 81.60~82.31㎡ · 전용 59.98~60.00㎡

C/D: 전용 76.79㎡형
```

## 재현

```bash
python3 scripts/poc_phase4_readiness_gate.py
python3 scripts/poc_phase4_readiness_gate.py --only=hangang-daewoo,eunma,jamsil-els
```

산출물:

- `data/poc/phase4/*-phase4.json`
- `data/poc/phase4/phase4-summary.json`

## 전국 backfill

**불가 (현재).**  
다음 단계: A allowlist 소량 적용 → B group-only 분석 → C/D 규칙 보강 후 재평가.
