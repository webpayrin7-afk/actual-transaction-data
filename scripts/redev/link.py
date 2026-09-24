r"""
정비사업 ↔ 정비구역, 단지 ↔ 구역 연결 계산 → links.json + report.json. DB 쓰기 없음.

  python scripts/redev/link.py C:/data/redev/out

입력(같은 폴더): zones.ndjson · zones_full.geojson (build-zones.py), projects.json (projects-to-json.py),
geocode.jsonl · anchors.json (fetch-inputs.ts).

project_zone — 후보 구역은 정비구역 계열만: ATRB_SE UQ12xx(주거환경개선·관리 UQ121x 제외) + 존치정비구역 UQ5140.
  1) 같은 자치구 + 구역명 정규화 정확 일치, 그런 구역이 1개일 때(method 'name').
     정규화: 공백 제거 → 괄호와 그 안 글자 제거 → '제'+숫자의 '제' 제거 → 끝의 사업 이름 조각
     (정비구역·정비사업·구역·지구·사업·재개발·재건축·주택재개발·주택재건축·도시환경정비·도시정비형·주택정비형·
     재정비촉진·정비·공공·아파트·주택)을 더 뗄 게 없을 때까지 뗀다. 양쪽에 같은 규칙.
  2) 아니면 위치1 NAVER 지오코딩 결과가 1개(OK)이고 그 점이 들어가는 후보 구역이 정확히 1개(method 'geocode_pip').
  퍼지·거리 근사 없음. 못 붙은 사업은 사유와 함께 report.json.
complex_zone — complex_map_anchor 점이 구역 폴리곤(단순화 전, 구멍 반영) 안이면 전부(method 'pip'). 구역 분류 제한 없음.
좌표 대조 — 한 필지 자율주택정비사업 구역(UQ1811)의 지번 NAVER 지오코딩 점 ↔ 그 구역 폴리곤 거리(m).
"""
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform
from shapely.strtree import STRtree

sys.stdout.reconfigure(encoding="utf-8")
D = Path(sys.argv[1])

SUFFIXES = sorted(
    ["정비구역", "정비사업", "구역", "지구", "사업", "재개발", "재건축", "주택재개발", "주택재건축", "도시환경정비",
     "도시정비형", "주택정비형", "재정비촉진", "정비", "공공", "아파트", "주택"],
    key=len,
    reverse=True,
)


def norm(name: str) -> str:
    s = re.sub(r"\s+", "", name or "")
    s = re.sub(r"[\(（\[].*?[\)）\]]", "", s)
    s = re.sub(r"[\(\)（）\[\]]", "", s)
    s = re.sub(r"제(?=\d)", "", s)
    changed = True
    while changed and s:
        changed = False
        for suf in SUFFIXES:
            if s.endswith(suf) and len(s) > len(suf):
                s = s[: -len(suf)]
                changed = True
                break
    return s


def is_candidate(code: str) -> bool:
    return (code.startswith("UQ12") and not code.startswith("UQ121")) or code == "UQ5140"


zones = {z["zone_id"]: z for z in (json.loads(l) for l in open(D / "zones.ndjson", encoding="utf-8"))}
full = {f["properties"]["zone_id"]: shape(f["geometry"]) for f in json.load(open(D / "zones_full.geojson", encoding="utf-8"))["features"]}
projects = json.load(open(D / "projects.json", encoding="utf-8"))
anchors = json.load(open(D / "anchors.json", encoding="utf-8"))
geocode = {}
for line in open(D / "geocode.jsonl", encoding="utf-8"):
    if line.strip():
        g = json.loads(line)
        if g["status"] != "ERROR":
            geocode[g["query"]] = g

ids = list(full)
geoms = [full[i] for i in ids]
tree = STRtree(geoms)


def containing(lng, lat, only_candidates=False):
    p = Point(lng, lat)
    hits = [ids[i] for i in tree.query(p) if geoms[i].contains(p)]
    if only_candidates:
        hits = [h for h in hits if is_candidate(zones[h]["category_code"])]
    return sorted(hits)


# 사업 → 구역
name_index = defaultdict(list)
for z in zones.values():
    if z["gu"] and is_candidate(z["category_code"]):
        name_index[(z["gu"], norm(z["name"]))].append(z["zone_id"])


def jibun_query(gu, addr):
    """fetch-inputs.ts jibunQuery 와 같은 규칙."""
    s = re.sub(r"^\s*서울(특별)?시\s*", "", addr)
    s = re.sub(rf"^\s*{re.escape(gu)}\s*", "", s)
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\s*외\s*\d*\s*(필지)?.*$", "", s)
    s = re.sub(r",.*$", "", s)
    s = re.sub(r"(번지)?\s*(일대|일원)\s*$", "", s)
    s = re.sub(r"번지\s*$", "", s).strip()
    m = re.match(r"^(.+?[^\d\s-])\s*(산\s*)?(\d+(?:-\d+)?)$", s)
    if not m:
        return None
    return f"서울특별시 {gu} {m.group(1).strip()} {'산' if m.group(2) else ''}{m.group(3)}"


