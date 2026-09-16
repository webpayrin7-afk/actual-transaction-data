#!/usr/bin/env python3
"""Phase 5.9b — Seoul missing-only gate-input acquisition (no Production writes).

SOT:
  - Phase 5.8 summary/manifests (universe size, prior HOLD)
  - Phase 5.9 acquisition-report (prior gate-input diagnosis)
  - Phase 5.11 parcel_exact_eligible.json (~15k deterministic parcel map)
  - Turso apt_complex_master (Seoul IDENTITY-READY parcel fields)
  - scripts/poc_phase4_readiness_gate.py (BldRgstHub fetch/cache)

Rules:
  - Seoul-only (~8774). No new full candidate rediscovery.
  - No full-history trade rescan.
  - Cache-first, missing-only, chunked, checkpoint/resume.
  - Bounded concurrency (serial pages; optional low workers across complexes).
  - Production unit-master writes: never.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import random
import sqlite3
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase59b"
CACHE_DIR = OUT / "bld-expos-cache"
DB_PATH = OUT / "seoul_gate_inputs.sqlite"
UNIVERSE_PATH = OUT / "seoul_universe.json"
PARCEL_MAP_PATH = OUT / "seoul_parcel_map.json"
INVENTORY_PATH = OUT / "missing_inventory.json"
PROGRESS_PATH = OUT / "acquisition_progress.json"
FAILED_PATH = OUT / "failed_targets.jsonl"
PAGE_SIZE = 100
DEFAULT_SLEEP = 0.35
MAX_RETRIES = 8
PAGE_TIMEOUT_SEC = 45
MAX_PAGE_BACKOFF_SEC = 20.0
MAX_WORKERS = 4

# Process-wide HTTP metrics + in-flight request-key dedupe (thread-safe).
_HTTP = {
    "requests": 0,
    "latencies_ms": [],  # capped
    "http_429": 0,
    "http_5xx": 0,
    "timeout": 0,
    "retry": 0,
    "other_err": 0,
}
_HTTP_LOCK = threading.Lock()
_INFLIGHT: dict[tuple[str, str, str, str], threading.Event] = {}
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT_RESULT: dict[tuple[str, str, str, str], Path] = {}
_ADAPTIVE = {"sleep_mult": 1.0, "recent_errors": 0, "recent_ok": 0}
_ADAPTIVE_LOCK = threading.Lock()


def _http_note(kind: str, latency_ms: float | None = None) -> None:
    with _HTTP_LOCK:
        if kind == "ok":
            _HTTP["requests"] += 1
            if latency_ms is not None:
                _HTTP["latencies_ms"].append(latency_ms)
                if len(_HTTP["latencies_ms"]) > 5000:
                    _HTTP["latencies_ms"] = _HTTP["latencies_ms"][-2500:]
        elif kind == "429":
            _HTTP["http_429"] += 1
            _HTTP["retry"] += 1
        elif kind == "5xx":
            _HTTP["http_5xx"] += 1
            _HTTP["retry"] += 1
        elif kind == "timeout":
            _HTTP["timeout"] += 1
            _HTTP["retry"] += 1
        else:
            _HTTP["other_err"] += 1
            _HTTP["retry"] += 1


def _adaptive_on_result(ok: bool) -> None:
    with _ADAPTIVE_LOCK:
        if ok:
            _ADAPTIVE["recent_ok"] += 1
        else:
            _ADAPTIVE["recent_errors"] += 1
        total = _ADAPTIVE["recent_ok"] + _ADAPTIVE["recent_errors"]
        if total >= 40:
            err_rate = _ADAPTIVE["recent_errors"] / total
            if err_rate >= 0.15:
                _ADAPTIVE["sleep_mult"] = min(3.0, _ADAPTIVE["sleep_mult"] * 1.5)
            elif err_rate <= 0.03 and _ADAPTIVE["sleep_mult"] > 1.0:
                # stabilize: do not aggressively ramp back up
                _ADAPTIVE["sleep_mult"] = max(1.0, _ADAPTIVE["sleep_mult"] * 0.9)
            _ADAPTIVE["recent_ok"] = 0
            _ADAPTIVE["recent_errors"] = 0


def http_metrics_snapshot() -> dict[str, Any]:
    with _HTTP_LOCK:
        lats = list(_HTTP["latencies_ms"])
        snap = {
            "requests": _HTTP["requests"],
            "http_429": _HTTP["http_429"],
            "http_5xx": _HTTP["http_5xx"],
            "timeout": _HTTP["timeout"],
            "retry": _HTTP["retry"],
            "other_err": _HTTP["other_err"],
        }
    if lats:
        lats_sorted = sorted(lats)
        n = len(lats_sorted)
        snap["median_latency_ms"] = round(lats_sorted[n // 2], 1)
        snap["p95_latency_ms"] = round(lats_sorted[min(n - 1, int(n * 0.95))], 1)
    else:
        snap["median_latency_ms"] = None
        snap["p95_latency_ms"] = None
    with _ADAPTIVE_LOCK:
        snap["adaptive_sleep_mult"] = round(_ADAPTIVE["sleep_mult"], 3)
    return snap


def reset_http_metrics() -> None:
    with _HTTP_LOCK:
        _HTTP["requests"] = 0
        _HTTP["latencies_ms"] = []
        _HTTP["http_429"] = 0
        _HTTP["http_5xx"] = 0
        _HTTP["timeout"] = 0
        _HTTP["retry"] = 0
        _HTTP["other_err"] = 0
    with _ADAPTIVE_LOCK:
        _ADAPTIVE["sleep_mult"] = 1.0
        _ADAPTIVE["recent_ok"] = 0
        _ADAPTIVE["recent_errors"] = 0


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_gate():
    path = ROOT / "scripts" / "poc_phase4_readiness_gate.py"
    spec = importlib.util.spec_from_file_location("phase4_gate", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_jibun(jibun: str | None) -> tuple[str | None, str | None]:
    if not jibun:
        return None, None
    j = str(jibun).strip().replace("산", "")
    if "-" in j:
        a, b = j.split("-", 1)
    else:
        a, b = j, "0"
    bun = "".join(c for c in a if c.isdigit())
    ji = "".join(c for c in b if c.isdigit()) or "0"
    if not bun:
        return None, None
    return bun.zfill(4), ji.zfill(4)


def service_key() -> str:
    key = (
        os.environ.get("MOLIT_API_KEY")
        or os.environ.get("DATA_GO_KR_SERVICE_KEY")
        or os.environ.get("MOLIT_SERVICE_KEY")
        or ""
    )
    if not key:
        raise RuntimeError("MOLIT_API_KEY missing")
    return key


def db() -> sqlite3.Connection:
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidates (
          complex_id TEXT PRIMARY KEY,
          lawd_cd TEXT NOT NULL,
          apt_name_norm TEXT NOT NULL,
          master_complex_id TEXT,
          gu TEXT,
          dong TEXT,
          jibun TEXT,
          trades_count INTEGER,
          trades_ok INTEGER NOT NULL DEFAULT 1,
          parcel_ok INTEGER NOT NULL DEFAULT 0,
          parcel_source TEXT,
          sigungu_cd TEXT,
          bjdong_cd TEXT,
          bun TEXT,
          ji TEXT,
          bld_ok INTEGER NOT NULL DEFAULT 0,
          bld_source TEXT,
          bld_total_count INTEGER,
          bld_pages INTEGER,
          bld_cache_path TEXT,
          gate_inputs_complete INTEGER NOT NULL DEFAULT 0,
          unresolved_reason TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          updated_at TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def load_parcel_exact() -> dict[str, dict[str, Any]]:
    path = ROOT / "data" / "poc" / "phase511" / "parcel_exact_eligible.json"
    rows = json.loads(path.read_text())
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        lawd = str(r["lawd_cd"])
        if not lawd.startswith("11"):
            continue
        cid = str(r.get("complex_id") or f"{lawd}:{r['apt_name_norm']}")
        bun = r.get("bun") or parse_jibun(r.get("jibun"))[0]
        ji = r.get("ji") or parse_jibun(r.get("jibun"))[1]
        if not r.get("bjdong_cd") or not bun:
            continue
        out[cid] = {
            "complex_id": cid,
            "lawd_cd": lawd,
            "apt_name_norm": str(r["apt_name_norm"]),
            "dong": str(r.get("dong") or ""),
            "jibun": str(r.get("jibun") or ""),
            "sigungu_cd": str(r.get("sigungu_cd") or lawd),
            "bjdong_cd": str(r["bjdong_cd"]),
            "bun": str(bun).zfill(4),
            "ji": str(ji or "0").zfill(4),
            "trades": int(r.get("trades") or 0),
            "source": "phase511_parcel_exact",
        }
    return out


def load_master_parcel() -> dict[str, dict[str, Any]]:
    js = r"""
