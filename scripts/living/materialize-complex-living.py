#!/usr/bin/env python3
"""Materialize complex living snapshots from a local SEMAS zip.

Reads canonical complex coordinates (PARCEL_REPRESENTATIVE_POINT already stored
on apt_complex_master). Does not geocode. Complexes without a coordinate are
NO_COORDINATE and get no facility counts.

Spatial path: grid candidate filter, then haversine. Not O(complexes * stores).

Writes a local SQLite database only. Production apply is a separate step.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sqlite3
import sys
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RULES_PATH = ROOT / "src/lib/living/category-rules.json"
SCHEMA_PATH = ROOT / "src/lib/db/migrations/20260920_complex_living_snapshots.sql"

# Prior SEMAS_2026Q2 verification at the published reference point.
# Used only as a parity check, never as stored counts.
JAMSIL_REFERENCE = {
    "complex_id": "cx_4c63d9a100973c60",
    "name": "잠실엘스",
    "lat": 37.5133051,
    "lng": 127.0815962,
    "radius_m": 1000,
    "note": "Reference point supplied for pipeline parity. Not a parcel coordinate and not written as this complex's snapshot.",
    "totals": {"MEDICAL": 205, "FOOD": 821},
    "prior_pipeline_same_point": {
        "MEDICAL": 205,
        "FOOD": 821,
        "CAFE": 116,
        "CONVENIENCE": 54,
        "GROCERY": 35,
        "ETC": 51,
        "SPORTS": 94,
    },
}

PILOT = [
    ("cx_4c63d9a100973c60", "잠실엘스"),
    ("cx_ed52bf895d064c11", "파크리오"),
    ("cx_caf229b5ac63cfbd", "리센츠"),
    ("cx_30d7eea6da810b52", "헬리오시티"),
    ("cx_1c244e7305d12c44", "반포자이"),
    ("cx_3bcf0f87bce7496b", "래미안퍼스티지"),
    ("cx_0320fd9e007e1f8c", "은마"),
    ("cx_c9ed0235ecca960c", "도곡렉슬"),
    ("cx_07caf64c556e85a7", "마포프레스티지자이"),
    ("cx_88d05e29df26a0d6", "포레나노원"),
]

KOREA_LAT = (33.0, 39.6)
KOREA_LNG = (124.0, 132.2)
CELL = 0.01
EARTH_M = 6_371_000.0


def load_rules():
    spec = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    by_code = {}
    for rule in spec["rules"]:
        by_code[rule["code"]] = (rule["category"], rule["subcategory"])
    subs = defaultdict(set)
    for category, subcategory in by_code.values():
        subs[category].add(subcategory)
    for fam in spec["familyFallbacks"]:
        subs[fam["category"]].add(fam["subcategory"])
    return spec, by_code, {k: sorted(v) for k, v in subs.items()}


def classify(lcls: str, mcls: str, scls: str, by_code: dict):
    hit = by_code.get(scls) or by_code.get(mcls)
    if hit:
        return hit
    if mcls in ("Q101", "Q102"):
        return ("MEDICAL", "OTHER")
    if lcls == "I2" and mcls != "I212":
        return ("FOOD", "OTHER")
    if mcls == "R103":
        return ("SPORTS", "OTHER")
    return None


def haversine_m(lat1, lng1, lat2, lng2):
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_M * math.asin(min(1.0, math.sqrt(a)))


def coord_status(lat, lng):
    if lat is None or lng is None or lat == "" or lng == "":
        return "NO_COORDINATE"
    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except (TypeError, ValueError):
        return "INVALID_COORDINATE"
    if not math.isfinite(lat_f) or not math.isfinite(lng_f):
        return "INVALID_COORDINATE"
    if lat_f == 0 or lng_f == 0:
        return "INVALID_COORDINATE"
    if not (KOREA_LAT[0] <= lat_f <= KOREA_LAT[1] and KOREA_LNG[0] <= lng_f <= KOREA_LNG[1]):
        return "INVALID_COORDINATE"
    return "OK"


def cell_of(lat, lng):
    return (math.floor(lat / CELL), math.floor(lng / CELL))


def candidate_cells(lat, lng, radius_m):
    dlat = (radius_m + 30) / 111_320
    dlng = (radius_m + 30) / (111_320 * math.cos(math.radians(lat)))
    i0, i1 = math.floor((lat - dlat) / CELL), math.floor((lat + dlat) / CELL)
    j0, j1 = math.floor((lng - dlng) / CELL), math.floor((lng + dlng) / CELL)
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            yield (i, j)


def parse_header(header):
    index = {name.strip().lstrip("\ufeff"): i for i, name in enumerate(header)}
    required = ["상가업소번호", "상권업종대분류코드", "상권업종중분류코드", "상권업종소분류코드", "경도", "위도"]
    missing = [name for name in required if name not in index]
    if missing:
        raise SystemExit(f"SEMAS header missing {missing}")
    status_cols = [name for name in index if any(token in name for token in ("영업", "폐업", "상태", "휴업"))]
    return index, status_cols


def bump(counter, key):
    counter[key] = counter.get(key, 0) + 1


def aggregate_center(lat, lng, grid, radii):
    """Return counts[radius][category][subcategory] and zero-distance tally."""
    counts = {radius: defaultdict(lambda: defaultdict(int)) for radius in radii}
    zero_distance = 0
    seen_cells = set()
    max_radius = max(radii)
    for cell in candidate_cells(lat, lng, max_radius):
        if cell in seen_cells:
            continue
        seen_cells.add(cell)
        for plat, plng, category, subcategory in grid.get(cell, ()):
            dist = haversine_m(lat, lng, plat, plng)
            if dist == 0:
                zero_distance += 1
            for radius in radii:
                if dist <= radius:
                    counts[radius][category][subcategory] += 1
    return counts, zero_distance


def empty_counts(subs, radii):
    return {
        radius: {category: {sub: 0 for sub in subcats} for category, subcats in subs.items()}
        for radius in radii
    }


def fill_fixed(counts, subs, radii):
    """Ensure every known subcategory exists, including real zeros."""
    out = empty_counts(subs, radii)
    for radius in radii:
        for category, subcats in counts[radius].items():
            if category not in out[radius]:
                out[radius][category] = {}
            for sub, n in subcats.items():
                out[radius][category][sub] = out[radius][category].get(sub, 0) + n
    return out


def category_total(subcats):
    return sum(subcats.values())


def stream_zip(zip_path, grid, by_code, boxes):
    stats = {
        "files": [],
        "rows": 0,
        "kept": 0,
        "invalid_coord": 0,
        "duplicate_extra_rows": 0,
        "status_columns": [],
        "status_values": {},
        "unlisted_medical": {},
        "unlisted_food": {},
        "unlisted_sports": {},
    }
    seen = set()
    with zipfile.ZipFile(zip_path) as zf:
        members = [info for info in zf.infolist() if info.filename.lower().endswith(".csv")]
        if not members:
            raise SystemExit(f"no CSV in {zip_path}")
        for info in members:
            file_rows = 0
            with zf.open(info, "r") as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                reader = csv.reader(text)
                try:
                    header = next(reader)
                except StopIteration:
                    continue
                index, status_cols = parse_header(header)
                for col in status_cols:
                    if col not in stats["status_columns"]:
                        stats["status_columns"].append(col)
                i_id = index["상가업소번호"]
                i_l = index["상권업종대분류코드"]
                i_m = index["상권업종중분류코드"]
                i_s = index["상권업종소분류코드"]
                i_lat = index["위도"]
                i_lng = index["경도"]
                status_idx = [(col, index[col]) for col in status_cols]
                for row in reader:
                    if not row:
                        continue
                    file_rows += 1
                    stats["rows"] += 1
                    if stats["rows"] % 500_000 == 0:
                        print(f"[semas] rows={stats['rows']} kept={stats['kept']}", flush=True)
                    try:
                        lat = float(row[i_lat])
                        lng = float(row[i_lng])
                    except (ValueError, IndexError):
                        stats["invalid_coord"] += 1
                        continue
                    if not math.isfinite(lat) or not math.isfinite(lng) or lat == 0 or lng == 0:
                        stats["invalid_coord"] += 1
                        continue
                    if not in_boxes(lat, lng, boxes):
                        continue
                    store_id = row[i_id].strip()
                    if not store_id:
                        continue
                    if store_id in seen:
                        stats["duplicate_extra_rows"] += 1
                        continue
                    seen.add(store_id)
                    lcls, mcls, scls = row[i_l].strip(), row[i_m].strip(), row[i_s].strip()
                    classified = classify(lcls, mcls, scls, by_code)
                    if classified is None:
                        continue
                    for col, idx in status_idx:
                        value = row[idx].strip() if idx < len(row) else ""
                        bucket = stats["status_values"].setdefault(col, {})
                        bucket[value] = bucket.get(value, 0) + 1
                    category, subcategory = classified
                    if category == "MEDICAL" and subcategory == "OTHER" and scls not in by_code:
                        bump(stats["unlisted_medical"], scls or mcls)
                    if category == "FOOD" and subcategory == "OTHER" and mcls not in by_code and scls not in by_code:
                        bump(stats["unlisted_food"], mcls or scls)
                    if category == "SPORTS" and subcategory == "OTHER" and scls not in by_code:
                        bump(stats["unlisted_sports"], scls or mcls)
                    grid[cell_of(lat, lng)].append((lat, lng, category, subcategory))
                    stats["kept"] += 1
            stats["files"].append({"name": info.filename, "rows": file_rows})
    stats["unique_store_ids"] = len(seen)
    return stats


def cluster_boxes(points, pad_m=1300):
    """One padded box per ~11km cluster. Do not union distant cities into one bbox."""
    if not points:
        raise SystemExit("no coordinate-ready complexes and no parity point")
    clusters = {}
    for lat, lng in points:
        clusters.setdefault((round(lat, 1), round(lng, 1)), []).append((lat, lng))
    boxes = []
    for group in clusters.values():
        min_lat = min(p[0] for p in group)
        max_lat = max(p[0] for p in group)
        min_lng = min(p[1] for p in group)
        max_lng = max(p[1] for p in group)
        mid_lat = (min_lat + max_lat) / 2
        dlat = pad_m / 111_320
        dlng = pad_m / (111_320 * math.cos(math.radians(mid_lat)))
        boxes.append((min_lat - dlat, max_lat + dlat, min_lng - dlng, max_lng + dlng))
    return boxes


def in_boxes(lat, lng, boxes):
    for min_lat, max_lat, min_lng, max_lng in boxes:
        if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
            return True
    return False


def load_complexes(path):
    complexes = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                complexes.append(json.loads(line))
    return complexes


def write_db(db_path, spec, subs, complexes, snapshots, built_at):
    if db_path.exists():
        db_path.unlink()
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    source_version = spec["sourceVersion"]
    snapshot_version = spec["snapshotVersion"]
    complete = 0
    readiness_rows = []
    snap_rows = []
    for complex_row in complexes:
        status = complex_row["coord_status"]
        if status == "OK":
            status = "COMPLETE"
            complete += 1
            packed = snapshots[complex_row["complex_id"]]
            for radius, categories in packed.items():
                for category, subcats in categories.items():
                    for sub, count in subcats.items():
                        snap_rows.append(
                            (
                                complex_row["complex_id"],
                                radius,
                                category,
                                sub,
                                int(count),
                                "COMPLETE",
                                spec["coordinateSemantics"],
                                spec["distanceMetric"],
                                spec["sourceProvider"],
                                spec["sourceDataset"],
                                source_version,
                                spec["sourceAsOf"],
                                spec["ruleVersion"],
                                snapshot_version,
                                built_at,
                            )
                        )
        readiness_rows.append(
            (
                complex_row["complex_id"],
                source_version,
                snapshot_version,
                status,
                spec["coordinateSemantics"] if status == "COMPLETE" else None,
                built_at,
            )
        )
    db.executemany(
        """INSERT INTO complex_living_readiness
           (complex_id, source_version, snapshot_version, quality_status, coordinate_semantics, built_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        readiness_rows,
    )
    db.executemany(
        """INSERT INTO complex_living_snapshots (
             complex_id, radius_m, product_category, product_subcategory, facility_count,
             quality_status, coordinate_semantics, distance_metric,
             source_provider, source_dataset, source_version, source_as_of,
             rule_version, snapshot_version, built_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        snap_rows,
    )
    db.executemany(
        """INSERT INTO living_category_rules
           (rule_version, source_provider, source_category_code, source_category_name,
            product_category, product_subcategory)
           VALUES (?, ?, ?, ?, ?, ?)""",
        [
            (
                spec["ruleVersion"],
                spec["sourceProvider"],
                rule["code"],
                rule["name"],
                rule["category"],
                rule["subcategory"],
            )
            for rule in spec["rules"]
        ],
    )
    note = "Current pointer for SEMAS_2026Q2 living_v1. Older source versions are retained by primary key."
    db.execute(
        """INSERT INTO complex_living_publications
           (source_version, snapshot_version, rule_version, source_provider, source_dataset,
            source_as_of, is_current, built_at, complex_count, note)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
        (
            source_version,
            snapshot_version,
            spec["ruleVersion"],
            spec["sourceProvider"],
            spec["sourceDataset"],
            spec["sourceAsOf"],
            built_at,
            complete,
            note,
        ),
    )
    db.commit()
    db.close()
    return complete, len(snap_rows), len(readiness_rows)


