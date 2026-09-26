"""
초등학교 통학구역 SHP → 지도용 GeoJSON(WGS84, 단순화) + 학구→학교 + 단지→통학구역(점-다각형).
DB 쓰기 없음 — 결과 JSON을 load-zones.ts 가 dry-run/apply 한다.

  python scripts/school-zones/build-zones.py --sd=11,41 \
    --shp=C:/data/school/shp/초등학교통학구역.shp \
    --link=C:/data/school/전국학교학구도연계정보표준데이터.csv \
    --points=C:/data/school/work/complex-points.json \
    --out=C:/data/school/work/zones-11-41.json

- 원본 좌표계 EPSG:5186(Korea 2000 Central Belt 2010, m). 단순화는 원본(m)에서 5m 허용오차로 하고,
  한 구역 GeoJSON이 30KB를 넘으면 10·15·20·30m 로 올린다(topology 유지). 좌표는 소수 5자리(약 1m).
- 점-다각형 판정은 단순화 전 원본 도형으로 (경계 위 점 포함 = covers).
- 같은 HAKGUDO_ID 가 여러 행이면 도형을 합친다.
"""
import argparse
import csv
import json
import sys
from collections import defaultdict

import shapefile
from pyproj import Transformer
from shapely.geometry import mapping, shape, Point
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid

MAX_BYTES = 30 * 1024
# 동 넓이의 이 비율 이상이 든 통학구역만 단지에 잇는다 (경계에 걸친 한두 동의 잡음 제외)
MIN_SHARE = 0.15
# 기준 점과 다른 통학구역에 동 넓이의 이 비율 이상이 들면 '동에 따라 배정이 다름'으로 함께 잇는다
SPLIT_SHARE = 0.3
TOLERANCES = [5.0, 10.0, 15.0, 20.0, 30.0]


def round_coords(obj, nd=5):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], nd), round(obj[1], nd)]
        return [round_coords(x, nd) for x in obj]
    return obj


