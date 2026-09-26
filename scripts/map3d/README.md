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