const {createClient}=require('@libsql/client');
const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
(async()=>{
  const r=await db.execute(`
    SELECT complex_id, lawd_cd, apt_name_norm, legal_dong_name, bjdong_cd, jibun, identity_status
    FROM apt_complex_master WHERE lawd_cd LIKE '11%'
  `);
  process.stdout.write(JSON.stringify(r.rows));
})();
"""
    raw = subprocess.check_output(["node", "-e", js], env=os.environ, cwd=str(ROOT))
    out: dict[str, dict[str, Any]] = {}
    for r in json.loads(raw):
        lawd = str(r["lawd_cd"])
        apt = str(r["apt_name_norm"])
        cid = f"{lawd}:{apt}"
        bun, ji = parse_jibun(r.get("jibun"))
        if not r.get("bjdong_cd") or not bun:
            continue
        out[cid] = {
            "complex_id": cid,
            "master_complex_id": str(r["complex_id"]),
            "lawd_cd": lawd,
            "apt_name_norm": apt,
            "dong": str(r.get("legal_dong_name") or ""),
            "jibun": str(r.get("jibun") or ""),
            "sigungu_cd": lawd,
            "bjdong_cd": str(r["bjdong_cd"]),
            "bun": bun,
            "ji": ji,
            "trades": 0,
            "source": "apt_complex_master",
            "identity_status": r.get("identity_status"),
        }
    return out


def load_allowlist_parcel(gate) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for c in gate.COMPLEXES:
        lawd = str(c["lawd_cd"])
        if not lawd.startswith("11"):
            continue
        cid = f"{lawd}:{c['apt_name_norm']}"
        out[cid] = {
            "complex_id": cid,
            "lawd_cd": lawd,
            "apt_name_norm": str(c["apt_name_norm"]),
            "dong": "",
            "jibun": "",
            "sigungu_cd": str(c["sigungu_cd"]),
            "bjdong_cd": str(c["bjdong_cd"]),
            "bun": str(c["bun"]).zfill(4),
            "ji": str(c["ji"]).zfill(4),
            "trades": 0,
            "source": "phase4_COMPLEXES",
            "complex_key": c["key"],
            "cache": str(c["cache"]) if c.get("cache") else None,
        }
    return out


def seed_universe_once(conn: sqlite3.Connection, gate) -> dict[str, Any]:
    """Seed Seoul universe from existing SOT assets only (no rediscovery loop)."""
    existing = conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
    if existing > 0 and UNIVERSE_PATH.exists():
        return {"seeded": False, "rows": existing, "source": "checkpoint"}

    parcel_exact = load_parcel_exact()
    master = load_master_parcel()
    allow = load_allowlist_parcel(gate)

    # One-shot distinct Seoul keys to match Phase5.8 universe cardinality.
    # Not a full-history trade rescan — only DISTINCT identity keys.
    js = r"""
