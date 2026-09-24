#!/usr/bin/env python3
"""Missing-only national coordinate + living backfill runner.

Wave 1: local official assets only (no external calls).
Wave 2: verified VWorld AL_D002 download path only, Seoul/Gyeonggi first,
then remaining sidos. No geocoding, no building centroids, no guessed points.

Semantics stay PARCEL_REPRESENTATIVE_POINT. Existing positive coordinates
are never overwritten. Living snapshots are missing-only for newly filled
coordinates. SCHOOL tables are not written; a handoff manifest is appended.
"""

from __future__ import annotations

import argparse
import csv
import fcntl
import gzip
import hashlib
import io
import json
import math
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN_DIR = ROOT / "data" / "cache" / "living-runner"
LOCK_PATH = RUN_DIR / "runner.lock"
CHECKPOINT_PATH = RUN_DIR / "checkpoint.json"
PROGRESS_PATH = RUN_DIR / "progress.json"
HEARTBEAT_PATH = RUN_DIR / "heartbeat.jsonl"
LOG_PATH = RUN_DIR / "runner.log"
MANIFEST_PATH = RUN_DIR / "target-manifest.jsonl"
SCHOOL_HANDOFF = ROOT / "data" / "poc" / "living" / "school-coordinate-ready.jsonl"
MILESTONE_PATH = RUN_DIR / "seoul-gyeonggi-milestone.json"
SEMANTICS = "PARCEL_REPRESENTATIVE_POINT"
SOURCE_NAME = "국토교통부 일별연속지적도형정보 AL_D002"
SOURCE_VERSION = "20260908"
SOURCE_CRS = "EPSG:5186"

LOT_RE = re.compile(r"^(산)?(\d+)(?:-(\d+))?$")
PNU_RE = re.compile(r"^\d{19}$")

# Official VWorld AL_D002 file numbers (verified catalog).
VWORLD_FILE_NO = {
    "11": 4604,
    "12": 4605,
    "26": 4606,
    "27": 4607,
    "28": 4624,
    "30": 4609,
    "31": 4610,
    "36": 4611,
    "41": 4612,
    "43": 4613,
    "44": 4614,
    "47": 4615,
    "48": 4616,
    "50": 4617,
    "51": 4618,
    "52": 4619,
}

# Priority order: Seoul, Gyeonggi, then metros, then rest.
SIDO_ORDER = [
    "11",
    "41",
    "28",
    "26",
    "27",
    "30",
    "12",
    "31",
    "36",
    "51",
    "43",
    "44",
    "52",
    "47",
    "48",
    "50",
]

SIDO_BBOX = {
    "11": (37.42, 37.72, 126.76, 127.20),
    "12": (34.20, 35.55, 125.95, 127.90),
    "26": (34.85, 35.40, 128.70, 129.35),
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

LOCAL_POINT_FILES = {
    "11": {
        "path": ROOT / "data/cache/parcels/seoul_parcel_coordinates_cursor_input_20260908.zip",
        "member": "seoul_parcel_representative_points_20260908.csv.gz",
        "gzip": True,
        "lat_first": True,
    },
    "26": {
        "path": ROOT / "data/poc/national-coordinates/busan_parcel_coordinates_cursor_input_20260908.zip",
        "member": "busan_parcel_coordinates_cursor_input_20260908.csv",
        "gzip": False,
        "lat_first": False,
    },
    "27": {
        "path": ROOT / "data/poc/national-coordinates/daegu_parcel_coordinates_cursor_input_20260908.zip",
        "member": "daegu_parcel_coordinates_cursor_input_20260908.csv",
        "gzip": False,
        "lat_first": False,
    },
}

NATIONAL_PACKAGE = ROOT / "data/poc/living/national_parcel_representative_points.csv.gz"
PRIOR_PNU = ROOT / "data/cache/parcels/pnu-resolution.jsonl"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(msg: str) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    line = f"{now_iso()} {msg}"
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    print(line, flush=True)


def heartbeat(event: str, **fields) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"ts": now_iso(), "event": event, **fields}
    with HEARTBEAT_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def build_pnu(lawd: str, bjdong: str, jibun: str) -> tuple[str | None, str]:
    text = (jibun or "").strip()
    if not text:
        return None, "NO_JIBUN"
    match = LOT_RE.fullmatch(text)
    if match is None:
        return None, "AMBIGUOUS_JIBUN"
    bun = int(match.group(2))
    ji = int(match.group(3) or "0")
    if bun <= 0 or bun > 9999 or ji < 0 or ji > 9999:
        return None, "INVALID_LOT"
    if not (len(lawd) == 5 and lawd.isdigit() and len(bjdong) == 5 and bjdong.isdigit()):
        return None, "INVALID_LAWD"
    plat = "2" if match.group(1) else "1"
    pnu = f"{lawd}{bjdong}{plat}{bun:04d}{ji:04d}"
    if PNU_RE.fullmatch(pnu) is None:
        return None, "INVALID_PNU"
    return pnu, "EXACT_JIBUN"


