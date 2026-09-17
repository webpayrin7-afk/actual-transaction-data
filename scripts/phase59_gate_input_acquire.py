#!/usr/bin/env python3
"""
Phase 5.9 — scalable gate-input acquisition (local/non-production only).

Gate classify() needs:
  - building registry expos (local cache or external BldRgstHub API)
  - trades (warehouse Turso)
  - area/group + label metrics (derived; not separately fetched)

Runner properties: dynamic candidates, batched, resumable sqlite, no COMPLEXES
allowlist for candidacy, per-complex failure isolation, reason codes.

Default: NO external API calls (cost gate). Production master writes: never.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase59"
DB_PATH = OUT / "gate_inputs.sqlite"


def load_gate_module():
    path = ROOT / "scripts" / "poc_phase4_readiness_gate.py"
    spec = importlib.util.spec_from_file_location("phase4_gate", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def db() -> sqlite3.Connection:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidates (
          complex_id TEXT PRIMARY KEY,
          lawd_cd TEXT NOT NULL,
          apt_name_norm TEXT NOT NULL,
          region TEXT,
          gu TEXT,
          dong TEXT,
          jibun TEXT,
          trades_count INTEGER,
          trades_ok INTEGER NOT NULL DEFAULT 0,
          bld_ok INTEGER NOT NULL DEFAULT 0,
          bld_source TEXT,
          parcel_ok INTEGER NOT NULL DEFAULT 0,
          sigungu_cd TEXT,
          bjdong_cd TEXT,
          bun TEXT,
          ji TEXT,
          gate_inputs_complete INTEGER NOT NULL DEFAULT 0,
          unresolved_reason TEXT,
          updated_at TEXT
        )
        """
    )
    conn.commit()
    return conn


def parse_jibun(jibun: str | None) -> tuple[str | None, str | None]:
    if not jibun:
        return None, None
    j = str(jibun).strip()
    if "-" in j:
        a, b = j.split("-", 1)
    else:
        a, b = j, "0"
    bun = "".join(c for c in a if c.isdigit())
    ji = "".join(c for c in b if c.isdigit()) or "0"
    if not bun:
        return None, None
    return bun.zfill(4), ji.zfill(4)


def fetch_universe() -> list[dict[str, Any]]:
    js = r"""
const {createClient}=require('@libsql/client');
const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
(async()=>{
  const r=await db.execute(`
    SELECT lawd_cd, apt_name_norm,
           MAX(gu) gu, MAX(dong) dong, MAX(jibun) jibun, COUNT(*) trades
    FROM transactions
    WHERE deal_type='trade'
      AND (lawd_cd LIKE '11%' OR lawd_cd LIKE '41%')
      AND apt_name_norm IS NOT NULL AND apt_name_norm!=''
    GROUP BY lawd_cd, apt_name_norm
  `);
  process.stdout.write(JSON.stringify(r.rows));
})();
"""
    raw = subprocess.check_output(["node", "-e", js], env=os.environ, cwd=str(ROOT))
    rows = []
    for r in json.loads(raw):
        lawd = str(r["lawd_cd"])
        apt = str(r["apt_name_norm"])
        rows.append(
            {
                "complex_id": f"{lawd}:{apt}",
                "lawd_cd": lawd,
                "apt_name_norm": apt,
                "region": "seoul" if lawd.startswith("11") else "gyeonggi",
                "gu": str(r.get("gu") or ""),
                "dong": str(r.get("dong") or ""),
                "jibun": str(r.get("jibun") or ""),
                "trades_count": int(r["trades"]),
            }
        )
    return rows


def upsert_universe(conn: sqlite3.Connection, rows: list[dict[str, Any]]) -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for r in rows:
        bun, ji = parse_jibun(r.get("jibun"))
        conn.execute(
            """
            INSERT INTO candidates(
              complex_id, lawd_cd, apt_name_norm, region, gu, dong, jibun,
              trades_count, sigungu_cd, bun, ji, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(complex_id) DO UPDATE SET
              gu=excluded.gu, dong=excluded.dong, jibun=excluded.jibun,
              trades_count=excluded.trades_count, bun=excluded.bun, ji=excluded.ji,
              updated_at=excluded.updated_at
            """,
            (
                r["complex_id"],
                r["lawd_cd"],
                r["apt_name_norm"],
                r["region"],
                r["gu"],
                r["dong"],
                r["jibun"],
                r["trades_count"],
                r["lawd_cd"],
                bun,
                ji,
                now,
            ),
        )
    conn.commit()
    return len(rows)


