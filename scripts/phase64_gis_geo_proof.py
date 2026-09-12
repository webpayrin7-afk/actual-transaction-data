#!/usr/bin/env python3
"""Phase 6.4 — MOLIT GIS건물통합정보 local GEO bootstrap proof (dry-run only)."""
from __future__ import annotations

import json
import re
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache" / "gis-building"
OUT = ROOT / "data" / "poc" / "phase64"
OUT.mkdir(parents=True, exist_ok=True)

GIS_SOURCE = "MOLIT_GIS_BUILDING"
GEO_DATA_VERSION = 1
JIBUN_RE = re.compile(r"^(산)?\s*(\d+)(?:\s*-\s*(\d+))?$")

try:
    import shapefile  # pyshp
except ImportError:
    shapefile = None  # type: ignore

try:
    from pyproj import Transformer
except ImportError:
    Transformer = None  # type: ignore

_TRANSFORMERS: dict[str, Any] = {"EPSG:4326": None}
if Transformer is not None:
    for crs in ("EPSG:5179", "EPSG:5186", "EPSG:5181"):
        _TRANSFORMERS[crs] = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)


@dataclass
class ParcelKey:
    klass: str
    reason: str | None
    pnu: str | None
    land: str | None
    bun: int | None
    ji: int | None


def classify_parcel(lawd_cd: Any, bjdong_cd: Any, jibun: Any) -> ParcelKey:
    a = str(lawd_cd or "").strip()
    b = str(bjdong_cd or "").strip()
    if not (re.fullmatch(r"\d{5}", a) and re.fullmatch(r"\d{5}", b)):
        return ParcelKey("PARCEL-KEY-INVALID", "MISSING_ADMIN_CODES", None, None, None, None)
    m = JIBUN_RE.fullmatch(str(jibun or "").strip())
    if not m:
        return ParcelKey("PARCEL-KEY-AMBIGUOUS", "MALFORMED_JIBUN", None, None, None, None)
    san = bool(m.group(1))
    bun = int(m.group(2))
    ji = int(m.group(3) or 0)
    if not (0 <= bun <= 9999 and 0 <= ji <= 9999):
        return ParcelKey("PARCEL-KEY-INVALID", "BUN_JI_RANGE", None, None, bun, ji)
    land = "2" if san else "1"
    return ParcelKey("PARCEL-KEY-READY", None, f"{a}{b}{land}{bun:04d}{ji:04d}", land, bun, ji)


def detect_crs(prj: Path) -> str:
    if not prj.exists():
        return "EPSG:5179"
    txt = prj.read_text(encoding="utf-8", errors="ignore")
    if "4326" in txt or "GCS_WGS_1984" in txt:
        return "EPSG:4326"
    if "5186" in txt:
        return "EPSG:5186"
    if "5181" in txt:
        return "EPSG:5181"
    return "EPSG:5179"


def to_4326(x: float, y: float, crs: str) -> tuple[float, float]:
    tr = _TRANSFORMERS.get(crs)
    if tr is None:
        return float(x), float(y)
    lon, lat = tr.transform(x, y)
    return float(lon), float(lat)


def ring_area(ring: list[tuple[float, float]]) -> float:
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(a) / 2.0


def ring_centroid(ring: list[tuple[float, float]]) -> tuple[float, float]:
    a = x = y = 0.0
    for i in range(len(ring) - 1):
        cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
        x += (ring[i][0] + ring[i + 1][0]) * cross
        y += (ring[i][1] + ring[i + 1][1]) * cross
        a += cross
    if abs(a) < 1e-18:
        n = max(len(ring) - 1, 1)
        return sum(p[0] for p in ring[:n]) / n, sum(p[1] for p in ring[:n]) / n
    return x / (3 * a), y / (3 * a)


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 0.0) + xi:
            inside = not inside
        j = i
    return inside


