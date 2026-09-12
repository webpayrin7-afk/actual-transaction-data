#!/usr/bin/env python3
"""
Phase 4 PoC — production readiness gate for market pyeong groups.

exclusive ≤1㎡ clustering = candidate generation only.
Final class A/B/C/D requires confidence gates.

Forbidden: production DB write, nationwide backfill, selector/singoga production changes.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
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
OUT = ROOT / "data" / "poc" / "phase4"
P3 = ROOT / "data" / "poc" / "phase3"
OUT.mkdir(parents=True, exist_ok=True)

PAGE_SIZE = 100
EXCLUSIVE_GAP = 1.0

# Supply formula: only these residential commons are added to exclusive.
SUPPLY_RES_RE = re.compile(r"계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과")
# Classification taxonomy (confidence) — broader than supply allowlist.
# Observed Phase4 etcPurps: 출입구/피난; 쓰레기·매장·탕비 are non-supply.
CLASS_RES_RE = re.compile(
    r"계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과|출입구|피난|대피"
)
CLASS_NONRES_RE = re.compile(
    r"주차|주차장|관리사무|관리실|경로당|노인정|주민공동|주민운동|보육|문고|"
    r"기계실|전기실|발전기|펌프|방재|경비|보일러|옥탑|지하실|기타|엠디에프|MDF|"
    r"쓰레기|매장|탕비|휴게|화장실|상가|점포"
)
# Back-compat aliases used by supply path.
RES_RE = SUPPLY_RES_RE
NONRES_RE = CLASS_NONRES_RE
PARTIAL_RE = re.compile(r"공유면적|일부공유")


def config_for_candidate(
    key: str,
    *,
    apt_name_norm: str | None = None,
    lawd_cd: str | None = None,
    era: str = "unknown",
    profile: str = "dynamic-candidate",
) -> dict[str, Any]:
    """Resolve a gate config dynamically.

    Prefer parcel metadata from COMPLEXES when present; otherwise build a
    cache-oriented config from apt_name_norm + lawd_cd. Does not invent parcel
    (bjdong/bun/ji) — callers must supply caches or parcel fields to fetch.
    """
    known = {c["key"]: dict(c) for c in COMPLEXES}
    if key in known:
        return known[key]
    if not apt_name_norm or not lawd_cd:
        raise ValueError(f"dynamic candidate {key} needs apt_name_norm and lawd_cd")
    return {
        "key": key,
        "lawd_cd": str(lawd_cd),
        "apt_name_norm": apt_name_norm,
        "sigungu_cd": str(lawd_cd),
        "bjdong_cd": None,
        "bun": None,
        "ji": None,
        "era": era,
        "profile": profile,
        "cache": OUT / f"{key}-bld-expos-cache.json",
        "trades_cache": OUT / f"{key}-trades-readonly.json",
    }


COMPLEXES: list[dict[str, Any]] = [
    {
        "key": "hangang-daewoo",
        "lawd_cd": "11170",
        "apt_name_norm": "한강(대우)",
        "sigungu_cd": "11170",
        "bjdong_cd": "12900",
        "bun": "0415",
        "ji": "0000",
        "era": "2000s",
        "profile": "2000s·동일전용 다타입·공급차이",
        "cache": ROOT / "data" / "poc" / "hangang-daewoo-bld-expos-cache.json",
        "trades_cache": P3 / "hangang-daewoo-trades-readonly.json",
    },
    {
        "key": "eunma",
        "lawd_cd": "11680",
        "apt_name_norm": "은마",
        "sigungu_cd": "11680",
        "bjdong_cd": "10600",
        "bun": "0316",
        "ji": "0000",
        "era": "1970s",
        "profile": "1970s 구축·재건축예정·일부공유면적포함",
        "cache": P3 / "eunma-bld-expos-cache.json",
        "trades_cache": P3 / "eunma-trades-readonly.json",
    },
    {
        "key": "jamsil-els",
        "lawd_cd": "11710",
        "apt_name_norm": "잠실엘스",
        "sigungu_cd": "11710",
        "bjdong_cd": "10100",
        "bun": "0019",
        "ji": "0000",
        "era": "2000s",
        "profile": "2000s 대단지·59/84/114 표준형",
        "cache": P3 / "jamsil-els-bld-expos-cache.json",
        "trades_cache": P3 / "jamsil-els-trades-readonly.json",
    },
    {
        "key": "banpo-xi",
        "lawd_cd": "11650",
        "apt_name_norm": "반포자이",
        "sigungu_cd": "11650",
        "bjdong_cd": "10700",
        "bun": "0020",
        "ji": "0043",
        "era": "2000s",
        "profile": "2000s·광범위·다타입",
        "cache": P3 / "banpo-xi-bld-expos-cache.json",
        "trades_cache": P3 / "banpo-xi-trades-readonly.json",
    },
    {
        "key": "raemian-hill-godeok",
        "lawd_cd": "11740",
        "apt_name_norm": "래미안힐스테이트고덕",
        "sigungu_cd": "11740",
        "bjdong_cd": "10200",
        "bun": "0688",
        "ji": "0000",
        "era": "2010s",
        "profile": "2010s 신축 대단지·공급 outlier",
        "cache": P3 / "raemian-hill-godeok-bld-expos-cache.json",
        "trades_cache": P3 / "raemian-hill-godeok-trades-readonly.json",
    },
    {
        "key": "parkrio",
        "lawd_cd": "11710",
        "apt_name_norm": "파크리오",
        "sigungu_cd": "11710",
        "bjdong_cd": "10200",
        "bun": "0017",
        "ji": "0000",
        "era": "2000s",
        "profile": "2000s 대단지·표준형",
    },
    {
        "key": "ricents",
        "lawd_cd": "11710",
        "apt_name_norm": "리센츠",
        "sigungu_cd": "11710",
        "bjdong_cd": "10100",
        "bun": "0022",
        "ji": "0000",
        "era": "2000s",
        "profile": "2000s 대단지·표준형",
    },
    {
        "key": "olympic-family",
        "lawd_cd": "11710",
        "apt_name_norm": "올림픽훼밀리타운",
        "sigungu_cd": "11710",
        "bjdong_cd": "10800",
        "bun": "0150",
        "ji": "0000",
        "era": "1980s",
        "profile": "1980s 구축 대단지·비표준 대형 포함",
    },
    {
        "key": "sangye-jugong9",
        "lawd_cd": "11350",
        "apt_name_norm": "상계주공9(고층)",
        "sigungu_cd": "11350",
        "bjdong_cd": "10500",
        "bun": "0670",
        "ji": "0000",
        "era": "1980s",
        "profile": "1980s 구축·재건축권·소형 위주",
    },
    {
        "key": "gwanak-prugio",
        "lawd_cd": "11620",
        "apt_name_norm": "관악푸르지오",
        "sigungu_cd": "11620",
        "bjdong_cd": "10100",
        "bun": "1717",
        "ji": "0000",
        "era": "2000s",
        "profile": "2000s·59/84/114",
    },
    {
        "key": "raemian-weve",
        "lawd_cd": "11230",
        "apt_name_norm": "래미안위브",
        "sigungu_cd": "11230",
        "bjdong_cd": "10500",
        "bun": "1003",
        "ji": "0000",
        "era": "2010s",
        "profile": "2010s·다타입",
    },
    # —— additional verified parcels ——
    {
        "key": "mokdong-7",
        "lawd_cd": "11470",
        "apt_name_norm": "목동신시가지7",
        "sigungu_cd": "11470",
        "bjdong_cd": "10200",
        "bun": "0925",
        "ji": "0000",
        "era": "1980s",
        "profile": "1980s 목동 구축·대단지",
    },
    {
        "key": "sibom-hanyang",
        "lawd_cd": "41135",
        "apt_name_norm": "시범한양",
        "sigungu_cd": "41135",
        "bjdong_cd": "10500",
        "bun": "0091",
        "ji": "0000",
        "era": "1990s",
        "profile": "1990s 분당 1기신도시",
    },
    {
        "key": "anyang-samsung-raemian",
        "lawd_cd": "41173",
        "apt_name_norm": "삼성래미안",
        "sigungu_cd": "41173",
        "bjdong_cd": "10100",
        "bun": "0425",
        "ji": "0000",
        "era": "2000s",
        "profile": "2000s 경기 대단지",
    },
    {
        "key": "ilsan-zenith",
        "lawd_cd": "41287",
        "apt_name_norm": "일산두산위브더제니스",
        "sigungu_cd": "41287",
        "bjdong_cd": "10300",
        "bun": "1640",
        "ji": "0000",
        "era": "2010s",
        "profile": "2010s 주상복합·초고층",
    },
    {
        "key": "hannam-thehill",
        "lawd_cd": "11170",
        "apt_name_norm": "한남더힐",
        "sigungu_cd": "11170",
        "bjdong_cd": "13100",
        "bun": "0810",
        "ji": "0000",
        "era": "2010s",
        "profile": "2010s 고급·비표준 대형·소규모 동수",
    },
    {
        "key": "mapo-raemian-prugio",
        "lawd_cd": "11440",
        "apt_name_norm": "마포래미안푸르지오4단지",
        "sigungu_cd": "11440",
        "bjdong_cd": "10100",
        "bun": "0777",
        "ji": "0000",
        "era": "2010s",
        "profile": "2010s 신축·다타입",
    },
    {
        "key": "acro-riverpark",
        "lawd_cd": "11650",
        "apt_name_norm": "아크로리버파크",
        "sigungu_cd": "11650",
        "bjdong_cd": "10700",
        "bun": "0002",
        "ji": "0012",
        "era": "2010s",
        "profile": "2010s 최근 신축·고가",
    },
    {
        "key": "gaepo-jugong6",
        "lawd_cd": "11680",
        "apt_name_norm": "개포주공6단지",
        "sigungu_cd": "11680",
        "bjdong_cd": "10300",
        "bun": "0185",
        "ji": "0000",
        "era": "1980s",
        "profile": "1980s 구축·재건축권",
    },
    {
        "key": "daechi-palace",
        "lawd_cd": "11680",
        "apt_name_norm": "래미안대치팰리스",
        "sigungu_cd": "11680",
        "bjdong_cd": "10600",
        "bun": "1027",
        "ji": "0000",
        "era": "2010s",
        "profile": "2010s 재건축 신축·동일전용 다타입",
    },
]


def load_env() -> None:
    for name in (".env.local", ".env"):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def r2(n: float) -> float:
    return round(n + 1e-12, 2)


def to_cents(n: float) -> int:
    return int(round(n * 100))


def is_exclusive(row: dict) -> bool:
    return (
        row.get("exposPubuseGbCdNm") == "전유"
        and row.get("mainAtchGbCdNm") == "주건축물"
        and row.get("mainPurpsCdNm") == "아파트"
    )


def has_partial_common(row: dict) -> bool:
    return bool(PARTIAL_RE.search(row.get("etcPurps") or ""))


def classify_etc(etc: str) -> str:
    """Taxonomy for confidence only — does not decide supply addends."""
    etc = etc or ""
    if not etc.strip():
        return "unknown"
    has_res = bool(CLASS_RES_RE.search(etc))
    has_non = bool(CLASS_NONRES_RE.search(etc))
    if has_res:
        return "residential"
    if has_non:
        return "non-residential"
    return "unknown"


def is_res_common(row: dict, *, allow_blank: bool) -> bool:
    if row.get("exposPubuseGbCdNm") != "공용" or row.get("mainAtchGbCdNm") != "주건축물":
        return False
    etc = row.get("etcPurps") or ""
    if RES_RE.search(etc):
        return True
    return allow_blank and etc.strip() == ""


def fetch_page(service_key: str, c: dict, page: int, retries: int = 20) -> tuple[list[dict], int]:
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
    url = f"https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?{qs}"
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            if not raw.strip():
                raise RuntimeError("empty body")
            # Some intermittent gateway responses return HTML/empty XML shells.
            if "<totalCount>" not in raw and "<resultCode>" not in raw and "<resultMsg>" not in raw:
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
            return items, total
        except Exception as exc:  # noqa: BLE001
            last = exc
            msg = str(exc)
            # MOLIT gateway 503/empty bodies are common on long paginations.
            base = 1.5 if ("503" in msg or "empty body" in msg or "non-api" in msg) else 0.8
            time.sleep(min(60.0, base * (2**attempt)))
    raise RuntimeError(f"{c['key']} page {page} failed: {last}")


def write_cache(path: Path, c: dict, items: list[dict], total: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "complex": c["key"],
                "fetchedAt": now_iso(),
                "totalCount": total,
                "pageSize": PAGE_SIZE,
                "count": len(items),
                "items": items,
            },
            ensure_ascii=False,
        )
    )


def load_or_fetch_items(service_key: str, c: dict) -> list[dict]:
    cache_path = Path(c["cache"]) if c.get("cache") else OUT / f"{c['key']}-bld-expos-cache.json"
    items: list[dict] = []
    total: int | None = None
    start_page = 1

    if cache_path.exists():
        data = json.loads(cache_path.read_text())
        items = data.get("items") or data.get("rows") or []
        total = int(data.get("totalCount") or data.get("total") or len(items))
        for it in items:
            if "_area" not in it:
                try:
                    it["_area"] = float(it.get("area") or 0)
                except ValueError:
                    it["_area"] = 0.0
        if items and total and len(items) >= total:
            print(f"[{c['key']}] cache hit {len(items)}/{total}", flush=True)
            return items
        start_page = max(1, len(items) // PAGE_SIZE + 1)
        print(f"[{c['key']}] resume {len(items)}/{total} page {start_page}", flush=True)

    if start_page == 1:
        page1, total = fetch_page(service_key, c, 1)
        items = list(page1)
        pages = max(1, math.ceil(total / PAGE_SIZE))
        print(f"[{c['key']}] page 1/{pages} total={total}", flush=True)
        write_cache(cache_path, c, items, total)

    assert total is not None
    pages = max(1, math.ceil(total / PAGE_SIZE))
    for page in range(max(2, start_page), pages + 1):
        time.sleep(0.28)
        chunk, _ = fetch_page(service_key, c, page)
        expected = (page - 1) * PAGE_SIZE
        if len(items) > expected:
            items = items[:expected]
        items.extend(chunk)
        if page % 5 == 0 or page == pages:
            write_cache(cache_path, c, items, total)
        if page % 25 == 0 or page == pages:
            print(f"[{c['key']}] page {page}/{pages} have={len(items)}", flush=True)
    write_cache(cache_path, c, items, total)
    return items


def build_units(items: list[dict]) -> tuple[list[dict], dict]:
    by_unit: dict[tuple[str, str], list[dict]] = defaultdict(list)
    etc_counter: Counter[str] = Counter()
    class_counter: Counter[str] = Counter()

    for row in items:
        dong, ho = row.get("dongNm") or "", row.get("hoNm") or ""
        if dong and ho:
            by_unit[(dong, ho)].append(row)
        if row.get("exposPubuseGbCdNm") == "공용" and row.get("mainAtchGbCdNm") == "주건축물":
            etc = row.get("etcPurps") or ""
            etc_counter[etc[:80] or "(blank)"] += 1
            class_counter[classify_etc(etc)] += 1

    units: list[dict] = []
    for (dong, ho), rows in sorted(by_unit.items()):
        excl = [x for x in rows if is_exclusive(x)]
        if not excl:
            continue
        partial = any(has_partial_common(x) for x in excl)
        common_rows = [x for x in rows if is_res_common(x, allow_blank=not partial)]
        exclusive = sum(x["_area"] for x in excl)
        common = sum(x["_area"] for x in common_rows)
        if exclusive <= 0:
            continue
        units.append(
            {
                "dong": dong,
                "ho": ho,
                "exclusive_area_sqm": r2(exclusive),
                "residential_common_area_sqm": r2(common),
                "supply_area_sqm": r2(exclusive + common),
                "exclusive_includes_partial_common": partial,
            }
        )

    total_cls = sum(class_counter.values()) or 1
    stats = {
        "etc_purps_top": etc_counter.most_common(12),
        "etc_class_counts": dict(class_counter),
        "unknown_common_area_ratio": class_counter["unknown"] / total_cls,
        "residential_common_ratio": class_counter["residential"] / total_cls,
        "non_residential_common_ratio": class_counter["non-residential"] / total_cls,
    }
    return units, stats


def build_unit_types(c: dict, units: list[dict]) -> list[dict]:
    buckets: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for u in units:
        buckets[(to_cents(u["exclusive_area_sqm"]), to_cents(u["supply_area_sqm"]))].append(u)
    code = c.get("kapt_code") or c["key"]
    types: list[dict] = []
    for (ex_c, su_c), us in sorted(buckets.items(), key=lambda x: (-len(x[1]), x[0][0])):
        exclusive, supply = ex_c / 100.0, su_c / 100.0
        common = r2(supply - exclusive)
        partial_n = sum(1 for u in us if u.get("exclusive_includes_partial_common"))
        if partial_n and common <= 0:
            conf = "ambiguous"
        elif common <= 0 and len(us) < 5:
            conf = "ambiguous"
        elif len(us) <= 2:
            conf = "grouped"
        else:
            conf = "exact"
        types.append(
            {
                "unit_type_key": f"{code}:{exclusive:.2f}:{supply:.2f}",
                "supply_area_sqm": supply,
                "exclusive_area_min": exclusive,
                "exclusive_area_max": exclusive,
                "household_count": len(us),
                "mapping_confidence": conf,
                "exclusive_includes_partial_common": partial_n > 0,
            }
        )
    return types


def naive_pyeong(supply: float) -> int:
    return int(round(supply / 3.3058))


def cluster_exclusive(types: list[dict]) -> list[list[dict]]:
    ordered = sorted(types, key=lambda t: t["exclusive_area_min"])
    if not ordered:
        return []
    clusters: list[list[dict]] = [[ordered[0]]]
    for t in ordered[1:]:
        if t["exclusive_area_min"] - clusters[-1][-1]["exclusive_area_max"] <= EXCLUSIVE_GAP:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return clusters


def split_outliers(cluster: list[dict]) -> tuple[list[dict], list[dict], float]:
    if len(cluster) <= 1:
        return cluster, [], 0.0
    expanded: list[float] = []
    for t in cluster:
        expanded.extend([t["supply_area_sqm"]] * t["household_count"])
    expanded.sort()
    median = expanded[len(expanded) // 2]
    hh_total = sum(t["household_count"] for t in cluster) or 1
    core, outliers = [], []
    for t in cluster:
        share = t["household_count"] / hh_total
        if share < 0.10 and abs(t["supply_area_sqm"] - median) > 8.0:
            outliers.append(t)
        else:
            core.append(t)
    if not core:
        return cluster, [], 0.0
    return core, outliers, sum(t["household_count"] for t in outliers) / hh_total


def build_groups(c: dict, types: list[dict]) -> list[dict]:
    code = c.get("kapt_code") or c["key"]
    groups: list[dict] = []
    for idx, cluster in enumerate(cluster_exclusive(types), start=1):
        core, outliers, outlier_ratio = split_outliers(cluster)
        supplies = [t["supply_area_sqm"] for t in core]
        exclusives = [t["exclusive_area_min"] for t in core]
        votes: Counter[int] = Counter()
        hh_total = 0
        supply_hh = 0.0
        partial_hh = 0
        for t in core:
            votes[naive_pyeong(t["supply_area_sqm"])] += t["household_count"]
            hh_total += t["household_count"]
            supply_hh += t["supply_area_sqm"] * t["household_count"]
            if t.get("exclusive_includes_partial_common"):
                partial_hh += t["household_count"]
        weighted = supply_hh / max(hh_total, 1)
        partial_majority = partial_hh / max(hh_total, 1) >= 0.5
        small_zone = 80.0 <= weighted < 85.0

        ranked = votes.most_common()
        label_null_reason = None
        if not ranked:
            label, confidence, label_null_reason = None, "ambiguous", "no_votes"
        else:
            top_label, top_n = ranked[0]
            second_n = ranked[1][1] if len(ranked) > 1 else 0
            if partial_majority:
                label, confidence, label_null_reason = (
                    None,
                    "ambiguous",
                    "exclusive_includes_partial_common",
                )
            elif small_zone:
                label = None
                confidence = "grouped" if len(core) > 1 else "exact"
                label_null_reason = "small_24_25_zone"
            elif second_n > 0 and second_n / max(top_n, 1) >= 0.25:
                # 33/34·24/25 등 라벨만 충돌 — 그룹 자체는 유지, label null
                label = None
                confidence = "grouped" if len(core) > 1 else "exact"
                label_null_reason = "vote_conflict"
            else:
                label = top_label
                confidence = "exact" if len(core) == 1 else "grouped"

        # 공급 분포가 크게 갈리면 그룹 자체가 모호
        supply_span = max(supplies) - min(supplies) if supplies else 0
        if supply_span > 15:
            label, confidence = None, "ambiguous"
            label_null_reason = label_null_reason or "supply_span_conflict"

        ex_lo, ex_hi = min(exclusives), max(exclusives)
        su_lo, su_hi = min(supplies), max(supplies)
        groups.append(
            {
                "group_key": f"{code}:G{idx}:ex{ex_lo:.2f}-{ex_hi:.2f}",
                "market_label": label,
                "supply_area_min": su_lo,
                "supply_area_max": su_hi,
                "exclusive_area_min": ex_lo,
                "exclusive_area_max": ex_hi,
                "household_count": hh_total,
                "confidence": confidence,
                "group_confidence_high": confidence in ("exact", "grouped") and not partial_majority,
                "label_null_reason": label_null_reason,
                "outlier_household_ratio": r2(outlier_ratio),
                "outlier_unit_type_count": len(outliers),
                "unit_type_count": len(core),
                "naive_vote": {str(k): v for k, v in votes.items()},
                "weighted_supply": r2(weighted),
                "candidate_only": True,
            }
        )
    return groups


def load_trades(c: dict) -> list[dict]:
    out = OUT / f"{c['key']}-trades-readonly.json"
    legacy = c.get("trades_cache")
    if legacy and Path(legacy).exists() and not out.exists():
        out.write_text(Path(legacy).read_text())
    # also accept phase3 naming
    p3 = P3 / f"{c['key']}-trades-readonly.json"
    if p3.exists() and not out.exists():
        out.write_text(p3.read_text())
    if out.exists():
        return json.loads(out.read_text())["trades"]

    script = OUT / f"_export_{c['key']}.mts"
    script.write_text(
        f"""
