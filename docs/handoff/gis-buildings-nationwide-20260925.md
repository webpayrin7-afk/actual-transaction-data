# Handoff: GIS건물통합정보 전국 적재 (3D 단지 탐색)

- **작업명:** GIS건물통합정보(AL_D010) → `gis_buildings` 전국 적재 (A: 단지 동 / B: 주변 ≥5층·500m)
- **중지 시각:** 2026-09-25 01:48 KST (요청에 따라 배치 중단)
- **브랜치:** `cursor/ziplab-ui-policy-v2-6779`
- **DB 대상:** Turso Production 하나 (`gis_buildings`). **이번 세션에서 `--apply`는 실행하지 않음** (기존 CH_D010 변동분 888행만 존재).

## 스크립트·실행 명령

| 단계 | 경로 | 명령 |
|------|------|------|
| 단지 좌표·키 export | `scripts/building-3d/export-complex-points.ts` | `npx tsx scripts/building-3d/export-complex-points.ts C:/data/gis/complexes.csv C:/data/gis/complex-bld-keys.csv` |
| SHP→NDJSON (A/B 필터) | `scripts/building-3d/build-gis-buildings.py` | `python scripts/building-3d/build-gis-buildings.py C:/data/gis/AL_D010_{SIDO}_20260909.zip C:/data/gis/out/buildings_{SIDO}.ndjson --near C:/data/gis/complexes.csv --keys C:/data/gis/complex-bld-keys.csv --radius 500` |
| 배치 러너(참고) | `.claude/run-gis-build.py` | `python .claude/run-gis-build.py` — **중지됨. 재개 시 남은 시도만 개별 실행 권장** |
| dry-run / apply | `scripts/building-3d/load-gis-buildings.ts` | `npx tsx scripts/building-3d/load-gis-buildings.ts --from=C:/data/gis/out/buildings.ndjson --missing-only` → 보고 후 `--apply` |
| 마이그레이션 | `src/lib/db/migrations/20260928_building_3d.sql` | load 시 `--apply`에서 DDL 적용 |

### 적재 규칙 (구현됨)

- **A:** `complex_buildings.mgm_bldrgst_pk[5:]` = GIS A19, 같은 `lawd`(A3 앞 5자리)에서만 정확 일치. 퍼지/이름 매칭 없음.
- **B:** A가 아니고 지상층수 ≥ 5, 단지 좌표(`complex_map_anchor` 우선, 없으면 `apt_complex_master`) 500m 안.
- **12번 파일:** `_12_` 감지 시 lawd 불일치하면 lawd가 `12`/`29`/`46`인 단지 중 A19가 **유일**하면 A로 채택하고 `gis_buildings.lawd_cd`는 단지 lawd로 저장. (실데이터 GIS A3도 `12xxx`; DB 단지도 `12xxx`, 옛 `29`/`46`은 0건.)
- **missing-only:** 이미 있는 `bld_key`는 갱신하지 않음.
- AL_D010은 필드 A0–A28 (CH는 A29/A30 추가). 매핑은 인덱스 동일, 없는 필드는 null.

## 완료 범위 (NDJSON 빌드만 — DB 미적재)

원천: `C:\data\gis\AL_D010_{sido}_20260909.zip`  
산출: `C:\data\gis\out\buildings_{sido}.ndjson`  
보조: `C:\data\gis\complexes.csv` (27360), `C:\data\gis\complex-bld-keys.csv` (93953)

| 시도 | kept A | kept B | rows | bytes | NDJSON |
|------|--------|--------|------|-------|--------|
| 11 서울 | 18604 | 88264 | 106868 | 87,115,658 | `buildings_11.ndjson` |
| 12 전남광주통합 | 33246 | 10260 | 43506 | 31,733,465 | `buildings_12.ndjson` (`file12_remap` 30664 — 러너 로그) |
| 26 부산 | 2791 | 26043 | 28834 | 24,794,493 | `buildings_26.ndjson` |
| 27 대구 | 2195 | 8863 | 11058 | 9,580,679 | `buildings_27.ndjson` |
| 28 인천 | 1618 | 19147 | 20765 | 18,224,919 | `buildings_28.ndjson` |
| 30 대전 | 1399 | 6852 | 8251 | 7,143,975 | `buildings_30.ndjson` |
| 31 울산 | 874 | 4826 | 5700 | 5,445,226 | `buildings_31.ndjson` |
| 36 세종 | 56 | 393 | 449 | 458,084 | `buildings_36.ndjson` |
| 41 경기 | 25926 | 41205 | 67131 | 61,977,572 | `buildings_41.ndjson` (**현재 배치까지 완료 후 중지**) |
| **소계** | **86309** | **207053** | **292562** | **246,474,071** | |

