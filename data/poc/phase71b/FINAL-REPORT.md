# Phase 7.1b — API unblock

## Phase 7.1 state audit
BASIC_INFO READY: **4** (after corrective; was 10)
BUILDING_INFO READY: **10**
MANAGEMENT_FEE READY: **0**
incorrect states: **0 remaining** (had 6× BASIC_INFO READY without KAPT/basic source)
corrective writes: **6** — BASIC_INFO READY→PENDING `BASIC_SOURCE_MISSING`

## API diagnosis
basic info: `NO_OPENAPI_SERVICE_ERROR` (12) on `AptBasisInfoService1/getAphusBassInfo`
complex list: `NO_OPENAPI_SERVICE_ERROR` (12) on `AptListService2/getSidoAptList`
complex identity: `NO_OPENAPI_SERVICE_ERROR` (12) on `AptBasisInfoService1/getAphusDtlInfo`
management common: **`SERVICE_KEY_IS_NOT_REGISTERED_ERROR` (30)** on `AptCmnuseManageCostServiceV2/getHsmpCleaningCostInfoV2` (endpoint exists; V1 path was wrong → 12)
management individual: `NO_OPENAPI_SERVICE_ERROR` (12) on candidate paths — exact V2 op path not confirmed
long-term reserve: **`SERVICE_KEY_IS_NOT_REGISTERED_ERROR` (30)** on `AptRepairsCostServiceV2/getHsmpMonthFeeInfoV2` (endpoint exists)

root cause: **SERVICE-NOT-ACTIVATED** (data.go.kr product approval for this key)
code-fixable: **NO**
manual action required: **YES**

Same `MOLIT_API_KEY` controls: Building Hub ✅, RTMS ✅, Energy V2 ✅ — encoding / env-var routing ruled out. No separate KAPT key is configured; do not rename `MOLIT_API_KEY`.

## KAPT identity
sample mapped: 4 (PoC cache only)
new source links: 0
unresolved: 6

## management fee proof
complexes retrieved: 0
months: 0
common / individual / reserve unit·basis: **UNPROVEN**
summable / per-area / per-household / selected-pyeong: **UNPROVEN**

## safe Phase 7.2 metrics
SAFE-NOW: _(none)_
DERIVABLE-WITH-CONDITION: _(none)_
UNSAFE: all candidate management-fee UI metrics

## persistence
management rows inserted: 0
updated: 0
state rows changed: 6
total writes: 6

## basic profile
new validated fields: _(none — live KAPT blocked)_
source precedence: unchanged

## decision
**HOLD**

### MANUAL-ACTION-REQUIRED
On [data.go.kr](https://www.data.go.kr), for the account that owns `MOLIT_API_KEY`, apply/re-apply and await approval for:

1. 공동주택 기본 정보제공 서비스 (15058453) — `AptBasisInfoService1`
2. 공동주택 단지 목록제공 서비스 (15057332) — `AptListService2`
3. 공동주택관리비(공용관리비) (15057937) — `AptCmnuseManageCostServiceV2` (path confirmed via code 30)
4. 공동주택관리비(개별사용료) (15059469) — confirm exact V2 operation from portal after approval
5. 공동주택관리비(장기수선충당금) (15059160) — `AptRepairsCostServiceV2` (path confirmed via code 30)

After approval: re-run `scripts/phase71b-diagnose-apis.mts` / path-variant checks; expect `resultCode 00` (not 12/30). Then retry ≤10-sample fee fetch + semantics proof.

Do **not** start Phase 7.2 UI. Do **not** bulk-load.
