#!/usr/bin/env python3
"""VWorld AL_D002 sido SHP -> PARCEL_REPRESENTATIVE_POINT NULL-fill.

Completes the WAVE2 path that run-national-coordinate-backfill.py only probes:
download official sido SHP zips, take the representative point of the exact
PNU polygon, and reuse that runner's NULL-only writer, school handoff and
SEMAS living materializer. No geocoding, no guessed points, no overwrites.

  --probe      exit 0 when the official download endpoint returns a zip
  --dry-run    download/join and report fills without writing
  --commit     apply fills (requires a prior passing dry-run of the same plan)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
import time
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("runner", ROOT / "scripts/living/run-national-coordinate-backfill.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

WORK = ROOT / "data" / "cache" / "vworld-join"
SHP_DIR = ROOT / "data" / "cache" / "vworld" / "al_d002"
CHECKPOINT = WORK / "checkpoint.json"
PLAN = WORK / "plan.json"
FILLS = WORK / "fills.jsonl"
LOG = WORK / "join.log"
URL = "https://www.vworld.kr/dtmk/downloadResourceFile.do?ds_id=20171128DS00002&fileNo={}"
EXPECTED_HAS_PNU_MAX = 7_680


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(msg: str) -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    line = f"{now()} {msg}"
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    print(line, flush=True)


def probe() -> dict:
    request = urllib.request.Request(URL.format(runner.VWORLD_FILE_NO["11"]), headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            head = response.read(4)
            return {"ok": head[:2] == b"PK", "status": response.status,
                    "content_type": response.headers.get("Content-Type", ""), "magic": head.hex()}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"{type(error).__name__}: {error}"[:200]}


def download(code: str) -> Path:
    SHP_DIR.mkdir(parents=True, exist_ok=True)
    dest = SHP_DIR / f"AL_D002_{code}.zip"
    if dest.exists() and zipfile.is_zipfile(dest):
        return dest
    part = dest.with_suffix(".zip.part")
    request = urllib.request.Request(URL.format(runner.VWORLD_FILE_NO[code]), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=120) as response, part.open("wb") as out:
        shutil.copyfileobj(response, out, 1 << 20)
    if not zipfile.is_zipfile(part):
        raise RuntimeError(f"sido {code}: response is not a zip ({part.stat().st_size} bytes); login/terms may be required")
    part.replace(dest)
    return dest


def extract_shps(zip_path: Path, out_dir: Path) -> list[Path]:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(out_dir)
    for nested in list(out_dir.rglob("*.zip")):
        with zipfile.ZipFile(nested) as archive:
            archive.extractall(nested.parent / nested.stem)
    return sorted(out_dir.rglob("*.shp"))


def join_sido(code: str, needed: dict[str, list[dict]]) -> tuple[list[dict], dict]:
    import shapefile
    from pyproj import CRS, Transformer
    from shapely.geometry import shape

    zip_path = download(code)
    vintage = datetime.fromtimestamp(zip_path.stat().st_mtime, timezone.utc).strftime("%Y%m%d")
    tmp = WORK / f"extract-{code}"
    shps = extract_shps(zip_path, tmp)
    found: dict[str, tuple[str, str]] = {}
    stats = Counter()
    try:
        for shp in shps:
            prj = shp.with_suffix(".prj")
            crs = CRS.from_wkt(prj.read_text(errors="ignore")) if prj.exists() else CRS.from_user_input(runner.SOURCE_CRS)
            to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
            reader = shapefile.Reader(str(shp), encoding="cp949", encodingErrors="replace")
            names = [f[0].upper() for f in reader.fields[1:]]
            pnu_idx = names.index("PNU") if "PNU" in names else names.index("A1")
            for sr in reader.iterShapeRecords():
                stats["records"] += 1
                pnu = str(sr.record[pnu_idx]).strip()
                if pnu not in needed or pnu in found:
                    continue
                geom = shape(sr.shape.__geo_interface__)
                if geom.is_empty:
                    stats["empty_geometry"] += 1
                    continue
                point = geom.representative_point()
                lng, lat = to_wgs.transform(point.x, point.y)
                found[pnu] = (f"{lat:.7f}", f"{lng:.7f}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    fills = []
    for pnu, targets in needed.items():
        if pnu not in found:
            stats["pnu_not_in_shp"] += len(targets)
            continue
        lat, lng = found[pnu]
        for target in targets:
            if not runner.in_bbox(float(lat), float(lng), code):
                stats["out_of_sido_bbox"] += 1
                continue
            fills.append({**target, "latitude": lat, "longitude": lng, "source_version": vintage})
    stats["fills"] = len(fills)
    return fills, {"vintage": vintage, "shp_files": len(shps), **stats}


def build_targets() -> tuple[list[dict], Counter]:
    missing = runner.fetch_missing_from_turso()
    prior = runner.load_prior_pnu()
    targets, klass = [], Counter()
    for row in missing:
        if row.get("latitude") is not None or row.get("longitude") is not None:
            klass["PARTIAL_COORD_SKIPPED"] += 1
            continue
        code = str(row["sido_code"])
        record = prior.get(row["complex_id"])
        if record and record.get("resolution_status") == "PNU_EXACT" and record.get("pnu"):
            pnu, status = record["pnu"], "PRIOR_EXACT"
        else:
            pnu, status = runner.build_pnu(str(row.get("lawd_cd") or ""), str(row.get("bjdong_cd") or ""), str(row.get("jibun") or ""))
        if status == "AMBIGUOUS_JIBUN" or (record and record.get("resolution_status") == "LOT_PARSE_FAILED"):
            klass["AMBIGUOUS_PARCEL"] += 1
            continue
        if not pnu or pnu[:2] != code:
            klass["NO_PNU_IDENTITY_GAP"] += 1
            continue
        klass["HAS_PNU_NO_GEOMETRY"] += 1
        targets.append({"complex_id": row["complex_id"], "apt_name": row.get("apt_name"), "sido": row.get("sido"),
                        "sido_code": code, "pnu": pnu})
    return targets, klass


def load_cp() -> dict:
    if CHECKPOINT.exists():
        return json.loads(CHECKPOINT.read_text(encoding="utf-8"))
    return {"sidos": {}, "applied_ids": []}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--commit", action="store_true")
    parser.add_argument("--sido", action="append", help="limit to sido code(s)")
    args = parser.parse_args(argv)

    if args.probe:
        result = probe()
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1

    WORK.mkdir(parents=True, exist_ok=True)
    lock = runner.acquire_lock()
    try:
        targets, klass = build_targets()
        log(f"targets {dict(klass)}")
        if klass["HAS_PNU_NO_GEOMETRY"] > EXPECTED_HAS_PNU_MAX:
            raise SystemExit(f"ABORT: HAS_PNU_NO_GEOMETRY {klass['HAS_PNU_NO_GEOMETRY']} > {EXPECTED_HAS_PNU_MAX}")
        cp = load_cp()
        by_sido: dict[str, dict[str, list[dict]]] = {}
        for target in targets:
            by_sido.setdefault(target["sido_code"], {}).setdefault(target["pnu"], []).append(target)
        order = [c for c in runner.SIDO_ORDER if c in by_sido and (not args.sido or c in args.sido)]
        target_ids = {t["complex_id"] for t in targets}
        plan = {"at": now(), "classification": dict(klass), "sidos": {}, "fills": 0}
        all_fills: list[dict] = []
        for code in order:
            try:
                fills, stats = join_sido(code, by_sido[code])
            except Exception as error:  # noqa: BLE001
                log(f"sido {code} join failed: {type(error).__name__}: {error}")
                plan["sidos"][code] = {"error": str(error)[:300]}
                continue
            bad = [f for f in fills if f["complex_id"] not in target_ids]
            if bad:
                raise SystemExit(f"ABORT: {len(bad)} fills outside NULL-coordinate targets")
            plan["sidos"][code] = {"targets": sum(len(v) for v in by_sido[code].values()), **stats}
            log(f"sido {code} {plan['sidos'][code]}")
            all_fills.extend(fills)
            if args.commit and fills:
                for vintage in sorted({f["source_version"] for f in fills}):
                    runner.SOURCE_VERSION = vintage
                    batch = [f for f in fills if f["source_version"] == vintage]
                    applied = runner.apply_fills_direct(batch, now())
                    log(f"sido {code} applied {applied} of {len(batch)} (vintage {vintage})")
                runner.append_school_handoff(fills)
                cov = runner.coverage_snapshot()
                living = runner.materialize_living(fills, publication_count=int(cov.get("ready") or 0) + len(fills))
                log(f"sido {code} living {living}")
                cp["sidos"][code] = {"at": now(), "fills": len(fills), "applied": applied, "living": living.get("apply")}
                cp["applied_ids"].extend(f["complex_id"] for f in fills)
                CHECKPOINT.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
        plan["fills"] = len(all_fills)
        PLAN.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        with FILLS.open("w", encoding="utf-8") as handle:
            for row in all_fills:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        log(f"{'commit' if args.commit else 'dry-run'} done fills={len(all_fills)}")
        return 0
    finally:
        runner.release_lock(lock)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
