"""
국토교통부 GIS건물통합정보(AL_D010/CH_D010, SHP, EPSG:5186) → 3D용 건물 NDJSON. DB 쓰기 없음.

  python scripts/building-3d/build-gis-buildings.py <shp|zip|폴더> <out.ndjson> \
      --near complexes.csv --keys complex-bld-keys.csv [--radius 500]

적재 후보만 남긴다 (퍼지/이름 매칭 없음):
  A. complex_buildings.mgm_bldrgst_pk[5:] = GIS A19, 같은 lawd(A3 앞 5자리)에서만 정확 일치
     - 파일명에 _12_ 가 있으면(전남광주통합): lawd 불일치 시 lawd가 12/29/46인 단지 중 A19만
       유일 일치하면 A로 채택하고 lawd_cd는 그 단지의 코드로 저장
  B. A가 아니고 지상층수 ≥ 5 이며 --near 단지 좌표 반경 --radius(m) 안

- 외곽선: 0.3m 단순화, 위경도 소수 7자리, 구멍(hole)은 뺀 외곽만.
- 속성은 원천 그대로 (높이·층수·용도·사용승인일 …). 높이가 0/빈 값이면 null.
- 원천 필드: A1 식별번호, A2 PNU, A3 법정동코드, A8/A9 용도, A11 구조, A12 건축면적,
  A13 사용승인일, A14 연면적, A16 높이, A19 건축물ID, A22 기준일, A24/A25 건물명/동명,
  A26/A27 지상/지하층수. CH_D010만 A29 변동구분·A30 시군구(AL은 A23이 시군구).
"""
import csv
import json
import math
import re
import sys
import zipfile
import tempfile
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import shape, MultiPolygon, Polygon
from shapely.ops import transform

args = sys.argv[1:]
if len(args) < 2:
    raise SystemExit(__doc__)
src = Path(args[0])
out = Path(args[1])
near_csv = args[args.index("--near") + 1] if "--near" in args else None
keys_csv = args[args.index("--keys") + 1] if "--keys" in args else None
radius = float(args[args.index("--radius") + 1]) if "--radius" in args else 500.0
out.parent.mkdir(parents=True, exist_ok=True)

file12_mode = bool(re.search(r"_12_", src.name)) or (
    src.is_dir() and any(re.search(r"_12_", p.name) for p in src.rglob("AL_D010_12*.zip"))
)

to_wgs = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True).transform

# 단지 좌표 격자 (반경 필터용, 약 0.01도 칸)
grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
if near_csv:
    with open(near_csv, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            lat, lng = float(row["lat"]), float(row["lng"])
            grid.setdefault((int(lat * 100), int(lng * 100)), []).append((lat, lng))

# A 매칭: lawd|a19 → complex meta / file12용 a19 → unique lawd
keys_lawd: set[str] = set()
file12_a19_lawd: dict[str, str] = {}  # a19 → lawd when unique among 12/29/46
file12_a19_ambiguous: set[str] = set()
if keys_csv:
    by_a19: dict[str, set[str]] = {}
    with open(keys_csv, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            lawd = (row.get("lawd_cd") or "").strip()
            a19 = (row.get("bldrgst_pk") or "").strip()
            if not lawd or not a19:
                continue
            keys_lawd.add(f"{lawd}|{a19}")
            if lawd.startswith(("12", "29", "46")):
                by_a19.setdefault(a19, set()).add(lawd)
    for a19, lawds in by_a19.items():
        if len(lawds) == 1:
            file12_a19_lawd[a19] = next(iter(lawds))
        else:
            file12_a19_ambiguous.add(a19)


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


def at(rec, i):
    return rec[i] if i < len(rec) else None


def shp_sources(root: Path):
    if root.is_file() and root.suffix.lower() == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="gis_"))
        with zipfile.ZipFile(root) as zf:
            zf.extractall(tmp)
        for p in sorted(tmp.rglob("*.shp")):
            yield p
        return
    if root.is_file() and root.suffix.lower() == ".shp":
        yield root
        return
    for p in sorted(root.rglob("*.shp")):
        yield p
    for z in sorted(root.rglob("*.zip")):
        tmp = Path(tempfile.mkdtemp(prefix="gis_"))
        with zipfile.ZipFile(z) as zf:
            zf.extractall(tmp)
        for p in sorted(tmp.rglob("*.shp")):
            yield p


seen = kept_a = kept_b = skipped = bad = 0
file12_remap = 0
with out.open("w", encoding="utf-8") as fo:
    for shp in shp_sources(src):
        shp_file12 = file12_mode or bool(re.search(r"_12_", shp.name))
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
            a19 = txt(at(rec, 19))
            bjdong = txt(at(rec, 3))
            lawd = (bjdong or "")[:5] or txt(at(rec, 30)) or txt(at(rec, 23))
            floors = int(at(rec, 26)) if num(at(rec, 26)) else None

            kind = None
            if a19 and lawd and f"{lawd}|{a19}" in keys_lawd:
                kind = "A"
            elif shp_file12 and a19 and a19 in file12_a19_lawd:
                lawd = file12_a19_lawd[a19]
                kind = "A"
                file12_remap += 1
            elif floors is not None and floors >= 5 and near_complex(c.y, c.x):
                kind = "B"
            else:
                skipped += 1
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
            key = txt(at(rec, 1)) or a19
            if not key:
                bad += 1
                continue
            fo.write(
                json.dumps(
                    {
                        "bld_key": key,
                        "bldrgst_pk": a19,
                        "pnu": txt(at(rec, 2)),
                        "bjdong_cd": bjdong,
                        "lawd_cd": lawd,
                        "name": txt(at(rec, 24)),
                        "dong_name": txt(at(rec, 25)),
                        "use_code": txt(at(rec, 8)),
                        "use_name": txt(at(rec, 9)),
                        "structure": txt(at(rec, 11)),
                        "height_m": num(at(rec, 16)),
                        "floors_above": floors,
                        "floors_below": int(at(rec, 27)) if num(at(rec, 27)) else None,
                        "building_area": num(at(rec, 12)),
                        "total_floor_area": num(at(rec, 14)),
                        "approval_date": txt(at(rec, 13)),
                        "lat": round(c.y, 7),
                        "lng": round(c.x, 7),
                        "rings": rings,
                        "source_date": str(at(rec, 22)) if at(rec, 22) else None,
                        "change_type": txt(at(rec, 29)),
                        "keep": kind,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            if kind == "A":
                kept_a += 1
            else:
                kept_b += 1

print(
    json.dumps(
        {
            "src": str(src),
            "file12_mode": file12_mode,
            "seen": seen,
            "kept_a": kept_a,
            "kept_b": kept_b,
            "kept": kept_a + kept_b,
            "skipped": skipped,
            "bad": bad,
            "file12_remap": file12_remap,
            "file12_a19_ambiguous": len(file12_a19_ambiguous),
            "out": str(out),
            "out_bytes": out.stat().st_size if out.exists() else 0,
        },
        ensure_ascii=False,
    )
)
