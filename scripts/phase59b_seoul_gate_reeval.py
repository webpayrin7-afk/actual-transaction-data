#!/usr/bin/env python3
"""Phase 5.9b — Seoul gate reevaluation + optional promotion manifest.

Runs AFTER missing-only acquisition. Reuses Phase4 classify() on local caches only
(no BldRgst re-fetch, no Production writes).

LOAD_ELIGIBLE rule (Phase 5.6b/5.8):
  classification in {auto-safe, group-safe-label-unknown}
  AND unexplainedDiff == 0

For complexes with no existing production pyeong-group rows, unexplainedDiff is
treated as 0 (insert-only; matches Phase5.5a first-expansion posture).
Known Phase5.8 diff_failed allowlist keys remain HOLD.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import time
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase59b"
DB_PATH = OUT / "seoul_gate_inputs.sqlite"
REEVAL_PATH = OUT / "seoul_gate_reeval.json"
MANIFEST_DIR = OUT / "promotion_manifests"
PHASE58_SUMMARY = ROOT / "data" / "poc" / "phase58" / "summary.json"

# From Phase 5.8 examples.diff_failed
KNOWN_DIFF_FAILED = {
    "raemian-weve",
    "sangye-jugong9",
    "gwanak-prugio",
    "ricents",
    "sibom-hanyang",
    "anyang-samsung-raemian",
    "ilsan-zenith",
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_gate():
    path = ROOT / "scripts" / "poc_phase4_readiness_gate.py"
    spec = importlib.util.spec_from_file_location("phase4_gate", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def production_group_keys() -> set[str]:
    js = r"""
const {createClient}=require('@libsql/client');
const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
(async()=>{
  try {
    const r=await db.execute(`SELECT DISTINCT complex_key FROM apt_pyeong_groups`);
    process.stdout.write(JSON.stringify(r.rows.map(x=>String(x.complex_key))));
  } catch(e) {
    process.stdout.write('[]');
  }
})();
"""
    raw = subprocess.check_output(["node", "-e", js], env=os.environ, cwd=str(ROOT))
    return set(json.loads(raw))


def bulk_trades(pairs: list[tuple[str, str]]) -> dict[str, list[dict]]:
    """Fetch trades for many (lawd, apt) in one node process."""
    payload = json.dumps([{"lawd_cd": a, "apt_name_norm": b} for a, b in pairs])
    script = OUT / "_bulk_trades_export.mjs"
    out_path = OUT / "_bulk_trades.json"
    script.write_text(
        f"""
