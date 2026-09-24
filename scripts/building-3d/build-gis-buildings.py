"""
국토교통부 GIS건물통합정보(CH_D010, SHP, EPSG:5186) → 3D용 건물 NDJSON. DB 쓰기 없음.

  python scripts/building-3d/build-gis-buildings.py <shp 폴더 또는 .zip 들이 있는 폴더> <out.ndjson> \
      [--near complexes.csv] [--radius 400]

- --near: 단지 좌표 CSV(complex_id,lat,lng). 주면 단지 중심 반경 --radius(m) 안의 건물만 남긴다
  (전국 수백만 동 중 3D 단지 탐색에 쓰는 주변만 — 주변 건물은 그림자·조망 계산과 배경에 쓴다).
- 외곽선: 0.3m 단순화, 위경도 소수 7자리, 구멍(hole)은 뺀 외곽만.
- 속성은 원천 그대로 (높이·층수·용도·사용승인일 …). 높이가 0/빈 값이면 null (추정하지 않음 — 화면에서 층수로만 쓸지 판단).
- 원천 필드(A0~A30): A1 GIS건물통합식별번호, A2 PNU, A3 법정동코드, A8/A9 용도, A11 구조, A12 건축면적,
  A13 사용승인일, A14 연면적, A16 높이, A19 건물ID, A22 기준일, A24 건물명, A25 동명, A26/A27 지상/지하층수,
  A29 변동구분, A30 시군구코드.
"""
import csv
import json
import math
import sys
import zipfile
import tempfile
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import shape, MultiPolygon, Polygon
from shapely.ops import transform

args = sys.argv[1:]
src = Path(args[0])
out = Path(args[1])
near_csv = args[args.index("--near") + 1] if "--near" in args else None
radius = float(args[args.index("--radius") + 1]) if "--radius" in args else 400.0
out.parent.mkdir(parents=True, exist_ok=True)

to_wgs = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True).transform

# 단지 좌표 격자 (반경 필터용, 약 0.01도 칸)
grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
if near_csv:
    with open(near_csv, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            lat, lng = float(row["lat"]), float(row["lng"])
            grid.setdefault((int(lat * 100), int(lng * 100)), []).append((lat, lng))


def near_complex(lat: float, lng: float) -> bool:
    if not grid:
        return True
    ci, cj = int(lat * 100), int(lng * 100)
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            for (a, b) in grid.get((ci + di, cj + dj), ()):
                dy = (lat - a) * 111_320
                dx = (lng - b) * 111_320 * math.cos(math.radians(a))
                if dx * dx + dy * dy <= radius * radius:
                    return True
    return False


def num(v):
    try:
        x = float(v)
        return x if x > 0 else None
    except (TypeError, ValueError):
        return None


def txt(v):
    s = ("" if v is None else str(v)).strip()
    return s or None


def shp_sources(root: Path):
    for p in sorted(root.rglob("*.shp")):
        yield p
    for z in sorted(root.rglob("*.zip")):
        tmp = Path(tempfile.mkdtemp(prefix="gis_"))
        with zipfile.ZipFile(z) as zf:
            zf.extractall(tmp)
        for p in sorted(tmp.rglob("*.shp")):
            yield p


seen = kept = skipped_far = bad = 0
with out.open("w", encoding="utf-8") as fo:
    for shp in shp_sources(src):
        r = shapefile.Reader(str(shp.with_suffix("")), encoding="cp949")
        for sr in r.iterShapeRecords():
            seen += 1
            rec = sr.record
            try:
                geom = shape(sr.shape.__geo_interface__)
                if not geom.is_valid:
                    geom = geom.buffer(0)
                geom = geom.simplify(0.3, preserve_topology=True)
                wgs = transform(to_wgs, geom)
            except Exception:
                bad += 1
                continue
            c = wgs.representative_point()
            if not near_complex(c.y, c.x):
                skipped_far += 1
                continue
            polys = wgs.geoms if isinstance(wgs, MultiPolygon) else [wgs]
            rings = [
                [[round(x, 7), round(y, 7)] for x, y in p.exterior.coords]
                for p in polys
                if isinstance(p, Polygon) and not p.is_empty
            ]
            if not rings:
                bad += 1
                continue
            key = txt(rec[1]) or txt(rec[19])
            if not key:
                bad += 1
                continue
            fo.write(
                json.dumps(
                    {
                        "bld_key": key,
                        "bldrgst_pk": txt(rec[19]),
                        "pnu": txt(rec[2]),
                        "bjdong_cd": txt(rec[3]),
                        # A30은 시 단위(성남시 41130)로 올 때가 있어 법정동코드 앞 5자리(구 단위)를 쓴다
                        "lawd_cd": (txt(rec[3]) or "")[:5] or txt(rec[30]),
                        "name": txt(rec[24]),
                        "dong_name": txt(rec[25]),
                        "use_code": txt(rec[8]),
                        "use_name": txt(rec[9]),
                        "structure": txt(rec[11]),
                        "height_m": num(rec[16]),
                        "floors_above": int(rec[26]) if num(rec[26]) else None,
                        "floors_below": int(rec[27]) if num(rec[27]) else None,
                        "building_area": num(rec[12]),
                        "total_floor_area": num(rec[14]),
                        "approval_date": txt(rec[13]),
                        "lat": round(c.y, 7),
                        "lng": round(c.x, 7),
                        "rings": rings,
                        "source_date": str(rec[22]) if rec[22] else None,
                        "change_type": txt(rec[29]),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            kept += 1

print(json.dumps({"seen": seen, "kept": kept, "skipped_far": skipped_far, "bad": bad, "out": str(out)}))
