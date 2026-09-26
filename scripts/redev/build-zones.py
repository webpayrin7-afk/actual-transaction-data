r"""
서울시 UPIS 의제처리구역(UPIS_C_UQ181) SHP zip → redev_zones 적재용 NDJSON + 연결 계산용 GeoJSON. DB 쓰기 없음.

  python scripts/redev/build-zones.py "C:/data/redev/570_UQ181_의제처리구역_202609.zip" C:/data/boundary/x/N3A_G0100000 C:/data/redev/out

- zip 안 경로·dbf 한글은 cp949. 좌표계 Korean_1985_Modified_Korea_Central_Belt(Bessel) → WGS84, towgs84 7-파라미터.
- 같은 PRESENT_SN의 똑같은 행(속성·모양 모두)은 하나만. 내용이 다르면 zone_id = PRESENT_SN:WTNNC_SN.
- gu: 대표점(폴리곤 안 보장)이 들어가는 자치구, 국토지리정보원 시군구 경계(EPSG:5179, 단순화 전).
- rings: 20m 단순화(topology 유지) 외곽선, 소수 5자리. zones_full.geojson은 단순화 전(구멍 포함) — 점-폴리곤 판정용.
- category_name: 원천 레이어표_181.xlsx의 코드 → 이름. 레이어표에 없는 코드(UQ181x·UQ9100·UQA330)는 NULL.
  (UQ1812 구역명엔 가로주택·모아타운·소규모주택정비 관리지역이 섞여 있어 이름으로 짐작하지 않는다.)
- name: DGM_NM 원문. 원천에 깨진 이름(UTF-8을 cp949로 저장한 흔적)이 있어 그대로 두고 건수만 센다.
"""
import datetime
import hashlib
import io
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import MultiPolygon, Polygon, Point, mapping, shape
from shapely.ops import transform
from shapely.strtree import STRtree

sys.stdout.reconfigure(encoding="utf-8")

SRC_ZIP, GU_SHP, OUT = sys.argv[1], sys.argv[2], Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)

BESSEL_CENTRAL = (
    "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m "
    "+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +no_defs"
)
to_wgs = Transformer.from_crs(BESSEL_CENTRAL, "EPSG:4326", always_xy=True).transform
wgs_to_5179 = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True).transform

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
T = "{%s}t" % NS["m"]


