#!/usr/bin/env python3
"""Lightweight Seoul acquire health snapshot (does not touch API / caches)."""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase59b"
DB = OUT / "seoul_gate_inputs.sqlite"
PROG = OUT / "acquisition_progress.json"
HEALTH_LOG = OUT / "health_log.jsonl"
CACHE = OUT / "bld-expos-cache"


def main() -> int:
    conn = sqlite3.connect(DB)
    gate = conn.execute(
        "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=1"
    ).fetchone()[0]
    rem_n = conn.execute(
        """
        SELECT COUNT(*) FROM candidates
        WHERE parcel_ok=1 AND bld_ok=0
          AND COALESCE(unresolved_reason,'') NOT IN (
            'deferred_large_registry','registry_not_found_terminal','parcel_unresolved_terminal'
          )
        """
    ).fetchone()[0]
    large = conn.execute(
        "SELECT COUNT(*) FROM candidates WHERE unresolved_reason='deferred_large_registry'"
    ).fetchone()[0]
    failed = conn.execute(
        "SELECT COUNT(*) FROM candidates WHERE unresolved_reason LIKE '%fail%'"
    ).fetchone()[0]
    shared = conn.execute(
        "SELECT COUNT(*) FROM candidates WHERE bld_source LIKE 'shared%'"
    ).fetchone()[0]
    prog = json.loads(PROG.read_text()) if PROG.exists() else {}
    stats = prog.get("stats") or {}
    http = stats.get("http") or {}
    caches = list(CACHE.glob("*-bld-expos-cache.json")) if CACHE.exists() else []
    cache_bytes = sum(p.stat().st_size for p in caches)
    row = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gate_complete": gate,
        "remaining_normal": rem_n,
        "deferred_large": large,
        "failed": failed,
        "shared_reuse": shared,
        "complexes_per_hour": stats.get("complexes_per_hour"),
        "requests_per_min": stats.get("requests_per_min"),
        "api_requests": stats.get("api_requests"),
        "p95_latency_ms": http.get("p95_latency_ms"),
        "http_429": http.get("http_429"),
        "http_5xx": http.get("http_5xx"),
        "timeout": http.get("timeout"),
        "retry": http.get("retry"),
        "cache_files": len(caches),
        "cache_bytes": cache_bytes,
        "progress_updated_at": prog.get("updated_at"),
        "drained": rem_n == 0 and large == 0 and failed == 0,
    }
    with HEALTH_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps(row, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