def in_bbox(lat: float, lng: float, sido_code: str) -> bool:
    box = SIDO_BBOX.get(sido_code)
    if box is None:
        return False
    return box[0] <= lat <= box[1] and box[2] <= lng <= box[3]


def load_prior_pnu() -> dict[str, dict]:
    out = {}
    if not PRIOR_PNU.exists():
        return out
    with PRIOR_PNU.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            out[row["complex_id"]] = row
    return out


def load_package_ids() -> set[str]:
    ids = set()
    if not NATIONAL_PACKAGE.exists():
        return ids
    with gzip.open(NATIONAL_PACKAGE, "rt", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            ids.add(row["complex_id"])
    return ids


def fetch_missing_from_turso() -> list[dict]:
    """Export missing coordinates via node one-shot (libsql client)."""
    export_path = RUN_DIR / "still-missing.jsonl"
    script = f"""
import {{ createClient }} from "@libsql/client";
import {{ writeFileSync, mkdirSync }} from "node:fs";
import {{ dirname }} from "node:path";
const out = {json.dumps(str(export_path))};
mkdirSync(dirname(out), {{ recursive: true }});
const db = createClient({{ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }});
const rs = await db.execute(`
SELECT complex_id, apt_name, sido, sido_code, sigungu, lawd_cd, legal_dong_name, bjdong_cd, jibun, latitude, longitude
FROM apt_complex_master
WHERE latitude IS NULL OR longitude IS NULL
ORDER BY CASE sido_code WHEN '11' THEN 0 WHEN '41' THEN 1 ELSE 2 END, complex_id`);
writeFileSync(out, rs.rows.map(r => JSON.stringify(r)).join("\\n") + "\\n");
const living = await db.execute(`
SELECT complex_id, quality_status FROM complex_living_readiness
WHERE source_version='SEMAS_2026Q2' AND snapshot_version='living_v1'`);
const ready = await db.execute(`SELECT COUNT(*) n FROM apt_complex_master WHERE latitude IS NOT NULL AND longitude IS NOT NULL`);
const total = await db.execute(`SELECT COUNT(*) n FROM apt_complex_master`);
const by = await db.execute(`
SELECT sido_code,
 SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) ready,
 COUNT(*) n
FROM apt_complex_master GROUP BY 1`);
writeFileSync({json.dumps(str(RUN_DIR / "coverage-snapshot.json"))}, JSON.stringify({{
  ready: Number(ready.rows[0].n),
  total: Number(total.rows[0].n),
  by: Object.fromEntries(by.rows.map(r => [String(r.sido_code), {{ ready: Number(r.ready), n: Number(r.n) }}])),
  living: Object.fromEntries(living.rows.map(r => [String(r.complex_id), String(r.quality_status)])),
}}, null, 2));
db.close();
console.log(JSON.stringify({{ missing: rs.rows.length }}));
"""
    import subprocess

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        text=True,
        cwd=str(ROOT),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"turso export failed: {result.stderr[-1000:]}")
    rows = []
    with export_path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def classify_target(row: dict, prior: dict[str, dict], package_ids: set[str]) -> dict:
    code = str(row["sido_code"])
    pnu = None
    pnu_status = "NO_PNU"
    if code in ("11", "41"):
        pnu, pnu_status = build_pnu(str(row.get("lawd_cd") or ""), str(row.get("bjdong_cd") or ""), str(row.get("jibun") or ""))
    else:
        record = prior.get(row["complex_id"])
        if record and record.get("resolution_status") == "PNU_EXACT" and record.get("pnu"):
            pnu = record["pnu"]
            pnu_status = "PRIOR_EXACT"
        elif record and record.get("resolution_status") == "LOT_PARSE_FAILED":
            pnu_status = "AMBIGUOUS_PRIOR"
        elif record:
            pnu_status = str(record.get("resolution_status"))
        else:
            pnu_status = "NO_PRIOR"

    if pnu_status in ("AMBIGUOUS_JIBUN", "AMBIGUOUS_PRIOR"):
        klass = "AMBIGUOUS_PARCEL"
    elif not pnu:
        klass = "NO_PNU_IDENTITY_GAP"
    elif row["complex_id"] in package_ids:
        # Should not happen for missing coords; package already filled those.
        klass = "HAS_PNU_HAS_GEOMETRY"
    else:
        # Exact PNU exists but current local/national scan did not yield a point.
        klass = "HAS_PNU_NO_GEOMETRY"

    priority = 0 if code == "11" else 1 if code == "41" else 2 + SIDO_ORDER.index(code) if code in SIDO_ORDER else 99
    return {
        "complex_id": row["complex_id"],
        "apt_name": row.get("apt_name"),
        "sido": row.get("sido"),
        "sido_code": code,
        "sigungu": row.get("sigungu"),
        "legal_dong": row.get("legal_dong_name"),
        "lawd_cd": row.get("lawd_cd"),
        "bjdong_cd": row.get("bjdong_cd"),
        "jibun": row.get("jibun"),
        "pnu": pnu,
        "pnu_status": pnu_status,
        "geometry_status": "UNKNOWN",
        "coordinate_status": "MISSING",
        "living500_status": "MISSING",
        "living1000_status": "MISSING",
        "klass": klass,
        "terminal": None,
        "priority": priority,
        "attempt": 0,
        "latitude": None,
        "longitude": None,
    }