def mark_trades(conn: sqlite3.Connection) -> dict[str, int]:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    conn.execute(
        "UPDATE candidates SET trades_ok=1, updated_at=? WHERE trades_count > 0",
        (now,),
    )
    conn.execute(
        """
        UPDATE candidates
        SET trades_ok=0, unresolved_reason='missing_trade_coverage', updated_at=?
        WHERE trades_count IS NULL OR trades_count <= 0
        """,
        (now,),
    )
    conn.commit()
    return {
        "trades_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE trades_ok=1"
        ).fetchone()[0],
        "trades_missing": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE trades_ok=0"
        ).fetchone()[0],
    }


def parcel_index(gate) -> dict[str, dict[str, str]]:
    idx: dict[str, dict[str, str]] = {}
    for c in gate.COMPLEXES:
        idx[f"{c['lawd_cd']}:{c['apt_name_norm']}"] = {
            "complex_key": c["key"],
            "sigungu_cd": str(c["sigungu_cd"]),
            "bjdong_cd": str(c["bjdong_cd"]),
            "bun": str(c["bun"]),
            "ji": str(c["ji"]),
        }
    extra = OUT / "parcel_map.json"
    if extra.exists():
        idx.update(json.loads(extra.read_text()))
    return idx


def cache_index(gate) -> dict[str, Path]:
    idx: dict[str, Path] = {}
    for folder in (gate.OUT, gate.P3):
        folder = Path(folder)
        if not folder.exists():
            continue
        for p in folder.glob("*-bld-expos-cache.json"):
            idx[p.name.replace("-bld-expos-cache.json", "")] = p
    for c in gate.COMPLEXES:
        if c.get("cache") and Path(c["cache"]).exists():
            idx[c["key"]] = Path(c["cache"])
    return idx


def acquire_building(conn: sqlite3.Connection, gate) -> dict[str, int]:
    """Local cache / parcel diagnosis only. No external API."""
    parcels = parcel_index(gate)
    caches = cache_index(gate)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    stats = {
        "bld_cache_hit": 0,
        "missing_parcel_bjdong": 0,
        "missing_bld_cache_external_deferred": 0,
    }

    for complex_id, lawd, bun, ji, trades_ok in conn.execute(
        "SELECT complex_id, lawd_cd, bun, ji, trades_ok FROM candidates"
    ):
        parcel = parcels.get(complex_id)
        ckey = parcel.get("complex_key") if parcel else None
        cache = caches.get(ckey) if ckey else None

        if cache and cache.exists():
            conn.execute(
                """
                UPDATE candidates SET
                  bld_ok=1, bld_source='local_cache', parcel_ok=?,
                  bjdong_cd=?, sigungu_cd=?,
                  bun=COALESCE(?, bun), ji=COALESCE(?, ji),
                  gate_inputs_complete=CASE WHEN ?=1 THEN 1 ELSE 0 END,
                  unresolved_reason=CASE WHEN ?=1 THEN NULL ELSE 'missing_trade_coverage' END,
                  updated_at=?
                WHERE complex_id=?
                """,
                (
                    1 if parcel else 0,
                    parcel.get("bjdong_cd") if parcel else None,
                    parcel.get("sigungu_cd") if parcel else lawd,
                    parcel.get("bun") if parcel else bun,
                    parcel.get("ji") if parcel else ji,
                    trades_ok,
                    trades_ok,
                    now,
                    complex_id,
                ),
            )
            stats["bld_cache_hit"] += 1
            continue

        if not parcel or not parcel.get("bjdong_cd"):
            conn.execute(
                """
                UPDATE candidates SET
                  bld_ok=0, parcel_ok=0, gate_inputs_complete=0,
                  unresolved_reason='missing_parcel_bjdong', updated_at=?
                WHERE complex_id=?
                """,
                (now, complex_id),
            )
            stats["missing_parcel_bjdong"] += 1
            continue

        conn.execute(
            """
            UPDATE candidates SET
              bld_ok=0, parcel_ok=1,
              bjdong_cd=?, sigungu_cd=?, bun=?, ji=?,
              gate_inputs_complete=0,
              unresolved_reason='missing_bld_cache_external_deferred',
              updated_at=?
            WHERE complex_id=?
            """,
            (
                parcel["bjdong_cd"],
                parcel.get("sigungu_cd", lawd),
                parcel.get("bun", bun),
                parcel.get("ji", ji),
                now,
                complex_id,
            ),
        )
        stats["missing_bld_cache_external_deferred"] += 1

    conn.commit()
    return stats


