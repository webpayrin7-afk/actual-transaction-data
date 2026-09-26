"""
국토지리정보원 수치지도 행정경계(N3A_G0100000 시군구 · N3A_G0110000 읍면동, EPSG:5179 SHP)
→ 단순화한 WGS84 다각형 NDJSON (map_boundaries 적재용). DB 쓰기 없음.

  python scripts/map-boundary/build-boundaries.py C:/data/boundary/x C:/data/boundary/out/boundaries.ndjson

- code: BJCD 10자리 (시군구는 앞 5자리 + 00000), level: gu | dong, name: NAME (cp949)
- 단순화: 시군구 60m, 읍면동 20m (topology 유지), 좌표 소수 5자리(약 1m)
- 여러 조각(섬 등)은 MultiPolygon 그대로, 구멍(hole)은 뺀다(지도 표시용 외곽선)
"""
import json
import sys
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import shape, mapping, MultiPolygon, Polygon
from shapely.ops import transform

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.parent.mkdir(parents=True, exist_ok=True)
to_wgs = Transformer.from_crs("EPSG:5179", "EPSG:4326", always_xy=True).transform

LAYERS = [("N3A_G0100000", "gu", 60.0), ("N3A_G0110000", "dong", 20.0)]


def rings(geom):
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    res = []
    for p in polys:
        if not isinstance(p, Polygon) or p.is_empty:
            continue
        if p.area < 1e-7:  # 약 1,000㎡ 미만 조각(작은 섬·찌꺼기)은 뺀다
            continue
        res.append([[round(x, 5), round(y, 5)] for x, y in p.exterior.coords])
    return res


n = 0
with out.open("w", encoding="utf-8") as f:
    for name, level, tol in LAYERS:
        r = shapefile.Reader(str(src / name), encoding="cp949")
        for sr in r.iterShapeRecords():
            rec = sr.record.as_dict()
            geom = shape(sr.shape.__geo_interface__)
            if not geom.is_valid:
                geom = geom.buffer(0)
            simple = geom.simplify(tol, preserve_topology=True)
            wgs = transform(to_wgs, simple)
            c = wgs.representative_point()
            f.write(
                json.dumps(
                    {
                        "code": rec["BJCD"],
                        "level": level,
                        "name": rec["NAME"].strip(),
                        "lat": round(c.y, 6),
                        "lng": round(c.x, 6),
                        "rings": rings(wgs),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            n += 1
print(json.dumps({"rows": n, "out": str(out), "bytes": out.stat().st_size}))
