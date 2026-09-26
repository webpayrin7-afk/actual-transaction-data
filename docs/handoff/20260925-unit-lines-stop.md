# 인수인계 — 2026-09-25 중지

적재 프로세스는 멈춰 있다. 이 세션에서 새 배치는 시작하지 않았다.

## 1. 호 라인 적재 (이 브랜치의 본 작업)

- 작업명: 건축물대장 전유공용면적 → 호 라인별 평형 적재
- 브랜치: `cursor/complex-unit-lines-6779`
- PR: https://github.com/webpayrin7-afk/actual-transaction-data/pull/144 (draft, base `cursor/ziplab-ui-policy-v2-6779`)
- 스크립트: `scripts/building-3d/load-unit-lines.ts`
- 마이그레이션: `src/lib/db/migrations/20260924_complex_unit_lines.sql`
- 실행: `npx tsx scripts/building-3d/load-unit-lines.ts` (dry-run) / `npx tsx scripts/building-3d/load-unit-lines.ts --apply`
- 작업 디렉터리: `C:\dev\ziplab\.claude\worktrees\unit-lines`
- 대상 테이블: `complex_unit_lines` 만. 다른 테이블은 쓰지 않음.
- 원천: `C:\data\buildinghub\2026-08\filtered\national_unit_building_evidence.csv.gz` (전국 zip 재파싱 없음)
- 연결: `official_building_key` = `complex_buildings.mgm_bldrgst_pk` 완전 일치. 전유부 번호(`source_building_id`)는 동 관리번호와 0건 일치라 사용하지 않음.

완료 범위 (전국, 시도 분할 없음):

| 항목 | 건수 |
|---|---|
| 단지 | 8,420 |
| 동 | 50,096 |
| 라인 | 281,567 |
| 호 | 3,803,556 |

마지막 체크포인트: 재실행 `--apply` 결과 `insert_or_update: 0`, `unchanged: 281567`, `applied: 0`. 로컬 보고 `data/poc/unit-lines/dry-run.json`, 불일치 목록 `data/poc/unit-lines/mismatch.json` (커밋하지 않음).

남은 범위: DB 적재는 끝. 남은 것은 해석·후속이다.

건너뛴 호:

- 관리번호 없음 (`official_building_key` 비어 있음): 465,422
- 숫자가 아닌 호 이름: 89,588
- 끝 두 자리를 뽑을 수 없음: 335
- 전용면적 없음: 22

보류가 아니라 대표값으로 넣은 것: 같은 동·라인·전용에 공급면적이 둘 이상인 묶음 14,578개 (호 218,539). 호 수가 많은 공급면적, 동률이면 더 작은 값. 호는 버리지 않음.

`unit_type_building_links` 세대 합과 라인 호 수가 다른 동: 22,040 (연결 세대 없음 13,962, 합이 다름 8,078).

외부 API: 없음. 호출량 0. DB는 Turso production.

주의:

- 첫 `--apply`는 168,720행에서 프로세스가 끊겼고, 이어서 나머지 112,847행을 넣은 뒤 재실행 0을 확인했다. 중간 롤백은 하지 않았다.
- 공급면적 = 전용 + 주거공용. 기타공용은 제외.
- 같은 관리번호가 `complex_buildings`에 두 행이면 스크립트는 예외로 멈춘다. 이번 실행 때는 중복이 없었다.

## 2. 같은 PC에서 같이 멈춰 둔 적재

이 프로세스는 다른 세션 것이었다. 중지 요청으로 트리를 종료했다. 커밋된 행은 되돌리지 않았다.

### 버스 정류장

- 스크립트: `scripts/bus/load-bus.ts`
- 명령: `npx tsx scripts/bus/load-bus.ts --stops=C:/data/bus/<국토교통부 버스정류장 위치정보 CSV> --routes=C:/data/bus/routes.json --apply`
- 테이블: `bus_stops`, `bus_stop_routes` (`INSERT OR IGNORE`)
- 상태: `--apply` 실행 중 종료. 끝나기 전에 Claude 세션이 같은 명령을 다시 띄웠고, 그것도 종료했다. 어디까지 들어갔는지는 이 메모 시점에 다시 세지 않았다. 재실행은 이미 있는 키를 건너뛴다.

### 지역 가격 지수

- 스크립트: `scripts/materialize-region-price-index.ts`
- 테이블: `region_price_index`
- 보이던 인자: `52210`, `51730`, `12840`, `12240` (중지 직전 프로세스는 이미 없었음). 직후 `12300`, `28275`와 인자 확인 전 프로세스 하나가 다시 시작되어 각각 종료함. Claude 세션이 같은 명령을 계속 다시 띄운다. 그 세션을 멈추지 않으면 새 배치가 또 시작된다.
- 한 시군구는 DELETE 후 INSERT를 한 배치로 쓴다. 배치가 커밋되기 전에 죽으면 그 시군구는 이전 값으로 남는 것이 정상이다. 위 코드를 다시 돌리기 전에 행 수를 확인할 것.

### GIS 건물 NDJSON

- 스크립트: `python .claude/run-gis-build.py` (저장소 루트 `C:\dev\ziplab`)
- 출력: `C:\data\gis\out\buildings_<시도>.ndjson`
- 완료된 시도: 11, 12, 26, 27, 28, 30, 31, 36
- 41은 `=== building 41 ===` 로그만 있고 완료 JSON이 없다. 프로세스는 이미 죽어 있었다 (exit 4294967295). 41부터 이어서 돌리면 된다. DB 적재(`load-gis-buildings.ts`)는 이 중지에 포함되지 않았고, 돌고 있지 않았다.

## 3. 공급면적 2차 (이미 끝난 작업, 이 중지와 별개)

- 브랜치: `cursor/supply-area-fill-6779` (worktree `C:\dev\ziplab\.claude\worktrees\agent-ab9f8df0cdcaf0df8`)
- G2 빈 공급면적 채움은 반영됨. 재실행 추가 쓰기 0. 대표값 테이블 `apt_unit_supply_representative` 는 SQL 초안만 있고 production에 만들지 않음.
- 외부 API 사용 없음 (로컬 건축HUB·연속지적도·법정동코드).