def representative_point(rings: list[list[tuple[float, float]]]) -> tuple[float, float, str] | None:
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None
    best = max(rings, key=ring_area)
    lon, lat = ring_centroid(best)
    if point_in_ring(lon, lat, best):
        return lat, lon, "largest_ring_centroid_on_surface"
    return best[0][1], best[0][0], "largest_ring_vertex0_on_surface"


def in_bounds(lat: float, lon: float) -> bool:
    return 36.8 <= lat <= 38.4 and 126.3 <= lon <= 127.9 and not (lat == 0 and lon == 0)


def find_pnu_field(fields: list) -> str | None:
    names = [f[0] for f in fields[1:]]
    for p in ("PNU", "pnu", "A2", "a2", "고유번호", "PNU_CD", "BD_PNU"):
        if p in names:
            return p
    for n in names:
        if re.search(r"pnu|고유|필지", n, re.I):
            return n
    return None


def shape_rings_4326(shape: Any, crs: str) -> list[list[tuple[float, float]]]:
    if shape.shapeType not in (5, 15, 25):
        return []
    parts = list(shape.parts) + [len(shape.points)]
    rings: list[list[tuple[float, float]]] = []
    for i in range(len(parts) - 1):
        pts = shape.points[parts[i] : parts[i + 1]]
        ring = [to_4326(x, y, crs) for x, y in pts]
        if ring and ring[0] != ring[-1]:
            ring.append(ring[0])
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def load_gis_index(cache_dir: Path) -> tuple[dict[str, list], dict[str, Any]]:
    meta: dict[str, Any] = {
        "shapefiles": 0,
        "features_read": 0,
        "features_with_pnu": 0,
        "crs_seen": {},
        "pnu_fields": {},
        "errors": [],
    }
    by_pnu: dict[str, list] = defaultdict(list)
    if shapefile is None:
        meta["errors"].append("pyshp not installed")
        return by_pnu, meta

    crs_seen: Counter[str] = Counter()
    pnu_fields: Counter[str] = Counter()
    bases: list[Path] = []
    if cache_dir.exists():
        for z in cache_dir.rglob("*.zip"):
            dest = z.with_suffix("")
            if not dest.exists():
                try:
                    dest.mkdir(parents=True, exist_ok=True)
                    with zipfile.ZipFile(z) as zf:
                        zf.extractall(dest)
                except Exception as e:
                    meta["errors"].append(f"unzip {z.name}: {e}")
        for p in cache_dir.rglob("*.shp"):
            bases.append(p.with_suffix(""))
    bases = sorted(set(bases))
    meta["shapefiles"] = len(bases)

    for base in bases:
        try:
            crs = detect_crs(Path(str(base) + ".prj"))
            crs_seen[crs] += 1
            sf = shapefile.Reader(str(base))
            field = find_pnu_field(sf.fields)
            pnu_fields[field or "AUTO"] += 1
            field_names = [f[0] for f in sf.fields[1:]]
            for sr in sf.iterShapeRecords():
                meta["features_read"] += 1
                attrs = dict(zip(field_names, sr.record))
                pnu = None
                if field and field in attrs:
                    v = str(attrs.get(field, "")).strip()
                    if re.fullmatch(r"\d{19}", v):
                        pnu = v
                if not pnu:
                    for v in attrs.values():
                        s = str(v).strip()
                        if re.fullmatch(r"\d{19}", s):
                            pnu = s
                            break
                if not pnu:
                    continue
                meta["features_with_pnu"] += 1
                rings = shape_rings_4326(sr.shape, crs)
                if rings:
                    by_pnu[pnu].append({"rings": rings, "attrs": attrs})
        except Exception as e:
            meta["errors"].append(f"{base.name}: {e}")

    meta["crs_seen"] = dict(crs_seen)
    meta["pnu_fields"] = dict(pnu_fields)
    return by_pnu, meta