def coverage_report(complexes, snapshots, subs):
    by_sido = {}
    for row in complexes:
        bucket = by_sido.setdefault(
            row["sido"] or "",
            {
                "target": 0,
                "coordinate_ready": 0,
                "snapshot_500": 0,
                "snapshot_1000": 0,
                "no_coordinate": 0,
                "invalid_coordinate": 0,
            },
        )
        bucket["target"] += 1
        if row["coord_status"] == "OK":
            bucket["coordinate_ready"] += 1
            bucket["snapshot_500"] += 1
            bucket["snapshot_1000"] += 1
        elif row["coord_status"] == "NO_COORDINATE":
            bucket["no_coordinate"] += 1
        else:
            bucket["invalid_coordinate"] += 1

    def sum_category(category, radius):
        total = 0
        other = 0
        complexes_with = 0
        for packed in snapshots.values():
            subcats = packed[radius].get(category, {})
            n = category_total(subcats)
            total += n
            other += subcats.get("OTHER", 0)
            if n > 0:
                complexes_with += 1
        classified = total - other
        return {
            "complexes_with_any": complexes_with,
            "complexes_measured": len(snapshots),
            "facility_count": total,
            "other": other,
            "classified": classified,
            "classification_coverage": (classified / total) if total else None,
        }

    categories = {}
    for category in subs:
        categories[category] = {
            "500": sum_category(category, 500),
            "1000": sum_category(category, 1000),
        }
    return {"by_sido": by_sido, "categories": categories}