def layer_names(z: zipfile.ZipFile) -> dict:
    """레이어표_181.xlsx 첫 시트: 각 행의 (이름, 코드) 쌍을 코드 → 이름으로. 같은 코드는 행의 마지막(가장 세부) 이름."""
    name = next(n for n in z.namelist() if n.endswith("레이어표_181.xlsx"))
    x = zipfile.ZipFile(io.BytesIO(z.read(name)))
    shared = ["".join(t.text or "" for t in si.iter(T)) for si in ET.fromstring(x.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    out = {}
    for row in ET.fromstring(x.read("xl/worksheets/sheet1.xml")).find("m:sheetData", NS).findall("m:row", NS):
        vals = []
        for c in row.findall("m:c", NS):
            v = c.find("m:v", NS)
            if v is not None:
                vals.append((shared[int(v.text)] if c.get("t") == "s" else v.text).strip())
        for i in range(1, len(vals)):
            if re.fullmatch(r"U[A-Z0-9]{5}", vals[i]) and not re.fullmatch(r"U[A-Z0-9]{5}", vals[i - 1]):
                out[vals[i]] = vals[i - 1]
    return out


def notice_date(sn: str):
    m = re.fullmatch(r"\d{5}NTC(\d{8})\d{4}", sn or "")
    if not m:
        return None
    try:
        return datetime.datetime.strptime(m.group(1), "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def ext_rings(geom):
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    return [[[round(x, 5), round(y, 5)] for x, y in p.exterior.coords] for p in polys if isinstance(p, Polygon) and not p.is_empty]


# 자치구 경계
gr = shapefile.Reader(GU_SHP, encoding="cp949")
gu_polys, gu_meta = [], []
for sr in gr.iterShapeRecords():
    code = str(sr.record["BJCD"])
    if code.startswith("11"):
        gu_polys.append(shape(sr.shape.__geo_interface__))
        gu_meta.append((code[:5], sr.record["NAME"]))
gu_tree = STRtree(gu_polys)
assert len(gu_polys) == 25, len(gu_polys)


def gu_of(lng, lat):
    x, y = wgs_to_5179(lng, lat)
    hits = [i for i in gu_tree.query(Point(x, y)) if gu_polys[i].contains(Point(x, y))]
    return gu_meta[hits[0]] if len(hits) == 1 else (None, None)


z = zipfile.ZipFile(SRC_ZIP, metadata_encoding="cp949")
names = layer_names(z)
base = next(n[:-4] for n in z.namelist() if n.endswith("UPIS_C_UQ181.shp"))
r = shapefile.Reader(
    shp=io.BytesIO(z.read(base + ".shp")), shx=io.BytesIO(z.read(base + ".shx")), dbf=io.BytesIO(z.read(base + ".dbf")),
    encoding="cp949",
)

groups = defaultdict(list)
for sr in r.iterShapeRecords():
    rec = sr.record.as_dict()
    rec["CREATE_DAT"] = rec["CREATE_DAT"].isoformat() if rec["CREATE_DAT"] else None
    geo = sr.shape.__geo_interface__
    key = hashlib.sha1(json.dumps([rec, geo], sort_keys=True, default=str).encode()).hexdigest()
    groups[rec["PRESENT_SN"]].append((key, rec, geo))

stats = Counter(source_rows=len(r))
zones = []
for sn, items in groups.items():
    uniq = {k: (rec, geo) for k, rec, geo in items}
    stats["exact_duplicate_rows_dropped"] += len(items) - len(uniq)
    for rec, geo in uniq.values():
        zone_id = sn if len(uniq) == 1 else f"{sn}:{rec['WTNNC_SN']}"
        g = shape(geo)
        if not g.is_valid:
            g = g.buffer(0)
            stats["repaired_invalid"] += 1
        rp = g.representative_point()
        lng, lat = to_wgs(rp.x, rp.y)
        gu_code, gu = gu_of(lng, lat)
        if gu is None:
            stats["gu_not_found"] += 1
        sig = rec["SIGNGU_SE"]
        if sig and sig != "11000" and gu_code and sig != gu_code:
            stats["signgu_se_vs_rep_point_gu_mismatch"] += 1
        code = rec["ATRB_SE"]
        cname = names.get(code)
        if re.search(r"[？�]", rec["DGM_NM"] or ""):
            stats["broken_name_in_source"] += 1
        simp = g.simplify(20.0, preserve_topology=True)
        zones.append(
            {
                "zone_id": zone_id,
                "present_sn": sn,
                "name": (rec["DGM_NM"] or "").strip(),
                "category_code": code,
                "category_name": cname,
                "lclas_cl": rec["LCLAS_CL"] or None,
                "mlsfc_cl": rec["MLSFC_CL"] or None,
                "sclas_cl": rec["SCLAS_CL"] or None,
                "gu": gu,
                "gu_code": gu_code,
                "signgu_se": sig or None,
                "area_m2": rec["DGM_AR"],
                "notice_sn": rec["NTFC_SN"] or None,
                "notice_date": notice_date(rec["NTFC_SN"]),
                "wtnnc_sn": rec["WTNNC_SN"] or None,
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "rings": ext_rings(transform(to_wgs, simp)),
                "_full": mapping(transform(to_wgs, g)),
            }
        )

ids = Counter(zz["zone_id"] for zz in zones)
assert max(ids.values()) == 1, [k for k, v in ids.items() if v > 1][:5]

with open(OUT / "zones.ndjson", "w", encoding="utf-8") as f:
    for zz in zones:
        f.write(json.dumps({k: v for k, v in zz.items() if k != "_full"}, ensure_ascii=False) + "\n")
with open(OUT / "zones_full.geojson", "w", encoding="utf-8") as f:
    json.dump(
        {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"zone_id": zz["zone_id"]}, "geometry": zz["_full"]} for zz in zones
            ],
        },
        f,
        ensure_ascii=False,
    )

stats["zones"] = len(zones)
stats["no_category_name"] = sum(1 for zz in zones if not zz["category_name"])
stats["no_notice_date"] = sum(1 for zz in zones if not zz["notice_date"])
print(json.dumps(dict(stats), ensure_ascii=False, indent=2))
by_cat = Counter((zz["category_code"], zz["category_name"]) for zz in zones)
for (c, n), k in sorted(by_cat.items(), key=lambda x: -x[1]):
    print(f"  {c} {n}: {k}")
