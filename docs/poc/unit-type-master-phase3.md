# 주택형 마스터 PoC Phase 3 — 시장 평형그룹 모델

production DB write / selector / 신고가 production / 전국 backfill **금지**.

## 결론 (한 줄)

**전국 확장 아직 불가. 추가 규칙 필요 후 allowlist 단지부터.**

## 모델 분리

| 레이어 | 테이블 | 역할 |
| --- | --- | --- |
| 공식 | `apt_unit_types` | 건축물대장 전유+주거공용으로 만든 공급타입 |
| 분석 | `apt_pyeong_groups` | 사용자/신고가 분석용 시장 그룹 (여러 unit type 병합 가능) |
| 연결 | `apt_unit_type_group_links` | unit type → group |

스키마: `src/lib/db/schema-pyeong-groups.poc.sql`

`market_label`은 nullable. 불확실하면 숫자를 만들지 않고
`display_fallback` (예: `전용 59.98~60.00㎡ · 공급 81.60~82.31㎡`)만 사용.

## 그룹 규칙 (자동)

1. unit type = (exclusive, supply) exact bucket
2. pyeong group = exclusive 근접 ≤ 1.0㎡ 클러스터 (**공급으로 재분할하지 않음** — 109/117 같은 시장그룹 유지, 전용 구간 겹침 방지)
3. label = 세대수 가중 `round(supply/3.3058)` 최빈값
4. 가중 공급 80~85㎡(24/25 혼재) → `market_label=null`
5. 최빈 2위 ≥ 25% → ambiguous + label null
6. 전유 `공유면적/일부공유` 과반 → label null + ambiguous

### 주거공용 키워드 (Phase3 보강)

`계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과`

전유에 공유면적 포함 시 공란 공용 가산 금지.

## 한강(대우) 재검증

### 117.13 공급 / 84.98 전용 / 40세대

- 108동만 40세대, 전원 동일 구조
- 공용 = `계단실,엘리베이터 23.14` + `지하대피소 9.01` (중복합산 없음)
- 109.26과 **별도 공식 unit type**, 시장 그룹은 **동일 33평**
- 공개: 휘익 33평형 109.3~117.1 / 호갱노노 33평 그룹

### 81계열 (81.60/81.81/82.28/82.31)

- 전용 59.98~60 → **하나의 시장 그룹**으로 묶음 가능
- 휘익 25 vs 호갱노노 24 → `market_label=null`, display fallback만

## 단지별 핵심 수치

| 단지 | unit exact | group exact map | ambiguous group | label 자동 | 신고가 ex→group | 이상 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 한강대우 | 27% | 100% | 0% | 75% | 85→80 | 없음(117 정상) |
| 은마 | 0% | 100%* | 100% | 0% | 125→125 | 전유=일부공유포함, 대장전유 매칭 0.5% |
| 잠실엘스 | 65% | 100% | 33% | 33% | 213→156 | 84계열 33/34 투표충돌 |
| 반포자이 | 81% | 100% | 29% | 57% | 302→205 | 키워드 보강 후 84→35평 일치 |
| 래미안힐스고덕 | 84% | 100% | 10% | 80% | 370→185 | 소수 호 공용 이상치(140㎡) |

\*은마 group map은 실거래 전용(76.79/84.43)이 소수 정상 타입에만 붙어 성립. 세대 99.5%는 부풀린 전유 타입.

## 신고가 false 사례 (exclusive만 신고가)

1. 한강대우 2020-07-11 전용60 143500 — 59.98 고점과 분리되어 false
2. 한강대우 2021-06-21 전용84.94 197000 — 84.98 그룹이면 비신고가
3. 반포자이 2016-10-18 전용84.998 163000 — 84.984와 분리
4. 잠실엘스 2016-10-21 전용84.97 122000 — 84.80 계열과 분리
5. 래미안고덕 2017-03-03 전용97 81500 — 97.00/97.26 미세분리

## 전국 확장 판단

**추가 규칙 필요. 전국 즉시 확장 금지.**

필수 후속:
1. 주거공용 키워드에 `승강기|홀|벽체|발코니초과` (본 PoC 반영)
2. `일부공유면적포함` 단지 전용 매핑 전략 (은마형) — 자동 label/공급 확정 금지
3. label은 24/25·투표충돌·부분공유 시 null + display fallback
4. production 적용 전 confidence/allowlist 게이트
5. 공용 이상치 호(래미안 6세대 140㎡) 처리 규칙

한강대우·반포자이·래미안고덕처럼 표기가 현대적인 단지는 그룹 모델이 유효.
은마형 구축 대장은 별도 규칙 없이 production 투입 불가.

## 재현

```bash
python3 scripts/poc_phase3_pyeong_groups.py
python3 scripts/poc_phase3_pyeong_groups.py --only=hangang-daewoo,eunma,banpo-xi
```

산출물: `data/poc/phase3/*-phase3.json`, `data/poc/phase3/phase3-summary.json`
(대형 `*-bld-expos-cache.json`은 gitignore)
