#!/usr/bin/env python3
"""Phase 5.11 — full legal-dong mapping + stratified BldRgstHub cost calibration.

No production writes. Max 60 registry sample complexes.
Reuses Phase 5.10 trade prefilter (multi-dong / multi-jibun → HOLD).
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase511"
STATIC = ROOT / "data" / "static" / "legal_dong_seoul_gyeonggi.json"
PAGE_SIZE = 100
MAX_SAMPLE = 60


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
    """Normalized variants. For 읍·면+리 compounds do not emit bare 리-only."""
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
    if len(parts) >= 2 and parts[0].endswith(("읍", "면")) and parts[-1].endswith("리"):
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


def load_table() -> tuple[list[dict], dict]:
    payload = json.loads(STATIC.read_text())
    rows = payload["rows"]
    meta = {
        "source": payload.get("source"),
        "source_url": payload.get("source_url"),
        "unique_mapping_rows": len(rows),
        "scope": payload.get("scope"),
        "filter": payload.get("filter"),
    }
    return rows, meta


def build_resolver(rows: list[dict]):
    idx: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        names: set[str] = set()
        if r["emd_nm"]:
            names.add(norm_name(r["emd_nm"]))
        if r["ri_nm"]:
            names.add(norm_name(r["ri_nm"]))
            if r["emd_nm"]:
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

    def resolve(lawd: str, dong: str) -> tuple[str, dict | None, list[dict]]:
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
            return "EXACT", uniq[0], uniq
        if len(uniq) > 1:
            return "AMBIGUOUS", None, uniq

        # Missing/reorganized lawd (부천 41192→41190, 화성 41591→41590):
        # only when lawd has zero active rows; unique name within 4-digit prefix.
        if lawd_counts[lawd] == 0:
            cands = []
            for v in variants:
                for r in by_prefix.get(lawd[:4], []):
                    names = {
                        norm_name(r["emd_nm"]),
                        norm_name(r["ri_nm"]),
                        norm_name(r["emd_nm"] + r["ri_nm"]),
                    }
                    if v in names:
                        cands.append(r)
            if "리" in norm_name(dong):
                leaves = [c for c in cands if c.get("ri_nm")]
                if leaves:
                    cands = leaves
            uniq = unique(cands)
            if len(uniq) == 1:
                return "EXACT", uniq[0], uniq
            if len(uniq) > 1:
                return "AMBIGUOUS", None, uniq
        return "UNRESOLVED", None, []

    return resolve


def fetch_page(
    service_key: str, c: dict, page: int, retries: int = 12
) -> tuple[list[dict], int]:
    qs = urllib.parse.urlencode(
        {
            "serviceKey": service_key,
            "sigunguCd": c["sigungu_cd"],
            "bjdongCd": c["bjdong_cd"],
            "bun": c["bun"],
            "ji": c["ji"],
            "numOfRows": str(PAGE_SIZE),
            "pageNo": str(page),
        }
    )
    url = (
        "https://apis.data.go.kr/1613000/BldRgstHubService/"
        f"getBrExposPubuseAreaInfo?{qs}"
    )
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            if "<totalCount>" not in raw and "<resultCode>" not in raw:
                raise RuntimeError(f"non-api body: {raw[:60]!r}")
            root = ET.fromstring(raw)
            code = (root.findtext(".//resultCode") or "").strip()
            if code and code not in ("00", "0", "000"):
                raise RuntimeError(f"API {code}: {root.findtext('.//resultMsg')}")
            total = int(root.findtext(".//totalCount") or "0")
            items = [
                {ch.tag: (ch.text or "").strip() for ch in it}
                for it in root.findall(".//item")
            ]
            return items, total
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(min(30.0, 0.8 * (2**attempt)))
    raise RuntimeError(f"page {page} failed: {last}")


def stratified_sample(eligible: list[dict], k: int = MAX_SAMPLE) -> list[dict]:
    if not eligible:
        return []
    ranked = sorted(eligible, key=lambda x: int(x["trades"]), reverse=True)
    n = len(ranked)
    mega = ranked[: max(1, n // 20)]
    large = ranked[max(1, n // 20) : max(2, n // 5)]
    medium = ranked[max(2, n // 5) : max(3, n // 2)]
    small = ranked[max(3, n // 2) :]
    buckets = [
        ("mega", mega),
        ("large", large),
        ("medium", medium),
        ("small", small),
    ]
    per = max(1, k // 4)
    picked: list[dict] = []
    seen: set[str] = set()
    for label, bucket in buckets:
        if not bucket:
            continue
        step = max(1, len(bucket) // per)
        for i in range(0, len(bucket), step):
            row = dict(bucket[i])
            cid = row["complex_id"]
            if cid in seen:
                continue
            row["strata"] = label
            picked.append(row)
            seen.add(cid)
            if sum(1 for p in picked if p["strata"] == label) >= per:
                break
    if len(picked) < k:
        for label, bucket in buckets:
            for row0 in bucket:
                if len(picked) >= k:
                    break
                if row0["complex_id"] in seen:
                    continue
                row = dict(row0)
                row["strata"] = label
                picked.append(row)
                seen.add(row["complex_id"])
    return picked[:k]


def pctile(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return float(s[0])
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(s[int(k)])
    return float(s[f] * (c - k) + s[c] * (k - f))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rows, meta = load_table()
    resolve = build_resolver(rows)

    pairs = json.loads((OUT / "_pairs.json").read_text())
    universe = json.loads((OUT / "_universe.json").read_text())

    pair_stats: Counter[str] = Counter()
    for p in pairs:
        st, _, _ = resolve(str(p["lawd_cd"]), str(p["dong"]))
        pair_stats[st] += 1

    loaded: set[str] = set()
    p58 = ROOT / "data" / "poc" / "phase58" / "summary.json"
    if p58.exists():
        try:
            s58 = json.loads(p58.read_text())
            for k in s58.get("alreadyLoadedKeys") or s58.get("loadedKeys") or []:
                loaded.add(str(k))
        except Exception:  # noqa: BLE001
            pass

    jibun_stats: Counter[str] = Counter()
    res_stats: Counter[str] = Counter()
    trade_pf: Counter[str] = Counter()
    parcel_exact_eligible: list[dict] = []
    trade_pass = 0
    legal_dong_resolved = 0

    for u in universe:
        lawd = str(u["lawd_cd"])
        apt = str(u["apt_name_norm"])
        cid = f"{lawd}:{apt}"
        dong = str(u.get("dong") or "")
        jibun = str(u.get("jibun") or "")
        trades = int(u.get("trades") or 0)
        ndong = int(u.get("ndong") or 1)
        njibun = int(u.get("njibun") or 1)

        jp = parse_jibun(jibun)
        jibun_stats[jp["kind"]] += 1

        prefilter_pass = True
        if cid in loaded:
            trade_pf["already_loaded_skipped"] += 1
            prefilter_pass = False
        elif ndong > 1 or njibun > 1:
            trade_pf["HOLD"] += 1
            prefilter_pass = False
        else:
            trade_pf["PASS"] += 1
            trade_pass += 1

        if not dong:
            res_stats["UNRESOLVED"] += 1
            continue
        st, hit, _ = resolve(lawd, dong)
        if st != "EXACT":
            res_stats[st] += 1
            continue
        legal_dong_resolved += 1
        assert hit is not None
        if not jp["bun"]:
            res_stats["BJDONG-ONLY"] += 1
            continue
        res_stats["PARCEL-EXACT"] += 1
        if prefilter_pass:
            parcel_exact_eligible.append(
                {
                    "complex_id": cid,
                    "lawd_cd": lawd,
                    "apt_name_norm": apt,
                    "dong": dong,
                    "sigungu_cd": hit["sigungu_cd"],
                    "bjdong_cd": hit["bjdong_cd"],
                    "bun": jp["bun"],
                    "ji": jp["ji"],
                    "jibun": jibun,
                    "trades": trades,
                    "mountain": jp["mountain"],
                }
            )

    id_index: dict[str, list[str]] = defaultdict(list)
    for row in parcel_exact_eligible:
        key = f"{row['sigungu_cd']}|{row['bjdong_cd']}|{row['bun']}|{row['ji']}"
        id_index[key].append(row["complex_id"])
    conflicts = sum(1 for v in id_index.values() if len(v) > 1)

    skip_sample = os.environ.get("PHASE511_SKIP_SAMPLE") == "1"
    service_key = (
        os.environ.get("MOLIT_API_KEY")
        or os.environ.get("DATA_GO_KR_SERVICE_KEY")
        or os.environ.get("MOLIT_SERVICE_KEY")
        or ""
    )
    sample = stratified_sample(parcel_exact_eligible, MAX_SAMPLE)
    sample_results: list[dict] = []
    cache_dir = OUT / "bld-sample-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    if skip_sample:
        sample_note = "sample skipped (PHASE511_SKIP_SAMPLE=1)"
    elif not service_key:
        sample_note = "MOLIT_API_KEY missing — sample skipped"
    else:
        sample_note = (
            "requests=ceil(totalCount/100) at exact parcel; page2 probed if multipage"
        )
        for i, row in enumerate(sample, 1):
            t0 = time.time()
            cfg = {
                "sigungu_cd": row["sigungu_cd"],
                "bjdong_cd": row["bjdong_cd"],
                "bun": row["bun"],
                "ji": row["ji"],
            }
            ok = False
            nonempty = False
            pages = 0
            total = 0
            err = None
            actual_calls = 0
            try:
                items, total = fetch_page(service_key, cfg, 1)
                pages = max(1, math.ceil(total / PAGE_SIZE)) if total else 1
                ok = True
                nonempty = total > 0
                if pages > 1:
                    time.sleep(0.25)
                    fetch_page(service_key, cfg, 2)
                    actual_calls = 2
                else:
                    actual_calls = 1
                (cache_dir / f"{row['complex_id'].replace(':', '_')}.json").write_text(
                    json.dumps(
                        {
                            "complex_id": row["complex_id"],
                            "totalCount": total,
                            "pages": pages,
                            "sample_items": len(items),
                            "strata": row["strata"],
                        },
                        ensure_ascii=False,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                err = str(exc)[:200]
            dt = time.time() - t0
            sample_results.append(
                {
                    "complex_id": row["complex_id"],
                    "strata": row["strata"],
                    "trades": row["trades"],
                    "success": ok,
                    "nonempty": nonempty,
                    "total_count": total,
                    "requests": pages if ok else actual_calls,
                    "runtime_sec": round(dt, 3),
                    "error": err,
                }
            )
            print(
                f"[{i}/{len(sample)}] {row['strata']} {row['complex_id']} "
                f"ok={ok} pages={pages if ok else '-'} t={dt:.1f}s",
                flush=True,
            )
            time.sleep(0.2)

    reqs = [float(r["requests"]) for r in sample_results if r["success"]]
    runtimes = [float(r["runtime_sec"]) for r in sample_results if r["success"]]
    success_n = sum(1 for r in sample_results if r["success"])
    nonempty_n = sum(1 for r in sample_results if r["nonempty"])

    n_cand = len(parcel_exact_eligible)
    p50 = pctile(reqs, 0.50)
    p90 = pctile(reqs, 0.90)
    p95 = pctile(reqs, 0.95)
    pmax = max(reqs) if reqs else 0.0
    avg_req = statistics.mean(reqs) if reqs else 0.0
    avg_rt = statistics.mean(runtimes) if runtimes else 0.0

    ranked = sorted(
        parcel_exact_eligible, key=lambda x: int(x["trades"]), reverse=True
    )
    n = len(ranked) or 1
    cuts = {
        "mega": ranked[: max(1, n // 20)],
        "large": ranked[max(1, n // 20) : max(2, n // 5)],
        "medium": ranked[max(2, n // 5) : max(3, n // 2)],
        "small": ranked[max(3, n // 2) :],
    }
    strata_req: dict[str, list[float]] = defaultdict(list)
    for r in sample_results:
        if r["success"]:
            strata_req[r["strata"]].append(float(r["requests"]))

    def strata_mean(label: str, fallback: float) -> float:
        xs = strata_req.get(label) or []
        return statistics.mean(xs) if xs else fallback

    likely = 0.0
    for label, bucket in cuts.items():
        likely += len(bucket) * strata_mean(label, avg_req)
    conservative = 0.0
    for label, bucket in cuts.items():
        xs = strata_req.get(label) or reqs
        conservative += len(bucket) * (pctile(xs, 0.95) if xs else p95)

    likely_runtime_h = (likely * 1.3) / 3600.0
    upper_runtime_h = (conservative * 2.0) / 3600.0

    opt = {
        "can_reduce_safely": "NO",
        "reason": (
            "classify()/build_units requires unit-level 전유부 rows "
            "(dongNm, hoNm, exposPubuseGbCdNm, mainAtchGbCdNm, mainPurpsCdNm, "
            "area, etcPurps). Header/summary endpoints do not supply per-ho "
            "exclusive+residential-common areas. Pagination is cardinality of "
            "전유/공용 rows at exact parcel, not missing filters. Reducing pages "
            "would drop units and change classifier semantics."
        ),
    }

    pair_total = len(pairs)
    coverage = pair_stats["EXACT"] / pair_total if pair_total else 0.0

    decision = "PASS"
    reasons: list[str] = []
    if coverage < 0.90:
        decision = "HOLD"
        reasons.append(f"legal-dong pair coverage {coverage:.1%} < 90%")
    eligible_share = n_cand / trade_pass if trade_pass else 0.0
    if trade_pass and eligible_share < 0.85:
        decision = "HOLD"
        reasons.append(
            f"parcel-exact eligible {n_cand} only {eligible_share:.1%} of "
            f"trade-prefilter PASS {trade_pass}"
        )
    if sample_results and (likely > 2_000_000 or upper_runtime_h > 200):
        decision = "HOLD"
        reasons.append(
            f"cost still high likely_req={likely:.0f} upper_h={upper_runtime_h:.1f}"
        )
    if sample_results and success_n < 0.8 * len(sample_results):
        decision = "HOLD"
        reasons.append("stratified sample systemic failures")
    if not reasons:
        reasons.append(
            "high legal-dong coverage; PARCEL-EXACT near trade-prefilter; "
            "stratified cost bounded"
            if sample_results
            else "mapping/resolution only (sample pending)"
        )

    report = {
        "phase": "5.11",
        "legal_dong_source": meta,
        "mapping": {
            "lawd_dong_pairs_total": pair_total,
            "resolved": pair_stats["EXACT"],
            "ambiguous": pair_stats["AMBIGUOUS"],
            "unresolved": pair_stats["UNRESOLVED"],
            "coverage": round(coverage, 4),
        },
        "universe_resolution": {
            "total_complexes": len(universe),
            "legal_dong_resolved": legal_dong_resolved,
            "PARCEL_EXACT": res_stats["PARCEL-EXACT"],
            "BJDONG_ONLY": res_stats["BJDONG-ONLY"],
            "AMBIGUOUS": res_stats["AMBIGUOUS"],
            "UNRESOLVED": res_stats["UNRESOLVED"],
        },
        "trade_prefilter": dict(trade_pf),
        "jibun_quality": {
            "normal": jibun_stats["normal"],
            "bun_ji": jibun_stats["bun-ji"],
            "mountain": jibun_stats["mountain"],
            "malformed": jibun_stats["malformed"],
            "conflicts": conflicts,
        },
        "registry_candidate_universe": {
            "trade_prefilter_pass": trade_pass,
            "parcel_exact_eligible": n_cand,
        },
        "stratified_sample": {
            "sample": len(sample_results),
            "success": success_n,
            "nonempty": nonempty_n,
            "avg_requests": round(avg_req, 3),
            "p50": round(p50, 3),
            "p90": round(p90, 3),
            "p95": round(p95, 3),
            "max": round(pmax, 3),
            "avg_runtime_sec": round(avg_rt, 3),
            "note": sample_note,
            "by_strata": {
                label: {
                    "n": sum(1 for r in sample_results if r["strata"] == label),
                    "avg_requests": round(strata_mean(label, 0.0), 3),
                    "universe_n": len(cuts[label]),
                }
                for label in ("mega", "large", "medium", "small")
            },
        },
        "full_cost_estimate": {
            "likely_requests": int(round(likely)),
            "conservative_upper_requests": int(round(conservative)),
            "likely_runtime_hours": round(likely_runtime_h, 2),
            "upper_runtime_hours": round(upper_runtime_h, 2),
            "method": "strata-weighted mean (likely) and strata p95 (conservative)",
        },
        "optimization": opt,
        "production_writes": 0,
        "decision": decision,
        "decision_reason": "; ".join(reasons),
        "next": (
            "run cached/scaled building-registry acquisition in controlled batches"
            if decision == "PASS"
            else "fix remaining legal-dong/jibun gaps before bulk registry"
        ),
        "sample_results": sample_results,
    }

    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (OUT / "parcel_exact_eligible.json").write_text(
        json.dumps(parcel_exact_eligible, ensure_ascii=False)
    )
    (OUT / "stratified_sample.json").write_text(
        json.dumps(sample, ensure_ascii=False, indent=2)
    )

    print("\n=== PHASE 5.11 SUMMARY ===")
    print(
        json.dumps(
            {k: report[k] for k in report if k != "sample_results"},
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
