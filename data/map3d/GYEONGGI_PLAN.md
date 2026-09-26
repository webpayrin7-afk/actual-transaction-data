# 3D 지도 경기도 확장 — 준비 결과와 계획 (2026-09-27, 준비만)

업로드·환경변수·배포·DB 쓰기 없음. 시험 타일은 로컬(`C:/data/map3d/`)에만 있음.

## 1. 원천 데이터 — 이미 로컬에 있음 (사장님 다운로드 불필요)

- 서울 타일 원천: `C:/data/gis/AL_D010_11_20260909.zip` (국토교통부 GIS건물통합정보, SHP/EPSG:5186, 2026-09-09 기준)
- 같은 폴더에 **경기 `AL_D010_41_20260909.zip`(386MB)** 이 이미 있음. 같은 날짜 기준으로 12·26·27·28(인천)·30·31·36·43·44·47·48·50·51·52 zip도 모두 받아져 있음.
- **주의 — 경기 zip은 SHP가 3개로 나뉘어 있음**: `AL_D010_41_20260909.shp`(100만) · `(2).shp`(100만) · `(3).shp`(298,133) = 2,298,133건.
  원본 `build_buildings_pmtiles.py`는 zip 안 첫 번째 .shp만 읽으므로(서울은 1개라 문제없음) 경기에 그대로 쓰면 **건물 57%가 빠진다**.
  지역판 스크립트는 모든 .shp를 읽도록 고침. 큰 시도(경북 47·경남 48·충남 44 등)도 같은 문제일 가능성 높음.

## 2. 경기 시험 타일

지역판 스크립트: `scripts/map3d/build_region_pmtiles.py` — 원본 복사본(원본은 서울 v3 작업 중이라 손대지 않음).
바뀐 점은 `--region seoul|gyeonggi`(자르는 범위·메타 이름), 여러 SHP 조각 모두 읽기, 바닥 면적을 건물마다 자기 위도로 계산하는 것 셋뿐.
SPBD 합치기(`--spbd`)·줌 규칙·MVT/PMTiles 쓰기는 원본과 같음.

```bash
python scripts/map3d/build_region_pmtiles.py C:/data/gis/AL_D010_41_20260909.zip C:/data/map3d/gyeonggi-buildings-test.pmtiles --region gyeonggi
```

| 항목 | 경기 (시험, SPBD 없음) | 서울 v2 (참고) |
|---|---|---|
| 파일 | `C:/data/map3d/gyeonggi-buildings-test.pmtiles` | `seoul-buildings-v2.pmtiles` |
| 크기 | **70.6MB** (z12 0.5 · z13 2.3 · z14 29.7 · z15 38.1MB, gzip) | 26.3MB (v3 27.2MB) |
| 건물 | **2,298,110** (좌표 튐 45건 제외) | 694,905 |
| 타일 | 13,340 (z12 140 · z13 675 · z14 2,756 · z15 9,769) | 984 |
| 가장 큰 타일 | 184KB (서울 196KB보다 작음 — 모바일 부담 같은 수준) | 196KB |
| 만드는 시간 | 23분 20초 (읽기 10분 · z15 9분) | 4~9분 |
| 범위(bbox) | 126.381, 36.897 ~ 127.823, 38.237 | |

- 검증: 머리글·메타 정상, 분당 부근 z12~15 타일을 풀어 건물이 들어 있는 것 확인(`verify-pmtiles.mjs`는 잠실 고정이라 경기 파일에선 missing이 정상).
- 경기는 작은 창고·축사가 많아 z14(바닥 12㎡ 이상)가 29.7MB로 서울(10.8MB)의 3배. 줄이고 싶으면 경기만 z14 기준을 30㎡로 올리는 선택지(화면 차이는 줌 14~15 사이 작은 건물뿐).