def parity_report(counts):
    totals = {category: category_total(subcats) for category, subcats in counts[1000].items()}
    medical_ok = totals.get("MEDICAL") == JAMSIL_REFERENCE["totals"]["MEDICAL"]
    food_ok = totals.get("FOOD") == JAMSIL_REFERENCE["totals"]["FOOD"]
    prior = JAMSIL_REFERENCE["prior_pipeline_same_point"]
    prior_diff = {
        category: {"expected": expected, "actual": totals.get(category, 0)}
        for category, expected in prior.items()
        if totals.get(category, 0) != expected
    }
    return {
        "complex_id": JAMSIL_REFERENCE["complex_id"],
        "name": JAMSIL_REFERENCE["name"],
        "source_version": "SEMAS_2026Q2",
        "radius_m": 1000,
        "reference_point": {
            "lat": JAMSIL_REFERENCE["lat"],
            "lng": JAMSIL_REFERENCE["lng"],
            "role": JAMSIL_REFERENCE["note"],
        },
        "totals": totals,
        "medical_subcategories": dict(counts[1000]["MEDICAL"]),
        "food_subcategories": dict(counts[1000]["FOOD"]),
        "cafe": totals.get("CAFE", 0),
        "parity": {
            "medical_total": medical_ok,
            "food_total": food_ok,
            "pass": medical_ok and food_ok,
        },
        "prior_pipeline_differences": prior_diff,
        "subcategory_note": (
            "SEMAS has no separate 정형/재활/가정 small code. "
            "성형외과 의원 stays PLASTIC_SURGERY, 안과 stays OPHTHALMOLOGY, "
            "방사선 진단/병리 stays RADIOLOGY_LAB. Those are not folded into the "
            "non-source specialty list."
        ),
    }