def match_pnu(pnu: str, by_pnu: dict[str, list]) -> dict[str, Any]:
    feats = by_pnu.get(pnu) or []
    if not feats:
        return {"join": "NO-MATCH", "reason": "PNU_NOT_IN_GIS", "lat": None, "lng": None, "method": None}
    rings: list = []
    for f in feats:
        rings.extend(f["rings"])
    rp = representative_point(rings)
    if not rp:
        return {"join": "AMBIGUOUS", "reason": "GEOMETRY_EMPTY", "lat": None, "lng": None, "method": None}
    lat, lon, method = rp
    if not in_bounds(lat, lon):
        return {"join": "AMBIGUOUS", "reason": "OUT_OF_BOUNDS", "lat": lat, "lng": lon, "method": method}
    join = "EXACT-PARCEL" if len(feats) == 1 else "MULTI-BUILDING-PARCEL"
    return {"join": join, "reason": None, "lat": lat, "lng": lon, "method": method}


def load_master() -> list[dict]:
    path = OUT / "master-export.json"
    if not path.exists():
        raise SystemExit(f"missing {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_phase5_ids() -> list[str]:
    path = OUT / "phase5-complex-ids.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def pick_sample(rows: list[dict], keys: dict[str, ParcelKey], limit: int = 200) -> list[str]:
    by_id = {r["complex_id"]: r for r in rows}
    chosen: list[str] = []

    def add(cid: str) -> None:
        if cid in by_id and cid not in chosen and len(chosen) < limit:
            chosen.append(cid)

    for cid in load_phase5_ids():
        add(cid)

    def ready(r: dict) -> bool:
        return keys[r["complex_id"]].klass == "PARCEL-KEY-READY"

    buckets = [
        [r for r in rows if ready(r) and r.get("sido_code") == "11" and keys[r["complex_id"]].ji == 0 and keys[r["complex_id"]].land == "1"],
        [r for r in rows if ready(r) and r.get("sido_code") == "11" and (keys[r["complex_id"]].ji or 0) > 0],
        [r for r in rows if ready(r) and r.get("sido_code") == "41" and keys[r["complex_id"]].ji == 0],
        [r for r in rows if ready(r) and r.get("sido_code") == "41" and (keys[r["complex_id"]].ji or 0) > 0],
        [r for r in rows if ready(r) and keys[r["complex_id"]].land == "2"],
    ]
    name_map: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        name_map[str(r.get("apt_name_norm"))].append(r["complex_id"])
    same: list[dict] = []
    for ids in name_map.values():
        if len({by_id[i]["lawd_cd"] for i in ids}) > 1:
            same.extend(by_id[i] for i in ids[:2])
    buckets.append(same)

    for bucket in buckets:
        for r in bucket[:40]:
            add(r["complex_id"])
    for r in rows:
        if len(chosen) >= limit:
            break
        if ready(r):
            add(r["complex_id"])
    return chosen[:limit]


def run_join(
    id_list: list[str],
    rows: list[dict],
    keys: dict[str, ParcelKey],
    by_pnu: dict[str, list],
    gis_available: bool,
) -> dict[str, Any]:
    by_id = {r["complex_id"]: r for r in rows}
    stats: Counter[str] = Counter()
    sanity: Counter[str] = Counter()
    unmatched: Counter[str] = Counter()
    dups: Counter[str] = Counter()
    name_pts: dict[str, set[str]] = defaultdict(set)
    coords = 0

    for cid in id_list:
        r = by_id[cid]
        pk = keys[cid]
        if pk.klass != "PARCEL-KEY-READY" or not pk.pnu:
            stats["SKIP_KEY"] += 1
            continue
        if not gis_available:
            stats["SKIP_NO_GIS"] += 1
            unmatched["GIS_CACHE_EMPTY"] += 1
            continue
        m = match_pnu(pk.pnu, by_pnu)
        stats[m["join"]] += 1
        if m["reason"]:
            unmatched[m["reason"]] += 1
        if m["lat"] is not None and m["lng"] is not None:
            coords += 1
            key = f"{m['lat']:.6f},{m['lng']:.6f}"
            dups[key] += 1
            name_pts[str(r.get("apt_name_norm"))].add(key)
            if not in_bounds(m["lat"], m["lng"]):
                sanity["OUT_OF_BOUNDS"] += 1
            if m["lat"] == 0 and m["lng"] == 0:
                sanity["ZERO"] += 1

    collapse = 0
    by_name: dict[str, list] = defaultdict(list)
    for cid in id_list:
        r = by_id[cid]
        by_name[str(r.get("apt_name_norm"))].append(r)
    for nm, lst in by_name.items():
        if len({x["lawd_cd"] for x in lst}) > 1 and len(name_pts.get(nm, set())) == 1 and len(lst) > 1:
            collapse += 1
    if collapse:
        sanity["SAME_NAME_COLLAPSE"] = collapse

    return {
        "n": len(id_list),
        "stats": dict(stats),
        "coords_generated": coords,
        "duplicate_coordinate_keys": sum(1 for v in dups.values() if v > 1),
        "sanity_failures": dict(sanity),
        "unmatched_reasons": dict(unmatched),
    }


def main() -> None:
    rows = load_master()
    keys: dict[str, ParcelKey] = {}
    key_counts: Counter[str] = Counter()
    reason_counts: Counter[str] = Counter()
    for r in rows:
        pk = classify_parcel(r.get("lawd_cd"), r.get("bjdong_cd"), r.get("jibun"))
        keys[r["complex_id"]] = pk
        key_counts[pk.klass] += 1
        if pk.reason:
            reason_counts[pk.reason] += 1

    by_pnu, gis_meta = load_gis_index(CACHE)
    gis_available = len(by_pnu) > 0

    sample = run_join(pick_sample(rows, keys, 200), rows, keys, by_pnu, gis_available)
    ready_ids = [r["complex_id"] for r in rows if keys[r["complex_id"]].klass == "PARCEL-KEY-READY"]
    full = run_join(ready_ids, rows, keys, by_pnu, gis_available)
    matched = full["stats"].get("EXACT-PARCEL", 0) + full["stats"].get("MULTI-BUILDING-PARCEL", 0)
    coverage = (matched / len(ready_ids) * 100.0) if ready_ids else 0.0

    decision = "HOLD"
    next_step = (
        "Acquire MOLIT GIS건물통합정보 SHP (Seoul+Gyeonggi) into data/cache/gis-building/ "
        "(VWorld dsId=18 currently 502), then re-run this proof"
    )
    if gis_available and matched > 0 and not full["sanity_failures"]:
        decision = "PASS"
        next_step = "Phase 6.5 — controlled GEO production bootstrap"

    vworld_candidates = (
        full["stats"].get("NO-MATCH", 0)
        + full["stats"].get("AMBIGUOUS", 0)
        + (len(ready_ids) if not gis_available else 0)
    )

    report = {
        "phase": "6.4",
        "dataset": {
            "source": "국토교통부 GIS건물통합정보 (data.go.kr 15083092 → VWorld dsId=18)",
            "version_date": "20260809",
            "license": "공공누리 제1유형 (출처표시)",
            "original_crs_expected": "EPSG:5179 (typical; read from .prj when present)",
            "geometry_type_expected": "Polygon / MultiPolygon (building footprints)",
            "identity_fields_expected": ["PNU (19-digit)", "optional building attrs"],
            "acquisition_status": "READY" if gis_available else "BLOCKED_VWORLD_502",
            "gis_available": gis_available,
            "gis_cache": gis_meta,
        },
        "parcel_key": {
            "READY": key_counts.get("PARCEL-KEY-READY", 0),
            "AMBIGUOUS": key_counts.get("PARCEL-KEY-AMBIGUOUS", 0),
            "INVALID": key_counts.get("PARCEL-KEY-INVALID", 0),
            "reasons": dict(reason_counts),
            "note": (
                "산* jibun → land=2 (PNU-ready). Distinct from Phase 6.3 GEO-INPUT "
                "AMBIGUOUS (20 mountain parcels rejected by jibun regex without 산)."
            ),
        },
        "sample": {
            "sample": sample["n"],
            "EXACT-PARCEL": sample["stats"].get("EXACT-PARCEL", 0),
            "MULTI-BUILDING": sample["stats"].get("MULTI-BUILDING-PARCEL", 0),
            "NO-MATCH": sample["stats"].get("NO-MATCH", 0),
            "AMBIGUOUS": sample["stats"].get("AMBIGUOUS", 0),
            "coordinates_generated": sample["coords_generated"],
            "sanity_failures": sample["sanity_failures"],
            "notes": sample["stats"],
        },
        "full_local_dry_run": {
            "eligible": len(ready_ids),
            "matched": matched,
            "unmatched": full["stats"].get("NO-MATCH", 0) + full["stats"].get("SKIP_NO_GIS", 0),
            "ambiguous": full["stats"].get("AMBIGUOUS", 0),
            "coverage_pct": round(coverage, 2),
            "stats": full["stats"],
            "unmatched_reasons": full["unmatched_reasons"],
        },
        "geo_method": {
            "representative_point": "largest-ring centroid if on-surface, else ring vertex0",
            "output_crs": "EPSG:4326",
            "source_constant": GIS_SOURCE,
        },
        "provenance": {
            "master_coordinates": "apt_complex_master.latitude/longitude",
            "source_link": f"source={GIS_SOURCE}, source_key=PNU",
            "enrichment_state": f"domain=GEO, data_version={GEO_DATA_VERSION} (lazy rows only on write)",
        },
        "expected_production_mutations": {
            "master_coordinate_updates": matched,
            "source_link_inserts": matched,
            "geo_state_inserts": matched,
            "total": matched * 3,
            "executed": 0,
        },
        "fallback_requirement": {
            "VWorld_candidates": vworld_candidates,
            "note": "Fallback not executed in 6.4",
        },
        "production_writes": 0,
        "decision": decision,
        "next": next_step,
        "safety": {
            "naver_calls": 0,
            "kakao_calls": 0,
            "vworld_calls": 0,
            "building_registry_api": 0,
            "flags_changed": False,
            "identity_master_changed": False,
            "complex_id_regenerated": False,
        },
    }

    (OUT / "phase64-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    s, f, e = report["sample"], report["full_local_dry_run"], report["expected_production_mutations"]
    md = f"""## Phase 6.4 — Public GIS GEO bootstrap proof

### dataset
source: {report['dataset']['source']}
version/date: {report['dataset']['version_date']}
license: {report['dataset']['license']}
original CRS: {report['dataset']['original_crs_expected']}
acquisition: {report['dataset']['acquisition_status']}

### parcel key
READY: {report['parcel_key']['READY']}
AMBIGUOUS: {report['parcel_key']['AMBIGUOUS']}
INVALID: {report['parcel_key']['INVALID']}

### sample
sample: {s['sample']}
EXACT-PARCEL: {s['EXACT-PARCEL']}
MULTI-BUILDING: {s['MULTI-BUILDING']}
NO-MATCH: {s['NO-MATCH']}
AMBIGUOUS: {s['AMBIGUOUS']}
sanity failures: {json.dumps(s['sanity_failures'], ensure_ascii=False)}

### full local dry-run
eligible: {f['eligible']}
matched: {f['matched']}
unmatched: {f['unmatched']}
ambiguous: {f['ambiguous']}
coverage %: {f['coverage_pct']}

### GEO method
representative point: {report['geo_method']['representative_point']}
output CRS: {report['geo_method']['output_crs']}

### provenance
master coordinates: {report['provenance']['master_coordinates']}
source link: {report['provenance']['source_link']}
enrichment state: {report['provenance']['enrichment_state']}

### expected production mutations
master coordinate updates: {e['master_coordinate_updates']}
source-link inserts: {e['source_link_inserts']}
GEO state inserts: {e['geo_state_inserts']}
total: {e['total']}

### fallback requirement
VWorld candidates: {vworld_candidates}

### production writes
0

### decision
{decision}

### next
{next_step}
"""
    (OUT / "phase64-report.md").write_text(md, encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