### SPBD(최근 준공 단지) 보강 — 서울 v2처럼
- DB `gis_buildings` 경기(41*) 행 78,666 중 **SPBD 11,403건** 이미 있음(서울은 4,728). 경기 신도시(동탄·광교·위례·고덕·운정 등)는 AL_D010에 없는 신축이 서울보다 많아 보강 효과가 클 것.
- `scripts/map3d/export_spbd_buildings.mts`가 `lawd_cd LIKE '11%'` 고정 → 지역 인자(`--lawd 41`)만 추가하면 됨(DB 읽기만). 그 뒤 `build_region_pmtiles.py ... --region gyeonggi --spbd C:/data/map3d/gyeonggi-spbd.geojson`.
- 서울 v3처럼 브이월드 SPBD 캐시(`C:/data/fixes/gis-spbd/cache`)로 "타일에 없는 SPBD" 추가분을 만들려면 `scripts/building-coverage/*`도 서울 고정이라 같은 방식의 지역 인자 필요(선택).

## 3. 합칠까, 나눌까 — **두 파일(소스 2개) 권장**

추정: 서울 v3 27MB + 경기 71MB(+SPBD 1~2MB) ≈ **약 100MB**. 한 파일로 합쳐도 경계 타일 몇 개만 겹쳐 크기는 거의 같고, 만드는 시간은 30분 이상.

| | 한 파일 (서울+경기) | 두 파일 (권장) |
|---|---|---|
| 앱 코드 | 지금 그대로(URL만 교체) | 건물 소스·레이어를 지역 목록으로 반복(소스 2개, 같은 `buildings-3d` 스타일) |
| 갱신 | 서울만 고쳐도 100MB 재빌드·재업로드 | 서울 27MB / 경기 71MB 따로 — 서울 v3 작업과 충돌 없음 |
| 경계 | 한 타일에 둘 다 | AL_D010 11·41은 건물이 겹치지 않아 두 소스가 경계 타일을 각자 그리면 빈틈·중복 없음 |
| 요청 | 1개 파일 | 각 PMTiles는 머리글·디렉터리(수십 KB)만 먼저 읽고, 헤더 bounds 밖 타일은 요청 안 함. 경기 bbox가 서울을 감싸 서울 안에서도 경기 디렉터리를 조금 읽지만 타일이 없어 데이터 요청은 거의 없음 |

앱 변경(코드 작업, 배포는 사장님 승인 후):
1. `seoul-3d-style.ts`: `buildingsTilesUrl()` → 지역 목록 `BUILDING_SOURCES = [{ id: "seoul", url, bounds }, { id: "gyeonggi", url, bounds }]`,
   환경변수는 `NEXT_PUBLIC_MAP3D_BUILDINGS_URL`(서울, 기존) + `NEXT_PUBLIC_MAP3D_BUILDINGS_GG_URL`(경기) 식으로.
2. `Seoul3DMap.tsx`(약 770~850행): `addSource("buildings")`·`buildings-3d` 레이어를 목록만큼 반복. 단지 선택 시 주변 건물을 옅게 하는 필터·`setBuildingsMissing`(소스 id가 `"buildings"`인지 확인) 등 `"buildings"` 이름을 쓰는 곳을 모두 목록 기준으로.
3. `SEOUL_BOUNDS`(서울 밖 안내, `MapSearchPage.tsx`의 `inSeoul` — 3D 초대·브리핑에서 3D→2D 전환) → "건물 타일이 있는 곳" 판정으로 교체.
   경기 사각형 범위는 **인천·충남·강원 일부를 포함**하므로 사각형만으로는 인천에서 잘못 "있음"이 됨 → 서울+경기 외곽 폴리곤(간략화 50~100점, 원천 `C:/data/boundary/N3A_G0100000.zip` 시도 경계)으로 점-안-폴리곤 판정 권장.
   더 간단한 대안: **인천(AL_D010_28, 55MB zip, 이미 있음, 예상 10~12MB)까지 같이 만들어 수도권 전체**로 두고 사각형 판정 유지(126.3~127.9 × 36.9~38.3에서 충남·강원 가장자리만 오차).
