#!/usr/bin/env python3
"""
사장님 PC에서 실행: 이미 받아 둔 AL_D002 시·도 zip에서 대상 필지 대표점만 뽑는다.

준비 (한 번만):
    pip install pyshp shapely pyproj

실행 예 (Windows):
    python local-extract-residual-parcels.py ^
        --targets residual_parcel_targets_20260923.csv ^
        --zips C:\\data\\cadastre\\2026-09 ^
        --out national_parcel_representative_points_residual.csv.gz

--zips 폴더 안의 AL_D002_<시도코드>_*.zip 파일을 시·도별로 읽는다.
결과 2개(csv.gz, _summary.json)를 대화에 올리면 클라우드에서 NULL 좌표만 채운다.

규칙: PNU(A1) 정확 일치만, 좌표 = 필지 대표점(EPSG:5186 → EPSG:4326), 추정 좌표 없음.
"""
import argparse
import csv
import glob
import gzip
import hashlib
import tempfile
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timezone

import shapefile  # pyshp
from pyproj import CRS, Transformer
from shapely.geometry import shape


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_targets(path):
    by_sido = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            by_sido.setdefault(row["sido_code"], {})[row["pnu"]] = row["complex_id"]
    return by_sido


def open_shp(zf, tmpdir):
    names = zf.namelist()
    shp = next((n for n in names if n.lower().endswith(".shp")), None)
    if not shp:
        return None, None
    base = shp[:-4]
    part = lambda ext: next((n for n in names if n.lower() == (base + ext).lower()), None)
    # 디스크에 풀어서 읽는다 (큰 시·도는 수 GB라 메모리에 올리지 않음)
    for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
        name = part(ext)
        if name:
            zf.extract(name, tmpdir)
    reader = shapefile.Reader(os.path.join(tmpdir, base), encoding="cp949")
    prj = part(".prj")
    crs = (
        CRS.from_wkt(open(os.path.join(tmpdir, prj), encoding="utf-8", errors="ignore").read())
        if prj
        else CRS.from_epsg(5186)
    )
    return reader, crs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", required=True)
    ap.add_argument("--zips", required=True, help="AL_D002 zip 폴더")
    ap.add_argument("--out", default="national_parcel_representative_points_residual.csv.gz")
    args = ap.parse_args()

    targets = load_targets(args.targets)
    total_targets = sum(len(v) for v in targets.values())
    rows, regions = [], {}
    for sido, wanted in sorted(targets.items()):
        paths = sorted(glob.glob(os.path.join(args.zips, f"AL_D002_{sido}_*.zip")))
        if not paths:
            regions[sido] = {"status": "ZIP_MISSING", "targets": len(wanted)}
            print(f"[{sido}] zip 없음 — 건너뜀", file=sys.stderr)
            continue
        path = paths[-1]
        version = (re.search(r"_(\d{8})\.zip$", path) or [None, "unknown"])[1]
        started = time.time()
        found, invalid, scanned = 0, 0, 0
        with zipfile.ZipFile(path) as zf, tempfile.TemporaryDirectory() as tmpdir:
            reader, crs = open_shp(zf, tmpdir)
            if reader is None:
                regions[sido] = {"status": "NO_SHP", "archive": os.path.basename(path)}
                continue
            fields = [f[0] for f in reader.fields[1:]]
            pnu_idx = fields.index("A1") if "A1" in fields else fields.index("PNU")
            to_wgs = Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True)
            remaining = dict(wanted)
            for sr in reader.iterShapeRecords():
                scanned += 1
                pnu = str(sr.record[pnu_idx]).strip()
                cid = remaining.pop(pnu, None)
                if cid is None:
                    continue
                try:
                    geom = shape(sr.shape.__geo_interface__)
                    if geom.is_empty:
                        raise ValueError("empty")
                    pt = geom.representative_point()
                    lon, lat = to_wgs.transform(pt.x, pt.y)
                except Exception:
                    invalid += 1
                    continue
                rows.append([cid, pnu, f"{lat:.8f}", f"{lon:.8f}", sido, os.path.basename(path), version,
                             crs.to_string(), "PARCEL_REPRESENTATIVE_POINT", "EXACT_PNU"])
                found += 1
                if not remaining:
                    break
            reader.close()
        regions[sido] = {"status": "COMPLETE", "archive": os.path.basename(path), "source_version": version,
                         "targets": len(wanted), "found": found, "pnu_not_found": len(remaining),
                         "invalid_geometry": invalid, "features_scanned": scanned,
                         "runtime_seconds": round(time.time() - started, 1)}
        print(f"[{sido}] {found}/{len(wanted)} ({time.time() - started:.0f}s)", file=sys.stderr)

    with gzip.open(args.out, "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["complex_id", "pnu", "lat", "lon", "source_region", "source_filename", "source_version",
                    "source_crs", "coordinate_semantics", "resolution_status"])
        w.writerows(rows)
    summary = {
        "status": "READY_FOR_LIVING_CLOUD",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target_file": os.path.basename(args.targets),
        "target_sha256": sha256(args.targets),
        "target_pnus": total_targets,
        "representative_points": len(rows),
        "output_sha256": sha256(args.out),
        "regions": regions,
    }
    out_summary = re.sub(r"\.csv\.gz$", "", args.out) + "_summary.json"
    with open(out_summary, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"완료: {len(rows)}/{total_targets} → {args.out}, {out_summary}")


if __name__ == "__main__":
    main()
