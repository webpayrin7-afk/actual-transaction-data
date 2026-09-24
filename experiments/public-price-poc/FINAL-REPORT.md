## ZIPLAB — Public Price Pilot Integration Phase 1.4B

### source
dataset: 3073746 (국토교통부_주택 공시가격 정보)
actual layout: UTF-8 CSV / CRLF / comma / quoted fields / header row
columns: 기준연도, 기준월, 법정동코드, 도로명주소, 시도, 시군구, 읍면, 동리, 특수지코드, 본번, 부번, 특수지명, 단지명, 동명, 호명, 전용면적, 공시가격, 단지코드, 동코드, 호코드, 건축물대장PK
sample source: official 2025 bulk package sample + stream-filtered 잠실엘스 UNIT_EXACT row
bulk downloaded: yes (layout/sample verification + 잠실엘스 row extract only)
production scraping: no

### building register PK
field present: yes
actual column: 건축물대장PK (not 관리건축물대장PK)
nullability: nullable in official sample (791/99,999)
uniqueness: non-null unique in sample; unique across full 잠실엘스 extract (5,678)
classification: NULLABLE
safe as unique key: no (linkage metadata only)

### source link
complex_id: cx_4c63d9a100973c60
name: 잠실엘스
road address: 서울특별시 송파구 올림픽로 99
lot address: 서울특별시 송파구 잠실동 19
deterministic: yes
method: pre-bound fixture link (complex_id OR name_norm with road+lot already bound). Name-only open matching forbidden.

### exact sample
year: 2025
dong: 131
ho: 101
exclusive area: 84.97
official price: 1,716,000,000
building register pk: 10251100214253
match type: UNIT_EXACT

### adapter
function: getComplexPublicPrices(...)
input: complexId/complexName + year + exclusive area (+ optional dong/ho)
result: UNIT_EXACT for 잠실엘스 131/101/84.97/2025; 2026 request returns same unit with usedPriorBulkYear=true and priceBaseYear=2025
fallback states: SOURCE_LINK_MISSING, NOT_FOUND, YEAR_NOT_AVAILABLE → manual input

### holding tax
official price connected: yes (171,600만원 auto-fill on UNIT_EXACT)
source/year label: 2025-01-01 공식 공시가격 · 국토교통부·한국부동산원
manual override: yes (clears official label → 사용자 입력)
2026 behavior: latest automatic public price shown as 2025.1.1 (bulk not yet available)
tax formula modified: no

### UI
unit context: pilot fixture 131동 101호 noted; no browseable full-unit directory
official label: shown when auto-linked; removed on manual override
privacy: no unit table exposure
area aggregate: not implemented (fixture is 1 unit)

### DB
writes: 0
migration: none
bulk ingestion: none

### QA
adapter test: pass (scripts/test-holding-public-price.ts)
exact sample: pass (131/101/84.97/2025 → 1,716,000,000)
holding integration: pass (officialPriceMan → calculateHoldingTax)
build/typecheck: pass (tsc --noEmit)
smoke: adapter + holding targeted script only
db writes: 0

### files
modified:
- src/lib/calculator/public-price.ts
- src/lib/calculator/index.ts
- src/components/apt/calculator/ComplexPurchaseCalculatorSection.tsx
- src/components/apt/AptDetailPage.tsx
- scripts/test-holding-public-price.ts
added:
- src/lib/calculator/fixtures/jamsil-els-public-price.ts
- experiments/public-price-poc/*

### decision
PASS

### next
Recommend exactly ONE next action: expand official bulk extract for 잠실엘스 all units (still local/fixture-first, no nationwide DB ingest) to enable AREA_AGGREGATE and real dong/ho selectors without inventing options.

STOP.