const {createClient}=require('@libsql/client');
const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
(async()=>{
  const r=await db.execute(`
    SELECT lawd_cd, apt_name_norm, MAX(gu) gu, MAX(dong) dong, MAX(jibun) jibun, COUNT(*) trades
    FROM transactions
    WHERE deal_type='trade' AND lawd_cd LIKE '11%'
      AND apt_name_norm IS NOT NULL AND apt_name_norm!=''
    GROUP BY lawd_cd, apt_name_norm
  `);
  process.stdout.write(JSON.stringify(r.rows));
})();
"""
    uni_rows = json.loads(
        subprocess.check_output(["node", "-e", js], env=os.environ, cwd=str(ROOT))
    )
    universe: list[dict[str, Any]] = []
    parcel_map: dict[str, dict[str, Any]] = {}
    for r in uni_rows:
        lawd = str(r["lawd_cd"])
        apt = str(r["apt_name_norm"])
        cid = f"{lawd}:{apt}"
        parcel = allow.get(cid) or parcel_exact.get(cid) or master.get(cid)
        row = {
            "complex_id": cid,
            "lawd_cd": lawd,
            "apt_name_norm": apt,
            "gu": str(r.get("gu") or ""),
            "dong": str(r.get("dong") or (parcel or {}).get("dong") or ""),
            "jibun": str(r.get("jibun") or (parcel or {}).get("jibun") or ""),
            "trades_count": int(r["trades"]),
        }
        universe.append(row)
        if parcel:
            parcel_map[cid] = parcel

    UNIVERSE_PATH.write_text(json.dumps(universe, ensure_ascii=False))
    PARCEL_MAP_PATH.write_text(json.dumps(parcel_map, ensure_ascii=False))

    now = now_iso()
    for row in universe:
        cid = row["complex_id"]
        p = parcel_map.get(cid)
        bun, ji = parse_jibun(row.get("jibun"))
        if p:
            bun = p.get("bun") or bun
            ji = p.get("ji") or ji
        conn.execute(
            """
            INSERT OR REPLACE INTO candidates(
              complex_id, lawd_cd, apt_name_norm, master_complex_id, gu, dong, jibun,
              trades_count, trades_ok, parcel_ok, parcel_source, sigungu_cd, bjdong_cd,
              bun, ji, unresolved_reason, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)
            """,
            (
                cid,
                row["lawd_cd"],
                row["apt_name_norm"],
                (p or {}).get("master_complex_id"),
                row["gu"],
                row["dong"],
                row["jibun"],
                row["trades_count"],
                1 if p else 0,
                (p or {}).get("source"),
                (p or {}).get("sigungu_cd") or row["lawd_cd"],
                (p or {}).get("bjdong_cd"),
                bun,
                ji,
                None if p else "missing_parcel_bjdong",
                now,
            ),
        )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('seeded_at',?)", (now,)
    )
    conn.commit()
    return {
        "seeded": True,
        "rows": len(universe),
        "parcel_mapped": len(parcel_map),
        "parcel_exact": len(parcel_exact),
        "master": len(master),
        "allowlist": len(allow),
    }


def cache_path_for(cid: str, gate, parcel_map: dict[str, Any]) -> Path:
    p = parcel_map.get(cid) or {}
    if p.get("cache") and Path(p["cache"]).exists():
        return Path(p["cache"])
    # stable filesystem-safe name
    digest = hashlib.sha1(cid.encode("utf-8")).hexdigest()[:12]
    safe = (
        cid.replace("/", "_")
        .replace(":", "__")
        .replace(" ", "_")
    )
    if len(safe) > 120:
        safe = safe[:80] + "_" + digest
    return CACHE_DIR / f"{safe}-bld-expos-cache.json"


def request_key(parcel: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(parcel.get("sigungu_cd") or ""),
        str(parcel.get("bjdong_cd") or ""),
        str(parcel.get("bun") or "").zfill(4),
        str(parcel.get("ji") or "").zfill(4),
    )


def build_shared_cache_index(conn: sqlite3.Connection) -> dict[tuple[str, str, str, str], Path]:
    """Map BldRgst request key -> complete local cache path (shared reuse)."""
    idx: dict[tuple[str, str, str, str], Path] = {}
    for sigungu, bjdong, bun, ji, path in conn.execute(
        """
        SELECT sigungu_cd, bjdong_cd, bun, ji, bld_cache_path
        FROM candidates
        WHERE parcel_ok=1 AND bld_ok=1 AND bld_cache_path IS NOT NULL
        """
    ):
        if not path:
            continue
        p = Path(path)
        ok, _, _ = cache_complete(p)
        if not ok:
            continue
        key = (str(sigungu), str(bjdong), str(bun).zfill(4), str(ji).zfill(4))
        idx.setdefault(key, p)
    return idx


def index_existing_caches(gate) -> dict[str, Path]:
    idx: dict[str, Path] = {}
    for c in gate.COMPLEXES:
        if c.get("cache") and Path(c["cache"]).exists():
            cid = f"{c['lawd_cd']}:{c['apt_name_norm']}"
            idx[cid] = Path(c["cache"])
    if CACHE_DIR.exists():
        for p in CACHE_DIR.glob("*-bld-expos-cache.json"):
            try:
                data = json.loads(p.read_text())
                cid = data.get("complex_id") or data.get("complex")
                if cid:
                    # normalize key form
                    if ":" not in str(cid) and data.get("lawd_cd") and data.get("apt_name_norm"):
                        cid = f"{data['lawd_cd']}:{data['apt_name_norm']}"
                    idx[str(cid)] = p
            except Exception:
                continue
    return idx


def cache_complete(path: Path) -> tuple[bool, int, int]:
    if not path.exists():
        return False, 0, 0
    try:
        data = json.loads(path.read_text())
        items = data.get("items") or data.get("rows") or []
        total = int(data.get("totalCount") or data.get("total") or len(items))
        if total == 0 and data.get("empty") is True:
            return True, 0, 0
        ok = bool(items) and total >= 0 and len(items) >= total
        pages = max(1, math.ceil(total / PAGE_SIZE)) if total else 0
        return ok, total, pages
    except Exception:
        return False, 0, 0


def mark_local_cache_hits(conn: sqlite3.Connection, gate) -> dict[str, int]:
    parcel_map = json.loads(PARCEL_MAP_PATH.read_text()) if PARCEL_MAP_PATH.exists() else {}
    caches = index_existing_caches(gate)
    now = now_iso()
    hits = 0
    for cid, path in caches.items():
        ok, total, pages = cache_complete(path)
        if not ok:
            continue
        row = conn.execute(
            "SELECT trades_ok, parcel_ok FROM candidates WHERE complex_id=?", (cid,)
        ).fetchone()
        if not row:
            continue
        trades_ok, parcel_ok = row
        complete = 1 if trades_ok and (parcel_ok or True) else 0
        # if cache exists, parcel is effectively resolved for this allowlist/cache hit
        conn.execute(
            """
            UPDATE candidates SET
              bld_ok=1, bld_source='local_cache', bld_total_count=?, bld_pages=?,
              bld_cache_path=?,
              parcel_ok=CASE WHEN parcel_ok=1 THEN 1 ELSE 1 END,
              gate_inputs_complete=CASE WHEN trades_ok=1 THEN 1 ELSE 0 END,
              unresolved_reason=CASE WHEN trades_ok=1 THEN NULL ELSE 'missing_trade_coverage' END,
              updated_at=?
            WHERE complex_id=?
            """,
            (total, pages, str(path), now, cid),
        )
        hits += 1
    conn.commit()
    return {"local_cache_hits": hits}


def inventory(conn: sqlite3.Connection) -> dict[str, Any]:
    total = conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
    reasons = dict(
        conn.execute(
            """
            SELECT COALESCE(unresolved_reason,'gate_inputs_complete'), COUNT(*)
            FROM candidates GROUP BY 1 ORDER BY 2 DESC
            """
        ).fetchall()
    )
    report = {
        "generated_at": now_iso(),
        "seoul_total": total,
        "parcel_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1"
        ).fetchone()[0],
        "parcel_missing": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=0"
        ).fetchone()[0],
        "bld_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE bld_ok=1"
        ).fetchone()[0],
        "bld_missing": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE bld_ok=0"
        ).fetchone()[0],
        "trades_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE trades_ok=1"
        ).fetchone()[0],
        "gate_inputs_complete": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=1"
        ).fetchone()[0],
        "reasons": reasons,
        "parcel_sources": dict(
            conn.execute(
                """
                SELECT COALESCE(parcel_source,'none'), COUNT(*)
                FROM candidates GROUP BY 1 ORDER BY 2 DESC
                """
            ).fetchall()
        ),
        "missing_bld_with_parcel": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1 AND bld_ok=0"
        ).fetchone()[0],
        "missing_parcel": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=0"
        ).fetchone()[0],
        "classification_prereq_note": (
            "area/group + label derived after building registry + trades; "
            "not separately fetched"
        ),
    }
    INVENTORY_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def fetch_page(key: str, parcel: dict[str, str], page: int) -> tuple[list[dict], int]:
    qs = urllib.parse.urlencode(
        {
            "serviceKey": key,
            "sigunguCd": parcel["sigungu_cd"],
            "bjdongCd": parcel["bjdong_cd"],
            "bun": parcel["bun"],
            "ji": parcel["ji"],
            "numOfRows": str(PAGE_SIZE),
            "pageNo": str(page),
        }
    )
    url = (
        "https://apis.data.go.kr/1613000/BldRgstHubService/"
        f"getBrExposPubuseAreaInfo?{qs}"
    )
    last: Exception | None = None
    for attempt in range(MAX_RETRIES):
        t0 = time.time()
        try:
            with urllib.request.urlopen(url, timeout=PAGE_TIMEOUT_SEC) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            latency_ms = (time.time() - t0) * 1000.0
            if not raw.strip():
                raise RuntimeError("empty body")
            if (
                "<totalCount>" not in raw
                and "<resultCode>" not in raw
                and "<resultMsg>" not in raw
            ):
                raise RuntimeError(f"non-api body: {raw[:80]!r}")
            root = ET.fromstring(raw)
            code = (root.findtext(".//resultCode") or "").strip()
            if code and code not in ("00", "0", "000"):
                raise RuntimeError(f"API {code}: {root.findtext('.//resultMsg')}")
            total = int(root.findtext(".//totalCount") or "0")
            items: list[dict] = []
            for it in root.findall(".//item"):
                row = {ch.tag: (ch.text or "").strip() for ch in it}
                try:
                    row["_area"] = float(row.get("area") or 0)
                except ValueError:
                    row["_area"] = 0.0
                items.append(row)
            _http_note("ok", latency_ms)
            _adaptive_on_result(True)
            return items, total
        except Exception as exc:  # noqa: BLE001
            last = exc
            msg = str(exc)
            if "429" in msg:
                _http_note("429")
            elif "503" in msg or "502" in msg or "500" in msg or "504" in msg:
                _http_note("5xx")
            elif "timed out" in msg.lower() or "timeout" in msg.lower():
                _http_note("timeout")
            else:
                _http_note("other")
            _adaptive_on_result(False)
            base = 1.4 if ("503" in msg or "empty body" in msg or "non-api" in msg or "429" in msg) else 0.8
            # exponential backoff + small jitter; honor adaptive multiplier
            with _ADAPTIVE_LOCK:
                mult = _ADAPTIVE["sleep_mult"]
            delay = min(MAX_PAGE_BACKOFF_SEC, base * (2**attempt) * mult)
            delay += random.uniform(0, min(1.0, delay * 0.1))
            time.sleep(delay)
    raise RuntimeError(f"page {page} failed: {last}")


def write_cache(path: Path, cid: str, parcel: dict[str, Any], items: list[dict], total: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "complex_id": cid,
                "lawd_cd": parcel.get("lawd_cd"),
                "apt_name_norm": parcel.get("apt_name_norm"),
                "sigungu_cd": parcel.get("sigungu_cd"),
                "bjdong_cd": parcel.get("bjdong_cd"),
                "bun": parcel.get("bun"),
                "ji": parcel.get("ji"),
                "fetchedAt": now_iso(),
                "totalCount": total,
                "pageSize": PAGE_SIZE,
                "count": len(items),
                "empty": total == 0,
                "items": items,
            },
            ensure_ascii=False,
        )
    )


def append_failed(rec: dict[str, Any]) -> None:
    with FAILED_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def progress_snapshot(conn: sqlite3.Connection, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    snap = {
        "updated_at": now_iso(),
        "gate_inputs_complete": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=1"
        ).fetchone()[0],
        "bld_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE bld_ok=1"
        ).fetchone()[0],
        "parcel_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1"
        ).fetchone()[0],
        "remaining_bld": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1 AND bld_ok=0"
        ).fetchone()[0],
        "missing_parcel": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=0"
        ).fetchone()[0],
        "failed_retries": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE retry_count>0 AND bld_ok=0"
        ).fetchone()[0],
    }
    if extra:
        snap.update(extra)
    PROGRESS_PATH.write_text(json.dumps(snap, ensure_ascii=False, indent=2))
    return snap


def acquire_one(
    key: str,
    cid: str,
    parcel: dict[str, Any],
    path: Path,
    sleep_s: float,
    max_pages: int | None,
) -> dict[str, Any]:
    ok, total, pages = cache_complete(path)
    if ok:
        return {
            "status": "cache_hit",
            "total": total,
            "pages": pages,
            "requests": 0,
            "path": str(path),
        }

    items: list[dict] = []
    start_page = 1
    if path.exists():
        data = json.loads(path.read_text())
        items = data.get("items") or []
        total = int(data.get("totalCount") or 0)
        if total and items:
            start_page = max(1, len(items) // PAGE_SIZE + 1)

    requests = 0
    if start_page == 1:
        page1, total = fetch_page(key, parcel, 1)
        requests += 1
        items = list(page1)
        write_cache(path, cid, parcel, items, total)
        if total == 0:
            return {
                "status": "not_found",
                "total": 0,
                "pages": 0,
                "requests": requests,
                "path": str(path),
            }

    pages = max(1, math.ceil(total / PAGE_SIZE))
    if max_pages is not None and pages > max_pages:
        return {
            "status": "deferred_large",
            "total": total,
            "pages": pages,
            "requests": requests,
            "path": str(path),
        }

    for page in range(max(2, start_page), pages + 1):
        with _ADAPTIVE_LOCK:
            mult = _ADAPTIVE["sleep_mult"]
        time.sleep(sleep_s * mult)
        chunk, _ = fetch_page(key, parcel, page)
        requests += 1
        expected = (page - 1) * PAGE_SIZE
        if len(items) > expected:
            items = items[:expected]
        items.extend(chunk)
        if page % 5 == 0 or page == pages:
            write_cache(path, cid, parcel, items, total)

    write_cache(path, cid, parcel, items, total)
    usable = len(items) >= total and total > 0
    return {
        "status": "success" if usable else "incomplete",
        "total": total,
        "pages": pages,
        "requests": requests,
        "path": str(path),
        "count": len(items),
    }


def run_acquire(
    conn: sqlite3.Connection,
    gate,
    *,
    limit: int | None,
    sleep_s: float,
    max_pages: int | None,
    workers: int,
    order: str,
) -> dict[str, Any]:
    key = service_key()
    parcel_map = json.loads(PARCEL_MAP_PATH.read_text())
    # refresh allowlist caches into parcel_map
    for c in gate.COMPLEXES:
        lawd = str(c["lawd_cd"])
        if not lawd.startswith("11"):
            continue
        cid = f"{lawd}:{c['apt_name_norm']}"
        parcel_map.setdefault(
            cid,
            {
                "complex_id": cid,
                "lawd_cd": lawd,
                "apt_name_norm": c["apt_name_norm"],
                "sigungu_cd": c["sigungu_cd"],
                "bjdong_cd": c["bjdong_cd"],
                "bun": str(c["bun"]).zfill(4),
                "ji": str(c["ji"]).zfill(4),
                "cache": str(c["cache"]) if c.get("cache") else None,
                "source": "phase4_COMPLEXES",
            },
        )

    order_sql = {
        "small_first": "ORDER BY COALESCE(bld_total_count, 999999999) ASC, complex_id ASC",
        "id": "ORDER BY complex_id ASC",
    }.get(order, "ORDER BY complex_id ASC")

    # Normal wave (max_pages set): exclude deferred_large + terminal not-found.
    # Full/large wave (max_pages None): include deferred_large, still skip terminal not-found.
    exclude = ["registry_not_found_terminal"]
    if max_pages is not None:
        exclude.append("deferred_large_registry")
    exclude_sql = ",".join(f"'{x}'" for x in exclude)
    rows = conn.execute(
        f"""
        SELECT complex_id, sigungu_cd, bjdong_cd, bun, ji, lawd_cd, apt_name_norm, retry_count
        FROM candidates
        WHERE parcel_ok=1 AND bld_ok=0
          AND COALESCE(unresolved_reason,'') NOT IN ({exclude_sql})
        {order_sql}
        """
    ).fetchall()
    if limit is not None:
        rows = rows[:limit]

    shared_idx = build_shared_cache_index(conn)
    stats = {
        "targets": len(rows),
        "cache_hits": 0,
        "shared_cache_hits": 0,
        "api_requests": 0,
        "successful": 0,
        "not_found": 0,
        "failed": 0,
        "retried": 0,
        "deferred_large": 0,
        "started_at": now_iso(),
    }

    def handle_result(cid: str, parcel: dict[str, Any], result: dict[str, Any], retry_count: int) -> None:
        now = now_iso()
        stats["api_requests"] += int(result.get("requests") or 0)
        status = result["status"]
        if status == "cache_hit":
            stats["cache_hits"] += 1
            src = result.get("bld_source") or "local_cache"
            if src.startswith("shared_request_key"):
                stats["shared_cache_hits"] += 1
            conn.execute(
                """
                UPDATE candidates SET bld_ok=1, bld_source=?,
                  bld_total_count=?, bld_pages=?, bld_cache_path=?,
                  gate_inputs_complete=1, unresolved_reason=NULL, last_error=NULL, updated_at=?
                WHERE complex_id=?
                """,
                (src, result["total"], result["pages"], result["path"], now, cid),
            )
            shared_idx[request_key(parcel)] = Path(result["path"])
        elif status == "success":
            stats["successful"] += 1
            conn.execute(
                """
                UPDATE candidates SET bld_ok=1, bld_source='bldrgst_api',
                  bld_total_count=?, bld_pages=?, bld_cache_path=?,
                  gate_inputs_complete=1, unresolved_reason=NULL, last_error=NULL, updated_at=?
                WHERE complex_id=?
                """,
                (result["total"], result["pages"], result["path"], now, cid),
            )
            shared_idx[request_key(parcel)] = Path(result["path"])
        elif status == "not_found":
            stats["not_found"] += 1
            conn.execute(
                """
                UPDATE candidates SET bld_ok=0, bld_source='api_empty',
                  bld_total_count=0, bld_pages=0, bld_cache_path=?,
                  gate_inputs_complete=0, unresolved_reason='registry_not_found',
                  last_error='totalCount=0', updated_at=?
                WHERE complex_id=?
                """,
                (result["path"], now, cid),
            )
        elif status == "deferred_large":
            stats["deferred_large"] += 1
            conn.execute(
                """
                UPDATE candidates SET bld_total_count=?, bld_pages=?,
                  unresolved_reason='deferred_large_registry',
                  last_error=?, updated_at=?
                WHERE complex_id=?
                """,
                (
                    result["total"],
                    result["pages"],
                    f"pages={result['pages']}>max_pages",
                    now,
                    cid,
                ),
            )
        else:
            stats["failed"] += 1
            conn.execute(
                """
                UPDATE candidates SET retry_count=retry_count+1,
                  unresolved_reason='bld_fetch_failed',
                  last_error=?, updated_at=?
                WHERE complex_id=?
                """,
                (status, now, cid),
            )
            append_failed(
                {
                    "complex_id": cid,
                    "request_key": {
                        "sigungu_cd": parcel["sigungu_cd"],
                        "bjdong_cd": parcel["bjdong_cd"],
                        "bun": parcel["bun"],
                        "ji": parcel["ji"],
                    },
                    "reason": status,
                    "retry_count": retry_count + 1,
                    "at": now,
                }
            )
        conn.commit()

    # workers>1 only across complexes; pages inside remain serial
    workers = max(1, min(workers, MAX_WORKERS))
    reset_http_metrics()
    t_run0 = time.time()

    def job(row):
        cid, sigungu, bjdong, bun, ji, lawd, apt, retry_count = row
        parcel = parcel_map.get(cid) or {
            "complex_id": cid,
            "lawd_cd": lawd,
            "apt_name_norm": apt,
            "sigungu_cd": sigungu,
            "bjdong_cd": bjdong,
            "bun": bun,
            "ji": ji,
        }
        path = cache_path_for(cid, gate, parcel_map)
        rkey = request_key(parcel)
        # Shared request-key reuse: do not re-call API for same parcel key.
        shared = shared_idx.get(rkey)
        if shared and shared.exists():
            ok, total, pages = cache_complete(shared)
            if ok:
                return (
                    cid,
                    parcel,
                    {
                        "status": "cache_hit",
                        "total": total,
                        "pages": pages,
                        "requests": 0,
                        "path": str(shared),
                        "bld_source": "shared_request_key",
                    },
                    retry_count,
                    None,
                )

        # In-flight dedupe: only one worker fetches a given request key.
        leader = False
        event: threading.Event | None = None
        with _INFLIGHT_LOCK:
            if rkey in _INFLIGHT_RESULT:
                done_path = _INFLIGHT_RESULT[rkey]
                ok, total, pages = cache_complete(done_path)
                if ok:
                    return (
                        cid,
                        parcel,
                        {
                            "status": "cache_hit",
                            "total": total,
                            "pages": pages,
                            "requests": 0,
                            "path": str(done_path),
                            "bld_source": "shared_request_key_inflight",
                        },
                        retry_count,
                        None,
                    )
            if rkey in _INFLIGHT:
                event = _INFLIGHT[rkey]
            else:
                event = threading.Event()
                _INFLIGHT[rkey] = event
                leader = True

        if not leader:
            assert event is not None
            event.wait(timeout=3600)
            with _INFLIGHT_LOCK:
                done_path = _INFLIGHT_RESULT.get(rkey)
            if done_path and done_path.exists():
                ok, total, pages = cache_complete(done_path)
                if ok:
                    return (
                        cid,
                        parcel,
                        {
                            "status": "cache_hit",
                            "total": total,
                            "pages": pages,
                            "requests": 0,
                            "path": str(done_path),
                            "bld_source": "shared_request_key_inflight",
                        },
                        retry_count,
                        None,
                    )
            # leader failed; fall through to own fetch

        try:
            result = acquire_one(key, cid, parcel, path, sleep_s, max_pages)
            if leader and result.get("status") in ("success", "cache_hit", "not_found", "deferred_large"):
                with _INFLIGHT_LOCK:
                    _INFLIGHT_RESULT[rkey] = Path(result["path"])
                    shared_idx[rkey] = Path(result["path"])
            return cid, parcel, result, retry_count, None
        except Exception as exc:  # noqa: BLE001
            return cid, parcel, None, retry_count, str(exc)
        finally:
            if leader and event is not None:
                event.set()
                with _INFLIGHT_LOCK:
                    _INFLIGHT.pop(rkey, None)

    if workers == 1:
        for i, row in enumerate(rows, 1):
            cid, parcel, result, retry_count, err = job(row)
            if err:
                stats["failed"] += 1
                stats["retried"] += 1
                now = now_iso()
                conn.execute(
                    """
                    UPDATE candidates SET retry_count=retry_count+1,
                      unresolved_reason='bld_fetch_failed', last_error=?, updated_at=?
                    WHERE complex_id=?
                    """,
                    (err, now, cid),
                )
                conn.commit()
                append_failed(
                    {
                        "complex_id": cid,
                        "request_key": {
                            "sigungu_cd": parcel.get("sigungu_cd"),
                            "bjdong_cd": parcel.get("bjdong_cd"),
                            "bun": parcel.get("bun"),
                            "ji": parcel.get("ji"),
                        },
                        "reason": err,
                        "retry_count": retry_count + 1,
                        "at": now,
                    }
                )
            else:
                handle_result(cid, parcel, result, retry_count)
            progress_snapshot(conn, {"stats": stats, "done": i, "wave": "max_pages"})
            if i % 10 == 0 or i == len(rows):
                print(
                    f"[{i}/{len(rows)}] complete={stats['successful']} "
                    f"empty={stats['not_found']} fail={stats['failed']} "
                    f"deferred={stats['deferred_large']} "
                    f"req={stats['api_requests']}",
                    flush=True,
                )
    else:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(job, row) for row in rows]
            for i, fut in enumerate(as_completed(futs), 1):
                cid, parcel, result, retry_count, err = fut.result()
                if err:
                    stats["failed"] += 1
                    stats["retried"] += 1
                    now = now_iso()
                    conn.execute(
                        """
                        UPDATE candidates SET retry_count=retry_count+1,
                          unresolved_reason='bld_fetch_failed', last_error=?, updated_at=?
                        WHERE complex_id=?
                        """,
                        (err, now, cid),
                    )
                    conn.commit()
                    append_failed(
                        {
                            "complex_id": cid,
                            "reason": err,
                            "retry_count": retry_count + 1,
                            "at": now,
                        }
                    )
                else:
                    handle_result(cid, parcel, result, retry_count)
                if i % 10 == 0 or i == len(rows):
                    progress_snapshot(conn, {"stats": stats, "done": i})
                    print(
                        f"[{i}/{len(rows)}] complete={stats['successful']} "
                        f"empty={stats['not_found']} fail={stats['failed']} "
                        f"req={stats['api_requests']}",
                        flush=True,
                    )

    stats["finished_at"] = now_iso()
    stats["remaining"] = conn.execute(
        "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1 AND bld_ok=0"
    ).fetchone()[0]
    elapsed = max(1e-6, time.time() - t_run0)
    stats["elapsed_sec"] = round(elapsed, 1)
    stats["complexes_completed_wave"] = (
        stats["successful"] + stats["cache_hits"] + stats.get("shared_cache_hits", 0)
    )
    # Prefer successful+cache for throughput of "done" complexes in this wave.
    done_n = stats["successful"] + stats["cache_hits"]
    stats["complexes_per_hour"] = round(done_n / (elapsed / 3600.0), 1)
    http = http_metrics_snapshot()
    stats["http"] = http
    if elapsed > 0 and http.get("requests"):
        stats["requests_per_min"] = round(http["requests"] / (elapsed / 60.0), 1)
    else:
        stats["requests_per_min"] = 0.0
    stats["workers"] = workers
    stats["sleep_s"] = sleep_s
    progress_snapshot(conn, {"stats": stats})
    return stats


def probe_totals(
    conn: sqlite3.Connection, gate, *, limit: int | None, sleep_s: float
) -> dict[str, Any]:
    """Page-1 only probe to bound remaining acquisition cost."""
    key = service_key()
    parcel_map = json.loads(PARCEL_MAP_PATH.read_text())
    rows = conn.execute(
        """
        SELECT complex_id, sigungu_cd, bjdong_cd, bun, ji, lawd_cd, apt_name_norm
        FROM candidates
        WHERE parcel_ok=1 AND bld_ok=0 AND (bld_total_count IS NULL)
        ORDER BY complex_id
        """
    ).fetchall()
    if limit is not None:
        rows = rows[:limit]
    stats = {"probed": 0, "empty": 0, "requests": 0, "errors": 0, "pages_sum": 0}
    for i, (cid, sigungu, bjdong, bun, ji, lawd, apt) in enumerate(rows, 1):
        parcel = parcel_map.get(cid) or {
            "sigungu_cd": sigungu,
            "bjdong_cd": bjdong,
            "bun": bun,
            "ji": ji,
            "lawd_cd": lawd,
            "apt_name_norm": apt,
        }
        path = cache_path_for(cid, gate, parcel_map)
        try:
            page1, total = fetch_page(key, parcel, 1)
            stats["requests"] += 1
            write_cache(path, cid, parcel, list(page1), total)
            pages = max(1, math.ceil(total / PAGE_SIZE)) if total else 0
            stats["pages_sum"] += pages
            if total == 0:
                stats["empty"] += 1
                conn.execute(
                    """
                    UPDATE candidates SET bld_total_count=0, bld_pages=0,
                      bld_cache_path=?, unresolved_reason='registry_not_found',
                      bld_source='api_empty', updated_at=?
                    WHERE complex_id=?
                    """,
                    (str(path), now_iso(), cid),
                )
            else:
                conn.execute(
                    """
                    UPDATE candidates SET bld_total_count=?, bld_pages=?,
                      bld_cache_path=?, updated_at=?
                    WHERE complex_id=?
                    """,
                    (total, pages, str(path), now_iso(), cid),
                )
            conn.commit()
            stats["probed"] += 1
        except Exception as exc:  # noqa: BLE001
            stats["errors"] += 1
            conn.execute(
                """
                UPDATE candidates SET retry_count=retry_count+1, last_error=?,
                  unresolved_reason='bld_probe_failed', updated_at=?
                WHERE complex_id=?
                """,
                (str(exc), now_iso(), cid),
            )
            conn.commit()
            append_failed(
                {"complex_id": cid, "reason": str(exc), "phase": "probe", "at": now_iso()}
            )
        if i % 25 == 0 or i == len(rows):
            print(f"probe {i}/{len(rows)} {stats}", flush=True)
            progress_snapshot(conn, {"probe": stats})
        time.sleep(sleep_s)
    # cost estimate from known totals
    row = conn.execute(
        """
        SELECT COUNT(*), COALESCE(SUM(bld_pages),0), COALESCE(SUM(bld_total_count),0)
        FROM candidates WHERE parcel_ok=1 AND bld_ok=0 AND bld_total_count IS NOT NULL
        """
    ).fetchone()
    stats["remaining_with_totals"] = row[0]
    stats["remaining_pages"] = row[1]
    stats["remaining_rows"] = row[2]
    stats["est_hours_at_0_35s"] = round(row[1] * 0.35 / 3600, 2)
    progress_snapshot(conn, {"probe": stats})
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--inventory", action="store_true")
    ap.add_argument("--mark-caches", action="store_true")
    ap.add_argument("--probe", action="store_true", help="page1 totals only")
    ap.add_argument("--acquire", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--sleep", type=float, default=DEFAULT_SLEEP)
    ap.add_argument("--max-pages", type=int, default=None)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--order", default="small_first")
    args = ap.parse_args()

    gate = load_gate()
    conn = db()
    out: dict[str, Any] = {"production_writes": 0}

    if args.seed or conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0] == 0:
        out["seed"] = seed_universe_once(conn, gate)
    if args.mark_caches or args.seed:
        out["cache_mark"] = mark_local_cache_hits(conn, gate)
    if args.inventory or args.seed:
        out["inventory"] = inventory(conn)
    if args.probe:
        out["probe"] = probe_totals(conn, gate, limit=args.limit, sleep_s=args.sleep)
        out["inventory"] = inventory(conn)
    if args.acquire:
        out["acquire"] = run_acquire(
            conn,
            gate,
            limit=args.limit,
            sleep_s=args.sleep,
            max_pages=args.max_pages,
            workers=args.workers,
            order=args.order,
        )
        out["inventory"] = inventory(conn)

    report_path = OUT / "runner_report.json"
    report_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