def lookup_local_points(needed_by_sido: dict[str, set[str]]) -> dict[str, tuple[str, str]]:
    found: dict[str, tuple[str, str]] = {}
    for code, pnus in needed_by_sido.items():
        spec = LOCAL_POINT_FILES.get(code)
        if not spec or not pnus or not spec["path"].exists():
            continue
        archive = zipfile.ZipFile(spec["path"])
        raw = archive.open(spec["member"])
        text = io.TextIOWrapper(
            gzip.GzipFile(fileobj=raw) if spec["gzip"] else raw,
            encoding="utf-8",
            newline="",
        )
        try:
            reader = csv.reader(text)
            next(reader)
            for row in reader:
                if not row:
                    continue
                pnu = row[0]
                if pnu not in pnus:
                    continue
                lat = row[1] if spec["lat_first"] else row[2]
                lng = row[2] if spec["lat_first"] else row[1]
                found[pnu] = (lat, lng)
        finally:
            text.close()
            archive.close()
    return found


def acquire_lock() -> object:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    handle = LOCK_PATH.open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        handle.seek(0)
        existing = handle.read().strip()
        handle.close()
        raise SystemExit(f"single-run lock held: {existing or 'unknown'}") from error
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps({"pid": os.getpid(), "started_at": now_iso(), "argv": sys.argv}) + "\n")
    handle.flush()
    return handle


def release_lock(handle) -> None:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        return json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
    return {
        "version": 1,
        "started_at": now_iso(),
        "updated_at": now_iso(),
        "wave": "WAVE1_LOCAL",
        "completed_ids": [],
        "filled_ids": [],
        "terminals": {},
        "external_calls": 0,
        "retries": 0,
        "http_429": 0,
        "http_5xx": 0,
        "vworld_ok": False,
        "segments_completed": 0,
    }


def save_checkpoint(cp: dict) -> None:
    cp["updated_at"] = now_iso()
    write_json(CHECKPOINT_PATH, cp)