import {{ createClient }} from "@libsql/client";
import {{ writeFileSync, readFileSync }} from "node:fs";
const pairs = JSON.parse({json.dumps(payload)});
const db = createClient({{
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
}});
const out = {{}};
for (const p of pairs) {{
  const key = p.lawd_cd + ":" + p.apt_name_norm;
  const r = await db.execute({{
    sql: `SELECT id, deal_date, exclusive_area, deal_amount, dealing_gbn
          FROM transactions
          WHERE deal_type='trade' AND lawd_cd=? AND apt_name_norm=?
          ORDER BY deal_date, id`,
    args: [p.lawd_cd, p.apt_name_norm],
  }});
  out[key] = r.rows.map((row) => ({{
    id: String(row.id),
    deal_date: String(row.deal_date),
    exclusive_area: Number(row.exclusive_area),
    deal_amount: Number(row.deal_amount),
    dealing_gbn: row.dealing_gbn == null ? "" : String(row.dealing_gbn),
  }}));
}}
writeFileSync({json.dumps(str(out_path))}, JSON.stringify(out));
console.log("pairs", pairs.length, "keys", Object.keys(out).length);
"""
    )
    subprocess.check_call(["node", str(script)], cwd=str(ROOT), env=os.environ)
    return json.loads(out_path.read_text())


def classify_row(gate, row: dict[str, Any], trades: list[dict]) -> dict[str, Any]:
    cache = Path(row["bld_cache_path"] or "")
    if not cache.exists():
        return {"classification": None, "reasons": ["missing_cache"]}
    data = json.loads(cache.read_text())
    items = data.get("items") or []
    if not items:
        return {"classification": None, "reasons": ["registry_empty"]}

    cfg = {
        "key": row["complex_id"].replace(":", "__"),
        "lawd_cd": row["lawd_cd"],
        "apt_name_norm": row["apt_name_norm"],
        "sigungu_cd": row["sigungu_cd"],
        "bjdong_cd": row["bjdong_cd"],
        "bun": row["bun"],
        "ji": row["ji"],
        "era": "unknown",
        "profile": "seoul-phase59b",
        "cache": str(cache),
    }
    units, common_stats = gate.build_units(items)
    types = gate.build_unit_types(cfg, units)
    groups = gate.build_groups(cfg, types)
    gate_res = gate.classify(units, types, groups, trades, common_stats)
    return {
        "classification": gate_res["classification"],
        "reasons": gate_res["reasons"],
        "metrics": gate_res.get("metrics"),
        "group_count": len(groups),
        "unit_type_count": len(types),
        "unit_households": len(units),
        "groups": groups,
    }


def bucket(classification: str | None) -> str:
    if classification == "auto-safe":
        return "AUTO_SAFE"
    if classification == "group-safe-label-unknown":
        return "GROUP_SAFE_LABEL_UNKNOWN"
    if classification == "ambiguous":
        return "AMBIGUOUS"
    if classification == "registry-abnormal":
        return "REGISTRY_ABNORMAL"
    return "UNRESOLVED"


def build_manifest(eligible: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not eligible:
        return None
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    # deterministic ordering
    eligible = sorted(eligible, key=lambda r: r["complex_id"])
    targets = []
    for r in eligible:
        targets.append(
            {
                "complex_id": r["complex_id"],
                "lawd_cd": r["lawd_cd"],
                "apt_name_norm": r["apt_name_norm"],
                "classification": r["classification"],
                "group_count": r.get("group_count", 0),
                "unit_type_count": r.get("unit_type_count", 0),
                "bld_cache_path": r.get("bld_cache_path"),
                "gate_version": "phase4.classify/phase59b",
                "source_cache_version": "bldrgst_expos_v1",
            }
        )
    body = {
        "manifest_type": "seoul_unit_master_promotion",
        "generated_at": now_iso(),
        "region": "seoul",
        "gate_version": "phase4.classify/phase59b",
        "source_cache_version": "bldrgst_expos_v1",
        "target_count": len(targets),
        "complex_count": len(targets),
        "targets": targets,
        "production_writes": 0,
        "note": "Immutable promotion input only. Do not auto-load to Production.",
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    body["manifest_id"] = f"seoul-promo-{digest[:16]}"
    body["manifest_hash"] = digest
    path = MANIFEST_DIR / f"{body['manifest_id']}.json"
    # freeze without re-hashing mutable fields after id assignment
    frozen = json.dumps(body, ensure_ascii=False, indent=2)
    path.write_text(frozen)
    # also write pointer
    (MANIFEST_DIR / "LATEST.json").write_text(
        json.dumps(
            {
                "path": str(path.relative_to(ROOT)),
                "manifest_id": body["manifest_id"],
                "manifest_hash": digest,
                "complexes": len(targets),
                "targets": len(targets),
                "generated_at": body["generated_at"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return {
        "created": True,
        "path": str(path.relative_to(ROOT)),
        "hash": digest,
        "manifest_id": body["manifest_id"],
        "complexes": len(targets),
        "targets": len(targets),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--chunk", type=int, default=200)
    args = ap.parse_args()

    gate = load_gate()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT complex_id, lawd_cd, apt_name_norm, sigungu_cd, bjdong_cd, bun, ji,
               bld_cache_path, gate_inputs_complete
        FROM candidates
        WHERE gate_inputs_complete=1
        ORDER BY complex_id
        """
    ).fetchall()
    rows = [dict(r) for r in rows]
    if args.limit is not None:
        rows = rows[: args.limit]

    prior = json.loads(PHASE58_SUMMARY.read_text()) if PHASE58_SUMMARY.exists() else {}
    prod_keys = production_group_keys()

    results: list[dict[str, Any]] = []
    for i in range(0, len(rows), args.chunk):
        chunk = rows[i : i + args.chunk]
        trades_map = bulk_trades([(r["lawd_cd"], r["apt_name_norm"]) for r in chunk])
        for r in chunk:
            trades = trades_map.get(r["complex_id"], [])
            cls = classify_row(gate, r, trades)
            b = bucket(cls.get("classification"))
            key_slug = r["complex_id"].replace(":", "__")
            # allowlist complex keys from COMPLEXES
            allow_key = None
            for c in gate.COMPLEXES:
                if c["lawd_cd"] == r["lawd_cd"] and c["apt_name_norm"] == r["apt_name_norm"]:
                    allow_key = c["key"]
                    break
            complex_key = allow_key or key_slug
            if allow_key and allow_key in KNOWN_DIFF_FAILED:
                unexplained = 1  # retain Phase5.8 HOLD
            elif complex_key in prod_keys or allow_key in prod_keys:
                # existing production rows present — require separate diff job
                unexplained = None
            else:
                unexplained = 0

            safe = b in ("AUTO_SAFE", "GROUP_SAFE_LABEL_UNKNOWN")
            load_eligible = bool(safe and unexplained == 0)
            hold_reason = None
            if not cls.get("classification"):
                hold_reason = (cls.get("reasons") or ["unresolved"])[0]
            elif not safe:
                hold_reason = b.lower()
            elif unexplained is None:
                hold_reason = "diff_pending_existing_production"
            elif unexplained > 0:
                hold_reason = "diff_failed"
            results.append(
                {
                    "complex_id": r["complex_id"],
                    "complex_key": complex_key,
                    "lawd_cd": r["lawd_cd"],
                    "apt_name_norm": r["apt_name_norm"],
                    "classification": cls.get("classification"),
                    "bucket": b,
                    "reasons": cls.get("reasons"),
                    "group_count": cls.get("group_count"),
                    "unit_type_count": cls.get("unit_type_count"),
                    "unit_households": cls.get("unit_households"),
                    "unexplainedDiff": unexplained,
                    "loadEligible": load_eligible,
                    "hold_reason": hold_reason,
                    "bld_cache_path": r["bld_cache_path"],
                }
            )
        print(f"reeval {min(i+args.chunk, len(rows))}/{len(rows)}", flush=True)

    counts = Counter(r["bucket"] for r in results)
    eligible = [r for r in results if r["loadEligible"]]
    hold = [r for r in results if not r["loadEligible"]]
    inv = json.loads((OUT / "missing_inventory.json").read_text()) if (OUT / "missing_inventory.json").exists() else {}
    progress = (
        json.loads((OUT / "acquisition_progress.json").read_text())
        if (OUT / "acquisition_progress.json").exists()
        else {}
    )

    manifest = build_manifest(eligible)
    report = {
        "phase": "5.9b-reeval",
        "generated_at": now_iso(),
        "production_writes": 0,
        "seoul": {
            "total_complexes": conn.execute("SELECT COUNT(*) FROM candidates").fetchone()[0],
            "initial_gate_complete": 20,  # Phase5.9 SOT allowlist-complete
            "final_gate_complete": conn.execute(
                "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=1"
            ).fetchone()[0],
            "reeval_classified": len(results),
        },
        "acquisition": progress.get("stats") or progress,
        "inventory": inv,
        "gate": {
            "auto_safe": counts.get("AUTO_SAFE", 0),
            "group_safe": counts.get("GROUP_SAFE_LABEL_UNKNOWN", 0),
            "ambiguous": counts.get("AMBIGUOUS", 0),
            "registry_abnormal": counts.get("REGISTRY_ABNORMAL", 0),
            "unresolved": counts.get("UNRESOLVED", 0)
            + (
                conn.execute(
                    "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=0"
                ).fetchone()[0]
            ),
            "load_eligible": len(eligible),
            "hold": len(hold)
            + conn.execute(
                "SELECT COUNT(*) FROM candidates WHERE gate_inputs_complete=0"
            ).fetchone()[0],
        },
        "delta_vs_phase58": {
            "prior_auto_safe": (prior.get("classification") or {}).get("AUTO_SAFE"),
            "prior_group_safe": (prior.get("classification") or {}).get("GROUP_SAFE"),
            "prior_unresolved": (prior.get("classification") or {}).get("UNRESOLVED"),
            "prior_load_eligible": (prior.get("eligibility") or {}).get("LOAD_ELIGIBLE"),
            "new_auto_safe": counts.get("AUTO_SAFE", 0),
            "new_group_safe": counts.get("GROUP_SAFE_LABEL_UNKNOWN", 0),
            "new_load_eligible": len(eligible),
        },
        "manifest": manifest
        or {"created": False, "path": None, "hash": None, "complexes": 0, "targets": 0},
        "final": {
            "SEOUL_PROMOTION_READINESS": (
                "READY"
                if eligible and conn.execute(
                    "SELECT COUNT(*) FROM candidates WHERE parcel_ok=1 AND bld_ok=0"
                ).fetchone()[0]
                == 0
                else ("PARTIAL" if eligible else "HOLD")
            )
        },
        "samples": {
            "load_eligible": [r["complex_id"] for r in eligible[:20]],
            "hold": [
                {"complex_id": r["complex_id"], "reason": r["hold_reason"]}
                for r in hold[:20]
            ],
        },
    }
    REEVAL_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    # slim per-complex detail
    (OUT / "seoul_gate_reeval_rows.json").write_text(
        json.dumps(results, ensure_ascii=False)
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