4. 안내 문구 "3D 건물은 서울만 준비돼 있어요" → "서울·경기만".
5. `seoul-districts.ts`(구 이동 알약, 서울 25구 고정) — 경기 시군(수원·성남·고양·용인 등 31) 추가하거나 "시도 → 구" 두 단계로. 3D 파일 이름·컴포넌트 이름(Seoul3DMap)은 그대로 둬도 됨.

## 4. 3D 지도에서 서울 전용인 다른 것들

| 항목 | 지금 | 경기 상태 (DB 읽기 2026-09-27) | 할 일 | 품 |
|---|---|---|---|---|
| 건물 타일 | 서울 v2(운영) | 시험 타일 완료 | SPBD 보강 빌드 → 업로드 → 앱 소스 2개 | 앱 반나절 + 빌드 30분 |
| 단지 3D 점 자리 `complex_3d_anchor` | 서울 7,948 | **0** — 경기 마스터 6,529(좌표 있음 6,445) | `build-3d-anchors.mts`의 `lawd_cd LIKE '11%'`(3곳)를 `--lawd=41` 인자로 → dry-run → apply(INSERT OR IGNORE, 약 5,500~5,900행 쓰기) | 1~2시간(주로 dry-run 읽기) |
| 동 외곽선 연결(complex_buildings ↔ gis_buildings) | 서울 7,880/8,364 (94%) | **5,955/6,445 (92%)** 이미 연결됨 — `gis_buildings` 경기 78,666행, `complex_buildings` 6,358단지 42,656행 | 없음(이미 있음). 빈 곳 감사는 `scripts/building-coverage/*`가 서울 고정 → 필요 시 지역 인자 | — |
| 대지 경계 `complex_site_boundary` | 요청 때 만들어 저장(서울 126건) | 0 — 같은 코드가 경기도 요청 때 만듦(브이월드 지적 + 추정) | 없음. 미리 채우려면 배치(쓰기 6천 행 — 쿼터상 비권장, 필요 때 생성으로 충분) | — |
| 지형 | AWS terrarium(전국) + 로컬 DEM 선택 | 전국 기본 동작 | 없음 | — |
| 도보 경로 | 배치 phase `서울:300,경기:300,전국` | 이미 경기 포함 | 없음 | — |
| 서울 밖 안내 / 3D 초대 / 브리핑 3D 유지 | `SEOUL_BOUNDS` | — | 3절 3번 | 앱 작업에 포함 |
| 구 이동 알약 | 서울 25구 | — | 3절 5번 | 1~2시간 |
| 검증 스크립트 | `verify-complexes.mts` `LIKE '11%'`, `verify-pmtiles.mjs` 잠실 고정 | — | 지역·좌표 인자 | 30분 |

`build-3d-anchors.mts` 참고: 2026-09-27 조사 중 다른 작업의 병합이 진행 중이었고 지금은 끝남(충돌 표시 없음).
앵커 쓰기는 Turso 쓰기 쿼터(메모: diff-only)에 맞춰 dry-run 건수 확인 → 한 번 apply → 다시 apply = 0.

## 5. 순서 (사장님 승인 필요한 곳 ★)

1. `export_spbd_buildings.mts`에 지역 인자 → 경기 SPBD GeoJSON (DB 읽기) → 경기 v1 타일(`--spbd`) 빌드, 동탄·광교 신축 단지 `verify-complexes`로 확인.
2. (선택) 인천 28도 같이 빌드 → 수도권 사각형 판정으로 단순화.
3. 앱: 소스 목록·커버리지 판정·문구·시군 이동 (코드, 미리보기에서 확인).
4. `build-3d-anchors.mts --lawd=41` dry-run → ★ apply (DB 쓰기 약 6천 행).
5. ★ Vercel Blob 업로드(`--pathname map3d/gyeonggi-buildings-v1.pmtiles`, README 2절과 같은 방법, 토큰은 사장님 환경변수) → ★ 환경변수·배포.
