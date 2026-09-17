# Data source exposure policy

집랩이 외부 데이터를 제품에 붙일 때, **사용자에게 필요한 기준·시점·법적 attribution은 제공**하고, **서비스 복제에 도움이 되는 내부 수집 구현정보는 제품 surface에 노출하지 않는다.**

이 정책은 실거래·단지·지역·학교·상권·건축물/대장 및 향후 외부 데이터 전반에 적용한다.

법령 / 라이선스 / 공공데이터 이용조건 / API 약관상 출처표시가 필요하면 **그 의무가 항상 우선**한다. attribution을 추측으로 삭제하지 않는다.

### Product UI rule (source names)

집랩은 **데이터 기준과 시점**은 사용자에게 제공한다.

외부 **source명**은 법률·라이선스·API 이용조건상 표시가 요구되는 경우에만
제품 UI에 표시하는 것을 기본으로 한다.

새로운 외부 source 도입 시 attribution requirement는
**해당 source 개발 시점에** 확인한다. (기존 source 일괄 audit 금지)

### Attribution placement (DATA CONTEXT vs REQUIRED)

집랩 기본 정책:

1. **DATA CONTEXT** — 해당 데이터 가까이에 표시  
   (예: `진학 현황 · 2025년 공시`)
2. **REQUIRED ATTRIBUTION** — 법률/라이선스/API 조건상 필요한 경우 표시  
   — 페이지 내 반복을 피하고, source가 별도 형식을 요구하지 않으면  
     **페이지 콘텐츠 최하단에 1회** 표시
3. **INTERNAL SOURCE INFORMATION** — 제품 UI/client에 노출하지 않음
4. 특정 source가 attribution 위치/형식을 별도로 요구하면  
   **해당 source 조건이 공통 위치 정책보다 우선**
5. 신규 source는 도입 시점에 attribution requirement 확인  
   — 기존 모든 source 일괄 audit 금지

## Boundary

```
RAW SOURCE
  → server-only adapter
  → normalization
  → product model
  → UI / public product API
```

- UI component는 raw provider schema를 직접 알지 않는다.
- browser / RSC client payload에는 가능한 한 **집랩 normalized product model**만 전달한다.
- README·개발 문서와 외부 사용자 product surface는 구분한다. (개발 문서까지 숨기지 않는다.)

## Show to users (not a hide-all rule)

유지·제공 가능:

- 기준일 / 계약일 / 공시연도 / 업데이트 시점 / 집계 기간
- 산정 기준에 대한 사용자 친화적 설명
- “공시자료 기준”, “공공데이터 기반” 등 일반 표현
- **법적·약관·라이선스상 의무 attribution**

예: `2025년 공시`, `최근 1년 실거래 기준`, `2026.09 업데이트`

## Do not expose on product surface (unless legally required)

제품 UI / client props / public API / RSC payload / data-* / HTML comments / console에 불필요하게 넣지 않는다:

- 외부 API endpoint·path·apiType·serviceKey 구조·API key 이름
- raw field명·raw JSON schema (예: `TOTAL3`)
- source join / identifier 변환 / resolution 방식
- normalization mapping·fallback 우선순위·confidence 내부 규칙
- scraping endpoint·request 조합·pagination 구현
- cache key·source-link table·enrichment pipeline·gate 로직
- DB table/column·내부 source/version metadata·수집 script·수집 주기 구현
- debug용 provider response

최종 **표시 데이터 자체**를 숨기는 정책이 아니다.  
“어떤 source를 어떤 방식으로 결합했는지”를 제품이 설명해주는 것을 막는 것이 목적이다.

## Classification for UI copy

기존/신규 출처 문구는 다음으로 분류한다.

| Class | Meaning | Action |
| --- | --- | --- |
| A | 법적/약관상 필요한 attribution | **삭제 금지** |
| B | 사용자 이해에 필요한 기준정보 | 유지 |
| C | 불필요한 내부 source 노출 | 제품 surface에서 제거·완화 |
| D | 내부 개발정보만 | 제품에 넣지 않음 |

불명확하면 `REVIEW_REQUIRED`로 남기고 **이번 작업에서 제거하지 않는다.**

## Product API shape

BAD (raw provider):

```json
{ "TOTAL3": 236, "TOTAL_RATE3": 72.2 }
```

GOOD (product):

```json
{ "category": "general_high_school", "count": 236, "rate": 72.2 }
```

명확한 고위험 노출만 최소 수정한다. 대규모 API refactor는 별도 작업.

## Server-only

API key, provider endpoint, raw field mapping, identifier resolver, normalization source map은 **server-only**에 둔다. client component로 옮기지 않는다. secret 값은 로그/응답에 출력하지 않는다.

## New external source checklist

새 source를 붙일 때 기본 절차:

1. 상업적 이용 가능 여부
2. 출처표시(attribution) 의무 여부·문구
3. 재배포·변경·식별 가능 개인정보 제한
4. server-only adapter 위치
5. normalized product model 정의 (UI는 raw field 비참조)
6. 사용자 노출: 기준일/기간 + 의무 attribution만
7. client/RSC/public API에 raw schema·endpoint·key·mapping metadata 미포함 확인
8. 불명확한 attribution → `REVIEW_REQUIRED` (삭제 금지)

## Out of scope

- robots.txt / AI crawler blocking
- Production 배포·Production DB write (정책 적용 PR은 Preview만)

## School detail notes (priority apply)

- **A 유지 (REQUIRED):** 학교알리미 — 제3유형. 표시: `출처: 학교알리미` **페이지 콘텐츠 최하단 1회**
- **B 유지:** section DATA CONTEXT (`2025년 공시` 등) — 데이터 가까이
- **C 제거/완화:** 학교명 아래 출처, NEIS tip, API key 문구, raw metadata
- 진학현황 mapping·count·rate·도넛 UI는 변경하지 않음

## UI audit snapshot (code search)

| Surface | Copy / signal | Class | Action |
| --- | --- | --- | --- |
| School detail footer | `학교알리미` attribution | A | Keep |
| School advancement | `2025년 공시` | B | Keep |
| School detail tip | `주변 학교 위치: NEIS` | C | Removed from school detail |
| School error | API key wording | C | Softened (no key/endpoint) |
| School CTA | `학교알리미에서 보기` | A/B | Keep (official site link) |
| App shell | `국토교통부 실거래 기반` | A/B | Keep (REVIEW if ever changing) |
| Mgmt fee / public price | 국토교통부·한국부동산원 | A | Keep |
| Complex schools tip | NEIS schoolInfo wording | A/C | REVIEW_REQUIRED (nearby map context; not this PR) |
| Nearby map pilot | NEIS labels in UI | A/C | REVIEW_REQUIRED |
| Calculator public price | dataset id / accessMethod | C | REVIEW_REQUIRED (follow-up) |

Do not remove A or REVIEW_REQUIRED items without license confirmation.
