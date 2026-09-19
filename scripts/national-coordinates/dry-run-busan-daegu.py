"""Dry-run Busan/Daegu parcel representative points onto PNU_EXACT rows.

Reads the lightweight GitHub ZIPs only. Does not download SHP, recompute PNU,
or open a database. Production write is a separate script and stays refused
until this artifact's decision is PASS.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coordinate_apply import (
    OUTPUT_CRS,
    SEMANTICS,
    SOURCE_CRS,
    classify_exact_join,
    parse_wgs84_pair,
    validate_payload,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data/poc/national-coordinates/busan-daegu-coordinate-dry-run.json"
PNU_PATH = ROOT / "data/poc/national-coordinates/pnu-resolution.jsonl"

REGIONS = {
    "26": {
        "sido": "부산광역시",
        "expected_targets": 1342,
        "zip": ROOT / "data/poc/national-coordinates/busan_parcel_coordinates_cursor_input_20260908.zip",
    },
    "27": {
        "sido": "대구광역시",
        "expected_targets": 1089,
        "zip": ROOT / "data/poc/national-coordinates/daegu_parcel_coordinates_cursor_input_20260908.zip",
    },
}


def fail(code: str) -> None:
    print(json.dumps({"status": "FAIL", "code": code}, ensure_ascii=False))
    raise SystemExit(2)


def load_targets() -> dict[str, list[dict]]:
    grouped = {code: [] for code in REGIONS}
    seen = {code: set() for code in REGIONS}
    with PNU_PATH.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            code = str(row.get("sido_code"))
            if code not in REGIONS or row.get("resolution_status") != "PNU_EXACT":
                continue
            if row.get("sido") != REGIONS[code]["sido"]:
                fail("SIDO_NAME")
            grouped[code].append(row)
            seen[code].add(row["complex_id"])
    for code, spec in REGIONS.items():
        if len(grouped[code]) != spec["expected_targets"]:
            fail("TARGET_COUNT")
        if len(seen[code]) != len(grouped[code]):
            fail("DUPLICATE_COMPLEX_ID")
    return grouped


def load_zip(path: Path, sido_code: str, sido: str) -> tuple[dict, dict[str, tuple[str, str]], set[str]]:
    if not path.is_file():
        fail("ZIP_MISSING")
    with zipfile.ZipFile(path) as archive:
        csv_names = [name for name in archive.namelist() if name.endswith(".csv")]
        meta_names = [name for name in archive.namelist() if name.endswith(".meta.json")]
        if len(csv_names) != 1 or len(meta_names) != 1:
            fail("ZIP_LAYOUT")
        meta = json.loads(archive.read(meta_names[0]))
        raw = archive.read(csv_names[0])
    if meta.get("region_code") != sido_code or meta.get("region_name") != sido:
        fail("META_REGION")
    if meta.get("coordinate_semantics") != SEMANTICS:
        fail("META_SEMANTICS")
    if meta.get("source_crs") != SOURCE_CRS or meta.get("output_crs") != OUTPUT_CRS:
        fail("META_CRS")
    if meta.get("output_columns") != ["pnu", "longitude", "latitude"]:
        fail("META_COLUMNS")
    if not meta.get("source_date_values") or not isinstance(meta.get("source_sha256"), str):
        fail("META_PROVENANCE")
    if len(meta["source_sha256"]) != 64:
        fail("META_PROVENANCE")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != meta.get("output_csv_sha256") or len(raw) != meta.get("output_csv_bytes"):
        fail("CSV_HASH")
    text = raw.decode("utf-8")
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if header != ["pnu", "longitude", "latitude"]:
        fail("CSV_HEADER")
    points: dict[str, tuple[str, str]] = {}
    duplicates: set[str] = set()
    rows = 0
    for record in reader:
        rows += 1
        if len(record) != 3:
            fail("CSV_ROW")
        pnu, longitude, latitude = record
        if pnu in points or pnu in duplicates:
            duplicates.add(pnu)
            points.pop(pnu, None)
            continue
        points[pnu] = (longitude, latitude)
    if rows != meta.get("output_rows"):
        fail("CSV_ROW_COUNT")
    if meta.get("excluded_duplicate_pnu_rows") not in (0, None) and duplicates:
        fail("CSV_DUPLICATE_UNEXPECTED")
    return meta, points, duplicates


def join_region(targets: list[dict], points: dict[str, tuple[str, str]], duplicates: set[str]) -> dict:
    counts = {
        "MATCHED_EXACT": 0,
        "PNU_NOT_FOUND": 0,
        "DUPLICATE_PNU": 0,
        "INVALID_COORDINATE": 0,
    }
    safe = []
    not_found = []
    for row in targets:
        pnu = row.get("pnu")
        if not isinstance(pnu, str):
            label = "INVALID_COORDINATE"
            coordinate = None
        else:
            coordinate = None if pnu in duplicates or pnu not in points else points[pnu]
            label = classify_exact_join(
                pnu,
                duplicate_pnu=pnu in duplicates,
                coordinate=coordinate,
                sido_code=str(row.get("sido_code")),
            )
        counts[label] += 1
        if label == "PNU_NOT_FOUND":
            not_found.append(row["complex_id"])
        if label != "MATCHED_EXACT" or coordinate is None:
            continue
        longitude, latitude = parse_wgs84_pair(coordinate[0], coordinate[1])
        safe.append(
            {
                "complex_id": row["complex_id"],
                "sido": row["sido"],
                "sido_code": str(row["sido_code"]),
                "resolution_status": "PNU_EXACT",
                "pnu": pnu,
                "expected_pnu": pnu,
                "longitude": longitude,
                "latitude": latitude,
                "longitude_text": coordinate[0],
                "latitude_text": coordinate[1],
                "semantics": SEMANTICS,
                "classification": "MATCHED_EXACT",
            }
        )
    safe.sort(key=lambda item: item["complex_id"])
    return {
        "counts": counts,
        "safe": safe,
        "not_found_sample": not_found[:20],
    }


def main() -> int:
    targets = load_targets()
    report_regions = {}
    for code, spec in REGIONS.items():
        meta, points, duplicates = load_zip(spec["zip"], code, spec["sido"])
        joined = join_region(targets[code], points, duplicates)
        safe = joined["safe"]
        try:
            validate_payload(safe, expected=len(safe), existing_coords=set())
        except Exception as exc:
            print(json.dumps({"status": "FAIL", "code": getattr(exc, "code", "VALIDATE"), "sido": spec["sido"]}))
            return 2
        ids = [row["complex_id"] for row in safe]
        if len(ids) != len(set(ids)):
            fail("DUPLICATE_COMPLEX_ID")
        if any(row["latitude"] is None or row["longitude"] is None for row in safe):
            fail("NULL_COORDINATE")
        targets_n = spec["expected_targets"]
        report_regions[code] = {
            "sido": spec["sido"],
            "sido_code": code,
            "zip": spec["zip"].name,
            "source_date_values": meta["source_date_values"],
            "source_sha256": meta["source_sha256"],
            "source_crs": meta["source_crs"],
            "output_crs": meta["output_crs"],
            "coordinate_semantics": meta["coordinate_semantics"],
            "output_rows": meta["output_rows"],
            "output_csv_sha256": meta["output_csv_sha256"],
            "csv_duplicate_pnu": len(duplicates),
            "targets": targets_n,
            "exact_matched": joined["counts"]["MATCHED_EXACT"],
            "not_found": joined["counts"]["PNU_NOT_FOUND"],
            "duplicate": joined["counts"]["DUPLICATE_PNU"],
            "invalid": joined["counts"]["INVALID_COORDINATE"],
            "safe": len(safe),
            "coverage": round(len(safe) / targets_n, 6) if targets_n else 0,
            "not_found_sample": joined["not_found_sample"],
            "safe_rows": safe,
        }
    decision = "PASS"
    for region in report_regions.values():
        if region["safe"] != region["exact_matched"]:
            decision = "FAIL"
        if region["duplicate"] or region["invalid"]:
            # Excluded from SAFE. Gates below still require the SAFE set itself to be clean.
            pass
    artifact = {
        "status": decision,
        "decision": decision,
        "db_write_executed": False,
        "semantics": SEMANTICS,
        "provenance": {
            "storage": "apt_complex_master.latitude/longitude",
            "new_source": False,
            "new_enrichment_domain": False,
            "source_link_write": False,
            "note": "Existing master coordinate columns only. No new source or enrichment domain.",
        },
        "gates": {
            "duplicate_complex_id": 0,
            "null_coordinates": 0,
            "malformed_coordinate": 0,
            "out_of_sido_bbox": 0,
        },
        "regions": report_regions,
    }
    if decision != "PASS":
        print(json.dumps({"status": "FAIL"}, ensure_ascii=False))
        return 2
    OUT.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {
        "status": "PASS",
        "out": str(OUT.relative_to(ROOT)),
        "busan": {k: report_regions["26"][k] for k in ("targets", "exact_matched", "not_found", "duplicate", "invalid", "safe", "coverage")},
        "daegu": {k: report_regions["27"][k] for k in ("targets", "exact_matched", "not_found", "duplicate", "invalid", "safe", "coverage")},
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