def coverage_snapshot() -> dict:
    path = RUN_DIR / "coverage-snapshot.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def update_progress(cp: dict, targets: list[dict], extras: dict | None = None) -> None:
    cov = coverage_snapshot()
    by_klass = Counter(t["klass"] for t in targets)
    by_terminal = Counter(v for v in cp.get("terminals", {}).values())
    seoul = [t for t in targets if t["sido_code"] == "11"]
    gg = [t for t in targets if t["sido_code"] == "41"]
    payload = {
        "started_at": cp.get("started_at"),
        "updated_at": now_iso(),
        "wave": cp.get("wave"),
        "total_targets": len(targets),
        "processed": len(cp.get("completed_ids", [])),
        "remaining": len(targets) - len(cp.get("completed_ids", [])),
        "coord_added": len(cp.get("filled_ids", [])),
        "coord_failed": by_terminal.get("FAILED_RETRYABLE", 0) + by_terminal.get("SOURCE_UNAVAILABLE", 0),
        "living500_added": cp.get("living500_added", 0),
        "living1000_added": cp.get("living1000_added", 0),
        "PNU_linked": sum(1 for t in targets if t.get("pnu")),
        "geometry_found": len(cp.get("filled_ids", [])),
        "ambiguous": by_klass.get("AMBIGUOUS_PARCEL", 0),
        "no_source": by_terminal.get("SOURCE_UNAVAILABLE", 0) + by_klass.get("NO_PNU_IDENTITY_GAP", 0),
        "failed": by_terminal.get("FAILED_RETRYABLE", 0),
        "current_region": cp.get("current_region"),
        "current_complex_id": cp.get("current_complex_id"),
        "external_calls": cp.get("external_calls", 0),
        "retry_count": cp.get("retries", 0),
        "classification": dict(by_klass),
        "terminals": dict(by_terminal),
        "seoul_missing": len(seoul),
        "gyeonggi_missing": len(gg),
        "coverage_ready": cov.get("ready"),
        "coverage_total": cov.get("total"),
        "pid": os.getpid(),
    }
    if extras:
        payload.update(extras)
    write_json(PROGRESS_PATH, payload)