- **마지막 체크포인트:** 시도 `41` NDJSON 완료. 마지막 `bld_key`=`1999216906264147681300000000`. 파일 유효(bad_lines=0).
- `C:\data\gis\out\build-summary.jsonl`에는 11–36만 기록됨(러너가 41 요약 기록 전에 종료됨). 41 수치는 위 NDJSON 재집계가 기준.
- **Turso `gis_buildings`:** apply 전, 기존 **888**행(CH_D010 변동분). 증가 없음.

## 남은 범위

시도 zip 빌드 미착수:

- `43` 충북, `44` 충남, `47` 경북, `48` 경남, `50` 제주, `51` 강원, `52` 전북

이후 공통:

1. 남은 시도별 `build-gis-buildings.py` 실행 → `buildings_{sido}.ndjson`
2. 전체 NDJSON concat → `C:/data/gis/out/buildings.ndjson` (또는 `--from`을 시도별로 순차)
3. `load-gis-buildings.ts --missing-only` dry-run → 시도별/전체 A·B·연결률·용량 보고
4. 승인 후 `--missing-only --apply`
5. 재실행 insert 0 확인
6. 보고: 시도별 A 연결 동 수·complex_buildings 대비 연결률, B 건수, 총 행·DB 증가, 12번 연결, 미연결 단지 상위 10

## 실패·보류

| 항목 | 상태 | 사유 |
|------|------|------|
| 시도 43–52 NDJSON | 보류 | 중지 요청으로 미시작 |
| `buildings.ndjson` merge | 보류 | 전국 미완 |
| Turso dry-run / apply | 보류 | 빌드 전국 완료 전·중지 요청 |
| 재실행 0건 검증 | 보류 | apply 미실시 |
| 러너 pid 종료 | 의도적 중지 | 41 자식 프로세스는 NDJSON 완성 후 종료 확인 |

## 외부 API·호출량

- **없음.** 원천은 로컬 zip/SHP, DB는 Turso 읽기(단지 키 export)만. 오늘 외부 GIS/지도 API 호출 0.

## 알려진 문제·주의점

1. **12번 파일:** shp 2벌 모두 처리됨(`seen` 1,831,912). `file12_remap` 30,664건 — GIS lawd|A19 직접 일치보다 A19 유일 매칭(12/29/46)으로 lawd를 단지 코드로 바꾼 건수가 큼. 짧은 A19는 지역 내 유일해도 오연결 가능 → 연결률·샘플 검증 필요.
2. **file12_a19_ambiguous=77:** 동일 A19가 12/29/46 단지 여러 lawd에 있어 remap 제외.
3. **DB lawd:** 광주·전남은 이미 `12xxx`(29/46 없음). 사용자 문구의 29/46은 코드상 `12`/`29`/`46` prefix로 구현.
4. **AL vs CH 스키마:** AL에 A29/A30 없음 → `change_type` null. `lawd_cd`는 A3[:5] (없으면 A30 또는 A23).
5. **기존 888행:** missing-only면 유지. 해시 갱신 없음.
6. **중지 시 부수:** 다른 워크트리 `load-unit-lines.ts --apply` 프로세스도 일괄 중지됨(터미널에 `insert_or_update: 281567`까지 출력된 상태). GIS와 별건 — 해당 세션에서 재개·검증 필요.
7. **비밀값:** `.env.local` Turso URL/토큰 출력·커밋 금지.
8. 재개 시 **새 배치로 43부터** 빌드하고, 41 NDJSON은 다시 만들지 않아도 됨(완전본 확인됨).

## 재개 체크리스트 (최소)

```bash
# 예: 충북부터
python scripts/building-3d/build-gis-buildings.py C:/data/gis/AL_D010_43_20260909.zip C:/data/gis/out/buildings_43.ndjson --near C:/data/gis/complexes.csv --keys C:/data/gis/complex-bld-keys.csv --radius 500
# … 44,47,48,50,51,52 동일

# merge 후
npx tsx scripts/building-3d/load-gis-buildings.ts --from=C:/data/gis/out/buildings.ndjson --missing-only
# 보고 →
npx tsx scripts/building-3d/load-gis-buildings.ts --from=C:/data/gis/out/buildings.ndjson --missing-only --apply
# 재실행 0건 확인
```
