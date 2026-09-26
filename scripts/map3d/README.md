# 서울 3D 지도 — 건물 타일 (PMTiles)

지도로 찾기 → `3D` 버튼을 누르면 `src/components/map3d/Seoul3DMap.tsx`(MapLibre)가 이 파일 하나에서
필요한 타일만 HTTP Range로 읽는다. DB 쓰기 없음.

## 1. 만들기

원천: 국토교통부 GIS건물통합정보 `AL_D010_11_*.zip`(서울, SHP/EPSG:5186). DB의 `gis_buildings`는 단지 주변
400m만 있어 서울 전체가 아니므로 원천 파일을 직접 쓴다. tippecanoe가 없는 Windows에서도 되도록
파이썬(pyshp·pyproj·shapely — `scripts/building-3d/build-gis-buildings.py`와 같은 도구)으로 자르고,
MVT 인코딩·PMTiles v3 쓰기는 스크립트 안에 들어 있다.

```bash
python scripts/map3d/build_buildings_pmtiles.py C:/data/gis/AL_D010_11_20260909.zip public/map3d/seoul-buildings.pmtiles
node scripts/map3d/verify-pmtiles.mjs public/map3d/seoul-buildings.pmtiles   # 머리글·메타·잠실 타일 풀어 보기
```

- 레이어 `buildings`, 속성 `h`(높이 m 정수 — A16, 없으면 지상층수×3.3, 둘 다 없으면 3.5) · `a`(공동주택=1)뿐.
- 줌 12(40m 이상) · 13(15m 이상 또는 바닥 1,500㎡ 이상) · 14(바닥 12㎡ 이상) · 15(전부). 16+ 는 15를 확대.
- 2026-09-09 원천 기준: 건물 695,763개, 타일 984개, **25.7MB** (z12 0.3 · z13 1.7 · z14 10.8 · z15 12.9MB, gzip),
  가장 큰 타일 196KB(z14). 약 7~9분.

### v2 — 최근 준공 단지 더하기 (도로명주소 건물 SPBD)

AL_D010에는 최근 준공 단지(헬리오시티·래미안웰스트림·올림픽파크포레온 등)가 없고, 철거된 옛 건물(원베일리 자리의 반포경남)이
남아 있다. DB `gis_buildings`의 `change_type='SPBD'`(브이월드 도로명주소 건물, `scripts/building-3d/fill-gis-from-vworld-spbd.mts`로
단지 동에 붙인 것) 중 서울(`lawd_cd` 11*)을 더하고, 그 도형과 (작은 쪽 면적의) 30% 이상 겹치는 AL_D010 건물은 뺀다.

```bash
npx tsx scripts/map3d/export_spbd_buildings.mts C:/data/map3d/seoul-spbd.geojson          # DB 읽기만
python scripts/map3d/build_buildings_pmtiles.py C:/data/gis/AL_D010_11_20260909.zip C:/data/map3d/seoul-buildings-v2.pmtiles --spbd C:/data/map3d/seoul-spbd.geojson
npx tsx scripts/map3d/verify-complexes.mts C:/data/map3d/seoul-buildings-v2.pmtiles 헬리오시티 래미안웰스트림   # 동마다 타일에 있는지
```

- SPBD 높이: 단지 동 대장 `height_m` → 층수(SPBD·대장 중 큰 값)×3m → 3.5m. `a`=1(모두 단지 동).
- 2026-09-26: AL_D010 695,763 중 5,129 뺌, SPBD 4,270건(폴리곤 4,271) 더함.

### v3 — 브이월드 SPBD 캐시 중 v2 타일에 없는 건물 더하기 (2026-09-27)

`data/building-coverage/PLAN.md` A절 명령 그대로(`export-spbd-missing.mts` → `--spbd seoul-spbd-plus.geojson`).

- SPBD `a`: GeoJSON `properties.a`를 읽는다(없으면 1). 추가분은 이름(아파트/맨션)·숫자 동 표기(5층+)·500m 안 단지 이름이면 1,
  30% 겹친 옛 AL_D010이 공동주택이면 1, 나머지 0(회색).
- 33m 이상 AL_D010은 겹치는 SPBD 중 80% 이상 높이가 있을 때만 뺀다. 아니면 고층을 두고 그 낮은 SPBD를 뺀다.
- 결과: AL_D010 31,629 뺌 · SPBD 39,995 더함(공동주택 10,561) · 고층 지킴 158 · 건물 704,129 · **27.3MB**.
- 올리기 전 구역 비교: `npx tsx scripts/building-coverage/compare-tiles.mts <v2> <v3>` (없어진 10층+ 0 확인).

## 2. 올리기 (Vercel Blob)

파일이 커서 git에는 넣지 않는다(`/public/map3d/*.pmtiles`는 .gitignore). 개발 서버는 `public/map3d/`에서 읽는다.

1. (한 번만) Vercel 프로젝트 → Storage → Blob 스토어 만들기 → 프로젝트에 연결하면 `BLOB_READ_WRITE_TOKEN`이 생긴다.
2. 올리기 (토큰은 환경변수로만):

   ```bash
   BLOB_READ_WRITE_TOKEN=... npx vercel blob put public/map3d/seoul-buildings.pmtiles \
     --access public --pathname map3d/seoul-buildings-20260909.pmtiles --cache-control-max-age 31536000
   ```

3. 나온 URL을 Vercel 환경변수 `NEXT_PUBLIC_MAP3D_BUILDINGS_URL`(Preview부터)에 넣고 다시 배포.
   파일 이름에 원천 날짜를 넣어 두면 갱신할 때 새 이름으로 올리고 변수만 바꾸면 된다(캐시 문제 없음).

변수가 없으면 `/map3d/seoul-buildings.pmtiles`를 찾고, 없으면 3D 화면이 "3D 건물 준비 중"을 띄우고
바탕 지도와 단지만 보여 준다.