import {{ createClient }} from "@libsql/client";
import {{ writeFileSync }} from "node:fs";
const db = createClient({{
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
}});
const r = await db.execute({{
  sql: `SELECT id, deal_date, exclusive_area, deal_amount, dealing_gbn
        FROM transactions
        WHERE deal_type='trade' AND apt_name_norm=? AND lawd_cd=?
        ORDER BY deal_date, id`,
  args: [{json.dumps(c["apt_name_norm"])}, {json.dumps(c["lawd_cd"])}],
}});
const trades = r.rows.map((row) => ({{
  id: String(row.id),
  deal_date: String(row.deal_date),
  exclusive_area: Number(row.exclusive_area),
  deal_amount: Number(row.deal_amount),
  dealing_gbn: row.dealing_gbn == null ? "" : String(row.dealing_gbn),
}}));
writeFileSync({json.dumps(str(out))}, JSON.stringify({{ count: trades.length, trades }}, null, 2));
console.log({json.dumps(c["key"])}, trades.length);
"""
    )
    subprocess.check_call(["npx", "--yes", "tsx", str(script)], cwd=str(ROOT))
    return json.loads(out.read_text())["trades"]


def map_trade(exclusive: float, groups: list[dict]) -> dict:
    hits = [
        g
        for g in groups
        if g["exclusive_area_min"] - 0.05 <= exclusive <= g["exclusive_area_max"] + 0.05
    ]
    status = "exact" if len(hits) == 1 else ("multi" if hits else "none")
    return {
        "status": status,
        "high": bool(hits) and all(g.get("group_confidence_high") for g in hits),
        "ambiguous": any(g["confidence"] == "ambiguous" for g in hits),
    }


def classify(
    units: list[dict],
    types: list[dict],
    groups: list[dict],
    trades: list[dict],
    common_stats: dict,
) -> dict:
    hh_units = len(units) or 1
    partial_ratio = sum(1 for u in units if u.get("exclusive_includes_partial_common")) / hh_units

    trade_ex = {to_cents(float(t["exclusive_area"])) for t in trades}
    type_ex = {to_cents(t["exclusive_area_min"]) for t in types}
    if trade_ex:
        trade_coverage = sum(1 for te in trade_ex if any(abs(te - xe) <= 5 for xe in type_ex)) / len(
            trade_ex
        )
        matched_hh = sum(
            t["household_count"]
            for t in types
            if any(abs(to_cents(t["exclusive_area_min"]) - te) <= 5 for te in trade_ex)
        )
        ledger_trade_hh_coverage = matched_hh / max(sum(t["household_count"] for t in types), 1)
    else:
        trade_coverage = 0.0
        ledger_trade_hh_coverage = 0.0

    group_stats: Counter[str] = Counter()
    high_map = 0
    for trade in trades:
        gm = map_trade(float(trade["exclusive_area"]), groups)
        group_stats[gm["status"]] += 1
        if gm["status"] == "exact" and gm["high"] and not gm["ambiguous"]:
            high_map += 1
    n_trades = max(len(trades), 1)
    group_exact = group_stats["exact"] / n_trades

    hh_groups = sum(g["household_count"] for g in groups) or 1
    ambiguous_group_ratio = (
        sum(g["household_count"] for g in groups if g["confidence"] == "ambiguous") / hh_groups
    )
    label_confidence = (
        sum(g["household_count"] for g in groups if g["market_label"] is not None) / hh_groups
    )
    outlier_ratio = (
        sum(g["household_count"] * g.get("outlier_household_ratio", 0) for g in groups) / hh_groups
    )
    unknown_common = common_stats["unknown_common_area_ratio"]

    reasons: list[str] = []
    if partial_ratio >= 0.50:
        classification = "registry-abnormal"
        reasons.append(f"partial_common_ratio={partial_ratio:.2f}")
    elif trade_ex and ledger_trade_hh_coverage < 0.20:
        classification = "registry-abnormal"
        reasons.append(f"ledger_trade_hh_coverage={ledger_trade_hh_coverage:.2f}")
    elif ambiguous_group_ratio >= 0.30:
        classification = "ambiguous"
        reasons.append(f"ambiguous_group_ratio={ambiguous_group_ratio:.2f}")
    elif group_exact < 0.80:
        classification = "ambiguous"
        reasons.append(f"group_exact_map_rate={group_exact:.2f}")
    elif unknown_common >= 0.38:
        # High unknown etcPurps (e.g. 1980s 지하층-heavy ledgers) blocks auto use.
        classification = "ambiguous"
        reasons.append(f"unknown_common_area_ratio={unknown_common:.2f}")
    elif unknown_common >= 0.30 and common_stats["residential_common_ratio"] < 0.40:
        classification = "ambiguous"
        reasons.append(
            f"unknown_common_area_ratio={unknown_common:.2f}"
            f"+residential={common_stats['residential_common_ratio']:.2f}"
        )
    elif outlier_ratio >= 0.20:
        classification = "ambiguous"
        reasons.append(f"supply_outlier_ratio={outlier_ratio:.2f}")
    elif label_confidence < 0.70:
        classification = "group-safe-label-unknown"
        reasons.append(f"label_confidence={label_confidence:.2f}")
    else:
        classification = "auto-safe"
        reasons.append("passed_all_gates")

    if classification in ("auto-safe", "group-safe-label-unknown"):
        singoga_mode = "market_group"
        singoga_rate = high_map / n_trades
    else:
        singoga_mode = "exclusive_area_fallback"
        singoga_rate = 0.0

    ui_examples = []
    for g in groups[:6]:
        if classification == "auto-safe" and g["market_label"] is not None:
            lines = [
                f"{g['market_label']}평형",
                f"공급 {g['supply_area_min']:.0f}~{g['supply_area_max']:.0f}㎡ · 전용 {g['exclusive_area_min']:.0f}~{g['exclusive_area_max']:.0f}㎡",
            ]
            mode = "label+range"
        elif classification in ("auto-safe", "group-safe-label-unknown") and g["group_confidence_high"]:
            lines = [
                f"공급 {g['supply_area_min']:.2f}~{g['supply_area_max']:.2f}㎡ · 전용 {g['exclusive_area_min']:.2f}~{g['exclusive_area_max']:.2f}㎡"
            ]
            mode = "range_only"
        else:
            if abs(g["exclusive_area_min"] - g["exclusive_area_max"]) < 0.005:
                lines = [f"전용 {g['exclusive_area_min']:.2f}㎡형"]
            else:
                lines = [f"전용 {g['exclusive_area_min']:.2f}~{g['exclusive_area_max']:.2f}㎡형"]
            mode = "exclusive_only"
        ui_examples.append({"group_key": g["group_key"], "mode": mode, "lines": lines})

    return {
        "classification": classification,
        "reasons": reasons,
        "metrics": {
            "partial_common_ratio": r2(partial_ratio),
            "trade_exclusive_coverage": r2(trade_coverage),
            "ledger_trade_hh_coverage": r2(ledger_trade_hh_coverage),
            "group_exact_map_rate": r2(group_exact),
            "group_ambiguity_rate": r2(ambiguous_group_ratio),
            "label_confidence": r2(label_confidence),
            "unknown_common_area_ratio": r2(unknown_common),
            "supply_outlier_ratio": r2(outlier_ratio),
            "singoga_market_group_eligible_rate": r2(singoga_rate),
        },
        "singoga_gate": {
            "mode": singoga_mode,
            "eligible_trade_rate": r2(singoga_rate),
            "rule": "group_confidence_high && not ambiguous; label may be null",
        },
        "ui_fallback_examples": ui_examples,
        "trade_mapping": dict(group_stats),
        "trade_count": len(trades),
    }


def analyze_complex(service_key: str, c: dict) -> dict:
    items = load_or_fetch_items(service_key, c)
    units, common_stats = build_units(items)
    types = build_unit_types(c, units)
    groups = build_groups(c, types)
    trades = load_trades(c)
    gate = classify(units, types, groups, trades, common_stats)
    result = {
        "complex": {
            "key": c["key"],
            "lawd_cd": c["lawd_cd"],
            "apt_name_norm": c["apt_name_norm"],
            "era": c.get("era"),
            "profile": c.get("profile"),
        },
        "ledger": {
            "fetched_items": len(items),
            "unit_households": len(units),
            "unit_type_count": len(types),
            "pyeong_group_count": len(groups),
        },
        "common_area_stats": common_stats,
        "gate": gate,
        "candidate_pyeong_groups": groups,
        "unit_types": types,
        "note": "exclusive<=1㎡ clusters are candidates only; production use requires gate pass",
    }
    (OUT / f"{c['key']}-phase4.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def build_summary(results: list[dict]) -> dict:
    counts: Counter[str] = Counter(r["gate"]["classification"] for r in results)
    n = max(len(results), 1)
    singoga_ok = sum(1 for r in results if r["gate"]["singoga_gate"]["mode"] == "market_group")
    summary = {
        "generated_at": now_iso(),
        "phase": 4,
        "principle": {
            "exclusive_le_1sqm": "candidate generation only",
            "production_requires": "confidence gate pass",
            "no_invented_pyeong_labels": True,
            "forbidden": [
                "production DB write",
                "nationwide backfill",
                "selector/singoga production change",
            ],
        },
        "classification_rubric": {
            "auto-safe": "registry normal + stable trade mapping + low ambiguity/outlier + label mostly known",
            "group-safe-label-unknown": "group high-confidence but label null (24/25, 33/34, vote conflict)",
            "ambiguous": "group conflict / weak mapping / unknown commons / heavy outliers",
            "registry-abnormal": "partial-common-in-exclusive or ledger≠trade exclusive structure",
        },
        "totals": {
            "complexes": len(results),
            "auto-safe": counts["auto-safe"],
            "group-safe-label-unknown": counts["group-safe-label-unknown"],
            "ambiguous": counts["ambiguous"],
            "registry-abnormal": counts["registry-abnormal"],
            "auto-safe_pct": r2(counts["auto-safe"] / n),
            "group-safe-label-unknown_pct": r2(counts["group-safe-label-unknown"] / n),
            "ambiguous_pct": r2(counts["ambiguous"] / n),
            "registry-abnormal_pct": r2(counts["registry-abnormal"] / n),
            "singoga_market_group_applicable_pct": r2(singoga_ok / n),
        },
        "nationwide_backfill": {
            "allowed": False,
            "reason": "Allowlist only after Phase4 gate; start with auto-safe, then B for group-only analytics",
        },
        "complexes": [
            {
                "key": r["complex"]["key"],
                "apt_name_norm": r["complex"]["apt_name_norm"],
                "era": r["complex"]["era"],
                "profile": r["complex"]["profile"],
                "classification": r["gate"]["classification"],
                "reasons": r["gate"]["reasons"],
                "metrics": r["gate"]["metrics"],
                "singoga_gate": r["gate"]["singoga_gate"],
                "ui_fallback_examples": r["gate"]["ui_fallback_examples"][:3],
                "common_area": {
                    "unknown_ratio": r["common_area_stats"]["unknown_common_area_ratio"],
                    "residential_ratio": r["common_area_stats"]["residential_common_ratio"],
                    "top_etc": r["common_area_stats"]["etc_purps_top"][:5],
                },
                "groups": [
                    {
                        "group_key": g["group_key"],
                        "market_label": g["market_label"],
                        "confidence": g["confidence"],
                        "group_confidence_high": g["group_confidence_high"],
                        "label_null_reason": g.get("label_null_reason"),
                        "households": g["household_count"],
                        "exclusive": [g["exclusive_area_min"], g["exclusive_area_max"]],
                        "supply": [g["supply_area_min"], g["supply_area_max"]],
                        "outlier_hh_ratio": g.get("outlier_household_ratio"),
                    }
                    for g in r["candidate_pyeong_groups"]
                ],
            }
            for r in results
        ],
    }
    (OUT / "phase4-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main() -> int:
    load_env()
    service_key = (
        os.environ.get("MOLIT_API_KEY")
        or os.environ.get("DATA_GO_KR_SERVICE_KEY")
        or os.environ.get("MOLIT_SERVICE_KEY")
    )
    if not service_key:
        print("MOLIT_API_KEY missing", file=sys.stderr)
        return 1

    only: set[str] = set()
    for arg in sys.argv[1:]:
        if arg.startswith("--only="):
            only.update(x.strip() for x in arg.split("=", 1)[1].split(",") if x.strip())

    results: list[dict] = []
    for c in COMPLEXES:
        if only and c["key"] not in only:
            continue
        print(f"=== {c['key']} ===", flush=True)
        try:
            results.append(analyze_complex(service_key, c))
        except Exception as exc:  # noqa: BLE001
            print(f"[{c['key']}] SKIP after error: {exc}", flush=True)
            continue

    # Always merge already-finished phase4 json so partial --only runs
    # still rebuild a full summary.
    done = {r["complex"]["key"] for r in results}
    for path in OUT.glob("*-phase4.json"):
        key = path.name.replace("-phase4.json", "")
        if key in done:
            continue
        try:
            results.append(json.loads(path.read_text()))
        except Exception as exc:  # noqa: BLE001
            print(f"[summary] skip {path.name}: {exc}", flush=True)

    if not results:
        print("no results", file=sys.stderr)
        return 1

    order = {c["key"]: i for i, c in enumerate(COMPLEXES)}
    results.sort(key=lambda r: order.get(r["complex"]["key"], 999))
    summary = build_summary(results)
    print(json.dumps(summary["totals"], ensure_ascii=False, indent=2))
    for c in summary["complexes"]:
        m = c["metrics"]
        print(
            f"{c['key']}: {c['classification']} | map={m['group_exact_map_rate']} "
            f"amb={m['group_ambiguity_rate']} label={m['label_confidence']} "
            f"singoga={c['singoga_gate']['mode']}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