def polygonal(g):
    """make_valid 결과에서 면만 남긴다."""
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
    return unary_union(parts) if parts else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sd", default="11,41")
    ap.add_argument("--shp", required=True)
    ap.add_argument("--link", required=True)
    ap.add_argument("--points", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    sds = {s.strip() for s in a.sd.split(",") if s.strip()}

    to_wgs = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True).transform
    to_tm = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True).transform

    r = shapefile.Reader(a.shp, encoding="cp949")
    names = [f[0] for f in r.fields[1:]]
    grouped = defaultdict(list)
    attrs = {}
    shp_rows = 0
    for sr in r.iterShapeRecords():
        rec = dict(zip(names, sr.record))
        if rec["SD_CD"] not in sds:
            continue
        shp_rows += 1
        zid = rec["HAKGUDO_ID"].strip()
        g = shape(sr.shape.__geo_interface__)
        if not g.is_valid:
            g = polygonal(make_valid(g))
        if g is None or g.is_empty:
            continue
        grouped[zid].append(g)
        attrs.setdefault(zid, rec)

    zones = []
    originals = []
    tol_count = defaultdict(int)
    for zid, geoms in grouped.items():
        rec = attrs[zid]
        g = geoms[0] if len(geoms) == 1 else unary_union(geoms)
        originals.append((zid, g))
        chosen = None
        for tol in TOLERANCES:
            s = g.simplify(tol, preserve_topology=True)
            w = transform(to_wgs, s)
            gj = mapping(w)
            text = json.dumps(
                {"type": gj["type"], "coordinates": round_coords(gj["coordinates"])},
                separators=(",", ":"),
            )
            chosen = (tol, w, text)
            if len(text.encode("utf-8")) <= MAX_BYTES:
                break
        tol, w, text = chosen
        tol_count[tol] += 1
        minx, miny, maxx, maxy = w.bounds
        gb = str(rec["HAKGUDO_GB"]).strip()
        zones.append(
            {
                "zone_id": zid,
                "zone_name": str(rec["HAKGUDO_NM"]).strip(),
                "zone_kind": "joint" if gb == "1" else "single",
                "hakgudo_gb": gb,
                "sd_cd": rec["SD_CD"],
                "sgg_cd": (str(rec["SGG_CD"]).strip() or None),
                "edu_office": (str(rec["EDU_NM"]).strip() or None),
                "bbox": [round(minx, 5), round(miny, 5), round(maxx, 5), round(maxy, 5)],
                "geojson": text,
                "bytes": len(text.encode("utf-8")),
                "simplify_m": tol,
                "upd_dt": (str(rec["UPD_DT"]).strip() or None),
                "base_date": str(rec["BASE_DT"]).strip(),
            }
        )

    # 학구 → 학교 (연계 표준데이터)
    zone_ids = {z["zone_id"] for z in zones}
    schools = []
    seen = set()
    non_elem = 0
    with open(a.link, encoding="cp949", errors="strict", newline="") as f:
        rd = csv.DictReader(f)
        link_base = None
        for row in rd:
            zid = row["학구ID"].strip()
            if zid not in zone_ids:
                continue
            if row["학교급구분"].strip() != "초등학교":
                non_elem += 1
                continue
            key = (zid, row["학교ID"].strip())
            if key in seen:
                continue
            seen.add(key)
            link_base = link_base or row["데이터기준일자"].strip()
            schools.append(
                {"zone_id": zid, "facility_school_id": key[1], "school_name": row["학교명"].strip()}
            )
    zones_with_school = {s["zone_id"] for s in schools}

    # 단지 → 통학구역 (원본 도형, covers). 동 외곽선(parts: [경도, 위도, 넓이㎡])은 동별로 판정해 넓이 비율(share)로 남긴다.
    pts = json.load(open(a.points, encoding="utf-8"))
    tree = STRtree([g for _, g in originals])
    kind = {z["zone_id"]: z["zone_kind"] for z in zones}
    links = []
    per_complex = defaultdict(list)
    split_single = 0
    for p in pts:
        parts = p.get("parts") or [[p["lng"], p["lat"], 1]]
        area = defaultdict(float)
        total = 0.0
        for lng, lat, m2 in parts:
            x, y = to_tm(lng, lat)
            total += m2
            for i in tree.query(Point(x, y), predicate="intersects"):
                area[originals[i][0]] += m2
        if not total:
            continue
        # 판정: 단지 기준 점(주소 점 → 필지 점)이 든 구역이 기본. 동별 투표는 보조로만 —
        #  (1) 동이 2개 이상이고 다른 통학구역에 동 넓이의 SPLIT_SHARE 이상이 들면 그 구역도 잇는다 (동에 따라 배정이 다름)
        #  (2) 기준 점이 어느 구역에도 안 들면(구역 사이 틈·도로) 동 넓이가 가장 많이 든 구역
        # (동 외곽선 연결이 틀린 단지도 있어, 동 투표만으로 기본 판정을 바꾸지 않는다)
        x0, y0 = to_tm(p["lng"], p["lat"])
        at_point = [originals[i][0] for i in tree.query(Point(x0, y0), predicate="intersects")]
        shares = {zid: a_ / total for zid, a_ in area.items()}
        chosen = [(zid, shares.get(zid)) for zid in at_point]
        if p.get("parts") and len(parts) >= 2:
            for zid, sh in shares.items():
                if zid not in at_point and kind[zid] == "single" and sh >= SPLIT_SHARE:
                    chosen.append((zid, sh))
        if not chosen and shares:
            best = max(shares.items(), key=lambda t: t[1])
            if best[1] >= MIN_SHARE:
                chosen = [best]
        if sum(1 for zid, _ in chosen if kind[zid] == "single") > 1:
            split_single += 1
        for zid, share in sorted(chosen, key=lambda t: -(t[1] if t[1] is not None else 1.0)):
            per_complex[p["complex_id"]].append(zid)
            links.append(
                {
                    "complex_id": p["complex_id"],
                    "zone_id": zid,
                    "zone_kind": kind[zid],
                    "lat": p["lat"],
                    "lng": p["lng"],
                    "src": p["src"],
                    "share": None if share is None else round(share, 3),
                }
            )

    multi_single = sum(
        1 for zs in per_complex.values() if sum(1 for z in zs if kind[z] == "single") > 1
    )
    sizes = sorted(z["bytes"] for z in zones)
    stats = {
        "sds": sorted(sds),
        "shp_rows": shp_rows,
        "zones": len(zones),
        "zones_single": sum(1 for z in zones if z["zone_kind"] == "single"),
        "zones_joint": sum(1 for z in zones if z["zone_kind"] == "joint"),
        "zones_without_school_link": len(zone_ids - zones_with_school),
        "tolerance_m": dict(sorted(tol_count.items())),
        "bytes": {
            "max": sizes[-1],
            "p50": sizes[len(sizes) // 2],
            "p95": sizes[int(len(sizes) * 0.95)],
            "over_30k": sum(1 for s in sizes if s > MAX_BYTES),
        },
        "school_links": len(schools),
        "school_links_non_elementary_skipped": non_elem,
        "link_base_date": link_base,
        "points": len(pts),
        "complexes_linked": len(per_complex),
        "complexes_unlinked": len(pts) - len(per_complex),
        "complexes_multi_single_zone": multi_single,
        "complexes_split_single_zone": split_single,
        "complexes_with_joint": sum(1 for zs in per_complex.values() if any(kind[z] == "joint" for z in zs)),
        "link_rows": len(links),
    }
    json.dump(
        {"stats": stats, "zones": zones, "schools": schools, "links": links},
        open(a.out, "w", encoding="utf-8"),
        ensure_ascii=False,
    )
    json.dump(stats, sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == "__main__":
    main()