def self_test():
    spec, by_code, subs = load_rules()
    assert classify("Q1", "Q102", "Q10210", by_code) == ("MEDICAL", "DENTAL")
    assert classify("Q1", "Q101", "Q10102", by_code) == ("MEDICAL", "HOSPITAL")
    assert classify("Q1", "Q102", "Q10299", by_code) == ("MEDICAL", "OTHER")
    assert classify("I2", "I201", "I20101", by_code) == ("FOOD", "KOREAN")
    assert classify("I2", "I212", "I21201", by_code) == ("CAFE", "CAFE")
    assert classify("I2", "I212", "I21202", by_code) is None
    assert classify("I2", "I206", "I20601", by_code) == ("FOOD", "OTHER")
    assert classify("G2", "G204", "G20405", by_code) == ("CONVENIENCE", "CONVENIENCE")
    assert classify("G2", "G204", "G20499", by_code) is None
    assert classify("R1", "R103", "R10307", by_code) == ("SPORTS", "GYM")
    dist = haversine_m(37.5, 127.0, 37.5 + 1 / 111.32, 127.0)
    assert 900 < dist < 1100, dist
    grid = defaultdict(list)
    grid[cell_of(37.51, 127.08)].append((37.5133051, 127.0815962, "MEDICAL", "HOSPITAL"))
    grid[cell_of(37.53, 127.08)].append((37.53, 127.08, "FOOD", "KOREAN"))
    counts, zeros = aggregate_center(37.5133051, 127.0815962, grid, (500, 1000))
    assert zeros == 1
    assert counts[500]["MEDICAL"]["HOSPITAL"] == 1
    far = haversine_m(37.5133051, 127.0815962, 37.53, 127.08)
    assert (far <= 1000) == (counts[1000]["FOOD"]["KOREAN"] == 1)
    assert (far <= 500) == (counts[500]["FOOD"]["KOREAN"] == 1)
    # duplicate source key is skipped by the caller; fixed subcategory zeros stay stable
    filled = fill_fixed(counts, subs, (500, 1000))
    assert filled[500]["CAFE"]["CAFE"] == 0
    assert "OTHER" in subs["MEDICAL"]
    print("self-test PASS")
    return 0


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--zip", dest="zip_path")
    parser.add_argument("--complexes", dest="complexes_path")
    parser.add_argument("--out-db", dest="out_db")
    parser.add_argument("--report-dir", dest="report_dir")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.zip_path or not args.complexes_path or not args.out_db or not args.report_dir:
        parser.error("zip, complexes, out-db, and report-dir are required")

    spec, by_code, subs = load_rules()
    radii = tuple(spec["radiiM"])
    complexes = load_complexes(Path(args.complexes_path))
    ready_points = []
    for row in complexes:
        row["coord_status"] = coord_status(row.get("latitude"), row.get("longitude"))
        if row["coord_status"] == "OK":
            row["lat"] = float(row["latitude"])
            row["lng"] = float(row["longitude"])
            ready_points.append((row["lat"], row["lng"]))
    ready_points.append((JAMSIL_REFERENCE["lat"], JAMSIL_REFERENCE["lng"]))
    boxes = cluster_boxes(ready_points)

    t0 = time.perf_counter()
    grid = defaultdict(list)
    source_stats = stream_zip(Path(args.zip_path), grid, by_code, boxes)
    source_stats["cluster_boxes"] = len(boxes)
    index_s = time.perf_counter() - t0

    t1 = time.perf_counter()
    snapshots = {}
    zero_distance = 0
    for row in complexes:
        if row["coord_status"] != "OK":
            continue
        counts, zeros = aggregate_center(row["lat"], row["lng"], grid, radii)
        zero_distance += zeros
        snapshots[row["complex_id"]] = fill_fixed(counts, subs, radii)
    agg_s = time.perf_counter() - t1

    parity_counts, parity_zeros = aggregate_center(
        JAMSIL_REFERENCE["lat"], JAMSIL_REFERENCE["lng"], grid, radii
    )
    parity = parity_report(fill_fixed(parity_counts, subs, radii))
    parity["zero_distance_links"] = parity_zeros

    built_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    out_db = Path(args.out_db)
    out_db.parent.mkdir(parents=True, exist_ok=True)
    complete, snap_rows, ready_rows = write_db(out_db, spec, subs, complexes, snapshots, built_at)

    report_dir = Path(args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    pilots = []
    by_id = {row["complex_id"]: row for row in complexes}
    for complex_id, name in PILOT:
        row = by_id.get(complex_id)
        pilots.append(
            {
                "complex_id": complex_id,
                "name": name,
                "found": row is not None,
                "sido": None if row is None else row.get("sido"),
                "quality_status": None if row is None else (
                    "COMPLETE" if row["coord_status"] == "OK" else row["coord_status"]
                ),
                "latitude": None if row is None else row.get("latitude"),
                "longitude": None if row is None else row.get("longitude"),
            }
        )
    coverage = coverage_report(complexes, snapshots, subs)
    summary = {
        "built_at": built_at,
        "source": {
            "provider": spec["sourceProvider"],
            "dataset": spec["sourceDataset"],
            "version": spec["sourceVersion"],
            "as_of": spec["sourceAsOf"],
            "rule_version": spec["ruleVersion"],
            "snapshot_version": spec["snapshotVersion"],
            "active_status": spec["activeStatus"],
            "files": source_stats["files"],
            "facility_rows": source_stats["rows"],
            "invalid_coord_rows": source_stats["invalid_coord"],
            "duplicate_extra_rows": source_stats["duplicate_extra_rows"],
            "classified_points_indexed": source_stats["kept"],
            "status_columns": source_stats["status_columns"],
            "status_values": source_stats["status_values"],
            "unlisted_medical": source_stats["unlisted_medical"],
            "unlisted_food": source_stats["unlisted_food"],
            "unlisted_sports": source_stats["unlisted_sports"],
        },
        "national": {
            "target_complexes": len(complexes),
            "coordinate_ready": complete,
            "snapshot_500": complete,
            "snapshot_1000": complete,
            "no_coordinate": sum(1 for row in complexes if row["coord_status"] == "NO_COORDINATE"),
            "invalid_coordinate": sum(1 for row in complexes if row["coord_status"] == "INVALID_COORDINATE"),
            "readiness_rows": ready_rows,
            "snapshot_rows": snap_rows,
            "zero_distance_links": zero_distance,
        },
        "coverage": coverage,
        "pilots": pilots,
        "jamsil_parity": parity,
        "performance": {
            "spatial_index": f"grid cell {CELL} degrees, then haversine",
            "index_seconds": round(index_s, 3),
            "aggregate_seconds": round(agg_s, 3),
        },
        "held": spec["held"],
        "local_db": str(out_db),
    }
    (report_dir / "materialize-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (report_dir / "jamsil-els-parity.json").write_text(
        json.dumps(parity, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        "parity_pass": parity["parity"]["pass"],
        "medical": parity["totals"].get("MEDICAL"),
        "food": parity["totals"].get("FOOD"),
        "cafe": parity["totals"].get("CAFE"),
        "complete": complete,
        "snapshot_rows": snap_rows,
        "index_seconds": round(index_s, 3),
        "aggregate_seconds": round(agg_s, 3),
    }, ensure_ascii=False))
    return 0 if parity["parity"]["pass"] else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
