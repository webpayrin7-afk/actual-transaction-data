"""Materialize national complex commerce snapshots from the SEMAS store zip.

National rollout of the 잠실엘스 commerce pilot (scripts/lib/commerce-semas-snapshot-transform.mjs).
Same population rule (daily_commerce_core_v1 / c1b_frozen_p2_v1), same bucket
mapping, same facility rules, same straight-line haversine (R=6,371,000m).

Output: a local SQLite file shaped like
src/lib/db/migrations/20260924_complex_commerce_snapshots.sql, plus a JSON report.
No network. No Production writes (see apply-commerce-snapshots.ts).

Usage:
  python scripts/commerce/materialize-complex-commerce.py \
    --zip data/semas/semas_store_20260630.zip \
    --centers data/semas/work/centers.json \
    --out-db data/semas/work/commerce_2026Q2.sqlite \
    --report data/poc/commerce/national-materialize-report.json
  python scripts/commerce/materialize-complex-commerce.py --self-test
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
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "src/lib/db/migrations/20260924_complex_commerce_snapshots.sql"
PILOT_POINTS = ROOT / "src/lib/complex-detail/jamsil-els-commerce-map-points.json"

SOURCE_VERSION = "SEMAS_2026Q2"
SNAPSHOT_VERSION = "commerce_v1"
SOURCE_AS_OF = "2026-06-30"
SOURCE_PROVIDER = "SEMAS"
SOURCE_DATASET = "소상공인시장진흥공단_상가(상권)정보"
POPULATION_VERSION = "daily_commerce_core_v1"
POPULATION_RULE_VERSION = "c1b_frozen_p2_v1"
DISTANCE_METRIC = "straight-line"
RADII = (500, 1000)
MAX_RADIUS = 1000
EARTH_R = 6371000.0

# Frozen P2 (C1B/C2) — identical to commerce-semas-snapshot-transform.mjs
P2_LCLS = {"I2", "G2", "Q1", "R1"}
P2_MCLS = {"P105", "P106"} | {f"S20{i}" for i in range(1, 10)}

# commerce_bucket_v1 — matches COMMERCE_CATEGORY_COLOR_KEYS + 기타
BUCKETS = ["음식/외식", "쇼핑/소매", "생활서비스", "교육", "여가/체육", "의료/건강", "기타"]
LCLS_TO_BUCKET = {"I2": 0, "G2": 1, "S2": 2, "P1": 3, "R1": 4, "Q1": 5}
# commerce_facility_v1 — matches COMMERCE_FACILITY_ORDER
FACILITIES = ["병원/의원", "약국", "편의점", "마트/슈퍼", "카페", "음식점", "미용", "학원", "체육"]

# Pilot 잠실엘스 (C4 center) for parity
PILOT_ID = "cx_4c63d9a100973c60"
PILOT_CENTER = (37.5133051, 127.0815962)
PILOT_EXPECTED = {
    "p0": 3562,
    "p2": 2745,
    "composition": [937, 660, 397, 318, 222, 211, 0],
    "facilities": [205, 51, 54, 35, 116, 821, 299, 282, 94],
}


def in_p2(l: str, m: str) -> bool:
    return l in P2_LCLS or m in P2_MCLS


def facility_mask(l: str, m: str, s: str, mn: str, sn: str) -> int:
    mask = 0
    if m in ("Q101", "Q102"):
        mask |= 1 << 0
    if s == "G21501":
        mask |= 1 << 1
    if s == "G20405":
        mask |= 1 << 2
    if s == "G20404":
        mask |= 1 << 3
    if s == "I21201":
        mask |= 1 << 4
    if l == "I2" and m != "I212":
        mask |= 1 << 5
    if m == "S207":
        mask |= 1 << 6
    if "학원" in (mn or "") or "학원" in (sn or ""):
        mask |= 1 << 7
    if m == "R103":
        mask |= 1 << 8
    return mask


def cell_key(lat100: int, lng100: int) -> int:
    return lat100 * 100000 + lng100


def query_cells(lat: float, lng: float, radius_m: float = MAX_RADIUS) -> list[int]:
    """Cells overlapping the radius bbox. Mirror of commerceQueryCells() in TS."""
    dlat = (radius_m + 5) / 110000.0
    dlng = (radius_m + 5) / (110000.0 * math.cos(math.radians(lat)))
    la0 = math.floor((lat - dlat) * 100)
    la1 = math.floor((lat + dlat) * 100)
    ln0 = math.floor((lng - dlng) * 100)
    ln1 = math.floor((lng + dlng) * 100)
    return [cell_key(a, b) for a in range(la0, la1 + 1) for b in range(ln0, ln1 + 1)]


def haversine_np(lat1, lng1, lat2, lng2):
    lat1r = math.radians(lat1)
    lat2r = np.radians(lat2)
    dlat = lat2r - lat1r
    dlng = np.radians(lng2) - math.radians(lng1)
    a = np.sin(dlat / 2) ** 2 + math.cos(lat1r) * np.cos(lat2r) * np.sin(dlng / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.minimum(1.0, np.sqrt(a)))


def valid_kr(lat: float, lng: float) -> bool:
    return 32.0 <= lat <= 39.5 and 123.5 <= lng <= 132.5


# ---------------------------------------------------------------- source ---

def stream_zip(zip_path: Path):
    ids_seen: set[str] = set()
    lat_l: list[float] = []
    lng_l: list[float] = []
    p2_l: list[bool] = []
    bucket_l: list[int] = []
    fac_l: list[int] = []
    stats = Counter()
    files = []
    with zipfile.ZipFile(zip_path) as zf:
        members = [i for i in zf.infolist() if i.filename.lower().endswith(".csv")]
        if not members:
            raise SystemExit(f"no CSV in {zip_path}")
        for info in members:
            files.append(info.filename)
            with zf.open(info) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                reader = csv.reader(text)
                header = next(reader)
                ix = {name: header.index(name) for name in (
                    "상가업소번호", "상권업종대분류코드", "상권업종중분류코드", "상권업종중분류명",
                    "상권업종소분류코드", "상권업종소분류명", "경도", "위도")}
                i_id, i_l, i_m, i_mn = ix["상가업소번호"], ix["상권업종대분류코드"], ix["상권업종중분류코드"], ix["상권업종중분류명"]
                i_s, i_sn, i_x, i_y = ix["상권업종소분류코드"], ix["상권업종소분류명"], ix["경도"], ix["위도"]
                for cols in reader:
                    if not cols:
                        continue
                    stats["rows"] += 1
                    try:
                        lat = float(cols[i_y])
                        lng = float(cols[i_x])
                    except (ValueError, IndexError):
                        stats["bad_coordinate"] += 1
                        continue
                    if not (math.isfinite(lat) and math.isfinite(lng)) or not valid_kr(lat, lng):
                        stats["bad_coordinate"] += 1
                        continue
                    sid = cols[i_id]
                    if sid in ids_seen:
                        stats["duplicate_id"] += 1
                        continue
                    ids_seen.add(sid)
                    l, m, s = cols[i_l], cols[i_m], cols[i_s]
                    p2 = in_p2(l, m)
                    lat_l.append(lat)
                    lng_l.append(lng)
                    p2_l.append(p2)
                    bucket_l.append(LCLS_TO_BUCKET.get(l, 6))
                    fac_l.append(facility_mask(l, m, s, cols[i_mn], cols[i_sn]))
                    stats["stores"] += 1
                    if p2:
                        stats["p2_stores"] += 1
            print(f"[source] {info.filename} cumulative rows={stats['rows']}", file=sys.stderr)
    # Quantize to 1e-6° (≈0.1m) BEFORE aggregating, so the stored point cells and the
    # stored counts use identical coordinates. Otherwise buildings holding many stores
    # sitting right on the radius edge flip in/out between aggregate and runtime decode.
    arr = {
        "lat": np.rint(np.asarray(lat_l, dtype=np.float64) * 1e6) / 1e6,
        "lng": np.rint(np.asarray(lng_l, dtype=np.float64) * 1e6) / 1e6,
        "p2": np.asarray(p2_l, dtype=bool),
        "bucket": np.asarray(bucket_l, dtype=np.int8),
        "fac": np.asarray(fac_l, dtype=np.int16),
    }
    return arr, dict(stats), files


def build_grid(arr):
    lat100 = np.floor(arr["lat"] * 100).astype(np.int64)
    lng100 = np.floor(arr["lng"] * 100).astype(np.int64)
    keys = lat100 * 100000 + lng100
    order = np.argsort(keys, kind="stable")
    for k in list(arr):
        arr[k] = arr[k][order]
    keys = keys[order]
    uniq, starts, counts = np.unique(keys, return_index=True, return_counts=True)
    grid = {int(k): (int(s), int(s + c)) for k, s, c in zip(uniq, starts, counts)}
    return grid


def candidate_index(grid, cells):
    parts = [np.arange(*grid[c]) for c in cells if c in grid]
    if not parts:
        return np.empty(0, dtype=np.int64)
    return np.concatenate(parts)


def aggregate(arr, grid, lat, lng):
    idx = candidate_index(grid, query_cells(lat, lng))
    out = {}
    if idx.size == 0:
        dist = np.empty(0)
    else:
        dist = haversine_np(lat, lng, arr["lat"][idx], arr["lng"][idx])
    for r in RADII:
        sel = idx[dist <= r] if idx.size else idx
        p2sel = sel[arr["p2"][sel]]
        comp = np.bincount(arr["bucket"][p2sel], minlength=7).tolist()
        fac = arr["fac"][sel]
        facilities = [int(((fac >> b) & 1).sum()) for b in range(len(FACILITIES))]
        out[r] = {
            "p0": int(sel.size),
            "p2": int(p2sel.size),
            "composition": [int(x) for x in comp],
            "facilities": facilities,
            "p2_index": p2sel,
        }
    return out


# ------------------------------------------------------------ point cells ---

def encode_cell(arr, grid, key):
    a, b = grid[key]
    lat100, lng100 = divmod(key, 100000)
    p2 = arr["p2"][a:b]
    lat = arr["lat"][a:b][p2]
    lng = arr["lng"][a:b][p2]
    bucket = arr["bucket"][a:b][p2].astype(np.int64)
    dlat = np.rint(lat * 1e6).astype(np.int64) - lat100 * 10000
    dlng = np.rint(lng * 1e6).astype(np.int64) - lng100 * 10000
    order = np.lexsort((bucket, dlng, dlat))
    flat = np.stack([dlat[order], dlng[order], bucket[order]], axis=1).reshape(-1)
    return int(order.size), "[" + ",".join(str(int(v)) for v in flat) + "]"


def decode_cell(key, payload):
    lat100, lng100 = divmod(key, 100000)
    vals = json.loads(payload)
    pts = []
    for i in range(0, len(vals), 3):
        pts.append(((lat100 * 10000 + vals[i]) / 1e6, (lng100 * 10000 + vals[i + 1]) / 1e6, vals[i + 2]))
    return pts


def js_round(x: float) -> int:
    # Math.round semantics (half toward +inf) to mirror the pilot fixture builder.
    return int(math.floor(x + 0.5))


def map_points_from_cells(cells_payload: dict, lat, lng, radius=MAX_RADIUS):
    """Mirror of the runtime decoder in src/lib/complex-detail/commerce-db.ts."""
    pts = []
    for key in query_cells(lat, lng):
        payload = cells_payload.get(key)
        if payload is None:
            continue
        for plat, plng, b in decode_cell(key, payload):
            pts.append((plat, plng, b))
    if not pts:
        return []
    a = np.asarray([p[0] for p in pts])
    o = np.asarray([p[1] for p in pts])
    d = haversine_np(lat, lng, a, o)
    m_lng = 111320.0 * math.cos(math.radians(lat))
    res = []
    for (plat, plng, b), dist in zip(pts, d):
        if dist <= radius:
            res.append((js_round((plng - lng) * m_lng), js_round((plat - lat) * 111320.0), b))
    return res


# ---------------------------------------------------------------- output ---

def write_db(db_path: Path, rows, cells, built_at, complex_count):
    if db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.executescript(MIGRATION.read_text(encoding="utf-8"))
    con.executemany(
        """INSERT INTO complex_commerce_snapshots (
            complex_id, radius_m, source_version, snapshot_version, population_version,
            population_rule_version, p0_total, p2_total, composition_json, facilities_json,
            center_lat, center_lng, coordinate_source, distance_metric, source_as_of, built_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    con.executemany(
        """INSERT INTO commerce_point_cells (
            source_version, snapshot_version, cell_key, point_count, points_json
        ) VALUES (?,?,?,?,?)""",
        cells,
    )
    con.execute(
        """INSERT INTO complex_commerce_publications (
            source_version, snapshot_version, population_version, population_rule_version,
            source_provider, source_dataset, source_as_of, is_current, built_at,
            complex_count, cell_count, note
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            SOURCE_VERSION, SNAPSHOT_VERSION, POPULATION_VERSION, POPULATION_RULE_VERSION,
            SOURCE_PROVIDER, SOURCE_DATASET, SOURCE_AS_OF, 1, built_at, complex_count, len(cells),
            "National rollout of the 잠실엘스 commerce pilot. Center = complex_map_anchor, else apt_complex_master.",
        ),
    )
    con.commit()
    con.execute("VACUUM")
    con.close()


def diff_vec(names, got, want):
    return {n: {"pipeline": g, "pilot": w, "diff": g - w} for n, g, w in zip(names, got, want)}


def parity(arr, grid, cells_payload, centers_by_id):
    res = {}
    lat, lng = PILOT_CENTER
    agg = aggregate(arr, grid, lat, lng)[1000]
    res["pilotCenter"] = {
        "center": {"lat": lat, "lng": lng, "source": "pilot C4 product_map_anchor_naver_geocode"},
        "p0": {"pipeline": agg["p0"], "pilot": PILOT_EXPECTED["p0"], "diff": agg["p0"] - PILOT_EXPECTED["p0"]},
        "p2": {"pipeline": agg["p2"], "pilot": PILOT_EXPECTED["p2"], "diff": agg["p2"] - PILOT_EXPECTED["p2"]},
        "composition": diff_vec(BUCKETS, agg["composition"], PILOT_EXPECTED["composition"]),
        "facilities": diff_vec(FACILITIES, agg["facilities"], PILOT_EXPECTED["facilities"]),
    }
    # Map points at the pilot center, decoded from stored cells (runtime path)
    fixture = json.loads(PILOT_POINTS.read_text(encoding="utf-8"))
    fx = Counter()
    off = fixture["offsetsM"]
    cat = fixture.get("categoryIdx") or []
    for i in range(fixture["pointCount"]):
        fx[(off[2 * i], off[2 * i + 1], cat[i] if cat else -1)] += 1
    pts = map_points_from_cells(cells_payload, lat, lng)
    got = Counter(pts)
    exact = sum((got & fx).values())
    # tolerate ±1m rounding at the same bucket
    loose_left = got - fx
    loose_right = fx - got
    near = 0
    rr = Counter(loose_right)
    for (x, y, b), n in loose_left.items():
        for _ in range(n):
            hit = None
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    k = (x + dx, y + dy, b)
                    if rr.get(k, 0) > 0:
                        hit = k
                        break
                if hit:
                    break
            if hit:
                rr[hit] -= 1
                near += 1
    res["pilotCenterMapPoints"] = {
        "pipelinePointCount": len(pts),
        "fixturePointCount": fixture["pointCount"],
        "exactMatch": exact,
        "withinOneMeterMatch": near,
        "unmatchedPipeline": len(pts) - exact - near,
        "unmatchedFixture": fixture["pointCount"] - exact - near,
    }
    c = centers_by_id.get(PILOT_ID)
    if c:
        a2 = aggregate(arr, grid, c["lat"], c["lng"])
        shift = float(haversine_np(lat, lng, np.asarray([c["lat"]]), np.asarray([c["lng"]]))[0])
        res["productionCenter"] = {
            "center": {"lat": c["lat"], "lng": c["lng"], "source": c["coordinate_source"]},
            "shiftFromPilotCenterM": round(shift, 1),
            "r1000": {
                "p0": a2[1000]["p0"], "p2": a2[1000]["p2"],
                "composition": diff_vec(BUCKETS, a2[1000]["composition"], PILOT_EXPECTED["composition"]),
                "facilities": diff_vec(FACILITIES, a2[1000]["facilities"], PILOT_EXPECTED["facilities"]),
            },
            "r500": {k: a2[500][k] for k in ("p0", "p2", "composition", "facilities")},
        }
    return res


def self_test():
    assert in_p2("I2", "I201") and in_p2("P1", "P106") and not in_p2("P1", "P101")
    assert in_p2("S2", "S207") and not in_p2("S2", "S210") and not in_p2("L1", "L102")
    assert facility_mask("Q1", "Q102", "Q10201", "의원", "내과") == 1
    assert facility_mask("I2", "I212", "I21201", "비알코올", "카페") == 1 << 4
    assert facility_mask("P1", "P106", "P10601", "기타 교육", "입시·교과학원") == 1 << 7
    k = query_cells(37.5133051, 127.0815962)
    assert cell_key(3751, 12708) in k and len(k) <= 16
    arr = {
        "lat": np.asarray([37.5133051, 37.5190, 37.5300]),
        "lng": np.asarray([127.0815962, 127.0815962, 127.0815962]),
        "p2": np.asarray([True, False, True]),
        "bucket": np.asarray([0, 6, 5], dtype=np.int8),
        "fac": np.asarray([1 << 5, 0, 1], dtype=np.int16),
    }
    grid = build_grid(arr)
    agg = aggregate(arr, grid, 37.5133051, 127.0815962)
    assert agg[500]["p0"] == 1 and agg[1000]["p0"] == 2 and agg[1000]["p2"] == 1
    assert agg[1000]["composition"][0] == 1 and agg[1000]["facilities"][5] == 1
    key = cell_key(3751, 12708)
    n, payload = encode_cell(arr, grid, key)
    back = decode_cell(key, payload)
    assert n == 1 and abs(back[0][0] - 37.5133051) < 1e-6 and back[0][2] == 0
    print("self-test ok")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", dest="zip_path")
    ap.add_argument("--centers")
    ap.add_argument("--out-db")
    ap.add_argument("--report")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        self_test()
        return
    if not (args.zip_path and args.centers and args.out_db and args.report):
        ap.error("--zip, --centers, --out-db, --report are required")

    t0 = time.time()
    arr, source_stats, files = stream_zip(Path(args.zip_path))
    t_src = time.time() - t0
    grid = build_grid(arr)

    centers_doc = json.loads(Path(args.centers).read_text(encoding="utf-8"))
    centers = centers_doc["centers"]
    centers_by_id = {c["complex_id"]: c for c in centers}
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    rows = []
    needed_cells: set[int] = set()
    invalid_center = []
    p2_1000 = []
    zero_p0_1000 = 0
    t1 = time.time()
    for n, c in enumerate(centers):
        lat, lng = float(c["lat"]), float(c["lng"])
        if not valid_kr(lat, lng):
            invalid_center.append(c["complex_id"])
            continue
        needed_cells.update(query_cells(lat, lng))
        agg = aggregate(arr, grid, lat, lng)
        for r in RADII:
            a = agg[r]
            rows.append((
                c["complex_id"], r, SOURCE_VERSION, SNAPSHOT_VERSION, POPULATION_VERSION,
                POPULATION_RULE_VERSION, a["p0"], a["p2"],
                json.dumps(a["composition"], separators=(",", ":")),
                json.dumps(a["facilities"], separators=(",", ":")),
                lat, lng, c["coordinate_source"], DISTANCE_METRIC, SOURCE_AS_OF, built_at,
            ))
        p2_1000.append(agg[1000]["p2"])
        if agg[1000]["p0"] == 0:
            zero_p0_1000 += 1
        if n and n % 5000 == 0:
            print(f"[aggregate] {n}/{len(centers)}", file=sys.stderr)
    t_agg = time.time() - t1

    cells = []
    cells_payload = {}
    points_total = 0
    payload_bytes = 0
    for key in sorted(needed_cells):
        if key not in grid:
            continue
        cnt, payload = encode_cell(arr, grid, key)
        if cnt == 0:
            continue
        cells.append((SOURCE_VERSION, SNAPSHOT_VERSION, key, cnt, payload))
        cells_payload[key] = payload
        points_total += cnt
        payload_bytes += len(payload.encode("utf-8"))

    complex_count = len(rows) // len(RADII)
    write_db(Path(args.out_db), rows, cells, built_at, complex_count)
    snap_bytes = sum(len(r[8]) + len(r[9]) + len(r[0]) + len(r[12]) + 120 for r in rows)

    p2s = sorted(p2_1000)
    q = lambda f: p2s[min(len(p2s) - 1, int(f * len(p2s)))] if p2s else 0
    report = {
        "builtAt": built_at,
        "source": {
            "dataset": SOURCE_DATASET, "version": SOURCE_VERSION, "asOf": SOURCE_AS_OF,
            "zip": Path(args.zip_path).name, "files": files, **source_stats,
            "p2StoresNational": int(arr["p2"].sum()),
        },
        "centers": {
            **centers_doc["counts"], "masterRows": centers_doc["masterRows"],
            "invalidCenter": len(invalid_center), "withSnapshot": complex_count,
        },
        "rows": {
            "complex_commerce_snapshots": len(rows),
            "commerce_point_cells": len(cells),
            "complex_commerce_publications": 1,
            "pointsInCells": points_total,
        },
        "sizeEstimateBytes": {
            "snapshots": snap_bytes,
            "pointCellsPayload": payload_bytes,
            "localSqliteFile": Path(args.out_db).stat().st_size,
        },
        "distributionP2r1000": {"min": q(0), "p25": q(0.25), "median": q(0.5), "p75": q(0.75), "p95": q(0.95), "max": p2s[-1] if p2s else 0},
        "zeroP0r1000": zero_p0_1000,
        "parity": parity(arr, grid, cells_payload, centers_by_id),
        "timingSec": {"source": round(t_src, 1), "aggregate": round(t_agg, 1), "total": round(time.time() - t0, 1)},
    }
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("rows", "sizeEstimateBytes", "centers")}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