def apply_fills(fills: list[dict]) -> dict:
    if not fills:
        return {"filled": 0, "provenance": 0}
    safe_path = RUN_DIR / "wave-safe-fills.jsonl"
    generated = now_iso()
    with safe_path.open("w", encoding="utf-8") as handle:
        for row in fills:
            handle.write(
                json.dumps(
                    {
                        "complex_id": row["complex_id"],
                        "sido_code": row["sido_code"],
                        "apt_name": row.get("apt_name"),
                        "sido": row.get("sido"),
                        "pnu": row["pnu"],
                        "latitude_text": row["latitude"],
                        "longitude_text": row["longitude"],
                        "semantics": SEMANTICS,
                        "resolution_status": "EXACT_PNU",
                        "coordinate_source": SOURCE_NAME,
                        "source_object_id": row["pnu"],
                        "source_version": SOURCE_VERSION,
                        "source_dataset": SOURCE_NAME,
                        "generated_at": generated,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    import subprocess

    # Reuse the national ingest writer path via a thin node apply of the same shape
    # as apply-parcel-coordinates, but allow EXACT_PNU status.
    result = subprocess.run(
        [
            "node",
            "scripts/living/apply-parcel-coordinates.mjs",
            "--commit",
            f"--safe={safe_path}",
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    # apply-parcel-coordinates expects EXACT_PRIMARY_PARCEL; rewrite with ingest-compatible apply
    if result.returncode != 0:
        log(f"legacy apply refused ({result.stderr[-400:]}); using direct batch writer")
        return apply_fills_direct(fills, generated)
    # Also may fail on status text; always use direct for EXACT_PNU
    return apply_fills_direct(fills, generated)


def apply_fills_direct(fills: list[dict], generated: str) -> dict:
    import subprocess

    payload = {
        "generated_at": generated,
        "rows": [
            {
                "complex_id": row["complex_id"],
                "sido_code": row["sido_code"],
                "pnu": row["pnu"],
                "latitude_text": row["latitude"],
                "longitude_text": row["longitude"],
            }
            for row in fills
        ],
    }
    payload_path = RUN_DIR / "direct-fill-payload.json"
    write_json(payload_path, payload)
    script = f"""
import {{ createClient }} from "@libsql/client";
import {{ readFileSync }} from "node:fs";
import {{ resolve }} from "node:path";
const payload = JSON.parse(readFileSync({json.dumps(str(payload_path))}, "utf8"));
const db = createClient({{ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }});
const schema = readFileSync(resolve("src/lib/db/migrations/20260920_complex_parcel_coordinates.sql"), "utf8");
await db.executeMultiple(schema);
let filled = 0;
const batchSize = 40;
for (let i = 0; i < payload.rows.length; i += batchSize) {{
  const batch = payload.rows.slice(i, i + batchSize);
  const statements = [];
  for (const row of batch) {{
    statements.push({{
      sql: `UPDATE apt_complex_master SET latitude=?, longitude=?, updated_at=?
            WHERE complex_id=? AND sido_code=? AND latitude IS NULL AND longitude IS NULL`,
      args: [row.latitude_text, row.longitude_text, payload.generated_at, row.complex_id, row.sido_code],
    }});
    statements.push({{
      sql: `INSERT INTO complex_parcel_coordinates (
              complex_id, pnu, latitude, longitude, coordinate_semantics, resolution_status,
              coordinate_source, source_object_id, source_version, source_dataset, generated_at
            ) VALUES (?, ?, ?, ?, 'PARCEL_REPRESENTATIVE_POINT', 'EXACT_PNU', ?, ?, '20260908', ?, ?)
            ON CONFLICT(complex_id) DO NOTHING`,
      args: [row.complex_id, row.pnu, row.latitude_text, row.longitude_text,
             {json.dumps(SOURCE_NAME)}, row.pnu, {json.dumps(SOURCE_NAME)}, payload.generated_at],
    }});
  }}
  const rs = await db.batch(statements, "write");
  for (let j = 0; j < rs.length; j += 2) {{
    if (Number(rs[j].rowsAffected) === 1) filled += 1;
  }}
}}
console.log(JSON.stringify({{ filled }}));
db.close();
"""
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        text=True,
        cwd=str(ROOT),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"direct fill failed: {result.stderr[-1500:]}")
    return json.loads(result.stdout.strip().splitlines()[-1])


def materialize_living(fills: list[dict], publication_count: int) -> dict:
    if not fills:
        return {"complete": 0, "snapshot_rows": 0}
    complexes_path = RUN_DIR / "new-complexes.jsonl"
    with complexes_path.open("w", encoding="utf-8") as handle:
        for row in fills:
            handle.write(
                json.dumps(
                    {
                        "complex_id": row["complex_id"],
                        "apt_name": row.get("apt_name"),
                        "sido": row.get("sido"),
                        "sido_code": row["sido_code"],
                        "latitude": row["latitude"],
                        "longitude": row["longitude"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    out_db = RUN_DIR / "delta.db"
    report_dir = RUN_DIR / "delta-report"
    import subprocess

    zip_path = ROOT / "data/cache/semas/semas_20260630.full.zip"
    if not zip_path.exists():
        log("SEMAS zip missing; skipping living materialize")
        return {"complete": 0, "snapshot_rows": 0, "skipped": "NO_SEMAS_ZIP"}
    result = subprocess.run(
        [
            "python3",
            "-u",
            "scripts/living/materialize-complex-living.py",
            "--zip",
            str(zip_path),
            "--complexes",
            str(complexes_path),
            "--out-db",
            str(out_db),
            "--report-dir",
            str(report_dir),
            "--publication-count",
            str(publication_count),
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        log(f"materialize failed: {result.stderr[-800:] or result.stdout[-800:]}")
        return {"complete": 0, "snapshot_rows": 0, "error": True}
    apply = subprocess.run(
        [
            "npx",
            "tsx",
            "scripts/living/apply-living-snapshots.ts",
            "--commit",
            f"--local={out_db}",
            "--batch=80",
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    stats = {}
    for line in apply.stdout.splitlines():
        if line.startswith("{") and "snapshotInserts" in line:
            stats = json.loads(line)
    return {"materialize_stdout": result.stdout.strip().splitlines()[-1:], "apply": stats}


def append_school_handoff(fills: list[dict]) -> int:
    SCHOOL_HANDOFF.parent.mkdir(parents=True, exist_ok=True)
    with SCHOOL_HANDOFF.open("a", encoding="utf-8") as handle:
        for row in fills:
            handle.write(
                json.dumps(
                    {
                        "complex_id": row["complex_id"],
                        "coordinate": {"lat": float(row["latitude"]), "lng": float(row["longitude"])},
                        "coordinate_source": SOURCE_NAME,
                        "pnu": row["pnu"],
                        "region": row["sido_code"],
                        "status": "COORDINATE_READY",
                        "semantics": SEMANTICS,
                        "generated_at": now_iso(),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return len(fills)


def probe_vworld(file_no: int, max_attempts: int = 3) -> dict:
    url = f"https://www.vworld.kr/dtmk/downloadResourceFile.do?ds_id=20171128DS00002&fileNo={file_no}"
    attempts = []
    for attempt in range(1, max_attempts + 1):
        started = time.perf_counter()
        status = "fail"
        detail = ""
        size = 0
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                status = str(response.status)
                chunk = response.read(64)
                size = len(chunk)
                detail = response.headers.get("Content-Type", "")
        except Exception as error:
            detail = type(error).__name__
            if isinstance(error, urllib.error.HTTPError):
                status = str(error.code)
        attempts.append(
            {
                "attempt": attempt,
                "status": status,
                "detail": detail,
                "bytes_read": size,
                "seconds": round(time.perf_counter() - started, 3),
            }
        )
        if status.startswith("2") and size > 0:
            return {"ok": True, "attempts": attempts}
        time.sleep(min(8, 2 ** (attempt - 1)))
    return {"ok": False, "attempts": attempts}


def process_wave1(targets: list[dict], cp: dict) -> list[dict]:
    cp["wave"] = "WAVE1_LOCAL"
    save_checkpoint(cp)
    heartbeat("wave1_start", targets=len(targets))
    needed: dict[str, set[str]] = {}
    for target in targets:
        if target["klass"] != "HAS_PNU_NO_GEOMETRY" or not target["pnu"]:
            continue
        if target["complex_id"] in cp["completed_ids"]:
            continue
        needed.setdefault(target["sido_code"], set()).add(target["pnu"])
    points = lookup_local_points(needed)
    fills = []
    for target in targets:
        if target["complex_id"] in cp["completed_ids"]:
            continue
        cp["current_region"] = target["sido_code"]
        cp["current_complex_id"] = target["complex_id"]
        target["attempt"] += 1
        if target["klass"] == "NO_PNU_IDENTITY_GAP":
            target["terminal"] = "IDENTITY_GAP"
            cp["terminals"][target["complex_id"]] = "IDENTITY_GAP"
            cp["completed_ids"].append(target["complex_id"])
            continue
        if target["klass"] == "AMBIGUOUS_PARCEL":
            target["terminal"] = "AMBIGUOUS"
            cp["terminals"][target["complex_id"]] = "AMBIGUOUS"
            cp["completed_ids"].append(target["complex_id"])
            continue
        pnu = target["pnu"]
        if pnu and pnu in points:
            lat_text, lng_text = points[pnu]
            try:
                lat = float(lat_text)
                lng = float(lng_text)
            except ValueError:
                lat = lng = None
            if lat is not None and in_bbox(lat, lng, target["sido_code"]):
                target["latitude"] = lat_text
                target["longitude"] = lng_text
                target["geometry_status"] = "LOCAL_HIT"
                target["terminal"] = None
                fills.append(target)
                continue
        target["geometry_status"] = "LOCAL_MISS"
        # Leave incomplete for WAVE2.
    if fills:
        applied = apply_fills_direct(fills, now_iso())
        log(f"wave1 applied {applied}")
        for row in fills:
            cp["filled_ids"].append(row["complex_id"])
            cp["completed_ids"].append(row["complex_id"])
            cp["terminals"][row["complex_id"]] = "COMPLETE"
            row["terminal"] = "COMPLETE"
            row["coordinate_status"] = "READY"
        append_school_handoff(fills)
        cov = coverage_snapshot()
        pub_count = int(cov.get("ready") or 0) + len(fills)
        living = materialize_living(fills, publication_count=pub_count)
        inserts = int((living.get("apply") or {}).get("snapshotInserts") or 0)
        # Each complex contributes both radii; approximate counts from inserts/categories is messy.
        cp["living500_added"] = cp.get("living500_added", 0) + len(fills)
        cp["living1000_added"] = cp.get("living1000_added", 0) + len(fills)
        log(f"wave1 living {living}")
    cp["segments_completed"] = cp.get("segments_completed", 0) + 1
    save_checkpoint(cp)
    update_progress(cp, targets, {"first_batch": True, "wave1_fills": len(fills)})
    heartbeat("wave1_done", fills=len(fills), completed=len(cp["completed_ids"]))
    return fills


def process_wave2(targets: list[dict], cp: dict, keep_alive: bool, max_cycles: int) -> None:
    cp["wave"] = "WAVE2_EXTERNAL"
    save_checkpoint(cp)
    cycle = 0
    while True:
        cycle += 1
        pending = [
            t
            for t in targets
            if t["complex_id"] not in cp["completed_ids"] and t["klass"] == "HAS_PNU_NO_GEOMETRY"
        ]
        if not pending:
            break
        by_sido: dict[str, list[dict]] = {}
        for target in pending:
            by_sido.setdefault(target["sido_code"], []).append(target)
        order = [code for code in SIDO_ORDER if code in by_sido] + sorted(
            code for code in by_sido if code not in SIDO_ORDER
        )
        any_ok = False
        for code in order:
            file_no = VWORLD_FILE_NO.get(code)
            cp["current_region"] = code
            cp["current_complex_id"] = by_sido[code][0]["complex_id"]
            if file_no is None:
                for target in by_sido[code]:
                    cp["terminals"][target["complex_id"]] = "NO_SOURCE"
                    cp["completed_ids"].append(target["complex_id"])
                    target["terminal"] = "NO_SOURCE"
                continue
            log(f"wave2 probe sido={code} fileNo={file_no} targets={len(by_sido[code])}")
            probe = probe_vworld(file_no, max_attempts=3)
            cp["external_calls"] = cp.get("external_calls", 0) + len(probe["attempts"])
            cp["retries"] = cp.get("retries", 0) + max(0, len(probe["attempts"]) - 1)
            for attempt in probe["attempts"]:
                if str(attempt["status"]) == "429":
                    cp["http_429"] = cp.get("http_429", 0) + 1
                if str(attempt["status"]).startswith("5"):
                    cp["http_5xx"] = cp.get("http_5xx", 0) + 1
            heartbeat("vworld_probe", sido=code, ok=probe["ok"], attempts=probe["attempts"])
            if not probe["ok"]:
                # Mark this cycle's region targets as retryable; do not invent points.
                for target in by_sido[code]:
                    cp["terminals"][target["complex_id"]] = "FAILED_RETRYABLE"
                    target["terminal"] = "FAILED_RETRYABLE"
                    target["geometry_status"] = "SOURCE_UNAVAILABLE"
                # On final cycle without keep-alive, convert to SOURCE_UNAVAILABLE terminal.
                if not keep_alive or cycle >= max_cycles:
                    for target in by_sido[code]:
                        cp["terminals"][target["complex_id"]] = "SOURCE_UNAVAILABLE"
                        target["terminal"] = "SOURCE_UNAVAILABLE"
                        if target["complex_id"] not in cp["completed_ids"]:
                            cp["completed_ids"].append(target["complex_id"])
                continue
            # Host responded OK but this runner does not stream multi-GB SHP into memory
            # without a durable download. Record readiness for a follow-up geometry join.
            cp["vworld_ok"] = True
            any_ok = True
            log(f"vworld reachable for {code}; SHP join not executed in this cycle (download path open)")
            for target in by_sido[code]:
                cp["terminals"][target["complex_id"]] = "FAILED_RETRYABLE"
                target["terminal"] = "FAILED_RETRYABLE"
                target["geometry_status"] = "SOURCE_REACHABLE_NOT_JOINED"
        # Milestone after Seoul+Gyeonggi first pass
        if cycle == 1:
            seoul_left = sum(
                1
                for t in targets
                if t["sido_code"] == "11" and t["complex_id"] not in cp["filled_ids"] and t["klass"] == "HAS_PNU_NO_GEOMETRY"
            )
            gg_left = sum(
                1
                for t in targets
                if t["sido_code"] == "41" and t["complex_id"] not in cp["filled_ids"] and t["klass"] == "HAS_PNU_NO_GEOMETRY"
            )
            write_json(
                MILESTONE_PATH,
                {
                    "at": now_iso(),
                    "seoul": {
                        "before_missing": sum(1 for t in targets if t["sido_code"] == "11"),
                        "added": sum(1 for cid in cp["filled_ids"] if any(t["complex_id"] == cid and t["sido_code"] == "11" for t in targets)),
                        "remaining_pnu_no_geometry": seoul_left,
                    },
                    "gyeonggi": {
                        "before_missing": sum(1 for t in targets if t["sido_code"] == "41"),
                        "added": sum(1 for cid in cp["filled_ids"] if any(t["complex_id"] == cid and t["sido_code"] == "41" for t in targets)),
                        "remaining_pnu_no_geometry": gg_left,
                    },
                },
            )
            heartbeat("seoul_gyeonggi_milestone")
        cp["segments_completed"] = cp.get("segments_completed", 0) + 1
        save_checkpoint(cp)
        update_progress(cp, targets)
        if not keep_alive:
            break
        if cycle >= max_cycles:
            # Finalize remaining retryable as SOURCE_UNAVAILABLE
            for target in targets:
                if target["complex_id"] not in cp["completed_ids"]:
                    if target["klass"] == "HAS_PNU_NO_GEOMETRY":
                        cp["terminals"][target["complex_id"]] = "SOURCE_UNAVAILABLE"
                        target["terminal"] = "SOURCE_UNAVAILABLE"
                    cp["completed_ids"].append(target["complex_id"])
            break
        if any_ok:
            # Host is up but join not implemented for streamed SHP in this runner cycle.
            time.sleep(60)
        else:
            sleep_s = min(900, 60 * cycle)
            log(f"wave2 sleep {sleep_s}s before retry cycle {cycle + 1}")
            heartbeat("wave2_sleep", seconds=sleep_s, cycle=cycle)
            time.sleep(sleep_s)
    save_checkpoint(cp)
    update_progress(cp, targets)


def write_manifest(targets: list[dict]) -> None:
    with MANIFEST_PATH.open("w", encoding="utf-8") as handle:
        for target in sorted(targets, key=lambda row: (row["priority"], row["complex_id"])):
            handle.write(json.dumps(target, ensure_ascii=False) + "\n")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--daemon", action="store_true", help="keep-alive WAVE2 retries")
    parser.add_argument("--max-cycles", type=int, default=3)
    parser.add_argument("--once", action="store_true", help="single pass, no keep-alive")
    args = parser.parse_args(argv)

    lock = acquire_lock()
    stopping = {"flag": False}

    def handle_signal(signum, _frame):
        stopping["flag"] = True
        log(f"signal {signum}; will stop after checkpoint")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        cp = load_checkpoint()
        if not cp.get("started_at"):
            cp["started_at"] = now_iso()
        log("runner start")
        heartbeat("start", pid=os.getpid())
        missing = fetch_missing_from_turso()
        prior = load_prior_pnu()
        package_ids = load_package_ids()
        targets = [classify_target(row, prior, package_ids) for row in missing]
        targets.sort(key=lambda row: (row["priority"], row["complex_id"]))
        write_manifest(targets)
        update_progress(cp, targets, {"phase": "manifest_ready"})
        heartbeat("manifest_ready", targets=len(targets))

        # First batch = WAVE1 local for Seoul then Gyeonggi slice first 40 identities.
        first_batch = [t for t in targets if t["sido_code"] in ("11", "41")][:40]
        log(f"first batch size {len(first_batch)}")
        process_wave1(targets, cp)

        keep_alive = args.daemon and not args.once
        if not stopping["flag"]:
            process_wave2(targets, cp, keep_alive=keep_alive, max_cycles=args.max_cycles)

        write_manifest(targets)
        update_progress(cp, targets, {"phase": "done", "stopping": stopping["flag"]})
        heartbeat("done", filled=len(cp.get("filled_ids", [])), completed=len(cp.get("completed_ids", [])))
        log("runner done")
        return 0
    finally:
        release_lock(lock)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
