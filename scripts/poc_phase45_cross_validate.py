#!/usr/bin/env python3
"""Phase 4.5 — cross-validate Phase4 classes with official housing-permit APIs.

Live sources:
  1) 건축HUB 주택인허가 HsPmsHubService (primary)
  2) K-apt web detail (household / dong counts)
  3) AptList / complex-id — probed; not usable with current key
  4) 청약홈 Applyhome — probed; unauthorized without dedicated key

PoC only: no production DB write / selector / 신고가 / nationwide backfill.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc" / "phase45"
P4_DIR = ROOT / "data" / "poc" / "phase4"
CACHE = OUT / "cache"

PAGE = 100
HS_BASE = "https://apis.data.go.kr/1613000/HsPmsHubService"
KAPT_URL = "https://www.k-apt.go.kr/kaptinfo/getKaptInfo_detail.do"

PARTIAL_RE = re.compile(r"공유면적|일부공유")
RES_COMMON_RE = re.compile(
    r"계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과|출입구|피난|대피"
)
NONRES_COMMON_RE = re.compile(
    r"주차|관리사무|관리실|경로당|노인정|주민공동|주민운동|보육|문고|"
    r"기계실|전기실|발전기|펌프|방재|경비|보일러|옥탑|지하실|쓰레기|매장|탕비|휴게|화장실|상가|점포"
)

HS_OPS = {
    "basis": "getHpBasisOulnInfo",
    "dong": "getHpDongOulnInfo",
    "ho": "getHpHoOulnInfo",
    "expos": "getHpExposPubuseAreaInfo",
    "ho_expos": "getHpHoExposPubuseAreaInfo",
    "mgm_type": "getHpMgmCoopTpOulnInfo",
    "act": "getHpActOulnInfo",
    "plat": "getHpPlatPlcInfo",
}

TARGETS: list[dict[str, Any]] = [
    {
        "key": "eunma",
        "name": "은마",
        "role": "D",
        "sigungu_cd": "11680",
        "bjdong_cd": "10600",
        "plat_gb_cd": "0",
        "bun": "0316",
        "ji": "0000",
        "kapt_code": "A13583507",
    },
    {
        "key": "mokdong-7",
        "name": "목동신시가지7",
        "role": "C",
        "sigungu_cd": "11470",
        "bjdong_cd": "10200",
        "plat_gb_cd": "0",
        "bun": "0925",
        "ji": "0000",
        "kapt_code": None,
    },
    {
        "key": "olympic-family",
        "name": "올림픽훼밀리타운",
        "role": "C",
        "sigungu_cd": "11710",
        "bjdong_cd": "10800",
        "plat_gb_cd": "0",
        "bun": "0150",
        "ji": "0000",
        "kapt_code": "A13820201",
    },
    {
        "key": "jamsil-els",
        "name": "잠실엘스",
        "role": "B",
        "sigungu_cd": "11710",
        "bjdong_cd": "10100",
        "plat_gb_cd": "0",
        "bun": "0019",
        "ji": "0000",
        "kapt_code": "A13822004",
    },
    {
        "key": "banpo-xi",
        "name": "반포자이",
        "role": "B",
        "sigungu_cd": "11650",
        "bjdong_cd": "10700",
        "plat_gb_cd": "0",
        "bun": "0020",
        "ji": "0043",
        "kapt_code": "A13704104",
    },
    {
        "key": "hangang-daewoo",
        "name": "한강대우",
        "role": "A-control",
        "sigungu_cd": "11170",
        "bjdong_cd": "12900",
        "plat_gb_cd": "0",
        "bun": "0415",
        "ji": "0000",
        "kapt_code": "A14003105",
    },
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def service_key() -> str:
    key = (
        os.environ.get("MOLIT_API_KEY") or os.environ.get("MOLIT_API_KEY")
        or os.environ.get("DATA_GO_KR_SERVICE_KEY")
        or os.environ.get("MOLIT_SERVICE_KEY")
        or ""
    ).strip()
    if not key:
        raise SystemExit("MOLIT_API_KEY missing")
    return urllib.parse.unquote(key)


def fnum(x: Any) -> float | None:
    if x is None or x == "":
        return None
    try:
        return float(str(x).replace(",", ""))
    except ValueError:
        return None


def r2(x: float | None) -> float | None:
    if x is None:
        return None
    return round(float(x) + 1e-12, 2)


def http_get(url: str, retries: int = 8) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; zip-lab-phase45/1.0)",
                    "Accept": "*/*",
                    "Referer": "https://www.k-apt.go.kr/",
                },
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read()
            if not raw.strip():
                raise RuntimeError("empty body")
            return raw
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(min(40.0, 0.6 * (2 ** attempt)))
    raise RuntimeError(f"GET failed: {last}")


def parse_items(xml_bytes: bytes) -> tuple[list[dict], int]:
    root = ET.fromstring(xml_bytes)
    if root.find(".//errMsg") is not None and root.find(".//resultCode") is None:
        msg = (root.findtext(".//returnAuthMsg") or root.findtext(".//errMsg") or "").strip()
        code = (root.findtext(".//returnReasonCode") or "").strip()
        raise RuntimeError(f"gateway {code}: {msg}")
    code = (root.findtext(".//resultCode") or "").strip()
    msg = (root.findtext(".//resultMsg") or "").strip()
    if code and code not in ("00", "0", "000"):
        raise RuntimeError(f"API {code}: {msg}")
    total = int(root.findtext(".//totalCount") or "0")
    items = [{ch.tag: (ch.text or "").strip() for ch in it} for it in root.findall(".//item")]
    return items, total


def hs_fetch_all(key: str, op: str, c: dict, max_pages: int = 250) -> list[dict]:
    cache_path = CACHE / f"{c['key']}__{op}.json"
    if cache_path.exists():
        data = json.loads(cache_path.read_text())
        if data.get("complete"):
            print(f"  [cache] {op} n={len(data.get('items') or [])}", flush=True)
            return data.get("items") or []

    params = {
        "sigunguCd": c["sigungu_cd"],
        "bjdongCd": c["bjdong_cd"],
        "platGbCd": c["plat_gb_cd"],
        "bun": c["bun"],
        "ji": c["ji"],
        "numOfRows": str(PAGE),
    }
    items: list[dict] = []
    total: int | None = None
    page = 1
    while page <= max_pages:
        q = dict(params)
        q["pageNo"] = str(page)
        url = f"{HS_BASE}/{op}?serviceKey={key}&{urllib.parse.urlencode(q)}"
        try:
            batch, tot = parse_items(http_get(url))
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] {op} p{page}: {exc}", flush=True)
            if page == 1 and not items:
                cache_path.write_text(
                    json.dumps(
                        {"op": op, "complete": True, "error": str(exc), "items": [], "fetchedAt": now_iso()},
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return []
            time.sleep(2)
            continue
        if total is None:
            total = tot
            print(f"  [{op}] total={total}", flush=True)
        items.extend(batch)
        if not batch or (total is not None and len(items) >= total):
            break
        if page % 15 == 0:
            cache_path.write_text(
                json.dumps(
                    {"op": op, "complete": False, "total": total, "items": items, "fetchedAt": now_iso()},
                    ensure_ascii=False,
                )
            )
            print(f"  [{op}] p{page} have={len(items)}", flush=True)
        page += 1
        time.sleep(0.15)

    cache_path.write_text(
        json.dumps(
            {
                "op": op,
                "complete": True,
                "total": total if total is not None else len(items),
                "items": items,
                "fetchedAt": now_iso(),
            },
            ensure_ascii=False,
        )
    )
    return items


def load_phase4(key: str) -> dict | None:
    path = P4_DIR / f"{key}-phase4.json"
    return json.loads(path.read_text()) if path.exists() else None


def fetch_kapt(code: str | None) -> dict:
    if not code:
        return {"ok": False, "reason": "kapt_code_unresolved"}
    cache = CACHE / f"kapt_{code}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    try:
        raw = http_get(f"{KAPT_URL}?kaptCode={code}", retries=5)
        data = json.loads(raw.decode("utf-8", errors="replace"))
        kap = data.get("resultMap_kapt") or {}
        areas = data.get("resultMap_kapt_areacnt") or []
        out = {
            "ok": True,
            "kaptCode": code,
            "kaptName": kap.get("kaptName"),
            "households": fnum(kap.get("kaptdaTCnt")),
            "dong_cnt": fnum(kap.get("kaptDongCnt")),
            "use_date": kap.get("kaptUsedate"),
            "area_bands": [
                {"areaGbn": a.get("areaGbn"), "cnt": fnum(a.get("kaptdaCnt"))}
                for a in areas
                if fnum(a.get("kaptdaCnt"))
            ],
            "fetchedAt": now_iso(),
        }
    except Exception as exc:  # noqa: BLE001
        out = {"ok": False, "kaptCode": code, "reason": str(exc)}
    cache.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    return out


def probe_cheongyak() -> dict:
    urls = [
        "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail?page=1&perPage=1",
        "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl?page=1&perPage=1",
    ]
    probes = []
    for url in urls:
        try:
            raw = http_get(url, retries=2)
            probes.append({"url": url.split("?")[0], "ok": True, "head": raw[:160].decode("utf-8", "replace")})
        except Exception as exc:  # noqa: BLE001
            probes.append({"url": url.split("?")[0], "ok": False, "error": str(exc)})
    return {
        "usable": any(p.get("ok") for p in probes),
        "probes": probes,
        "note": "No housing-type fields consumed — unauthorized or empty.",
    }


def probe_complex_id_api(key: str) -> dict:
    candidates = [
        ("total", f"https://apis.data.go.kr/1613000/AptListService2/getTotalAptList?serviceKey={key}&pageNo=1&numOfRows=1"),
        ("basis", f"https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusBassInfo?serviceKey={key}&kaptCode=A14003105"),
        ("legal", f"https://apis.data.go.kr/1613000/AptListService2/getLegaldongAptList?serviceKey={key}&bjdCode=1117012900&pageNo=1&numOfRows=1"),
    ]
    probes = []
    for name, url in candidates:
        try:
            raw = http_get(url, retries=2)
            probes.append({"name": name, "ok": True, "head": raw[:200].decode("utf-8", "replace")})
        except Exception as exc:  # noqa: BLE001
            probes.append({"name": name, "ok": False, "error": str(exc)})
    return {
        "usable_with_current_key": False,
        "probes": probes,
        "note": "AptList/Basis not registered on MOLIT_API_KEY. REB identity files not wired. No VWorld key.",
    }


def classify_etc(etc: str) -> str:
    etc = etc or ""
    if not etc.strip():
        return "unknown"
    if RES_COMMON_RE.search(etc):
        return "residential"
    if NONRES_COMMON_RE.search(etc):
        return "non-residential"
    return "unknown"


def analyze_ho_expos(rows: list[dict]) -> dict:
    by_ho: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    etc_counter: Counter[str] = Counter()
    class_counter: Counter[str] = Counter()
    partial_hits = 0

    for row in rows:
        dong = row.get("dongNm") or row.get("bldNm") or ""
        ho = row.get("hoNm") or row.get("ho") or ""
        flr = row.get("flrNoNm") or row.get("flrNo") or ""
        by_ho[(dong, flr, ho)].append(row)
        gb = row.get("exposPubuseGbCdNm") or ""
        etc = row.get("etcPurps") or row.get("mainPurpsCdNm") or ""
        if "공용" in gb or row.get("exposPubuseGbCd") == "2":
            etc_counter[etc or "(blank)"] += 1
            class_counter[classify_etc(etc)] += 1
        if PARTIAL_RE.search(etc):
            partial_hits += 1

    types: dict[tuple[float, float], dict] = {}
    unit_count = 0
    partial_units = 0
    for (dong, flr, ho), parts in by_ho.items():
        if not ho:
            continue
        excl = 0.0
        res_common = 0.0
        other_common = 0.0
        partial = False
        for p in parts:
            area = fnum(p.get("area")) or 0.0
            gb = p.get("exposPubuseGbCdNm") or ""
            etc = p.get("etcPurps") or p.get("mainPurpsCdNm") or ""
            if PARTIAL_RE.search(etc):
                partial = True
            if "전유" in gb or p.get("exposPubuseGbCd") == "1":
                excl += area
            elif "공용" in gb or p.get("exposPubuseGbCd") == "2":
                if RES_COMMON_RE.search(etc):
                    res_common += area
                else:
                    other_common += area
        if excl <= 0:
            continue
        unit_count += 1
        if partial:
            partial_units += 1
            supply = None
        else:
            supply = r2(excl + res_common)
        excl_r = r2(excl) or 0.0
        key = (excl_r, supply if supply is not None else -1.0)
        slot = types.setdefault(
            key,
            {
                "exclusive": excl_r,
                "supply": supply,
                "res_common": r2(res_common),
                "other_common": r2(other_common),
                "households": 0,
                "partial": False,
                "sample_units": [],
            },
        )
        slot["households"] += 1
        slot["partial"] = slot["partial"] or partial
        if len(slot["sample_units"]) < 3:
            slot["sample_units"].append({"dong": dong, "flr": flr, "ho": ho})

    type_list = sorted(types.values(), key=lambda x: (-x["households"], x["exclusive"]))
    groups: list[dict] = []
    for t in type_list:
        placed = False
        for g in groups:
            if abs(g["exclusive_min"] - t["exclusive"]) <= 1.0:
                g["types"].append(t)
                g["households"] += t["households"]
                g["exclusive_min"] = min(g["exclusive_min"], t["exclusive"])
                g["exclusive_max"] = max(g["exclusive_max"], t["exclusive"])
                supplies = [x["supply"] for x in g["types"] if x["supply"] is not None]
                if supplies:
                    g["supply_min"] = min(supplies)
                    g["supply_max"] = max(supplies)
                g["partial"] = g["partial"] or t["partial"]
                placed = True
                break
        if not placed:
            groups.append(
                {
                    "exclusive_min": t["exclusive"],
                    "exclusive_max": t["exclusive"],
                    "supply_min": t["supply"],
                    "supply_max": t["supply"],
                    "households": t["households"],
                    "partial": t["partial"],
                    "types": [t],
                }
            )

    outlier_hh = 0
    for g in groups:
        supplies = [(t["supply"], t["households"]) for t in g["types"] if t["supply"] is not None]
        if not supplies:
            g["outlier_hh"] = 0
            g["market_label"] = None
            g["label_reason"] = "no_supply"
            continue
        supplies.sort(key=lambda x: x[0] or 0)
        total = sum(h for _, h in supplies)
        acc = 0
        median = supplies[0][0] or 0
        for s, h in supplies:
            acc += h
            if acc >= total / 2:
                median = s or 0
                break
        out_h = 0
        for t in g["types"]:
            if t["supply"] is None:
                t["outlier"] = False
                continue
            share = t["households"] / max(g["households"], 1)
            if share < 0.10 and abs(t["supply"] - median) > 8:
                t["outlier"] = True
                out_h += t["households"]
            else:
                t["outlier"] = False
        g["outlier_hh"] = out_h
        outlier_hh += out_h
        smin, smax = g.get("supply_min"), g.get("supply_max")
        if smin is not None and smax is not None and (smax - smin) <= 4:
            lab = int(round(smin / 3.3))
            if lab in (24, 25, 33, 34):
                g["market_label"] = None
                g["label_reason"] = "24_25_or_33_34_zone"
            else:
                g["market_label"] = lab
                g["label_reason"] = None
        else:
            g["market_label"] = None
            g["label_reason"] = "supply_span_or_missing"

    common_total = sum(class_counter.values()) or 1
    return {
        "unit_count": unit_count,
        "type_count": len(type_list),
        "group_count": len(groups),
        "partial_unit_ratio": partial_units / max(unit_count, 1),
        "partial_row_hits": partial_hits,
        "unknown_common_ratio": class_counter["unknown"] / common_total,
        "residential_common_ratio": class_counter["residential"] / common_total,
        "non_residential_common_ratio": class_counter["non-residential"] / common_total,
        "etc_purps_top": etc_counter.most_common(12),
        "etc_class_counts": dict(class_counter),
        "outlier_household_ratio": outlier_hh / max(unit_count, 1),
        "types": type_list[:40],
        "groups": [
            {
                "exclusive": [g["exclusive_min"], g["exclusive_max"]],
                "supply": [g.get("supply_min"), g.get("supply_max")],
                "households": g["households"],
                "market_label": g.get("market_label"),
                "label_reason": g.get("label_reason"),
                "partial": g["partial"],
                "outlier_hh": g.get("outlier_hh", 0),
                "type_variants": len(g["types"]),
            }
            for g in groups
        ],
    }


def analyze_mgm_types(rows: list[dict]) -> dict:
    if not rows:
        return {"ok": False, "count": 0, "fields_observed": [], "rows_sample": []}
    fields = sorted({k for r in rows for k in r})
    area_fields = [f for f in fields if re.search(r"area|Area|면적|exclu|suply|hh|세대", f, re.I)]
    return {
        "ok": True,
        "count": len(rows),
        "fields_observed": fields,
        "area_like_fields": area_fields,
        "rows_sample": [{k: r.get(k) for k in fields if r.get(k)} for r in rows[:8]],
    }


def reclassify(p4: dict | None, hs: dict, kapt: dict) -> dict:
    p4_class = (p4 or {}).get("gate", {}).get("classification") or "unknown"
    p4_metrics = (p4 or {}).get("gate", {}).get("metrics") or {}
    reasons: list[str] = []

    partial_ratio = hs.get("partial_unit_ratio") or 0.0
    unknown_common = hs.get("unknown_common_ratio") or 0.0
    unit_count = hs.get("unit_count") or 0
    groups = hs.get("groups") or []
    hh_all = sum(g["households"] for g in groups) or 1
    labeled_hh = sum(g["households"] for g in groups if g.get("market_label") is not None)
    label_conf = labeled_hh / hh_all
    multi_supply_same_ex = sum(1 for g in groups if g.get("type_variants", 0) >= 2)
    outlier_ratio = hs.get("outlier_household_ratio") or 0.0
    res_common = hs.get("residential_common_ratio") or 0.0

    kapt_hh = kapt.get("households") if kapt.get("ok") else None
    hh_delta = abs(kapt_hh - unit_count) / max(kapt_hh, 1) if kapt_hh and unit_count else None

    rescued = False
    if partial_ratio >= 0.50:
        new_class = "registry-abnormal"
        reasons.append(f"hs_partial_unit_ratio={partial_ratio:.2f}")
        supply_conf, group_conf = "blocked", "blocked"
        rescue_reason = "일부공유/공유면적 표기 — 주택인허가도 자동 공급산식 금지"
    elif unit_count == 0:
        new_class = p4_class if p4_class != "unknown" else "ambiguous"
        reasons.append("hs_ho_expos_empty")
        supply_conf, group_conf = "none", "unchanged"
        rescue_reason = "행위호 전유공용면적 없음 — Phase4 유지"
    elif unknown_common >= 0.45 and res_common < 0.35:
        new_class = "ambiguous"
        reasons.append(f"hs_unknown_common={unknown_common:.2f}")
        supply_conf, group_conf = "low", ("medium" if multi_supply_same_ex == 0 else "low")
        rescue_reason = "주택인허가에서도 unknown 공용 비중 큼"
    elif outlier_ratio >= 0.20:
        new_class = "ambiguous"
        reasons.append(f"hs_outlier_ratio={outlier_ratio:.2f}")
        supply_conf, group_conf = "medium", "low"
        rescue_reason = "공급 outlier 비중 과다"
    else:
        supply_present = sum(
            g["households"] for g in groups if g.get("supply") and g["supply"][0] is not None
        ) / hh_all
        if supply_present >= 0.80 and unknown_common < 0.38:
            supply_conf, group_conf = "high", "high"
            new_class = "auto-safe" if label_conf >= 0.70 else "group-safe-label-unknown"
            reasons.append(
                "hs_supply_groups_stable" if label_conf >= 0.70 else f"hs_label_confidence={label_conf:.2f}"
            )
            if p4_class in ("ambiguous", "registry-abnormal") and new_class in (
                "auto-safe",
                "group-safe-label-unknown",
            ):
                rescued = True
                rescue_reason = "주택인허가 행위호 면적으로 공급/group 재구성 성공"
            elif p4_class == "group-safe-label-unknown" and new_class == "auto-safe":
                rescued = True
                rescue_reason = "주택인허가로 label 확정률 상승"
            else:
                rescue_reason = "교차검증 일치/부분개선"
        else:
            new_class = "group-safe-label-unknown" if supply_present >= 0.50 else "ambiguous"
            reasons.append(f"hs_supply_present={supply_present:.2f}")
            supply_conf = "medium" if supply_present >= 0.50 else "low"
            group_conf = "medium"
            rescue_reason = "공급면적 커버 부족"

    if hh_delta is not None and hh_delta > 0.15:
        reasons.append(f"kapt_hh_delta={hh_delta:.2f}")
        if new_class == "auto-safe":
            new_class = "group-safe-label-unknown"
            reasons.append("downgrade_hh_mismatch")

    return {
        "phase4_class": p4_class,
        "new_class": new_class,
        "changed": p4_class != new_class,
        "rescued": rescued,
        "rescue_reason": rescue_reason,
        "reasons": reasons,
        "supply_confidence": supply_conf,
        "market_group_confidence": group_conf,
        "label_confidence": r2(label_conf),
        "metrics": {
            "hs_unit_count": unit_count,
            "hs_type_count": hs.get("type_count"),
            "hs_group_count": hs.get("group_count"),
            "partial_unit_ratio": r2(partial_ratio),
            "unknown_common_ratio": r2(unknown_common),
            "residential_common_ratio": r2(res_common),
            "outlier_household_ratio": r2(outlier_ratio),
            "multi_supply_same_exclusive_groups": multi_supply_same_ex,
            "kapt_households": kapt_hh,
            "kapt_dong_cnt": kapt.get("dong_cnt"),
            "household_delta_vs_kapt": r2(hh_delta) if hh_delta is not None else None,
            "phase4_unknown_common": p4_metrics.get("unknown_common_area_ratio"),
            "phase4_label_confidence": p4_metrics.get("label_confidence"),
        },
    }


def analyze_complex(key: str, c: dict, cheongyak: dict, complex_id: dict) -> dict:
    print(f"=== {c['key']} ===", flush=True)
    p4 = load_phase4(c["key"])
    hs_raw = {name: hs_fetch_all(key, op, c) for name, op in HS_OPS.items()}

    ho_expos = analyze_ho_expos(hs_raw.get("ho_expos") or [])
    if ho_expos["unit_count"] == 0 and hs_raw.get("expos"):
        ho_expos = analyze_ho_expos(hs_raw["expos"])
        ho_expos["source_op"] = "getHpExposPubuseAreaInfo"
    else:
        ho_expos["source_op"] = "getHpHoExposPubuseAreaInfo"

    mgm = analyze_mgm_types(hs_raw.get("mgm_type") or [])
    kapt = fetch_kapt(c.get("kapt_code"))
    dong_cnt_hs = len({(r.get("dongNm") or r.get("bldNm") or "") for r in (hs_raw.get("dong") or []) if r})
    gate = reclassify(p4, ho_expos, kapt)

    result = {
        "complex": {
            "key": c["key"],
            "name": c["name"],
            "role": c["role"],
            "parcel": {
                "sigunguCd": c["sigungu_cd"],
                "bjdongCd": c["bjdong_cd"],
                "platGbCd": c["plat_gb_cd"],
                "bun": c["bun"],
                "ji": c["ji"],
            },
            "kapt_code": c.get("kapt_code"),
        },
        "sources": {
            "housing_permit": {
                "service": "HsPmsHubService",
                "counts": {k: len(v) for k, v in hs_raw.items()},
                "basis_sample": (hs_raw.get("basis") or [])[:2],
            },
            "kapt": kapt,
            "complex_identification_api": complex_id,
            "cheongyak": cheongyak,
        },
        "housing_permit_analysis": {
            **ho_expos,
            "dong_outline_count": dong_cnt_hs,
            "ho_outline_count": len(hs_raw.get("ho") or []),
            "mgm_coop_type": mgm,
        },
        "phase4_ref": {
            "classification": (p4 or {}).get("gate", {}).get("classification"),
            "metrics": (p4 or {}).get("gate", {}).get("metrics"),
            "reasons": (p4 or {}).get("gate", {}).get("reasons"),
        }
        if p4
        else None,
        "gate": gate,
        "note": "PoC cross-check only; production writes forbidden",
        "fetchedAt": now_iso(),
    }
    (OUT / f"{c['key']}-phase45.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def build_summary(results: list[dict]) -> dict:
    n = len(results) or 1
    classes = Counter(r["gate"]["new_class"] for r in results)
    p4_classes = Counter((r["phase4_ref"] or {}).get("classification") for r in results)
    rescued = sum(1 for r in results if r["gate"]["rescued"])
    changed = sum(1 for r in results if r["gate"]["changed"])
    p4_ab = sum(
        1
        for r in results
        if (r["phase4_ref"] or {}).get("classification") in ("auto-safe", "group-safe-label-unknown")
    )
    new_ab = sum(1 for r in results if r["gate"]["new_class"] in ("auto-safe", "group-safe-label-unknown"))

    phase4_base = {
        "auto-safe": 0.50,
        "group-safe-label-unknown": 0.31,
        "ambiguous": 0.13,
        "registry-abnormal": 0.06,
        "singoga_market_group_applicable": 0.81,
    }
    non_control = [r for r in results if r["complex"]["role"] != "A-control"]
    c_probe = [r for r in non_control if r["complex"]["role"] == "C"]
    d_probe = [r for r in non_control if r["complex"]["role"] == "D"]
    b_probe = [r for r in non_control if r["complex"]["role"] == "B"]
    c_rescue = sum(1 for r in c_probe if r["gate"]["rescued"]) / max(len(c_probe), 1)
    d_rescue = sum(1 for r in d_probe if r["gate"]["rescued"]) / max(len(d_probe), 1)
    b_to_a = sum(
        1
        for r in b_probe
        if r["gate"]["phase4_class"] == "group-safe-label-unknown" and r["gate"]["new_class"] == "auto-safe"
    ) / max(len(b_probe), 1)
    est_new_ab = min(
        1.0,
        phase4_base["singoga_market_group_applicable"]
        + phase4_base["ambiguous"] * c_rescue
        + phase4_base["registry-abnormal"] * d_rescue,
    )
    est_auto = min(
        1.0,
        phase4_base["auto-safe"]
        + phase4_base["group-safe-label-unknown"] * b_to_a
        + phase4_base["ambiguous"] * c_rescue * 0.5,
    )

    summary = {
        "generatedAt": now_iso(),
        "scope": {
            "production_db_write": False,
            "selector_change": False,
            "singoga_production_change": False,
            "nationwide_backfill": False,
        },
        "sample_size": len(results),
        "phase4_class_counts": dict(p4_classes),
        "new_class_counts": dict(classes),
        "rescued_count": rescued,
        "changed_count": changed,
        "sample_singoga_applicable": {
            "phase4": p4_ab / n,
            "phase45": new_ab / n,
            "delta_pp": (new_ab - p4_ab) / n,
        },
        "nationwide_estimate_from_phase4_base": {
            "method": "Apply observed C/D/B rescue rates onto Phase4 16-complex base rates",
            "phase4_singoga_applicable": phase4_base["singoga_market_group_applicable"],
            "phase45_singoga_applicable_est": round(est_new_ab, 3),
            "delta_pp_est": round(est_new_ab - phase4_base["singoga_market_group_applicable"], 3),
            "phase4_auto_safe": phase4_base["auto-safe"],
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
    return summary


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    key = service_key()

    only: set[str] = set()
    for arg in sys.argv[1:]:
        if arg.startswith("--only="):
            only.update(x.strip() for x in arg.split("=", 1)[1].split(",") if x.strip())

    print("Probing complex-id + cheongyak availability...", flush=True)
    complex_id = probe_complex_id_api(key)
    cheongyak = probe_cheongyak()
    (OUT / "source-availability.json").write_text(
        json.dumps({"complex_id": complex_id, "cheongyak": cheongyak}, ensure_ascii=False, indent=2)
    )

    results = []
    for c in TARGETS:
        if only and c["key"] not in only:
            continue
        results.append(analyze_complex(key, c, cheongyak, complex_id))

    done = {r["complex"]["key"] for r in results}
    for path in OUT.glob("*-phase45.json"):
        k = path.name.replace("-phase45.json", "")
        if k in done:
            continue
        try:
            results.append(json.loads(path.read_text()))
            done.add(k)
        except Exception:
            pass

    order = {c["key"]: i for i, c in enumerate(TARGETS)}
    results.sort(key=lambda r: order.get(r["complex"]["key"], 999))
    summary = build_summary(results)
    print(json.dumps(summary["nationwide_estimate_from_phase4_base"], ensure_ascii=False, indent=2))
    for c in summary["complexes"]:
        print(
            f"{c['key']}: {c['phase4']} → {c['phase45']} | rescued={c['rescued']} "
            f"supply={c['supply_confidence']} group={c['market_group_confidence']} | {c['rescue_reason']}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
