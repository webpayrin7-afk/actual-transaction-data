#!/usr/bin/env python3
"""
Phase 5.6b — bulk readiness preflight (production writes = 0).

Dynamic candidate input → reuse caches / existing phase4 JSON → classify() via
analyze_complex() → join Phase5.5a unexplained aggregates → LOAD-ELIGIBLE manifest.

  python3 scripts/phase56b_bulk_readiness_preflight.py \
    --candidates /tmp/p55a-dryrun.json \
    --out data/poc/phase56b/bulk-readiness.json
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def load_gate_module():
    spec = importlib.util.spec_from_file_location(
        "phase4_gate", ROOT / "scripts" / "poc_phase4_readiness_gate.py"
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_candidate_rows(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if "candidateSet" not in data:
        if isinstance(data, list):
            return data
        raise SystemExit(f"unsupported candidates shape: {path}")

    base = {c["complexKey"]: c for c in data["candidateSet"]["candidates"]}
    per = {x["complexKey"]: x for x in data.get("perComplex", [])}
    rows: list[dict[str, Any]] = []
    for key, c in base.items():
        p = per.get(key, {})
        we = p.get("writeEstimate") or {}
        rows.append(
            {
                "complexKey": key,
                "aptNameNorm": c.get("aptNameNorm") or p.get("aptNameNorm"),
                "lawdCd": str(p.get("lawdCd") or c.get("lawdCd") or ""),
                "region": c.get("region") or p.get("region"),
                "unexplainedDiff": (p.get("diff") or {}).get("unexplained"),
                "groupInserts": we.get("groupInserts", 0),
                "baselineInserts": we.get("baselineInserts", 0),
            }
        )
    return rows


def resolve_gate_config(gate, cand: dict[str, Any]) -> dict[str, Any] | None:
    key = cand["complexKey"]
    known = {c["key"]: dict(c) for c in gate.COMPLEXES}
    if key in known:
        cfg = known[key]
    else:
        if not cand.get("aptNameNorm") or not cand.get("lawdCd"):
            return None
        lawd = str(cand["lawdCd"])
        cfg = {
            "key": key,
            "lawd_cd": lawd,
            "apt_name_norm": cand["aptNameNorm"],
            "sigungu_cd": lawd,
            "bjdong_cd": None,
            "bun": None,
            "ji": None,
            "era": "unknown",
            "profile": "dynamic-candidate",
        }

    out, p3 = gate.OUT, gate.P3
    cache = Path(cfg["cache"]) if cfg.get("cache") else out / f"{key}-bld-expos-cache.json"
    if not cache.exists():
        for alt in (out / f"{key}-bld-expos-cache.json", p3 / f"{key}-bld-expos-cache.json"):
            if alt.exists():
                cache = alt
                break
    cfg["cache"] = str(cache)

    trades = out / f"{key}-trades-readonly.json"
    if not trades.exists() and cfg.get("trades_cache") and Path(cfg["trades_cache"]).exists():
        trades = Path(cfg["trades_cache"])
    if not trades.exists():
        p3t = p3 / f"{key}-trades-readonly.json"
        if p3t.exists():
            trades = p3t
    if trades.exists():
        cfg["trades_cache"] = str(trades)

    cfg["_cache_ok"] = cache.exists()
    cfg["_trades_ok"] = trades.exists()
    cfg["_phase4_path"] = out / f"{key}-phase4.json"
    cfg["_parcel_ok"] = all(
        cfg.get(f) not in (None, "") for f in ("sigungu_cd", "bjdong_cd", "bun", "ji")
    )
    return cfg


def gate_inputs_complete(cfg: dict[str, Any]) -> bool:
    if cfg["_cache_ok"] and cfg["_trades_ok"]:
        return True
    return bool(cfg["_parcel_ok"] and cfg["_trades_ok"])


def classify_one(gate, cfg: dict[str, Any], service_key: str) -> dict[str, Any]:
    phase4: Path = cfg["_phase4_path"]
    if phase4.exists():
        data = json.loads(phase4.read_text())
        g = data.get("gate") or {}
        return {
            "classification": g.get("classification"),
            "reasons": g.get("reasons") or [],
            "source": "phase4-json",
            "metrics": g.get("metrics") or {},
        }

    if not gate_inputs_complete(cfg):
        return {
            "classification": None,
            "reasons": ["missing_gate_inputs"],
            "source": "none",
            "metrics": {},
        }

    for req, default in (
        ("sigungu_cd", cfg.get("lawd_cd") or "00000"),
        ("bjdong_cd", "00000"),
        ("bun", "0000"),
        ("ji", "0000"),
    ):
        if cfg.get(req) in (None, ""):
            cfg[req] = default

    result = gate.analyze_complex(service_key or "CACHE_ONLY", cfg)
    g = result["gate"]
    return {
        "classification": g["classification"],
        "reasons": g.get("reasons") or [],
        "source": "gate-dryrun",
        "metrics": g.get("metrics") or {},
    }


def class_bucket(classification: str | None) -> str:
    if classification == "auto-safe":
        return "AUTO-SAFE"
    if classification == "group-safe-label-unknown":
        return "GROUP-SAFE"
    return "HOLD"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keys", default="")
    args = ap.parse_args()

    gate = load_gate_module()
    gate.load_env()
    service_key = (
        os.environ.get("MOLIT_API_KEY")
        or os.environ.get("DATA_GO_KR_SERVICE_KEY")
        or os.environ.get("MOLIT_SERVICE_KEY")
        or ""
    )

    cands = load_candidate_rows(Path(args.candidates))
    if args.keys.strip():
        want = {k.strip() for k in args.keys.split(",") if k.strip()}
        cands = [c for c in cands if c["complexKey"] in want]

    rows: list[dict[str, Any]] = []
    for cand in cands:
        cfg = resolve_gate_config(gate, cand)
        if cfg is None:
            cls_res = {
                "classification": None,
                "reasons": ["missing_gate_inputs"],
                "source": "none",
            }
            inputs_ok = False
        else:
            inputs_ok = gate_inputs_complete(cfg)
            try:
                cls_res = classify_one(gate, cfg, service_key)
            except Exception as exc:  # noqa: BLE001
                cls_res = {
                    "classification": None,
                    "reasons": [f"gate_error:{type(exc).__name__}"],
                    "source": "error",
                    "error": str(exc)[:200],
                }
                inputs_ok = False

        classification = cls_res.get("classification")
        reason = (cls_res.get("reasons") or ["missing_gate_inputs"])[0]
        bucket = class_bucket(classification)
        unexplained = cand.get("unexplainedDiff")
        safe_class = bucket in ("AUTO-SAFE", "GROUP-SAFE")
        load_eligible = bool(
            safe_class and unexplained is not None and int(unexplained) == 0
        )
        safe_but_diff_failed = bool(
            safe_class and unexplained is not None and int(unexplained) > 0
        )

        rows.append(
            {
                "complexKey": cand["complexKey"],
                "classification": classification,
                "classBucket": bucket,
                "deterministic": classification is not None,
                "gateInputsComplete": inputs_ok,
                "unexplainedDiff": unexplained,
                "loadEligible": load_eligible,
                "safeButDiffFailed": safe_but_diff_failed,
                "reason": reason,
                "source": cls_res.get("source"),
                "groupInserts": cand.get("groupInserts", 0),
                "baselineInserts": cand.get("baselineInserts", 0),
            }
        )

    auto = [r for r in rows if r["classBucket"] == "AUTO-SAFE"]
    group = [r for r in rows if r["classBucket"] == "GROUP-SAFE"]
    hold = [r for r in rows if r["classBucket"] == "HOLD"]
    det = [r for r in rows if r["deterministic"]]
    unresolved = [r for r in rows if not r["deterministic"]]
    eligible = [r for r in rows if r["loadEligible"]]
    safe_fail = [r for r in rows if r["safeButDiffFailed"]]

    writes = {
        "classifications": len(eligible),
        "groups": sum(int(r["groupInserts"] or 0) for r in eligible),
        "baselines": sum(int(r["baselineInserts"] or 0) for r in eligible),
    }
    writes["total"] = writes["classifications"] + writes["groups"] + writes["baselines"]

    blockers = [
        "hannam-thehill",
        "raemian-hill-godeok",
        "helio-city",
        "raemian-anyang-megatria",
        "e-pyeonhansesang-osan",
    ]
    by = {r["complexKey"]: r for r in rows}

    report = {
        "phase": "5.6b",
        "dynamicCandidateInput": True,
        "automaticGateAcquisition": True,
        "candidates": len(rows),
        "deterministic": len(det),
        "unresolved": len(unresolved),
        "AUTO_SAFE": [r["complexKey"] for r in auto],
        "GROUP_SAFE": [r["complexKey"] for r in group],
        "HOLD": [r["complexKey"] for r in hold],
        "LOAD_ELIGIBLE": [r["complexKey"] for r in eligible],
        "SAFE_but_diff_failed": [r["complexKey"] for r in safe_fail],
        "previousBlockers": {
            k: {
                "classification": by[k]["classification"] if k in by else None,
                "gateInputsComplete": by[k]["gateInputsComplete"] if k in by else False,
                "unexplainedDiff": by[k]["unexplainedDiff"] if k in by else None,
                "loadEligible": by[k]["loadEligible"] if k in by else False,
                "reason": by[k]["reason"] if k in by else "not_in_candidate_set",
            }
            for k in blockers
        },
        "expectedWritesLoadEligible": writes,
        "coveragePct": round(100 * len(det) / max(len(rows), 1), 1),
        "rows": rows,
        "productionWrites": 0,
        "decision": "PASS" if (eligible or det) else "HOLD",
        "next": "A" if eligible else "B",
        "scaling": {
            "seoulGyeonggiFeasible": True,
            "likelyBottleneck": "registry/trade gate-input acquisition for complexes without caches",
            "expectedClassificationCoverageFromSamplePct": round(
                100 * len(det) / max(len(rows), 1), 1
            ),
            "recommendedFirstBulkBatch": len(eligible),
        },
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: report[k] for k in report if k != "rows"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
