#!/usr/bin/env python3
"""Phase 4.5 cache reclassifier — uses 관리공동형별개요 as primary cross-check.

Reads HsPmsHub caches written by poc_phase45_cross_validate.py and Phase4 JSON.
No network required. No production writes.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase45"
CACHE = OUT / "cache"
P4_DIR = ROOT / "data" / "poc" / "phase4"

TARGETS = [
    {"key": "eunma", "name": "은마", "role": "D", "kapt_code": "A13583507"},
    {"key": "mokdong-7", "name": "목동신시가지7", "role": "C", "kapt_code": None},
    {"key": "olympic-family", "name": "올림픽훼밀리타운", "role": "C", "kapt_code": "A13820201"},
    {"key": "jamsil-els", "name": "잠실엘스", "role": "B", "kapt_code": "A13822004"},
    {"key": "banpo-xi", "name": "반포자이", "role": "B", "kapt_code": "A13704104"},
    {"key": "hangang-daewoo", "name": "한강대우", "role": "A-control", "kapt_code": "A14003105"},
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fnum(x: Any) -> float | None:
    if x is None or x == "":
        return None
    try:
        return float(str(x).replace(",", ""))
    except ValueError:
        return None


def r2(x: float | None) -> float | None:
    return None if x is None else round(float(x) + 1e-12, 2)


def load_cache(key: str, op: str) -> list[dict]:
    path = CACHE / f"{key}__{op}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text()).get("items") or []


def load_p4(key: str) -> dict | None:
    path = P4_DIR / f"{key}-phase4.json"
    return json.loads(path.read_text()) if path.exists() else None


def load_kapt(code: str | None) -> dict:
    if not code:
        return {"ok": False}
    path = CACHE / f"kapt_{code}.json"
    return json.loads(path.read_text()) if path.exists() else {"ok": False}


def parse_type_label(type_gb: str) -> tuple[int | None, str | None]:
    if not type_gb:
        return None, "empty"
    m = re.match(r"^(\d{2})([A-Za-z].*)?$", type_gb.strip())
    if not m:
        return None, "non_pyeong_code"
    n = int(m.group(1))
    if n in (24, 25, 33, 34):
        return None, "24_25_or_33_34_zone"
    if n in (59, 84) or n >= 100:
        return None, "looks_like_exclusive"
    if 15 <= n <= 90:
        return n, None
    return None, "out_of_range"


def analyze_mgm(items: list[dict]) -> dict:
    best: dict[tuple, dict] = {}
    for it in items:
        t = it.get("typeGb") or ""
        excl = fnum(it.get("exuseArea"))
        hh = fnum(it.get("hhldCnt")) or 0.0
        key = (t, excl)
        prev = best.get(key)
        if prev is None or hh > prev["households"]:
            label, reason = parse_type_label(t)
            best[key] = {
                "typeGb": t,
                "exclusive": excl,
                "households": hh,
                "market_label": label,
                "label_reason": reason,
                "cmplxNm": it.get("cmplxNm") or "",
            }
    types = [t for t in best.values() if t["households"] > 0]
    types.sort(key=lambda x: -x["households"])
    total_hh = sum(t["households"] for t in types) or 0.0
    with_excl = sum(t["households"] for t in types if t["exclusive"] and t["exclusive"] > 1)
    labeled = sum(t["households"] for t in types if t["market_label"] is not None)

    groups: list[dict] = []
    for t in types:
        if not t["exclusive"] or t["exclusive"] <= 1:
            continue
        placed = False
        for g in groups:
            if abs(g["exclusive_min"] - t["exclusive"]) <= 1.0:
                g["types"].append(t)
                g["households"] += t["households"]
                g["exclusive_min"] = min(g["exclusive_min"], t["exclusive"])
                g["exclusive_max"] = max(g["exclusive_max"], t["exclusive"])
                placed = True
                break
        if not placed:
            groups.append(
                {
                    "exclusive_min": t["exclusive"],
                    "exclusive_max": t["exclusive"],
                    "households": t["households"],
                    "types": [t],
                }
            )

    return {
        "type_count": len(types),
        "households_sum": total_hh,
        "exclusive_coverage": with_excl / max(total_hh, 1),
        "label_confidence": labeled / max(total_hh, 1),
        "group_count": len(groups),
        "multi_type_same_exclusive_groups": sum(1 for g in groups if len(g["types"]) >= 2),
        "types": types,
        "groups": [
            {
                "exclusive": [g["exclusive_min"], g["exclusive_max"]],
                "households": g["households"],
                "type_variants": len(g["types"]),
                "labels": sorted({x["market_label"] for x in g["types"] if x["market_label"] is not None}),
                "typeGbs": [x["typeGb"] for x in g["types"]],
            }
            for g in groups
        ],
    }


def reclassify(p4: dict | None, mgm: dict, kapt: dict, hs_counts: dict) -> dict:
    p4_class = (p4 or {}).get("gate", {}).get("classification") or "unknown"
    p4_metrics = (p4 or {}).get("gate", {}).get("metrics") or {}
    reasons: list[str] = []
    excl_cov = mgm.get("exclusive_coverage") or 0.0
    label_conf = mgm.get("label_confidence") or 0.0
    hh = mgm.get("households_sum") or 0.0
    kapt_hh = kapt.get("households") if kapt.get("ok") else None
    hh_delta = abs(kapt_hh - hh) / max(kapt_hh, 1) if (kapt_hh and hh) else None

    rescued = False
    if hh > 0 and excl_cov < 0.05:
        if p4_class == "registry-abnormal":
            new, supply, group = "registry-abnormal", "blocked", "blocked"
            reason = "형별개요에 전용면적 0 — 은마형 구조 유지"
        else:
            new, supply, group = "ambiguous", "low", "medium"
            reason = "형별개요 세대수/타입코드만 있고 전용·공급면적 없음"
        reasons.append("mgm_exclusive_missing")
    elif excl_cov >= 0.80 and hh > 0:
        supply, group = "high", "high"
        if label_conf >= 0.70:
            new = "auto-safe"
            reasons.append(f"mgm_label_confidence={label_conf:.2f}")
            reason = "관리공동형별개요로 전용면적+평형코드 확인"
        else:
            new = "group-safe-label-unknown"
            reasons.append(f"mgm_label_confidence={label_conf:.2f}")
            reason = "전용면적 그룹은 확실, 평형 label은 타입코드로 미확정"
        if p4_class in ("ambiguous", "registry-abnormal") and new in (
            "auto-safe",
            "group-safe-label-unknown",
        ):
            rescued = True
        if p4_class == "group-safe-label-unknown" and new == "auto-safe":
            rescued = True
            reason = "형별개요 typeGb로 label 확정"
    elif excl_cov >= 0.40:
        new, supply, group = "group-safe-label-unknown", "medium", "medium"
        reason = "형별개요 전용면적 부분 커버"
        rescued = p4_class == "ambiguous"
        reasons.append(f"mgm_exclusive_coverage={excl_cov:.2f}")
    else:
        new = p4_class if p4_class != "unknown" else "ambiguous"
        supply, group = "none", "unchanged"
        reason = "주택인허가 형별/행위호 면적 유용정보 부족 — Phase4 유지"
        reasons.append("mgm_insufficient")

    if hh_delta is not None and hh_delta > 0.20 and new == "auto-safe":
        new = "group-safe-label-unknown"
        reasons.append(f"downgrade_kapt_hh_delta={hh_delta:.2f}")

    return {
        "phase4_class": p4_class,
        "new_class": new,
        "changed": p4_class != new,
        "rescued": rescued,
        "rescue_reason": reason,
        "reasons": reasons,
        "supply_confidence": supply,
        "market_group_confidence": group,
        "label_confidence": r2(label_conf),
        "metrics": {
            "mgm_households_sum": hh,
            "mgm_exclusive_coverage": r2(excl_cov),
            "mgm_type_count": mgm.get("type_count"),
            "mgm_group_count": mgm.get("group_count"),
            "multi_type_same_exclusive_groups": mgm.get("multi_type_same_exclusive_groups"),
            "kapt_households": kapt_hh,
            "kapt_dong_cnt": kapt.get("dong_cnt"),
            "household_delta_vs_kapt": r2(hh_delta) if hh_delta is not None else None,
            "hs_counts": hs_counts,
            "phase4_unknown_common": p4_metrics.get("unknown_common_area_ratio"),
            "phase4_label_confidence": p4_metrics.get("label_confidence"),
        },
    }


def main() -> int:
    results = []
    for c in TARGETS:
        p4 = load_p4(c["key"])
        mgm_items = load_cache(c["key"], "getHpMgmCoopTpOulnInfo")
        mgm = analyze_mgm(mgm_items)
        kapt = load_kapt(c.get("kapt_code"))
        prev = OUT / f"{c['key']}-phase45.json"
        hs_counts = {}
        if prev.exists():
            hs_counts = (
                (json.loads(prev.read_text()).get("sources") or {})
                .get("housing_permit", {})
                .get("counts")
                or {}
            )
        gate = reclassify(p4, mgm, kapt, hs_counts)
        out = {
            "complex": c,
            "sources": {
                "housing_permit_mgm_type_count": len(mgm_items),
                "kapt": kapt,
                "notes": {
                    "ho_expos": "행위호 전유공용은 대체로 부대시설만 있거나 dong/ho 키 없음",
                    "mgm_coop_type": "관리공동형별개요가 전용면적·세대수·타입코드의 핵심 교차검증 소스",
                    "complex_id_api": "current MOLIT key: not registered",
                    "cheongyak": "401 without dedicated key; no fields used",
                },
            },
            "housing_permit_analysis": {"mgm_coop_type": mgm},
            "phase4_ref": {
                "classification": (p4 or {}).get("gate", {}).get("classification"),
                "metrics": (p4 or {}).get("gate", {}).get("metrics"),
                "reasons": (p4 or {}).get("gate", {}).get("reasons"),
            }
            if p4
            else None,
            "gate": gate,
            "fetchedAt": now(),
        }
        (OUT / f"{c['key']}-phase45.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
        results.append(out)
        print(
            f"{c['key']}: {gate['phase4_class']} → {gate['new_class']} "
            f"rescued={gate['rescued']} supply={gate['supply_confidence']} "
            f"label={gate['label_confidence']} | {gate['rescue_reason']}"
        )

    n = len(results) or 1
    p4_ab = sum(
        1
        for r in results
        if (r["phase4_ref"] or {}).get("classification") in ("auto-safe", "group-safe-label-unknown")
    )
    new_ab = sum(1 for r in results if r["gate"]["new_class"] in ("auto-safe", "group-safe-label-unknown"))
    rescued = sum(1 for r in results if r["gate"]["rescued"])
    non = [r for r in results if r["complex"]["role"] != "A-control"]
    c_probe = [r for r in non if r["complex"]["role"] == "C"]
    d_probe = [r for r in non if r["complex"]["role"] == "D"]
    b_probe = [r for r in non if r["complex"]["role"] == "B"]
    c_rescue = sum(1 for r in c_probe if r["gate"]["rescued"]) / max(len(c_probe), 1)
    d_rescue = sum(1 for r in d_probe if r["gate"]["rescued"]) / max(len(d_probe), 1)
    b_to_a = sum(
        1
        for r in b_probe
        if r["gate"]["phase4_class"] == "group-safe-label-unknown" and r["gate"]["new_class"] == "auto-safe"
    ) / max(len(b_probe), 1)
    base_ab = 0.81
    est_ab = min(1.0, base_ab + 0.13 * c_rescue + 0.06 * d_rescue)
    est_auto = min(1.0, 0.50 + 0.31 * b_to_a + 0.13 * c_rescue * 0.5)
    summary = {
        "generatedAt": now(),
        "scope": {
            "production_db_write": False,
            "selector_change": False,
            "singoga_production_change": False,
            "nationwide_backfill": False,
        },
        "sample_size": n,
        "rescued_count": rescued,
        "sample_singoga_applicable": {
            "phase4": p4_ab / n,
            "phase45": new_ab / n,
            "delta_pp": (new_ab - p4_ab) / n,
        },
        "nationwide_estimate_from_phase4_base": {
            "method": "Apply observed C/D/B rescue rates onto Phase4 16-complex base rates",
            "phase4_singoga_applicable": base_ab,
            "phase45_singoga_applicable_est": round(est_ab, 3),
            "delta_pp_est": round(est_ab - base_ab, 3),
            "phase4_auto_safe": 0.50,
            "phase45_auto_safe_est": round(est_auto, 3),
            "c_rescue_rate": round(c_rescue, 3),
            "d_rescue_rate": round(d_rescue, 3),
            "b_to_a_rate": round(b_to_a, 3),
        },
        "complexes": [
            {
                "key": r["complex"]["key"],
                "name": r["complex"]["name"],
                "role": r["complex"]["role"],
                "phase4": r["gate"]["phase4_class"],
                "phase45": r["gate"]["new_class"],
                "changed": r["gate"]["changed"],
                "rescued": r["gate"]["rescued"],
                "rescue_reason": r["gate"]["rescue_reason"],
                "supply_confidence": r["gate"]["supply_confidence"],
                "market_group_confidence": r["gate"]["market_group_confidence"],
                "label_confidence": r["gate"]["label_confidence"],
                "metrics": r["gate"]["metrics"],
            }
            for r in results
        ],
    }
    (OUT / "phase45-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary["nationwide_estimate_from_phase4_base"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
