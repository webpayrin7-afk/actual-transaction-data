#!/usr/bin/env python3
"""Recover PARCEL_REPRESENTATIVE_POINT coordinates for NO_COORDINATE complexes.

Identity is deterministic only:
- Seoul/Gyeonggi: exact lawd + bjdong + a single jibun lot
- other sidos: prior pnu-cadastral-v1 PNU_EXACT rows

Geometry is an exact PNU join to an official cadastral representative-point
file already produced from 국토교통부 일별연속지적도형정보. No geocoding,
no building centroid, no fuzzy name match.

Does not write Production. Apply is scripts/living/apply-parcel-coordinates.mjs.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import math
import re
import sys
import time
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache" / "parcels"
SEMANTICS = "PARCEL_REPRESENTATIVE_POINT"
SOURCE_NAME = "국토교통부 일별연속지적도형정보"
DATASET = "국토교통부 일별연속지적도형정보"
JAMSIL_ID = "cx_4c63d9a100973c60"
JAMSIL_PNU = "1171010100100190000"
JAMSIL_REF = (37.5133051, 127.0815962)
# A parcel interior point versus the previous map anchor can differ by a few
# hundred metres on a large complex. A kilometre-scale gap means the lot
# identity is not safe to write.
JAMSIL_HOLD_M = 1000.0

PILOTS = [
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

LOT_RE = re.compile(r"^(산)?(\d+)(?:-(\d+))?$")
PNU_RE = re.compile(r"^\d{19}$")

# Same loose guards as the Busan/Daegu coordinate apply. Not a geocoder.
SIDO_BBOX = {
    "11": (37.42, 37.72, 126.76, 127.20),
    "12": (34.20, 35.55, 125.95, 127.90),
    "26": (34.85, 35.40, 128.70, 129.35),
    # Includes 군위군, incorporated into Daegu. Still rejects swapped axes.
    "27": (35.55, 36.40, 128.35, 128.80),
    "28": (37.00, 37.85, 126.05, 126.80),
    "30": (36.20, 36.50, 127.25, 127.55),
    "31": (35.30, 35.75, 129.00, 129.50),
    "36": (36.42, 36.75, 127.15, 127.40),
    "41": (36.85, 38.30, 126.35, 127.85),
    "43": (36.15, 37.25, 127.25, 128.75),
    "44": (35.95, 37.10, 126.05, 127.45),
    "47": (35.45, 37.25, 128.25, 129.60),
    "48": (34.55, 35.95, 127.55, 129.30),
    "50": (33.10, 33.60, 126.10, 126.98),
    "51": (37.00, 38.65, 127.05, 129.40),
    "52": (35.25, 36.15, 126.35, 127.90),
}

# Local representative-point extracts. order is the CSV lat/lng column order.
POINT_FILES = {
    "11": {
        "path": CACHE / "seoul_parcel_coordinates_cursor_input_20260908.zip",
        "member": "seoul_parcel_representative_points_20260908.csv.gz",
        "gzip_member": True,
        "lat_first": True,
        "source_version": "AL_D002_11_20260908",
        "source_date": "2026-09-05",
    },
    "26": {
        "path": ROOT / "data/poc/national-coordinates/busan_parcel_coordinates_cursor_input_20260908.zip",
        "member": "busan_parcel_coordinates_cursor_input_20260908.csv",
        "gzip_member": False,
        "lat_first": False,
        "source_version": "AL_D002_26_20260908",
        "source_date": "2026-09-05",
    },
    "27": {
        "path": ROOT / "data/poc/national-coordinates/daegu_parcel_coordinates_cursor_input_20260908.zip",
        "member": "daegu_parcel_coordinates_cursor_input_20260908.csv",
        "gzip_member": False,
        "lat_first": False,
        "source_version": "AL_D002_27_20260908",
        "source_date": "2026-09-05",
    },
}

VWORLD_FILES = {
    "41": 4612,
    "28": 4624,
    "30": 4609,
    "12": 4605,
    "31": 4610,
    "36": 4611,
    "43": 4613,
    "44": 4614,
    "47": 4615,
    "48": 4616,
    "50": 4617,
    "51": 4618,
    "52": 4619,
}


def haversine_m(lat1, lng1, lat2, lng2):
    radius = 6_371_000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


def build_pnu(lawd: str, bjdong: str, mountain: bool, bun: int, ji: int) -> str | None:
    if not (len(lawd) == 5 and lawd.isdigit() and len(bjdong) == 5 and bjdong.isdigit()):
        return None
    if bun <= 0 or bun > 9999 or ji < 0 or ji > 9999:
        return None
    plat = "2" if mountain else "1"
    pnu = f"{lawd}{bjdong}{plat}{bun:04d}{ji:04d}"
    if PNU_RE.fullmatch(pnu) is None or pnu[10] not in ("1", "2"):
        return None
    return pnu


def parse_single_jibun(lawd: str, bjdong: str, jibun: str) -> tuple[str | None, str]:
    """One lot only. Leftover prose, lists, or 외 are ambiguous."""
    text = (jibun or "").strip()
    if not text:
        return None, "NO_PARCEL_IDENTITY"
    match = LOT_RE.fullmatch(text)
    if match is None:
        return None, "PARCEL_AMBIGUOUS"
    bun = int(match.group(2))
    ji = int(match.group(3) or "0")
    pnu = build_pnu(lawd or "", bjdong or "", bool(match.group(1)), bun, ji)
    if pnu is None:
        return None, "NO_PARCEL_IDENTITY"
    return pnu, "EXACT_PRIMARY_PARCEL"


def hub_relation(pnu: str, hub_key: str | None) -> str:
    """BUILDING_HUB_PARCEL stores plat 0 for the same 일반 lot. Plat 2 is a conflict."""
    if not hub_key:
        return "NO_HUB"
    if len(hub_key) != 19 or not hub_key.isdigit():
        return "HUB_CONFLICT"
    if hub_key[:10] != pnu[:10] or hub_key[11:] != pnu[11:]:
        return "HUB_CONFLICT"
    plat = hub_key[10]
    if plat == "0":
        return "HUB_AGREES" if pnu[10] == "1" else "HUB_CONFLICT"
    if plat == pnu[10]:
        return "HUB_AGREES"
    return "HUB_CONFLICT"


def in_bbox(lat: float, lng: float, sido_code: str) -> bool:
    box = SIDO_BBOX.get(sido_code)
    if box is None:
        return False
    return box[0] <= lat <= box[1] and box[2] <= lng <= box[3]


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def open_member(spec: dict):
    archive = zipfile.ZipFile(spec["path"])
    raw = archive.open(spec["member"])
    if spec["gzip_member"]:
        return archive, io.TextIOWrapper(gzip.GzipFile(fileobj=raw), encoding="utf-8", newline="")
    return archive, io.TextIOWrapper(raw, encoding="utf-8", newline="")


def lookup_points(sido_code: str, needed: set[str]) -> tuple[dict[str, tuple[str, str]], list[str]]:
    spec = POINT_FILES[sido_code]
    found: dict[str, tuple[str, str]] = {}
    conflicts: list[str] = []
    archive, text = open_member(spec)
    try:
        reader = csv.reader(text)
        header = next(reader)
        if header[0] != "pnu":
            raise SystemExit(f"unexpected header {sido_code}: {header[:3]}")
        for row in reader:
            if not row:
                continue
            pnu = row[0]
            if pnu not in needed:
                continue
            lat_text = row[1] if spec["lat_first"] else row[2]
            lng_text = row[2] if spec["lat_first"] else row[1]
            pair = (lat_text, lng_text)
            previous = found.get(pnu)
            if previous is None:
                found[pnu] = pair
            elif previous != pair:
                conflicts.append(pnu)
    finally:
        text.close()
        archive.close()
    for pnu in conflicts:
        found.pop(pnu, None)
    return found, conflicts


def probe_vworld(attempts: list[dict]) -> None:
    """Bounded probe. Official SHP host has been returning an empty reply."""
    url = "https://www.vworld.kr/dtmk/downloadResourceFile.do?ds_id=20171128DS00002&fileNo=4611"
    for attempt in range(1, 4):
        started = time.perf_counter()
        status = "fail"
        detail = ""
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=20) as response:
                status = str(response.status)
                detail = response.headers.get("Content-Type", "")
                response.read(64)
        except Exception as error:
            detail = type(error).__name__
        attempts.append(
            {
                "attempt": attempt,
                "host": "www.vworld.kr",
                "status": status,
                "detail": detail,
                "seconds": round(time.perf_counter() - started, 3),
            }
        )
        if status.startswith("2"):
            return
        if attempt < 3:
            time.sleep(min(4, 2 ** (attempt - 1)))


def resolve(rows: list[dict], hubs: dict[str, str], prior: dict[str, dict]) -> list[dict]:
    resolved = []
    for row in rows:
        complex_id = row["complex_id"]
        sido_code = str(row.get("sido_code") or "")
        if sido_code in ("11", "41"):
            pnu, status = parse_single_jibun(
                str(row.get("lawd_cd") or ""),
                str(row.get("bjdong_cd") or ""),
                str(row.get("jibun") or ""),
            )
        else:
            record = prior.get(complex_id)
            if record is None:
                pnu, status = None, "NO_PARCEL_IDENTITY"
            elif record.get("resolution_status") == "PNU_EXACT" and record.get("pnu"):
                pnu, status = record["pnu"], "EXACT_PRIMARY_PARCEL"
            elif record.get("resolution_status") == "LOT_PARSE_FAILED":
                pnu, status = None, "PARCEL_AMBIGUOUS"
            else:
                pnu, status = None, "NO_PARCEL_IDENTITY"
        hub = hub_relation(pnu, hubs.get(complex_id)) if pnu else "NO_HUB"
        if pnu and hub == "HUB_CONFLICT":
            status = "PARCEL_AMBIGUOUS"
        if pnu and pnu[:2] != sido_code:
            status = "PARCEL_AMBIGUOUS"
            pnu = None
        resolved.append(
            {
                **row,
                "pnu": pnu,
                "resolution_status": status,
                "hub_relation": hub if pnu or hubs.get(complex_id) else "NO_HUB",
            }
        )
    return resolved


def classify_geometry(item: dict, points: dict[str, tuple[str, str]], conflicts: set[str]) -> dict:
    status = item["resolution_status"]
    pnu = item.get("pnu")
    sido_code = str(item.get("sido_code") or "")
    geometry = "NOT_JOINED"
    lat_text = lng_text = None
    if status != "EXACT_PRIMARY_PARCEL" or not pnu:
        geometry = "NOT_JOINED"
    elif pnu in conflicts:
        geometry = "DUPLICATE_PNU"
        status = "PARCEL_AMBIGUOUS"
    elif sido_code not in POINT_FILES:
        geometry = "SOURCE_UNAVAILABLE"
    elif pnu not in points:
        geometry = "PNU_NOT_FOUND"
    else:
        lat_text, lng_text = points[pnu]
        try:
            lat = float(lat_text)
            lng = float(lng_text)
        except ValueError:
            lat = lng = None
        if lat is None or not in_bbox(lat, lng, sido_code) or (lat == 0 and lng == 0):
            geometry = "BBOX_REJECT"
            lat_text = lng_text = None
        else:
            geometry = "MATCHED"
    hold_reason = None
    delta_m = None
    if item["complex_id"] == JAMSIL_ID and geometry == "MATCHED":
        delta_m = round(haversine_m(float(lat_text), float(lng_text), JAMSIL_REF[0], JAMSIL_REF[1]), 1)
        if pnu != JAMSIL_PNU or item["hub_relation"] != "HUB_AGREES" or delta_m > JAMSIL_HOLD_M:
            geometry = "IDENTITY_HOLD"
            hold_reason = "jamsil_parcel_identity"
            lat_text = lng_text = None
    safe = geometry == "MATCHED" and status == "EXACT_PRIMARY_PARCEL"
    return {
        "complex_id": item["complex_id"],
        "apt_name": item.get("apt_name"),
        "sido": item.get("sido"),
        "sido_code": sido_code,
        "pnu": pnu,
        "resolution_status": status,
        "geometry_status": geometry,
        "hub_relation": item.get("hub_relation"),
        "latitude_text": lat_text if safe else None,
        "longitude_text": lng_text if safe else None,
        "reference_delta_m": delta_m,
        "hold_reason": hold_reason,
        "safe": safe,
    }


def self_test() -> int:
    pnu, status = parse_single_jibun("11710", "10100", "19")
    assert pnu == JAMSIL_PNU and status == "EXACT_PRIMARY_PARCEL"
    pnu, status = parse_single_jibun("11650", "10700", "20-43")
    assert pnu == "1165010700100200043" and status == "EXACT_PRIMARY_PARCEL"
    pnu, status = parse_single_jibun("41135", "10500", "산69-1")
    assert pnu == "4113510500200690001" and status == "EXACT_PRIMARY_PARCEL"
    assert parse_single_jibun("11710", "10100", "19, 20")[1] == "PARCEL_AMBIGUOUS"
    assert parse_single_jibun("11710", "10100", "19 외 2")[1] == "PARCEL_AMBIGUOUS"
    assert parse_single_jibun("11710", "10100", "")[1] == "NO_PARCEL_IDENTITY"
    assert hub_relation(JAMSIL_PNU, "1171010100000190000") == "HUB_AGREES"
    assert hub_relation("1165010700100200043", "1165010700000200043") == "HUB_AGREES"
    assert hub_relation(JAMSIL_PNU, "1171010100000190001") == "HUB_CONFLICT"
    assert hub_relation("4113510500200690001", "4113510500000690001") == "HUB_CONFLICT"
    assert in_bbox(37.51413457, 127.07932524, "11")
    assert in_bbox(36.23177375, 128.56877726, "27")
    assert not in_bbox(128.56877726, 36.23177375, "27")
    print("self-test PASS")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--complexes", type=Path, default=CACHE / "no-coordinate-complexes.jsonl")
    parser.add_argument("--prior", type=Path, default=CACHE / "pnu-resolution.jsonl")
    parser.add_argument("--summary", type=Path, default=ROOT / "data/poc/living/parcel-recovery-summary.json")
    parser.add_argument("--safe", type=Path, default=CACHE / "parcel-coordinates-safe.jsonl")
    parser.add_argument("--materialize", type=Path, default=ROOT / "data/cache/living/new-complexes.jsonl")
    parser.add_argument("--skip-vworld", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()

    complexes = load_jsonl(args.complexes)
    prior = {}
    if args.prior.exists():
        for record in load_jsonl(args.prior):
            prior[record["complex_id"]] = record
    hubs = {
        "cx_ec9a204afeaadf1b": "1117012900004150000",
        "cx_e47102400fbc8ec6": "1117013100008100000",
        "cx_ba770c1e608ed88f": "1165010700000020012",
        "cx_1c244e7305d12c44": "1165010700000200043",
        "cx_0320fd9e007e1f8c": "1168010600003160000",
        "cx_adb7193c5c99abd6": "1168010600010270000",
        "cx_4c63d9a100973c60": "1171010100000190000",
        "cx_ed52bf895d064c11": "1171010200000170000",
        "cx_f39813c026bb2817": "1174010200006880000",
        "cx_d6b07e832d194cf9": "4113510500000910000",
    }
    # Prefer the live export when present next to the complexes file.
    hub_path = args.complexes.with_name("building-hub-parcels.json")
    if hub_path.exists():
        hubs = json.loads(hub_path.read_text(encoding="utf-8"))

    resolved = resolve(complexes, hubs, prior)
    needed: dict[str, set[str]] = {code: set() for code in POINT_FILES}
    for item in resolved:
        if item["resolution_status"] == "EXACT_PRIMARY_PARCEL" and item["pnu"] and item["sido_code"] in needed:
            needed[item["sido_code"]].add(item["pnu"])

    points: dict[str, dict[str, tuple[str, str]]] = {}
    conflict_pnus: set[str] = set()
    for code, pnus in needed.items():
        if not pnus:
            points[code] = {}
            continue
        if not POINT_FILES[code]["path"].exists():
            raise SystemExit(f"missing point file {POINT_FILES[code]['path']}")
        found, conflicts = lookup_points(code, pnus)
        points[code] = found
        conflict_pnus.update(conflicts)

    flat_points = {}
    for code, found in points.items():
        flat_points.update(found)

    classified = [
        classify_geometry(item, flat_points, conflict_pnus)
        for item in resolved
    ]
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    safe_rows = []
    for item in classified:
        if not item["safe"]:
            continue
        spec = POINT_FILES[item["sido_code"]]
        safe_rows.append(
            {
                "complex_id": item["complex_id"],
                "sido_code": item["sido_code"],
                "apt_name": item["apt_name"],
                "sido": item["sido"],
                "pnu": item["pnu"],
                "latitude_text": item["latitude_text"],
                "longitude_text": item["longitude_text"],
                "semantics": SEMANTICS,
                "resolution_status": item["resolution_status"],
                "coordinate_source": SOURCE_NAME,
                "source_object_id": item["pnu"],
                "source_version": spec["source_version"],
                "source_dataset": DATASET,
                "source_date": spec["source_date"],
                "generated_at": generated_at,
            }
        )

    api_attempts: list[dict] = []
    if not args.skip_vworld:
        probe_vworld(api_attempts)
    vworld_ok = any(str(item["status"]).startswith("2") for item in api_attempts)

    by_sido = {}
    for item in classified:
        bucket = by_sido.setdefault(
            item["sido_code"],
            {
                "sido": item["sido"],
                "no_coordinate_in": 0,
                "safe": 0,
                "resolution": Counter(),
                "geometry": Counter(),
            },
        )
        bucket["no_coordinate_in"] += 1
        bucket["resolution"][item["resolution_status"]] += 1
        bucket["geometry"][item["geometry_status"]] += 1
        if item["safe"]:
            bucket["safe"] += 1

    pilots = []
    by_id = {item["complex_id"]: item for item in classified}
    for complex_id, name in PILOTS:
        item = by_id.get(complex_id)
        pilots.append(
            {
                "complex_id": complex_id,
                "name": name,
                "pnu": None if item is None else item["pnu"],
                "resolution_status": None if item is None else item["resolution_status"],
                "geometry_status": None if item is None else item["geometry_status"],
                "hub_relation": None if item is None else item["hub_relation"],
                "latitude": None if item is None else item["latitude_text"],
                "longitude": None if item is None else item["longitude_text"],
                "reference_delta_m": None if item is None else item["reference_delta_m"],
                "safe": bool(item and item["safe"]),
            }
        )

    jamsil = by_id.get(JAMSIL_ID)
    summary = {
        "generated_at": generated_at,
        "semantics": SEMANTICS,
        "production_write": False,
        "input_no_coordinate": len(complexes),
        "recovered_safe": len(safe_rows),
        "remaining_no_coordinate": len(complexes) - len(safe_rows),
        "resolution_counts": dict(Counter(item["resolution_status"] for item in classified)),
        "geometry_counts": dict(Counter(item["geometry_status"] for item in classified)),
        "duplicate_pnu_conflicts": sorted(conflict_pnus),
        "point_files": {
            code: {
                "source_version": spec["source_version"],
                "needed": len(needed[code]),
                "matched": len(points[code]),
            }
            for code, spec in POINT_FILES.items()
        },
        "vworld": {
            "downloaded": vworld_ok,
            "attempts": api_attempts,
            "unavailable_sido_file_no": VWORLD_FILES,
            "note": "Representative-point files on disk cover Seoul, Busan, and Daegu only. Other sidos stay unwritten while the official SHP host is unreachable.",
        },
        "by_sido": {
            code: {
                "sido": bucket["sido"],
                "no_coordinate_in": bucket["no_coordinate_in"],
                "safe": bucket["safe"],
                "resolution": dict(bucket["resolution"]),
                "geometry": dict(bucket["geometry"]),
            }
            for code, bucket in sorted(by_sido.items())
        },
        "pilots": pilots,
        "jamsil_els": None
        if jamsil is None
        else {
            "pnu": jamsil["pnu"],
            "expected_pnu": JAMSIL_PNU,
            "latitude": jamsil["latitude_text"],
            "longitude": jamsil["longitude_text"],
            "reference": {"lat": JAMSIL_REF[0], "lng": JAMSIL_REF[1]},
            "reference_delta_m": jamsil["reference_delta_m"],
            "hub_relation": jamsil["hub_relation"],
            "resolution_status": jamsil["resolution_status"],
            "geometry_status": jamsil["geometry_status"],
            "safe": jamsil["safe"],
            "identity_note": (
                "Master jibun 19, 잠실동, and BUILDING_HUB_PARCEL lot 19 normalize to the same "
                "cadastral PNU. The reference pin is not the parcel representative point."
            ),
        },
    }

    args.safe.parent.mkdir(parents=True, exist_ok=True)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.materialize.parent.mkdir(parents=True, exist_ok=True)
    with args.safe.open("w", encoding="utf-8") as handle:
        for row in safe_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with args.materialize.open("w", encoding="utf-8") as handle:
        for row in safe_rows:
            handle.write(
                json.dumps(
                    {
                        "complex_id": row["complex_id"],
                        "apt_name": row["apt_name"],
                        "sido": row["sido"],
                        "sido_code": row["sido_code"],
                        "latitude": row["latitude_text"],
                        "longitude": row["longitude_text"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    checkpoint = CACHE / "coordinate-checkpoint.jsonl"
    with checkpoint.open("w", encoding="utf-8") as handle:
        for item in classified:
            handle.write(
                json.dumps(
                    {
                        "complex_id": item["complex_id"],
                        "pnu": item["pnu"],
                        "resolution_status": item["resolution_status"],
                        "geometry_status": item["geometry_status"],
                        "safe": item["safe"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "recovered_safe": len(safe_rows),
                "remaining": len(complexes) - len(safe_rows),
                "jamsil": summary["jamsil_els"],
                "vworld_ok": vworld_ok,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
