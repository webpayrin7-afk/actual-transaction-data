#!/usr/bin/env python3
"""
Seoul school materialization DRY-RUN (no Production writes).

Uses:
  - exported seoul-complexes.json (Turso READ)
  - KOIES SHP (EPSG:5186) for elementary attendance + middle districts
  - 한국교육시설안전원 school location CSV for nearby
  - Pilot seed membership fixtures for known districts only

Default: DRY_RUN only. Refuse --write unless SCHOOL_MAT_ALLOW_WRITE=1
(and even then this script still does not touch Turso).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import shapefile
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from batch_cursor import (
    CheckpointScopeError,
    apply_counter_delta,
    assert_checkpoint_scope,
    checkpoint_path,
    counter_delta,
    load_checkpoint,
    plan_remaining,
    read_chunk,
    save_checkpoint,
    write_chunk,
)
from nearby_index import (
    NEARBY_MAX_M,
    NEARBY_STORE_CAP_PER_LEVEL,
    SchoolGrid,
    annotate_nearby_db_candidate,
)

ROOT = Path(__file__).resolve().parents[2]
SOURCE_VERSION = "koies-2026-03-20"
BASE_DATE = "2026-03-20"
CRS_SHP = "EPSG:5186"
CRS_WGS = "EPSG:4326"

JAMSIL_ID = "cx_4c63d9a100973c60"
JAMSIL_EXPECT = {
    "elem_zone_id": "Z000100307",
    "elem_zone_name": "서울잠일초통학구역",
    "elem_school_name": "서울잠일초등학교",
    "elem_school_code": "7130153",
    "mid_district_id": "Z000200027",
    "mid_district_name": "강동송파3학교군",
    "mid_member_count": 11,
    "high_district_name": "강동송파학교군",
    "high_member_count": 26,
}


def load_membership_seeds() -> dict[str, dict[str, Any]]:
    """district_id / known names → official members from pilot seeds."""
    out: dict[str, dict[str, Any]] = {}
    mid = json.loads(
        (ROOT / "data/poc/school-district/seoul-middle-gangdong-songpa-3.v1.json").read_text(
            encoding="utf-8"
        )
    )
    hak = mid["source"]["hakgoonCode"]
    out[hak] = {
        "level": "middle",
        "name": mid["officialName"],
        "members": [
            {
                "name": m["name"],
                "school_code": m.get("neisSdSchulCode"),
                "establishment": m.get("establishment"),
            }
            for m in mid["members"]
        ],
    }
    high = json.loads(
        (ROOT / "data/poc/school-district/seoul-high-gangdong-songpa.v1.json").read_text(
            encoding="utf-8"
        )
    )
    # High seed has no hakgudoId SHP link — index by official name.
    out[f"name:{high['officialName']}"] = {
        "level": "high",
        "name": high["officialName"],
        "members": [
            {
                "name": m["name"],
                "school_code": m.get("neisSdSchulCode"),
                "establishment": m.get("establishment"),
            }
            for m in high["members"]
        ],
    }
    elem = json.loads(
        (ROOT / "data/poc/attendance-zone/seoul-jamsil-jam-il-elementary.v1.json").read_text(
            encoding="utf-8"
        )
    )
    out[elem["hakgudoId"]] = {
        "level": "elementary",
        "name": elem["officialName"],
        "members": [
            {
                "name": elem["designatedSchool"]["name"],
                "school_code": elem["designatedSchool"]["neisSdSchulCode"],
                "establishment": elem["designatedSchool"].get("establishment"),
            }
        ],
    }
    return out


@dataclass
class PolyRec:
    zone_id: str
    zone_name: str
    hakgudo_gb: str
    geom: Any
    edu_up_nm: str


def load_seoul_polys(shp_path: Path) -> list[PolyRec]:
    from shapely.ops import transform as shp_transform

    reader = shapefile.Reader(str(shp_path), encoding="euc_kr")
    fields = [f[0] for f in reader.fields[1:]]
    to_wgs = Transformer.from_crs(CRS_SHP, CRS_WGS, always_xy=True)
    out: list[PolyRec] = []
    for sr in reader.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        if "서울" not in str(rec.get("EDU_UP_NM", "")) and str(rec.get("SD_CD")) not in (
            "11",
            "11000",
        ):
            continue
        geom5186 = shape(sr.shape.__geo_interface__)
        if geom5186.is_empty:
            continue
        geom = shp_transform(lambda x, y, z=None: to_wgs.transform(x, y), geom5186)
        if not geom.is_valid:
            geom = geom.buffer(0)
        out.append(
            PolyRec(
                zone_id=str(rec["HAKGUDO_ID"]),
                zone_name=str(rec["HAKGUDO_NM"]),
                hakgudo_gb=str(rec.get("HAKGUDO_GB") or "0"),
                geom=geom,
                edu_up_nm=str(rec.get("EDU_UP_NM") or ""),
            )
        )
    return out


def pip_query(
    tree: STRtree,
    polys: list[PolyRec],
    lat: float,
    lng: float,
) -> tuple[str, list[PolyRec]]:
    """
    Boundary semantics:
      - covers(point): interior OR boundary (Shapely 2)
      - multiple covers → BOUNDARY_AMBIGUOUS / multi-match
      - none → NO_POLYGON_MATCH
    We do NOT arbitrarily pick one polygon on multi-match.
    """
    pt = Point(lng, lat)
    idxs = tree.query(pt)
    hits: list[PolyRec] = []
    for i in idxs:
        poly = polys[int(i)]
        # covers = contains OR touches boundary
        if poly.geom.covers(pt):
            hits.append(poly)
    if not hits:
        return "NO_POLYGON_MATCH", []
    if len(hits) == 1:
        gb = hits[0].hakgudo_gb
        if gb == "1":
            return "CONFIRMED_COMMON", hits
        return "CONFIRMED_SINGLE", hits
    # Multiple polygons cover the point (boundary or overlapping)
    return "BOUNDARY_AMBIGUOUS", hits


def zone_name_to_school_guess(zone_name: str) -> str | None:
    name = zone_name.strip()
    for suffix in ("공동통학구역", "통학구역"):
        if name.endswith(suffix):
            base = name[: -len(suffix)].strip()
            if base and not base.endswith("초등학교"):
                if base.endswith("초"):
                    base = base + "등학교"
                elif "초등" not in base:
                    base = base + "초등학교"
            return base or None
    return None


def load_schools_csv(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if "서울" not in (row.get("시도교육청명") or ""):
                continue
            if (row.get("운영상태") or "") != "운영":
                continue
            try:
                lat = float(row["위도"])
                lng = float(row["경도"])
            except (KeyError, ValueError, TypeError):
                continue
            level_raw = row.get("학교급구분") or ""
            if "초등" in level_raw:
                level = "elementary"
            elif "중학" in level_raw:
                level = "middle"
            elif "고등" in level_raw:
                level = "high"
            else:
                continue
            rows.append(
                {
                    "facility_id": row.get("학교ID"),
                    "name": row.get("학교명") or "",
                    "level": level,
                    "establishment": row.get("설립형태"),
                    "lat": lat,
                    "lng": lng,
                }
            )
    return rows


def build_name_index(schools: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    idx: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in schools:
        idx[s["name"]].append(s)
    return idx


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="dry-run", choices=["dry-run", "write"])
    ap.add_argument("--region", default="seoul")
    ap.add_argument(
        "--school-level",
        default="all",
        choices=["all", "elementary", "middle", "high"],
    )
    ap.add_argument("--complex-id", default="")
    ap.add_argument("--sido", default="", help="Keep complexes with this sido name or sido_code.")
    ap.add_argument("--complexes-json", default="/tmp/school-materialization-out/seoul-complexes.json")
    ap.add_argument(
        "--coords-json",
        default="",
        help="Gate-eligible coordinate overrides JSON "
        "(complex-coordinate-gate-overrides.json). Applied before PIP; "
        "does not require Production master lat/lng write.",
    )
    ap.add_argument("--elem-shp", default="/tmp/schoolzone-data/elem/초등학교통학구역.shp")
    ap.add_argument("--middle-shp", default="/tmp/schoolzone-data/middle/중학교학교군.shp")
    ap.add_argument(
        "--schools-csv",
        default="/tmp/schoolzone-data/schools/한국교육시설안전원_초중등학교위치_20260320.csv",
    )
    ap.add_argument("--out-dir", default="/tmp/school-materialization-out")
    ap.add_argument("--chunk-size", type=int, default=500)
    args = ap.parse_args()

    if args.mode == "write":
        if os.environ.get("SCHOOL_MAT_ALLOW_WRITE") != "1":
            print("WRITE GUARD: refusing --mode=write (SCHOOL_MAT_ALLOW_WRITE!=1)", file=sys.stderr)
            return 2
        print("WRITE GUARD: this dry-run binary never writes Production rows.", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    payload = json.loads(Path(args.complexes_json).read_text(encoding="utf-8"))
    complexes = payload["complexes"]
    if args.complex_id:
        complexes = [c for c in complexes if c["complex_id"] == args.complex_id]
    if args.sido:
        wanted = args.sido
        complexes = [
            c
            for c in complexes
            if wanted in (c.get("sido"), c.get("sido_code"))
        ]

    coord_overrides: dict[str, dict[str, Any]] = {}
    if args.coords_json:
        ov_doc = json.loads(Path(args.coords_json).read_text(encoding="utf-8"))
        coord_overrides = ov_doc.get("overrides") or {}
        applied = 0
        for c in complexes:
            ov = coord_overrides.get(c["complex_id"])
            if not ov:
                continue
            lat, lng = ov.get("lat"), ov.get("lng")
            if lat is None or lng is None:
                continue
            c["lat"] = float(lat)
            c["lng"] = float(lng)
            c["coord_source"] = ov.get("source") or "coord_override"
            applied += 1
        print(f"coord overrides applied: {applied}", flush=True)

    seeds = load_membership_seeds()
    do_elem = args.school_level in ("all", "elementary")
    do_mid = args.school_level in ("all", "middle")
    do_high = args.school_level in ("all", "high")

    elem_polys: list[PolyRec] = []
    mid_polys: list[PolyRec] = []
    elem_tree = mid_tree = None
    if do_elem:
        print(f"loading elem SHP…", flush=True)
        elem_polys = load_seoul_polys(Path(args.elem_shp))
        elem_tree = STRtree([p.geom for p in elem_polys])
        print(f"  seoul elem polys={len(elem_polys)}", flush=True)
    if do_mid:
        print(f"loading middle SHP…", flush=True)
        mid_polys = load_seoul_polys(Path(args.middle_shp))
        mid_tree = STRtree([p.geom for p in mid_polys])
        print(f"  seoul middle polys={len(mid_polys)}", flush=True)

    print("loading schools CSV…", flush=True)
    schools = load_schools_csv(Path(args.schools_csv))
    name_idx = build_name_index(schools)
    by_level: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in schools:
        by_level[s["level"]].append(s)
    level_grids = {
        level: SchoolGrid(rows, max_m=NEARBY_MAX_M, cap=NEARBY_STORE_CAP_PER_LEVEL)
        for level, rows in by_level.items()
    }
    print(f"  seoul schools={len(schools)}", flush=True)

    # Optional NEIS code map from seeds
    neis_by_name = {}
    for v in seeds.values():
        for m in v["members"]:
            if m.get("school_code") and m.get("name"):
                neis_by_name[m["name"]] = m["school_code"]

    if len({c["complex_id"] for c in complexes}) != len(complexes):
        print("DUPLICATE_COMPLEX_ID", file=sys.stderr)
        return 1
    complexes = sorted(complexes, key=lambda c: c["complex_id"])
    ordered_ids = [c["complex_id"] for c in complexes]
    by_complex = {c["complex_id"]: c for c in complexes}
    ckpt_file = checkpoint_path(out_dir)
    saved = load_checkpoint(ckpt_file)
    try:
        assert_checkpoint_scope(saved, args.school_level, args.complex_id, args.chunk_size, args.sido)
    except CheckpointScopeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    try:
        chunk_plan = plan_remaining(ordered_ids, saved, args.chunk_size, SOURCE_VERSION)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    elem_stats = Counter()
    mid_stats = Counter()
    high_stats = Counter()
    nearby_stats = Counter()
    unresolved_rows = []
    samples = {}
    area_rows = []
    nearby_rows = []
    valid_coords = 0
    resumed_from = None if saved is None else saved.get("last_completed_complex_id")
    chunk_counts = [] if saved is None else list(saved.get("chunk_completed_counts") or [])
    if saved and saved.get("completed_count") and not chunk_counts:
        print("CHECKPOINT_CHUNKS_MISSING", file=sys.stderr)
        return 1
    if saved and saved.get("completed_count"):
        for done in chunk_counts:
            part = read_chunk(out_dir, done)
            area_rows.extend(part["area_rows"])
            nearby_rows.extend(part["nearby_rows"])
            unresolved_rows.extend(part["unresolved_rows"])
            valid_coords += int(part["valid_coords"])
            apply_counter_delta(elem_stats, part["elem_stats"])
            apply_counter_delta(mid_stats, part["mid_stats"])
            apply_counter_delta(high_stats, part["high_stats"])
            apply_counter_delta(nearby_stats, part["nearby_stats"])
            for key, value in part["samples"].items():
                samples.setdefault(key, value)

    for step in chunk_plan:
        samples_before = set(samples)
        a0, n0, u0 = len(area_rows), len(nearby_rows), len(unresolved_rows)
        v0 = valid_coords
        e0, m0, h0, nb0 = elem_stats.copy(), mid_stats.copy(), high_stats.copy(), nearby_stats.copy()
        for c in (by_complex[i] for i in step["ids"]):
            cid = c["complex_id"]
            lat, lng = c.get("lat"), c.get("lng")
            has_coords = (
                lat is not None
                and lng is not None
                and isinstance(lat, (int, float))
                and isinstance(lng, (int, float))
                and 33 <= lat <= 39
                and 124 <= lng <= 132
            )
            if has_coords:
                valid_coords += 1

            # --- elementary ---
            if do_elem:
                if not has_coords:
                    st = "INVALID_COMPLEX_COORD"
                    elem_stats[st] += 1
                    unresolved_rows.append(
                        {
                            "complex_id": cid,
                            "apt_name": c.get("apt_name"),
                            "school_level": "elementary",
                            "status": st,
                            "detail": "master latitude/longitude null",
                        }
                    )
                    area_rows.append(
                        {
                            "complex_id": cid,
                            "school_level": "elementary",
                            "area_type": "attendance_zone",
                            "area_id": None,
                            "resolution_status": st,
                            "source_version": SOURCE_VERSION,
                        }
                    )
                else:
                    assert elem_tree is not None
                    st, hits = pip_query(elem_tree, elem_polys, float(lat), float(lng))
                    school_code = None
                    school_name = None
                    zone_id = hits[0].zone_id if hits else None
                    zone_name = hits[0].zone_name if hits else None
                    if st in ("CONFIRMED_SINGLE", "CONFIRMED_COMMON") and hits:
                        # Prefer seed membership
                        seed = seeds.get(hits[0].zone_id)
                        if seed and seed["members"]:
                            school_name = seed["members"][0]["name"]
                            school_code = seed["members"][0]["school_code"]
                        else:
                            guess = zone_name_to_school_guess(hits[0].zone_name)
                            school_name = guess
                            if guess and guess in name_idx:
                                # facility id only — NEIS unresolved unless seed
                                school_code = neis_by_name.get(guess)
                                if school_code is None:
                                    st_code = "SCHOOL_CODE_UNRESOLVED"
                                    elem_stats[st_code] += 1
                                    unresolved_rows.append(
                                        {
                                            "complex_id": cid,
                                            "apt_name": c.get("apt_name"),
                                            "school_level": "elementary",
                                            "status": st_code,
                                            "detail": f"zone={hits[0].zone_id} guess={guess}",
                                        }
                                    )
                            elif guess:
                                elem_stats["SCHOOL_CODE_UNRESOLVED"] += 1
                                unresolved_rows.append(
                                    {
                                        "complex_id": cid,
                                        "apt_name": c.get("apt_name"),
                                        "school_level": "elementary",
                                        "status": "SCHOOL_CODE_UNRESOLVED",
                                        "detail": f"zone={hits[0].zone_id} guess={guess} not in CSV",
                                    }
                                )
                    elem_stats[st] += 1
                    if st not in ("CONFIRMED_SINGLE", "CONFIRMED_COMMON"):
                        unresolved_rows.append(
                            {
                                "complex_id": cid,
                                "apt_name": c.get("apt_name"),
                                "school_level": "elementary",
                                "status": st,
                                "detail": ",".join(h.zone_id for h in hits),
                            }
                        )
                    area_rows.append(
                        {
                            "complex_id": cid,
                            "school_level": "elementary",
                            "area_type": "attendance_zone",
                            "area_id": zone_id,
                            "zone_name": zone_name,
                            "school_code": school_code,
                            "school_name": school_name,
                            "resolution_status": st,
                            "source_version": SOURCE_VERSION,
                        }
                    )
                    if st == "CONFIRMED_SINGLE" and "normal_elementary_single" not in samples:
                        samples["normal_elementary_single"] = {
                            "complex_id": cid,
                            "zone_id": zone_id,
                            "zone_name": zone_name,
                            "school_name": school_name,
                        }
                    if st == "CONFIRMED_COMMON" and "common_attendance_zone" not in samples:
                        samples["common_attendance_zone"] = {
                            "complex_id": cid,
                            "zone_id": zone_id,
                            "zone_name": zone_name,
                        }
                    if st == "BOUNDARY_AMBIGUOUS" and "boundary_ambiguous" not in samples:
                        samples["boundary_ambiguous"] = {
                            "complex_id": cid,
                            "hits": [h.zone_id for h in hits],
                        }
                    if st == "NO_POLYGON_MATCH" and "unmatched" not in samples:
                        samples["unmatched"] = {"complex_id": cid, "lat": lat, "lng": lng}

            # --- middle ---
            if do_mid:
                if not has_coords:
                    st = "INVALID_COMPLEX_COORD"
                    mid_stats[st] += 1
                    area_rows.append(
                        {
                            "complex_id": cid,
                            "school_level": "middle",
                            "area_type": "district",
                            "area_id": None,
                            "resolution_status": st,
                            "source_version": SOURCE_VERSION,
                        }
                    )
                else:
                    assert mid_tree is not None
                    st, hits = pip_query(mid_tree, mid_polys, float(lat), float(lng))
                    district_id = hits[0].zone_id if hits else None
                    district_name = hits[0].zone_name if hits else None
                    membership_status = None
                    members = []
                    if st in ("CONFIRMED_SINGLE", "CONFIRMED_COMMON") and district_id:
                        seed = seeds.get(district_id)
                        if seed:
                            members = seed["members"]
                            membership_status = "MEMBERSHIP_COMPLETE"
                            mid_stats["MEMBERSHIP_COMPLETE"] += 1
                        else:
                            membership_status = "RESOLVED_DISTRICT_ONLY"
                            mid_stats["RESOLVED_DISTRICT_ONLY"] += 1
                    mid_stats[st] += 1
                    area_rows.append(
                        {
                            "complex_id": cid,
                            "school_level": "middle",
                            "area_type": "district",
                            "area_id": district_id,
                            "district_name": district_name,
                            "membership_status": membership_status,
                            "member_count": len(members),
                            "resolution_status": st,
                            "source_version": SOURCE_VERSION,
                        }
                    )
                    if membership_status == "MEMBERSHIP_COMPLETE" and "middle_normal_district" not in samples:
                        samples["middle_normal_district"] = {
                            "complex_id": cid,
                            "district_id": district_id,
                            "district_name": district_name,
                            "member_count": len(members),
                        }

            # --- high ---
            if do_high:
                # No Seoul-wide high SHP in this dry-run package.
                if cid == JAMSIL_ID:
                    seed = seeds.get("name:강동송파학교군")
                    high_stats["MEMBERSHIP_COMPLETE"] += 1
                    high_stats["DISTRICT_RESOLVED_SEED"] += 1
                    area_rows.append(
                        {
                            "complex_id": cid,
                            "school_level": "high",
                            "area_type": "district",
                            "area_id": None,
                            "district_name": "강동송파학교군",
                            "membership_status": "MEMBERSHIP_COMPLETE",
                            "member_count": len(seed["members"]) if seed else 0,
                            "resolution_status": "CONFIRMED_SEED",
                            "source_version": "pilot-high-seed-web",
                        }
                    )
                else:
                    high_stats["UNRESOLVED"] += 1
                    area_rows.append(
                        {
                            "complex_id": cid,
                            "school_level": "high",
                            "area_type": "district",
                            "area_id": None,
                            "resolution_status": "UNRESOLVED",
                            "source_version": "high-shp-absent",
                        }
                    )

            # --- nearby ---
            if has_coords:
                nearby_stats["complexes_calculated"] += 1
                for level in ("elementary", "middle", "high"):
                    if args.school_level not in ("all", level):
                        continue
                    near = (level_grids.get(level) or SchoolGrid([])).nearest(float(lat), float(lng))
                    for rank, s in enumerate(near, start=1):
                        code = neis_by_name.get(s["name"])
                        row = annotate_nearby_db_candidate(
                            {
                                "complex_id": cid,
                                "school_level": level,
                                "school_name": s["name"],
                                "school_code": code,
                                "facility_id": s.get("facility_id"),
                                "distance_m": s["distance_m"],
                                "rank": rank,
                                "source_version": SOURCE_VERSION,
                            }
                        )
                        if not row["db_candidate"]:
                            nearby_stats["neis_code_unresolved"] += 1
                            nearby_stats["db_candidate_excluded"] += 1
                        nearby_rows.append(row)
                        nearby_stats[f"{level}_rows"] += 1
            else:
                nearby_stats["skipped_no_coord"] += 1

        done = step["checkpoint_after"]
        part = {
            "completed_count": done["completed_count"],
            "last_completed_complex_id": done["last_completed_complex_id"],
            "area_rows": area_rows[a0:],
            "nearby_rows": nearby_rows[n0:],
            "unresolved_rows": unresolved_rows[u0:],
            "valid_coords": valid_coords - v0,
            "elem_stats": counter_delta(e0, elem_stats),
            "mid_stats": counter_delta(m0, mid_stats),
            "high_stats": counter_delta(h0, high_stats),
            "nearby_stats": counter_delta(nb0, nearby_stats),
            "samples": {key: samples[key] for key in samples if key not in samples_before},
        }
        write_chunk(out_dir, done["completed_count"], part)
        chunk_counts.append(done["completed_count"])
        done = dict(done)
        done["chunk_completed_counts"] = chunk_counts
        save_checkpoint(ckpt_file, done, args.school_level, args.complex_id, args.chunk_size, args.sido)

    elapsed = round(time.time() - t0, 2)

    # Jamsil regression
    jam_areas = [a for a in area_rows if a["complex_id"] == JAMSIL_ID]
    jam_elem = next((a for a in jam_areas if a["school_level"] == "elementary"), None)
    jam_mid = next((a for a in jam_areas if a["school_level"] == "middle"), None)
    jam_high = next((a for a in jam_areas if a["school_level"] == "high"), None)
    jam_near = [n for n in nearby_rows if n["complex_id"] == JAMSIL_ID]
    regression = {
        "elementary_zone": jam_elem.get("zone_name") if jam_elem else None,
        "elementary_zone_id": jam_elem.get("area_id") if jam_elem else None,
        "elementary_school": jam_elem.get("school_name") if jam_elem else None,
        "elementary_school_code": jam_elem.get("school_code") if jam_elem else None,
        "elementary_status": jam_elem.get("resolution_status") if jam_elem else None,
        "middle_district": jam_mid.get("district_name") if jam_mid else None,
        "middle_district_id": jam_mid.get("area_id") if jam_mid else None,
        "middle_members": jam_mid.get("member_count") if jam_mid else None,
        "middle_membership_status": jam_mid.get("membership_status") if jam_mid else None,
        "high_district": jam_high.get("district_name") if jam_high else None,
        "high_members": jam_high.get("member_count") if jam_high else None,
        "nearby_count": len(jam_near),
    }
    regression["elem_pass"] = (
        regression["elementary_zone_id"] == JAMSIL_EXPECT["elem_zone_id"]
        and regression["elementary_school_code"] == JAMSIL_EXPECT["elem_school_code"]
        and regression["elementary_status"] == "CONFIRMED_SINGLE"
    )
    regression["middle_pass"] = (
        regression["middle_district_id"] == JAMSIL_EXPECT["mid_district_id"]
        and regression["middle_members"] == JAMSIL_EXPECT["mid_member_count"]
        and regression["middle_membership_status"] == "MEMBERSHIP_COMPLETE"
    )
    regression["high_pass"] = (
        regression["high_district"] == JAMSIL_EXPECT["high_district_name"]
        and regression["high_members"] == JAMSIL_EXPECT["high_member_count"]
    )
    regression["result"] = (
        "PASS"
        if regression["elem_pass"] and regression["middle_pass"] and regression["high_pass"]
        else "FAIL"
    )

    def coverage(stats: Counter, total: int, keys: list[str]) -> float:
        if total <= 0:
            return 0.0
        return round(100.0 * sum(stats[k] for k in keys) / total, 2)

    n = len(complexes)
    elem_resolved = elem_stats["CONFIRMED_SINGLE"] + elem_stats["CONFIRMED_COMMON"]
    mid_district_resolved = mid_stats["CONFIRMED_SINGLE"] + mid_stats["CONFIRMED_COMMON"]

    summary = {
        "mode": "dry-run",
        "region": args.region,
        "source_version": SOURCE_VERSION,
        "base_date": BASE_DATE,
        "runtime_sec": elapsed,
        "total_complexes": n,
        "valid_coordinates": valid_coords,
        "coord_note": "Production apt_complex_master lat/lng currently null for Seoul; only product mapAnchor overrides applied (잠실엘스).",
        "elementary": {
            "resolved": elem_resolved,
            "single": elem_stats["CONFIRMED_SINGLE"],
            "common": elem_stats["CONFIRMED_COMMON"],
            "ambiguous": elem_stats["BOUNDARY_AMBIGUOUS"],
            "unmatched": elem_stats["NO_POLYGON_MATCH"],
            "school_code_unresolved": elem_stats["SCHOOL_CODE_UNRESOLVED"],
            "invalid_coord": elem_stats["INVALID_COMPLEX_COORD"],
            "coverage_pct_of_valid_coords": coverage(
                elem_stats,
                max(1, valid_coords),
                ["CONFIRMED_SINGLE", "CONFIRMED_COMMON"],
            ),
            "counts": dict(sorted(elem_stats.items())),
        },
        "middle": {
            "district_resolved": mid_district_resolved,
            "membership_complete": mid_stats["MEMBERSHIP_COMPLETE"],
            "district_only": mid_stats["RESOLVED_DISTRICT_ONLY"],
            "ambiguous": mid_stats["BOUNDARY_AMBIGUOUS"],
            "unmatched": mid_stats["NO_POLYGON_MATCH"],
            "invalid_coord": mid_stats["INVALID_COMPLEX_COORD"],
            "coverage_pct_of_valid_coords": coverage(
                mid_stats,
                max(1, valid_coords),
                ["CONFIRMED_SINGLE", "CONFIRMED_COMMON"],
            ),
            "counts": dict(sorted(mid_stats.items())),
        },
        "high": {
            "district_resolved": high_stats["DISTRICT_RESOLVED_SEED"],
            "membership_complete": high_stats["MEMBERSHIP_COMPLETE"],
            "partial": 0,
            "unresolved": high_stats["UNRESOLVED"],
            "coverage_note": "Seoul-wide high SHP/membership not packaged; seed-only for 잠실엘스.",
            "counts": dict(sorted(high_stats.items())),
        },
        "nearby": {
            "complexes_calculated": nearby_stats["complexes_calculated"],
            "elementary_rows": nearby_stats["elementary_rows"],
            "middle_rows": nearby_stats["middle_rows"],
            "high_rows": nearby_stats["high_rows"],
            "neis_code_unresolved": nearby_stats["neis_code_unresolved"],
            "db_candidate_excluded": nearby_stats["db_candidate_excluded"],
            "skipped_no_coord": nearby_stats["skipped_no_coord"],
            "radius_m": NEARBY_MAX_M,
            "store_cap_per_level": NEARBY_STORE_CAP_PER_LEVEL,
            "store_cap_reason": "Product UI shows all within 1500m (SCHOOL_MAX_PER_LEVEL=null); store cap 24 mirrors legacy dev map bound without truncating typical in-radius sets.",
        },
        "write_eligibility": {
            "elementary_eligible": elem_stats["CONFIRMED_SINGLE"] + elem_stats["CONFIRMED_COMMON"],
            "middle_eligible_membership": mid_stats["MEMBERSHIP_COMPLETE"],
            "middle_eligible_district_only": mid_stats["RESOLVED_DISTRICT_ONLY"],
            "high_eligible": high_stats["MEMBERSHIP_COMPLETE"],
            "nearby_eligible_complexes": nearby_stats["complexes_calculated"],
            "excluded_reason": "CONFIRMED(+membership) only; INVALID_COMPLEX_COORD / AMBIGUOUS / UNRESOLVED excluded. Seoul coord backfill required before Production write.",
        },
        "jamsil_els_regression": regression,
        "polygon_inventory": {
            "elem_seoul_polys": len(elem_polys),
            "middle_seoul_polys": len(mid_polys),
            "seoul_schools_csv": len(schools),
        },
        "samples": samples,
        "nearby_db_candidates": {
            "excluded_null_school_code": nearby_stats["db_candidate_excluded"],
            "excluded_reason": "SCHOOL_CODE_UNRESOLVED",
            "note": "Nearby rows are kept. NULL school_code is not a materialization candidate and no code is invented.",
        },
        "batch": {
            "chunk_size": args.chunk_size,
            "ordered_by": "complex_id",
            "resumed_from": resumed_from,
            "chunks_this_run": len(chunk_plan),
            "completed_count": chunk_counts[-1] if chunk_counts else 0,
        },
        "pip_semantics": "shapely Polygon.covers(point) — interior OR boundary; multi-cover → BOUNDARY_AMBIGUOUS (no arbitrary pick)",
        "production_rows_written": 0,
    }

    summary_path = out_dir / "school-materialization-summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    # unresolved CSV (cap)
    un_path = out_dir / "school-materialization-unresolved.csv"
    with un_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["complex_id", "apt_name", "school_level", "status", "detail"],
        )
        w.writeheader()
        for row in unresolved_rows[:50000]:
            w.writerow(row)

    sample_path = out_dir / "school-materialization-sample.json"
    sample_path.write_text(
        json.dumps(
            {
                "jamsil_areas": jam_areas,
                "jamsil_nearby_top": jam_near[:30],
                "samples": samples,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    # Copy artifacts into repo data/poc for commit-sized summary only
    repo_art = ROOT / "data/poc/school-materialization"
    repo_art.mkdir(parents=True, exist_ok=True)
    (repo_art / "school-materialization-summary.json").write_text(
        summary_path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (repo_art / "school-materialization-sample.json").write_text(
        sample_path.read_text(encoding="utf-8"), encoding="utf-8"
    )

    print(json.dumps({"summary": str(summary_path), "regression": regression["result"], "runtime_sec": elapsed}, ensure_ascii=False))
    return 0 if regression["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
