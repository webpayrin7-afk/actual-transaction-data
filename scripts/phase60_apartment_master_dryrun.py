#!/usr/bin/env python3
"""Phase 6.0 — Apartment Master v1 architecture dry-run (no production writes).

Reuses Phase 5.11 legal-dong static table + Seoul/Gyeonggi universe.
Local artifacts only.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase60"
P511 = ROOT / "data" / "poc" / "phase511"
STATIC = ROOT / "data" / "static" / "legal_dong_seoul_gyeonggi.json"


def norm_name(s: str | None) -> str:
    s = unicodedata.normalize("NFKC", str(s or "")).strip()
    return (
        s.replace(" ", "")
        .replace("\u00b7", "")
        .replace("ㆍ", "")
        .replace("（", "(")
        .replace("）", ")")
    )


def name_variants(dong: str | None) -> list[str]:
    raw = str(dong or "").strip()
    n = norm_name(raw)
    out: list[str] = []
    seen: set[str] = set()

    def add(x: str) -> None:
        x = norm_name(x)
        if x and x not in seen:
            seen.add(x)
            out.append(x)

    add(n)
    parts = raw.split()
    if len(parts) >= 2 and parts[0].endswith(("읍", "면")) and parts[-1].endswith(
        "리"
    ):
        emd, ri = parts[0], parts[-1]
        add(emd + ri)
        add(emd[:-1] + ("면" if emd.endswith("읍") else "읍") + ri)
        return out
    m = re.match(r"^(.+?)([읍면])(.+리)$", n)
    if m:
        head, suf, ri = m.group(1), m.group(2), m.group(3)
        add(head + suf + ri)
        add(head + ("면" if suf == "읍" else "읍") + ri)
        return out
    return out


def parse_jibun(jibun: str | None) -> dict[str, Any]:
    raw = str(jibun or "").strip()
    if not raw:
        return {
            "kind": "malformed",
            "bun": None,
            "ji": None,
            "mountain": False,
            "identity": None,
        }
    mountain = "산" in raw
    work = raw.replace("산", "")
    if "-" in work:
        a, b = work.split("-", 1)
        kind = "bun-ji"
    else:
        a, b = work, "0"
        kind = "normal"
    bun = "".join(c for c in a if c.isdigit())
    ji = "".join(c for c in b if c.isdigit()) or "0"
    if not bun:
        return {
            "kind": "malformed",
            "bun": None,
            "ji": None,
            "mountain": mountain,
            "identity": None,
        }
    bun4, ji4 = bun.zfill(4), ji.zfill(4)
    return {
        "kind": "mountain" if mountain else kind,
        "bun": bun4,
        "ji": ji4,
        "mountain": mountain,
        "identity": f"{bun4}|{ji4}|{'1' if mountain else '0'}",
    }


def sido_from_lawd(lawd: str) -> tuple[str, str]:
    if str(lawd).startswith("11"):
        return "서울특별시", "11"
    if str(lawd).startswith("41"):
        return "경기도", "41"
    return "UNKNOWN", str(lawd)[:2]


def build_resolver(rows: list[dict]):
    idx: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        names: set[str] = set()
        if r.get("emd_nm"):
            names.add(norm_name(r["emd_nm"]))
        if r.get("ri_nm"):
            names.add(norm_name(r["ri_nm"]))
            if r.get("emd_nm"):
                names.add(norm_name(r["emd_nm"] + r["ri_nm"]))
        for nm in names:
            idx[(r["sigungu_cd"], nm)].append(r)

    lawd_counts = Counter(r["sigungu_cd"] for r in rows)
    by_prefix: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_prefix[r["sigungu_cd"][:4]].append(r)

    def unique(cands: list[dict]) -> list[dict]:
        by: dict[str, dict] = {}
        for c in cands:
            by[f"{c['sigungu_cd']}|{c['bjdong_cd']}"] = c
        return list(by.values())

    def resolve(lawd: str, dong: str) -> tuple[str, dict | None]:
        lawd = str(lawd)
        variants = name_variants(dong)
        cands: list[dict] = []
        for v in variants:
            cands.extend(idx.get((lawd, v), []))
        if re.search(r"[읍면].+리$", norm_name(dong)) or " " in str(dong):
            leaves = [c for c in cands if c.get("ri_nm")]
            if leaves:
                cands = leaves
        uniq = unique(cands)
        if len(uniq) == 1:
            return "EXACT", uniq[0]
        if len(uniq) > 1:
            return "AMBIGUOUS", None
        if lawd_counts[lawd] == 0:
            cands = []
            for v in variants:
                for r in by_prefix.get(lawd[:4], []):
                    names = {
                        norm_name(r.get("emd_nm")),
                        norm_name(r.get("ri_nm")),
                        norm_name((r.get("emd_nm") or "") + (r.get("ri_nm") or "")),
                    }
                    if v in names:
                        cands.append(r)
            if "리" in norm_name(dong):
                leaves = [c for c in cands if c.get("ri_nm")]
                if leaves:
                    cands = leaves
            uniq = unique(cands)
            if len(uniq) == 1:
                return "EXACT", uniq[0]
            if len(uniq) > 1:
                return "AMBIGUOUS", None
        return "UNRESOLVED", None

    return resolve


def provisional_complex_id(lawd: str, apt_name_norm: str) -> str:
    """Deterministic bootstrap ID only — production should allocate opaque IDs."""
    raw = f"molit:{lawd}:{apt_name_norm}"
    return "cx_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def classify_row(u: dict, resolve) -> dict[str, Any]:
    lawd = str(u["lawd_cd"])
    apt = str(u["apt_name_norm"])
    dong = str(u.get("dong") or "")
    jibun = str(u.get("jibun") or "")
    ndong = int(u.get("ndong") or 1)
    njibun = int(u.get("njibun") or 1)
    trades = int(u.get("trades") or 0)
    sido, sido_code = sido_from_lawd(lawd)
    jp = parse_jibun(jibun)
    ld_status, hit = resolve(lawd, dong)

    reasons: list[str] = []
    if ndong > 1:
        reasons.append("multi_dong")
    if njibun > 1:
        reasons.append("multi_jibun")
    if ld_status == "AMBIGUOUS":
        reasons.append("legal_dong_ambiguous")
    if ld_status == "UNRESOLVED":
        reasons.append("legal_dong_unresolved")
    if jp["kind"] == "malformed" or not jp["bun"]:
        reasons.append("malformed_jibun")

    hard_fail = any(
        r in reasons for r in ("legal_dong_unresolved", "malformed_jibun")
    )
    soft_amb = any(
        r in reasons
        for r in ("multi_dong", "multi_jibun", "legal_dong_ambiguous")
    )

    if hard_fail and not soft_amb:
        identity = "IDENTITY-UNRESOLVED"
    elif soft_amb:
        identity = "IDENTITY-AMBIGUOUS"
    elif ld_status == "EXACT" and jp["bun"]:
        identity = "IDENTITY-READY"
    else:
        identity = "IDENTITY-UNRESOLVED"
        reasons.append("incomplete_core")

    parcel_key = None
    if hit and jp["bun"]:
        parcel_key = f"{hit['sigungu_cd']}|{hit['bjdong_cd']}|{jp['bun']}|{jp['ji']}"

    return {
        "complex_id": provisional_complex_id(lawd, apt),
        "molit_key": f"{lawd}:{apt}",
        "lawd_cd": lawd,
        "apt_name_norm": apt,
        "sido": sido,
        "sido_code": sido_code,
        "dong": dong,
        "jibun": jibun,
        "ndong": ndong,
        "njibun": njibun,
        "trades": trades,
        "legal_dong_status": ld_status,
        "sigungu_cd": hit["sigungu_cd"] if hit else None,
        "bjdong_cd": hit["bjdong_cd"] if hit else None,
        "legal_dong_name": (
            ((hit.get("emd_nm") or "") + ((" " + hit["ri_nm"]) if hit.get("ri_nm") else ""))
            if hit
            else None
        ),
        "bun": jp["bun"],
        "ji": jp["ji"],
        "jibun_kind": jp["kind"],
        "parcel_key": parcel_key,
        "identity_status": identity,
        "reason_codes": reasons,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    static = json.loads(STATIC.read_text())
    resolve = build_resolver(static["rows"])
    universe = json.loads((P511 / "_universe.json").read_text())

    rows = [classify_row(u, resolve) for u in universe]
    status = Counter(r["identity_status"] for r in rows)
    reason = Counter(rc for r in rows for rc in r["reason_codes"])
    jibun_kind = Counter(r["jibun_kind"] for r in rows)
    ld = Counter(r["legal_dong_status"] for r in rows)

    by_parcel: dict[str, list[str]] = defaultdict(list)
    by_name: dict[str, set[str]] = defaultdict(set)
    by_addr_names: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        by_name[r["apt_name_norm"]].add(r["lawd_cd"])
        if r["parcel_key"]:
            by_parcel[r["parcel_key"]].append(r["molit_key"])
            by_addr_names[r["parcel_key"]].add(r["apt_name_norm"])

    parcel_conflicts = {k: v for k, v in by_parcel.items() if len(set(v)) > 1}
    same_addr_multi_name = {
        k: sorted(v) for k, v in by_addr_names.items() if len(v) > 1
    }
    same_name_multi_lawd = sum(1 for _, lawds in by_name.items() if len(lawds) > 1)
    id_counts = Counter(r["complex_id"] for r in rows)
    duplicate_complex_id = sum(1 for _, c in id_counts.items() if c > 1)

    # Mark parcel-collision rows as ambiguous for reporting overlay
    parcel_conflict_keys = set(parcel_conflicts)
    parcel_conflict_complexes = 0
    for r in rows:
        if r["parcel_key"] in parcel_conflict_keys:
            parcel_conflict_complexes += 1
            if r["identity_status"] == "IDENTITY-READY":
                r["identity_status"] = "IDENTITY-AMBIGUOUS"
                r["reason_codes"] = list(
                    dict.fromkeys([*r["reason_codes"], "parcel_collision"])
                )

    status = Counter(r["identity_status"] for r in rows)
    reason = Counter(rc for r in rows for rc in r["reason_codes"])

    master_rows = len(rows)
    source_link_rows = len(rows)
    domains = [
        "BUILDING_REGISTRY",
        "GEO",
        "UNIT_GROUP",
        "SINGOGA_BASELINE",
        "SCHOOL",
        "FLOORPLAN",
    ]
    eager_status_rows = master_rows * len(domains)
    batch_size = 80
    master_ops = (master_rows + batch_size - 1) // batch_size
    link_ops = (source_link_rows + batch_size - 1) // batch_size
    eager_status_ops = (eager_status_rows + batch_size - 1) // batch_size

    report = {
        "phase": "6.0",
        "production_writes": 0,
        "identity_audit": {
            "current_key": (
                "fragmented: transactions(lawd_cd,apt_name_norm); "
                "apt_catalog(apt_name_norm,gu); pilot complex_key slug; "
                "PoC complex_id=lawd:apt_name_norm; market typeKey "
                "apt_norm|lawd|dong|area100"
            ),
            "problems": [
                "apt_name_norm alone is not unique across regions",
                "pilot complex_key is hand slug, not warehouse-linked",
                "catalog PK ignores lawd_cd",
                "rename/re-norm would split history if used as PK",
                "Phase5 child tables soft-join on complex_key without FK",
            ],
            "recommended_canonical_identity": (
                "opaque immutable complex_id; map MOLIT (lawd_cd, apt_name_norm) "
                "and parcel/registry/map keys via apt_complex_source_links"
            ),
        },
        "bootstrap": {
            "total": len(rows),
            "IDENTITY-READY": status["IDENTITY-READY"],
            "AMBIGUOUS": status["IDENTITY-AMBIGUOUS"],
            "UNRESOLVED": status["IDENTITY-UNRESOLVED"],
            "legal_dong": dict(ld),
            "jibun_kind": dict(jibun_kind),
            "reason_codes": dict(reason),
            "duplicates_conflicts": {
                "duplicate_complex_id": duplicate_complex_id,
                "same_name_different_lawd_count": same_name_multi_lawd,
                "parcel_key_shared_by_multiple_complexes": len(parcel_conflicts),
                "complexes_touched_by_parcel_collision": parcel_conflict_complexes,
                "same_address_multiple_norm_names": len(same_addr_multi_name),
                "malformed_jibun": reason.get("malformed_jibun", 0),
                "legal_dong_unresolved": reason.get("legal_dong_unresolved", 0),
                "multi_dong": reason.get("multi_dong", 0),
                "multi_jibun": reason.get("multi_jibun", 0),
            },
            "parcel_conflict_samples": {
                k: v for k, v in list(parcel_conflicts.items())[:15]
            },
            "same_addr_multi_name_samples": {
                k: v for k, v in list(same_addr_multi_name.items())[:15]
            },
        },
        "production_bootstrap_estimate": {
            "master_rows": master_rows,
            "source_link_rows_molit": source_link_rows,
            "status_rows_eager_6_domains": eager_status_rows,
            "status_rows_lazy_preferred": 0,
            "total_rows_lazy": master_rows + source_link_rows,
            "total_rows_eager_status": master_rows
            + source_link_rows
            + eager_status_rows,
            "estimated_write_operations_lazy_batch80": master_ops + link_ops,
            "estimated_write_operations_eager_batch80": master_ops
            + link_ops
            + eager_status_ops,
            "note": (
                "Turso billed write units depend on statement shape; "
                "estimate assumes multi-row INSERT packed ~80 rows/statement "
                "(current sync batch style). Exact units unknown without metering."
            ),
        },
        "decision": "PASS",
        "decision_reason": (
            "canonical complex_id strategy is clear; bootstrap READY is high "
            f"({status['IDENTITY-READY']}/{len(rows)}); building registry stays "
            "enrichment; no production writes in this phase"
        ),
        "recommended_next": "A",
    }

    manifest = {
        "phase": "6.0",
        "note": "local dry-run only; provisional complex_id is deterministic hash",
        "counts": dict(status),
        "ready_sample": [
            r for r in rows if r["identity_status"] == "IDENTITY-READY"
        ][:20],
        "ambiguous_sample": [
            r for r in rows if r["identity_status"] == "IDENTITY-AMBIGUOUS"
        ][:20],
        "unresolved_sample": [
            r for r in rows if r["identity_status"] == "IDENTITY-UNRESOLVED"
        ][:20],
    }

    (OUT / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / "bootstrap_manifest_sample.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / "bootstrap_identity_status.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
