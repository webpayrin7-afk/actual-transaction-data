# 주택형 마스터 Phase 4.5 — 신규 공식 API 교차검증

production DB write / selector / 신고가 production / 전국 backfill **금지**.

## 결론 (한 줄)

**신규 API로 C/D 구제는 거의 안 된다.**  
B→A label 보강은 일부 가능(반포자이).  
신고가 market-group 전국 적용률(A∪B) 개선폭은 **+0%p (81%→81%)**.  
auto-safe(라벨까지 자동) 추정만 **50%→65.5% (+15.5%p)**.

## 검증 대상 (6)

| key | Phase4 | 역할 |
| --- | --- | --- |
| eunma | D registry-abnormal | 은마형 |
| mokdong-7 | C ambiguous | 구축·unknown 공용 |
| olympic-family | C ambiguous | 구축·unknown 공용 |
| jamsil-els | B group-safe-label-unknown | label 불확실 |
| banpo-xi | B group-safe-label-unknown | label 불확실 |
| hangang-daewoo | A auto-safe | control |

## Source 실측 결과

| Source | 현재 키로 사용 가능? | 실제 확인 |
| --- | --- | --- |
| **건축HUB 주택인허가 `HsPmsHubService`** | ✅ | 호별개요/전유공용/행위호전유공용/관리공동형별개요/동·층·행위·대지 호출 성공 |
| **K-apt 웹 detail** | ✅ (키 불필요) | 세대수·동수 검산 가능 |
| **공동주택 단지식별 / AptList / AptBasis** | ❌ | `MOLIT_API_KEY` 미등록·서비스 폐기 응답 |
| **VWorld** | ❌ | 키 없음 |
| **청약홈 Applyhome** | ❌ | dedicated key 없이 401 — 필드 미사용(추측 금지) |

### 주택인허가에서 실제로 쓸모 있었던 것

- **관리공동형별개요 (`getHpMgmCoopTpOulnInfo`)**  
  - `typeGb`, `exuseArea`(전용), `hhldCnt`  
  - 반포자이·잠실엘스처럼 **재건축 후 신축**에서 타입×전용×세대 확정에 유효
- **행위호 전유공용 (`getHpHoExposPubuseAreaInfo`)**  
  - 구축/신축 모두 **dong/ho 키가 없거나 부대시설 위주**인 사례 다수 → 세대 타입 재구성에 부적합
- **전유공용면적 (`getHpExposPubuseAreaInfo`)**  
  - 타입 단위 행이지만 호 연결 약함 → 보조

## 단지별 결과

| 단지 | Phase4 → Phase45 | 공급 confidence | market-group confidence | 구제 | 이유 |
| --- | --- | --- | --- | --- | --- |
| 은마 | D → D | blocked | blocked | 불가 | 형별개요 전용면적 0, typeGb만 31/34 + 세대수. 일부공유 구조 미해소 |
| 목동7 | C → C | low | medium | 불가 | 형별개요에 typeGb(20/27/35)·세대만 있고 전용/공급면적 0 |
| 올림픽훼밀리 | C → C | none | unchanged | 불가 | 형별개요 무효(전용0·세대0). K-apt 세대(4494)/동(56)만 검산 |
| 잠실엘스 | B → B | **high** | **high** | 부분 | 전용면적 그룹은 형별로 확정. typeGb가 84C/59 등 **전용코드형**이라 24/25·33/34 label은 여전히 null |
| 반포자이 | B → **A** | **high** | **high** | **가능** | typeGb 35A/50A… + exuseArea + hhldCnt=3410(=K-apt). label conf≈0.78 (25A는 24/25 zone으로 null) |
| 한강대우(A) | A → A | none* | unchanged | control | 주택인허가 형별 없음. Phase4 건축물대장 결과 유지 (*신규 API 보강 없음) |

\* control은 Phase4 건축물대장 경로로 이미 A.

## 전국 적용률 숫자

Phase4 16단지 base:

| 지표 | Phase4 | Phase45 추정 | Δ |
| --- | ---: | ---: | ---: |
| **신고가 market-group 적용 가능 (A∪B)** | **81%** | **81%** | **+0%p** |
| auto-safe (라벨까지 자동) | 50% | **65.5%** | **+15.5%p** |
| C 구제율(샘플) | — | 0% | — |
| D 구제율(샘플) | — | 0% | — |
| B→A 전환율(샘플) | — | 50% (1/2) | — |

추정 방법: 샘플에서 관측된 C/D/B 구제율을 Phase4 base rate에 곱해 외삽.  
C/D가 0이라 **신고가 적용률은 不动**.

## 해석

1. **은마형 D는 신규 API로도 자동승격 금지** — 형별개요조차 전용면적 공란.
2. **1980s 구축 C(목동·올림픽)는 주택인허가가 면적 마스터를 대체하지 못함** — unknown 공용/대장 이슈 해소 안 됨.
3. **2000s 재건축 신축 B는 관리공동형별개요로 label/전용 보강 가능** — 반포자이 A 승격, 잠실엘스는 group high·label null 유지.
4. 따라서 신규 API의 전국 효과는  
   - 신고가 market-group 롤아웃: **거의 없음**  
   - 라벨 자동표기(auto-safe) 확대: **제한적(+)**.

## 재현

```bash
# 1) 주택인허가 + K-apt fetch (캐시 생성)
python3 scripts/poc_phase45_cross_validate.py

# 2) 캐시 기반 형별개요 재분류
python3 scripts/poc_phase45_reclassify_from_cache.py
```

산출물:

- `data/poc/phase45/*-phase45.json`
- `data/poc/phase45/phase45-summary.json`
- `data/poc/phase45/source-availability.json`

## 다음

- 전국 backfill 여전히 **불가**
- A allowlist + B group-only 유지
- 주택인허가 형별개요는 **신축/재건축 단지 label 보강 보조 소스**로만 편입 검토
- 구축 C/D는 별도 수작업·건축물대장 규칙 보강 필요