links, unlinked = [], []
method_count = Counter()
for p in projects:
    key = (p["gu"], norm(p["zone_name"]))
    cands = name_index.get(key, [])
    if len(cands) == 1:
        links.append({"kind": "project_zone", "ref_id": p["code"], "zone_id": cands[0], "method": "name", "detail": key[1]})
        method_count["name"] += 1
        continue
    q = jibun_query(p["gu"], p["addr_jibun"] or "")
    g = geocode.get(q) if q else None
    reason = None
    if len(cands) > 1:
        reason_name = f"이름 일치 구역 {len(cands)}개"
    else:
        reason_name = "이름 일치 없음"
    if g is None:
        reason = "지오코딩 질의 없음"
    elif g["status"] != "OK":
        reason = f"지오코딩 {g['status']}({g['result_count']})"
    else:
        hits = containing(g["lng"], g["lat"], only_candidates=True)
        if len(hits) == 1:
            links.append({"kind": "project_zone", "ref_id": p["code"], "zone_id": hits[0], "method": "geocode_pip", "detail": q})
            method_count["geocode_pip"] += 1
            continue
        reason = "지오코딩 점이 정비구역 밖" if not hits else f"지오코딩 점이 정비구역 {len(hits)}개 안"
        if len(hits) > 1:
            # 보고용(연결하지 않음): 가장 작은 구역이 나머지 모두에 99% 이상 들어가 있으면 '겹겹이 든 구역'
            small = min(hits, key=lambda h: full[h].area)
            if all(full[small].intersection(full[h]).area >= 0.99 * full[small].area for h in hits if h != small):
                reason += " (가장 작은 구역이 나머지 안에 듦)"
    unlinked.append({"code": p["code"], "gu": p["gu"], "zone_name": p["zone_name"], "addr_jibun": p["addr_jibun"],
                     "stage": p["stage"], "reason": f"{reason_name}; {reason}", "query": q})

# 한 구역에 여러 사업이 붙은 경우(보고용)
zone_projects = defaultdict(list)
for l in links:
    zone_projects[l["zone_id"]].append(l["ref_id"])
multi = {z: c for z, c in zone_projects.items() if len(c) > 1}

# 단지 → 구역
proj_by_code = {p["code"]: p for p in projects}
complex_links = []
for a in anchors:
    for zid in containing(a["lng"], a["lat"]):
        complex_links.append({"kind": "complex_zone", "ref_id": a["complex_id"], "zone_id": zid, "method": "pip", "detail": None})
links += complex_links

complexes_in_any = {l["ref_id"] for l in complex_links}
complexes_in_cand = {l["ref_id"] for l in complex_links if is_candidate(zones[l["zone_id"]]["category_code"])}
complexes_in_proj_zone = {l["ref_id"] for l in complex_links if l["zone_id"] in zone_projects}
anchor_by_id = {a["complex_id"]: a for a in anchors}
examples = []
for l in complex_links:
    if l["zone_id"] in zone_projects and len(examples) < 400:
        pc = zone_projects[l["zone_id"]][0]
        examples.append({"complex": anchor_by_id[l["ref_id"]]["apt_name"], "complex_id": l["ref_id"], "zone": zones[l["zone_id"]]["name"],
                         "zone_category": zones[l["zone_id"]]["category_name"], "project": proj_by_code[pc]["zone_name"], "stage": proj_by_code[pc]["stage"]})

# 좌표 대조
to_m = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True).transform
checks = []
for z in zones.values():
    if z["category_code"] != "UQ1811" or not z["gu"]:
        continue
    m = re.match(r"^(\S+[동가로])\s+(\d+(?:-\d+)?)\s*(번지)?\s*자율주택", z["name"])
    if not m:
        continue
    g = geocode.get(f"서울특별시 {z['gu']} {m.group(1)} {m.group(2)}")
    if not g or g["status"] != "OK":
        continue
    poly = transform(to_m, full[z["zone_id"]])
    pt = Point(*to_m(g["lng"], g["lat"]))
    checks.append({"zone": z["name"], "area_m2": round(z["area_m2"]), "inside": poly.contains(pt),
                   "dist_to_polygon_m": round(poly.distance(pt), 1), "dist_to_centroid_m": round(poly.centroid.distance(pt), 1)})

with open(D / "links.json", "w", encoding="utf-8") as f:
    json.dump(links, f, ensure_ascii=False)

stage_linked = Counter(proj_by_code[l["ref_id"]]["stage"] for l in links if l["kind"] == "project_zone")
report = {
    "projects": len(projects),
    "project_zone_links": sum(method_count.values()),
    "project_zone_by_method": dict(method_count),
    "project_link_rate": round(sum(method_count.values()) / len(projects), 4),
    "project_linked_by_stage": dict(stage_linked),
    "zones_with_multiple_projects": len(multi),
    "unlinked_count": len(unlinked),
    "unlinked_reasons": dict(Counter(u["reason"] for u in unlinked)),
    "complex_zone_links": len(complex_links),
    "anchors_checked": len(anchors),
    "complexes_in_any_zone": len(complexes_in_any),
    "complexes_in_redev_zone_family": len(complexes_in_cand),
    "complexes_in_zone_with_project": len(complexes_in_proj_zone),
    "complex_links_by_category": dict(Counter(zones[l["zone_id"]]["category_code"] + " " + str(zones[l["zone_id"]]["category_name"]) for l in complex_links).most_common()),
    "coord_check": {
        "n": len(checks),
        "inside": sum(c["inside"] for c in checks),
        "dist_to_polygon_m_median": statistics.median([c["dist_to_polygon_m"] for c in checks]) if checks else None,
        "dist_to_polygon_m_max": max([c["dist_to_polygon_m"] for c in checks], default=None),
        "dist_to_centroid_m_median": statistics.median([c["dist_to_centroid_m"] for c in checks]) if checks else None,
        "rows": checks,
    },
    "unlinked": unlinked,
    "multi_project_zones": {zones[z]["name"]: [proj_by_code[c]["zone_name"] for c in cs] for z, cs in multi.items()},
    "complex_examples": examples,
}
with open(D / "report.json", "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in report.items() if k not in ("unlinked", "complex_examples", "multi_project_zones")} | {"coord_check": {k: v for k, v in report["coord_check"].items() if k != "rows"}}, ensure_ascii=False, indent=1))