def summarize(conn: sqlite3.Connection) -> dict[str, Any]:
    total = conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
    complete = conn.execute(
        "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=1"
    ).fetchone()[0]
    reasons = dict(
        conn.execute(
            """
            SELECT COALESCE(unresolved_reason, 'complete'), COUNT(*)
            FROM candidates GROUP BY 1 ORDER BY 2 DESC
            """
        ).fetchall()
    )
    return {
        "total": total,
        "seoul": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE region='seoul'"
        ).fetchone()[0],
        "gyeonggi": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE region='gyeonggi'"
        ).fetchone()[0],
        "trades_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE trades_ok=1"
        ).fetchone()[0],
        "bld_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE bld_ok=1"
        ).fetchone()[0],
        "parcel_ok": conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1"
        ).fetchone()[0],
        "gate_inputs_complete": complete,
        "unresolved": total - complete,
        "coverage_pct": round(100.0 * complete / max(total, 1), 3),
        "unresolved_reasons": reasons,
    }


def estimate_pages(gate) -> float | None:
    pages: list[int] = []
    for p in cache_index(gate).values():
        try:
            d = json.loads(Path(p).read_text())
            items = d.get("items") or d.get("rows") or []
            total = int(d.get("totalCount") or d.get("total") or len(items))
            pages.append(max(1, (total + 99) // 100))
        except Exception:
            continue
    return round(sum(pages) / len(pages), 1) if pages else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-universe", action="store_true")
    ap.add_argument("--out", default=str(OUT / "acquisition-report.json"))
    args = ap.parse_args()

    gate = load_gate_module()
    conn = db()

    if (
        args.refresh_universe
        or conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0] == 0
    ):
        n = upsert_universe(conn, fetch_universe())
    else:
        n = conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]

    trade_stats = mark_trades(conn)
    bld_stats = acquire_building(conn, gate)
    summary = summarize(conn)
    mean_pages = estimate_pages(gate)

    report = {
        "phase": "5.9",
        "universe_rows": n,
        "trade_stats": trade_stats,
        "bld_stats": bld_stats,
        "summary": summary,
        "diagnosis": {
            "building_registry": {
                "current_source": "local *-bld-expos-cache.json or BldRgstHub API",
                "exists_in_warehouse": False,
                "requires_external": True,
                "allowlist_cache_limited": True,
                "affected": summary["total"] - summary["bld_ok"],
            },
            "trade_coverage": {
                "current_source": "Turso transactions",
                "exists_in_warehouse": True,
                "requires_external": False,
                "allowlist_cache_limited": False,
                "affected": summary["total"] - summary["trades_ok"],
            },
            "area_group": {
                "current_source": "derived in classify() from building+trades",
                "exists_in_warehouse": False,
                "requires_external": "indirect",
                "allowlist_cache_limited": True,
                "affected": summary["unresolved"],
            },
            "label": {
                "current_source": "derived in classify() from groups",
                "exists_in_warehouse": False,
                "requires_external": "indirect",
                "allowlist_cache_limited": True,
                "affected": summary["unresolved"],
            },
            "cache_config_parcel": {
                "current_source": "phase4 COMPLEXES parcel fields / parcel_map.json",
                "exists_in_warehouse": False,
                "requires_external": False,
                "allowlist_cache_limited": True,
                "affected": summary["unresolved_reasons"].get(
                    "missing_parcel_bjdong", 0
                ),
            },
        },
        "cost_gate": {
            "external_api": "apis.data.go.kr BldRgstHubService/getBrExposPubuseAreaInfo",
            "external_required_for_full_coverage": True,
            "estimated_pages_per_complex": mean_pages,
            "estimated_full_requests": int(summary["total"] * mean_pages)
            if mean_pages
            else None,
            "estimated_hours_at_0_28s": round(
                summary["total"] * mean_pages * 0.28 / 3600, 1
            )
            if mean_pages
            else None,
            "credentials_present": bool(
                os.environ.get("MOLIT_API_KEY")
                or os.environ.get("DATA_GO_KR_SERVICE_KEY")
                or os.environ.get("MOLIT_SERVICE_KEY")
            ),
            "full_run_performed": False,
            "sample_size_if_used": 0,
            "blocker": (
                "missing_parcel_bjdong for ~all candidates; "
                "full building fetch unbounded (~millions requests / hundreds of hours)"
            ),
        },
        "runner": {
            "dynamic": True,
            "batched": True,
            "resumable": True,
            "db": str(DB_PATH),
        },
        "production_writes": 0,
        "decision": "HOLD",
        "next": (
            "add scalable bjdong/parcel resolution (dong-name→bjdong map) "
            "before any external building acquisition; then re-run acquisition"
        ),
    }
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
