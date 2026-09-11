#!/usr/bin/env python3
"""
Phase 3 PoC — apt_unit_types vs apt_pyeong_groups

공식 건축물 타입과 시장 평형그룹을 분리해 검증한다.
production DB write / selector / 신고가 production / 전국 backfill 금지.
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
OUT = ROOT / "data" / "poc" / "phase3"
OUT.mkdir(parents=True, exist_ok=True)

PAGE_SIZE = 100
# 주거공용: Phase2 키워드 + 현장 표기 이명(승강기) + 공급산입 빈출(홀/벽체/발코니초과)
# 반포자이 등: 공급 ≈ 전유 + 계단실·승강기·홀 + 벽체·발코니초과
RES_COMMON_RE = re.compile(r"계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과")

COMPLEXES: list[dict[str, Any]] = [
    {
        "key": "hangang-daewoo",
        "lawd_cd": "11170",
        "apt_name_norm": "한강(대우)",
        "kapt_code": "A14003105",
        "sigungu_cd": "11170",
        "bjdong_cd": "12900",
        "bun": "0415",
        "ji": "0000",
        "profile": "구축·동일전용 A/B/C·공급차이",
        "cache": ROOT / "data" / "poc" / "hangang-daewoo-bld-expos-cache.json",
    },
    {
        "key": "eunma",
        "lawd_cd": "11680",
        "apt_name_norm": "은마",
        "kapt_code": None,
        "sigungu_cd": "11680",
        "bjdong_cd": "10600",
        "bun": "0316",
        "ji": "0000",
        "profile": "구축 대단지·전형 76/84",
    },
    {
        "key": "jamsil-els",
        "lawd_cd": "11710",
        "apt_name_norm": "잠실엘스",
        "kapt_code": None,
        "sigungu_cd": "11710",
        "bjdong_cd": "10100",
        "bun": "0019",
        "ji": "0000",
        "profile": "구축 대단지·59/84/114",
    },
    {
        "key": "banpo-xi",
        "lawd_cd": "11650",
        "apt_name_norm": "반포자이",
        "kapt_code": None,
        "sigungu_cd": "11650",
        "bjdong_cd": "10700",
        "bun": "0020",
        "ji": "0043",
        "profile": "신축급·광범위 면적·다타입",
    },
    {
        "key": "raemian-hill-godeok",
        "lawd_cd": "11740",
        "apt_name_norm": "래미안힐스테이트고덕",
        "kapt_code": None,
        "sigungu_cd": "11740",
        "bjdong_cd": "10200",
        "bun": "0688",
        "ji": "0000",
        "profile": "신축 대단지·다타입",
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


def exclusive_includes_partial_common(row: dict) -> bool:
    """전유 행이 이미 일부 공유면적을 포함한 경우 (은마 등)."""
    etc = row.get("etcPurps") or ""
    return "공유면적" in etc or "일부공유" in etc


def is_res_common(row: dict, *, allow_blank: bool) -> bool:
    """주거공용 판정.

    - 기본: 계단/엘리베이터/복도/현관/대피소
    - 보조: etcPurps 공란인 주건축물 공용은 allow_blank=True 일 때만
      (전유에 공유면적이 이미 포함된 호는 이중계산 방지를 위해 금지)
    """
    if row.get("exposPubuseGbCdNm") != "공용" or row.get("mainAtchGbCdNm") != "주건축물":
        return False
    etc = row.get("etcPurps") or ""
    if RES_COMMON_RE.search(etc):
        return True
    return allow_blank and etc.strip() == ""


def fetch_page(service_key: str, c: dict, page: int, retries: int = 8) -> tuple[list[dict], int]:
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
            time.sleep(min(45.0, 0.8 * (2**attempt)))
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
        time.sleep(0.22)
        chunk, _ = fetch_page(service_key, c, page)
        expected = (page - 1) * PAGE_SIZE
        if len(items) > expected:
            items = items[:expected]
        items.extend(chunk)
        if page % 25 == 0 or page == pages:
            print(f"[{c['key']}] page {page}/{pages} have={len(items)}", flush=True)
            write_cache(cache_path, c, items, total)
    write_cache(cache_path, c, items, total)
    return items


def build_units(items: list[dict]) -> list[dict]:
    by_dong_ho: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in items:
        dong, ho = row.get("dongNm") or "", row.get("hoNm") or ""
        if not dong or not ho:
            continue
        by_dong_ho[(dong, ho)].append(row)

    units: list[dict] = []
    for (dong, ho), all_rows in sorted(by_dong_ho.items()):
        excl_rows = [x for x in all_rows if is_exclusive(x)]
        if not excl_rows:
            continue
        partial = any(exclusive_includes_partial_common(x) for x in excl_rows)
        # 전유에 공유면적 포함 → 공란 공용 가산 금지 (이중계산)
        allow_blank = not partial
        common_rows = [x for x in all_rows if is_res_common(x, allow_blank=allow_blank)]
        exclusive = sum(x["_area"] for x in excl_rows)
        common = sum(x["_area"] for x in common_rows)
        if exclusive <= 0:
            continue
        part_map: dict[str, float] = defaultdict(float)
        for x in common_rows:
            part_map[x.get("etcPurps") or ""] += float(x.get("area") or 0)
        keys = [(x.get("etcPurps"), x.get("flrNoNm"), x.get("area")) for x in common_rows]
        units.append(
            {
                "dong": dong,
                "ho": ho,
                "exclusive_area_sqm": r2(exclusive),
                "residential_common_area_sqm": r2(common),
                "supply_area_sqm": r2(exclusive + common),
                "common_parts": sorted((k, r2(v)) for k, v in part_map.items()),
                "dup_common_rows": len(keys) != len(set(keys)),
                "n_common_rows": len(common_rows),
                "n_exclusive_rows": len(excl_rows),
                "exclusive_includes_partial_common": partial,
            }
        )
    return units


def build_unit_types(c: dict, units: list[dict]) -> list[dict]:
    buckets: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for unit in units:
        key = (to_cents(unit["exclusive_area_sqm"]), to_cents(unit["supply_area_sqm"]))
        buckets[key].append(unit)

    code = c.get("kapt_code") or c["key"]
    types: list[dict] = []
    for (ex_c, su_c), us in sorted(buckets.items(), key=lambda x: (-len(x[1]), x[0][0])):
        exclusive = ex_c / 100.0
        supply = su_c / 100.0
        common = r2(supply - exclusive)
        partial_n = sum(1 for u in us if u.get("exclusive_includes_partial_common"))
        if partial_n > 0 and common <= 0:
            confidence = "ambiguous"
        elif common <= 0 and len(us) < 5:
            confidence = "ambiguous"
        elif len(us) <= 2:
            confidence = "grouped"
        else:
            confidence = "exact"
        types.append(
            {
                "unit_type_key": f"{code}:{exclusive:.2f}:{supply:.2f}",
                "lawd_cd": c["lawd_cd"],
                "apt_name_norm": c["apt_name_norm"],
                "kapt_code": c.get("kapt_code"),
                "supply_area_sqm": supply,
                "exclusive_area_min": exclusive,
                "exclusive_area_max": exclusive,
                "residential_common_area_sqm": common,
                "household_count": len(us),
                "type_label": f"{exclusive:.2f}/{supply:.2f}",
                "mapping_confidence": confidence,
                "source": "building_register_expos_pubuse",
                "source_updated_at": now_iso(),
                "sample_units": [{"dong": u["dong"], "ho": u["ho"]} for u in us[:5]],
                "anomaly_dup_common": sum(1 for u in us if u.get("dup_common_rows")),
                "exclusive_includes_partial_common": partial_n > 0,
                "partial_common_households": partial_n,
            }
        )
    return types


def naive_pyeong(supply: float) -> int:
    return int(round(supply / 3.3058))


def dist_to_half(supply: float) -> float:
    frac = (supply / 3.3058) % 1.0
    return abs(frac - 0.5)


EXCLUSIVE_CLUSTER_GAP = 1.0


def _cluster_by_exclusive(types: list[dict], gap: float) -> list[list[dict]]:
    """전용면적 근접(≤gap)만으로 시장 그룹 후보를 만든다.

    공급면적으로 재분할하지 않는다 — 동일 전용 밴드의 공급 차이
    (한강대우 109 vs 117)는 같은 시장 그룹이어야 하고,
    공급 분할은 전용 구간이 겹치는 그룹을 만들어 실거래 매핑을 깨뜨린다.
    """
    ordered = sorted(types, key=lambda t: t["exclusive_area_min"])
    if not ordered:
        return []
    clusters: list[list[dict]] = [[ordered[0]]]
    for t in ordered[1:]:
        prev_max = clusters[-1][-1]["exclusive_area_max"]
        if t["exclusive_area_min"] - prev_max <= gap:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return clusters


def build_pyeong_groups(c: dict, types: list[dict]) -> tuple[list[dict], list[dict]]:
    if not types:
        return [], []

    raw_clusters = _cluster_by_exclusive(types, EXCLUSIVE_CLUSTER_GAP)

    code = c.get("kapt_code") or c["key"]
    groups: list[dict] = []
    links: list[dict] = []
    for idx, cluster in enumerate(raw_clusters, start=1):
        supplies = [t["supply_area_sqm"] for t in cluster]
        exclusives = [t["exclusive_area_min"] for t in cluster]
        votes: Counter[int] = Counter()
        hh_total = 0
        supply_hh = 0.0
        partial_hh = 0
        for t in cluster:
            votes[naive_pyeong(t["supply_area_sqm"])] += t["household_count"]
            hh_total += t["household_count"]
            supply_hh += t["supply_area_sqm"] * t["household_count"]
            if t.get("exclusive_includes_partial_common"):
                partial_hh += t["household_count"]
        weighted_supply = supply_hh / max(hh_total, 1)
        partial_majority = partial_hh / max(hh_total, 1) >= 0.5

        # 24/25 혼재 구간만 라벨 null. 그 외는 세대수 가중 최빈값 사용.
        small_label_zone = 80.0 <= weighted_supply < 85.0

        ranked = votes.most_common()
        label_null_reason: str | None = None
        if not ranked:
            label: int | None = None
            confidence = "ambiguous"
            label_null_reason = "no_votes"
        else:
            top_label, top_n = ranked[0]
            second_n = ranked[1][1] if len(ranked) > 1 else 0
            if partial_majority:
                # 전유=일부공유포함 대장은 공급/라벨 신뢰 낮음 → 라벨 확정 금지
                label = None
                confidence = "ambiguous"
                label_null_reason = "exclusive_includes_partial_common"
            elif small_label_zone:
                label = None
                confidence = "grouped" if len(cluster) > 1 else "exact"
                label_null_reason = "small_24_25_zone"
            elif second_n > 0 and second_n / max(top_n, 1) >= 0.25:
                label = None
                confidence = "ambiguous"
                label_null_reason = "vote_conflict"
            else:
                label = top_label
                confidence = "exact" if len(cluster) == 1 else "grouped"

        ex_lo, ex_hi = min(exclusives), max(exclusives)
        su_lo, su_hi = min(supplies), max(supplies)
        if label is None:
            if abs(ex_lo - ex_hi) < 0.005 and abs(su_lo - su_hi) < 0.005:
                display = f"전용 {ex_lo:.2f}㎡"
            elif abs(ex_lo - ex_hi) < 0.005:
                display = f"전용 {ex_lo:.2f}㎡ · 공급 {su_lo:.2f}~{su_hi:.2f}㎡"
            else:
                display = f"전용 {ex_lo:.2f}~{ex_hi:.2f}㎡ · 공급 {su_lo:.2f}~{su_hi:.2f}㎡"
        else:
            display = f"{label}평형"

        group_key = f"{code}:G{idx}:ex{ex_lo:.2f}-{ex_hi:.2f}"
        group = {
            "group_key": group_key,
            "lawd_cd": c["lawd_cd"],
            "apt_name_norm": c["apt_name_norm"],
            "kapt_code": c.get("kapt_code"),
            "market_label": label,
            "display_fallback": display,
            "supply_area_min": su_lo,
            "supply_area_max": su_hi,
            "exclusive_area_min": ex_lo,
            "exclusive_area_max": ex_hi,
            "household_count": sum(t["household_count"] for t in cluster),
            "confidence": confidence,
            "source": "unit_types_clustered_by_exclusive<=1.0",
            "source_updated_at": now_iso(),
            "unit_type_keys": [t["unit_type_key"] for t in cluster],
            "unit_type_count": len(cluster),
            "naive_vote": {str(k): v for k, v in votes.items()},
            "weighted_supply": r2(weighted_supply),
            "label_null_reason": label_null_reason,
            "partial_common_households": partial_hh,
        }
        groups.append(group)
        for t in cluster:
            t["pyeong_group_key"] = group_key
            t["market_label_inferred"] = label
            links.append(
                {
                    "unit_type_key": t["unit_type_key"],
                    "group_key": group_key,
                    "lawd_cd": c["lawd_cd"],
                    "apt_name_norm": c["apt_name_norm"],
                }
            )
    return groups, links


def load_trades(c: dict) -> list[dict]:
    out = OUT / f"{c['key']}-trades-readonly.json"
    legacy = ROOT / "data" / "poc" / "hangang-daewoo-trades-readonly.json"
    if c["key"] == "hangang-daewoo" and legacy.exists() and not out.exists():
        out.write_text(legacy.read_text())
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


def map_trade_to_types(exclusive: float, types: list[dict]) -> dict:
    c = to_cents(exclusive)
    hits = [
        t
        for t in types
        if t["mapping_confidence"] != "ambiguous"
        and to_cents(t["exclusive_area_min"]) <= c <= to_cents(t["exclusive_area_max"])
    ]
    if not hits:
        hits = [
            t
            for t in types
            if t["mapping_confidence"] != "ambiguous"
            and abs(t["exclusive_area_min"] - exclusive) <= 0.05
        ]
    status = "exact" if len(hits) == 1 else ("multi" if hits else "none")
    return {"status": status, "candidates": [t["unit_type_key"] for t in hits]}


def map_trade_to_group(exclusive: float, groups: list[dict]) -> dict:
    hits = [
        g
        for g in groups
        if g["exclusive_area_min"] - 0.05 <= exclusive <= g["exclusive_area_max"] + 0.05
    ]
    status = "exact" if len(hits) == 1 else ("multi" if hits else "none")
    labels = {g["market_label"] for g in hits if g.get("market_label") is not None}
    return {
        "status": status,
        "candidates": [g["group_key"] for g in hits],
        "labels": sorted(labels),
        "label_status": "exact" if len(labels) == 1 else ("multi" if len(labels) > 1 else "none"),
    }


def compute_singoga(trades: list[dict], key_fn) -> dict:
    hist: dict[str, float] = {}
    results = []
    for trade in sorted(trades, key=lambda x: (x["deal_date"], x["id"])):
        if "취소" in (trade.get("dealing_gbn") or ""):
            continue
        key = key_fn(trade)
        if key is None:
            results.append({**trade, "is_singoga": False, "reason": "unmapped_or_ambiguous"})
            continue
        prev = hist.get(key)
        amount = float(trade["deal_amount"])
        is_hit = prev is not None and amount > prev
        results.append({**trade, "is_singoga": is_hit, "group_key": key, "prev_high": prev})
        hist[key] = max(prev or 0.0, amount)
    return {
        "singoga_count": sum(1 for r in results if r["is_singoga"]),
        "results": results,
    }


def audit_hangang_117(units: list[dict]) -> dict:
    target = [u for u in units if abs(u["supply_area_sqm"] - 117.13) < 0.05]
    parts = sorted({tuple(u["common_parts"]) for u in target})
    return {
        "households": len(target),
        "dongs": sorted({u["dong"] for u in target}),
        "common_parts_unique": [list(p) for p in parts],
        "dup_common_any": any(u["dup_common_rows"] for u in target),
        "all_same_structure": len(parts) == 1,
        "exclusive": sorted({u["exclusive_area_sqm"] for u in target}),
        "note": "108동 40세대 동일구조. 공용=계단실/엘리베이터+지하대피소. 중복합산 없음.",
        "public_crosscheck": [
            {
                "source": "hwik.kr",
                "finding": "33평형 공급 109.3~117.1; 타입117=117.1㎡ 40세대. 109A/B와 동일 33평 그룹.",
            },
            {
                "source": "hogangnono.com",
                "finding": "33평 그룹 존재. 81계열은 24평 표기(휘익은 25평) → 라벨만 충돌.",
            },
        ],
    }


def analyze_complex(service_key: str, c: dict) -> dict:
    items = load_or_fetch_items(service_key, c)
    units = build_units(items)
    types = build_unit_types(c, units)
    groups, links = build_pyeong_groups(c, types)
    trades = load_trades(c)

    type_stats: Counter[str] = Counter()
    group_stats: Counter[str] = Counter()
    label_stats: Counter[str] = Counter()
    for trade in trades:
        exclusive = float(trade["exclusive_area"])
        type_stats[map_trade_to_types(exclusive, types)["status"]] += 1
        gm = map_trade_to_group(exclusive, groups)
        group_stats[gm["status"]] += 1
        label_stats[gm["label_status"]] += 1

    exclusive_sg = compute_singoga(
        trades, lambda t: f"ex:{to_cents(float(t['exclusive_area']))}"
    )

    def group_key_fn(trade: dict) -> str | None:
        gm = map_trade_to_group(float(trade["exclusive_area"]), groups)
        if gm["status"] != "exact":
            return None
        return f"grp:{gm['candidates'][0]}"

    group_sg = compute_singoga(trades, group_key_fn)
    exclusive_ids = {r["id"] for r in exclusive_sg["results"] if r["is_singoga"]}
    group_ids = {r["id"] for r in group_sg["results"] if r["is_singoga"]}
    only_exclusive = [r for r in exclusive_sg["results"] if r["id"] in exclusive_ids - group_ids]
    only_group = [r for r in group_sg["results"] if r["id"] in group_ids - exclusive_ids]

    def brief(rows: list[dict], limit: int = 5) -> list[dict]:
        return [
            {
                "id": r["id"],
                "deal_date": r["deal_date"],
                "exclusive_area": r["exclusive_area"],
                "deal_amount": r["deal_amount"],
                "group_key": r.get("group_key"),
                "prev_high": r.get("prev_high"),
            }
            for r in rows[:limit]
        ]

    anomalies = {
        "units_with_dup_common": sum(1 for u in units if u.get("dup_common_rows")),
        "units_partial_common_in_exclusive": sum(
            1 for u in units if u.get("exclusive_includes_partial_common")
        ),
        "types_ambiguous": sum(1 for t in types if t["mapping_confidence"] == "ambiguous"),
        "types_zero_common": sum(1 for t in types if t["residential_common_area_sqm"] <= 0),
        "types_partial_common": sum(
            1 for t in types if t.get("exclusive_includes_partial_common")
        ),
        "groups_ambiguous": sum(1 for g in groups if g["confidence"] == "ambiguous"),
        "groups_label_null": sum(1 for g in groups if g["market_label"] is None),
        "ledger_vs_trade_exclusive_mismatch": False,
    }
    trade_ex = {to_cents(float(t["exclusive_area"])) for t in trades}
    type_ex = {to_cents(t["exclusive_area_min"]) for t in types}
    if trade_ex and type_ex:
        # 실거래 전용 중 과반이 대장 unit type 전유에 없으면 불일치 플래그
        matched = sum(1 for c in trade_ex if any(abs(c - te) <= 5 for te in type_ex))
        anomalies["ledger_vs_trade_exclusive_mismatch"] = matched / len(trade_ex) < 0.5
        anomalies["trade_exclusive_values"] = sorted(c / 100.0 for c in trade_ex)
        anomalies["ledger_exclusive_top"] = sorted(
            {t["exclusive_area_min"] for t in types},
        )[:20]
    n_trades = max(len(trades), 1)
    result = {
        "complex": {
            "key": c["key"],
            "lawd_cd": c["lawd_cd"],
            "apt_name_norm": c["apt_name_norm"],
            "kapt_code": c.get("kapt_code"),
            "profile": c["profile"],
        },
        "ledger": {
            "fetched_items": len(items),
            "unit_households": len(units),
            "unit_type_count": len(types),
            "pyeong_group_count": len(groups),
        },
        "hangang_117_audit": audit_hangang_117(units) if c["key"] == "hangang-daewoo" else None,
        "unit_types": types,
        "pyeong_groups": groups,
        "unit_type_group_links": links,
        "trade_mapping": {
            "trade_count": len(trades),
            "type_level": dict(type_stats),
            "group_level": dict(group_stats),
            "label_level": dict(label_stats),
        },
        "singoga": {
            "exclusive_only": exclusive_sg["singoga_count"],
            "market_group": group_sg["singoga_count"],
            "only_exclusive_examples": brief(only_exclusive),
            "only_group_examples": brief(only_group),
        },
        "anomalies": anomalies,
        "metrics": {
            "unit_type_exact_rate": type_stats["exact"] / n_trades,
            "unit_type_multi_rate": type_stats["multi"] / n_trades,
            "group_exact_map_rate": group_stats["exact"] / n_trades,
            "group_auto_map_rate": (group_stats["exact"] + group_stats["multi"]) / n_trades,
            "ambiguous_group_ratio": (
                anomalies["groups_ambiguous"] / len(groups) if groups else None
            ),
            "market_label_auto_rate": (
                sum(1 for g in groups if g["market_label"] is not None) / len(groups)
                if groups
                else None
            ),
        },
    }
    (OUT / f"{c['key']}-phase3.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2)
    )
    return result


def build_summary_from_disk() -> dict:
    """Merge all *-phase3.json so --only runs do not wipe other complexes."""
    results = []
    for path in sorted(OUT.glob("*-phase3.json")):
        if path.name.startswith("_"):
            continue
        results.append(json.loads(path.read_text()))
    summary = {
        "generated_at": now_iso(),
        "model_split": {
            "apt_unit_types": "공식 건축물 타입 (전유+주거공용)",
            "apt_pyeong_groups": "사용자 분석용 시장 그룹 (unit type 클러스터)",
        },
        "complexes": [
            {
                "key": r["complex"]["key"],
                "profile": r["complex"]["profile"],
                "ledger": r["ledger"],
                "trade_mapping": r["trade_mapping"],
                "singoga": {
                    "exclusive_only": r["singoga"]["exclusive_only"],
                    "market_group": r["singoga"]["market_group"],
                },
                "metrics": r["metrics"],
                "anomalies": r["anomalies"],
                "groups": [
                    {
                        "group_key": g["group_key"],
                        "market_label": g["market_label"],
                        "display_fallback": g["display_fallback"],
                        "supply": [g["supply_area_min"], g["supply_area_max"]],
                        "exclusive": [g["exclusive_area_min"], g["exclusive_area_max"]],
                        "households": g["household_count"],
                        "confidence": g["confidence"],
                        "unit_types": g["unit_type_count"],
                        "label_null_reason": g.get("label_null_reason"),
                    }
                    for g in r["pyeong_groups"]
                ],
                "hangang_117_audit": r.get("hangang_117_audit"),
                "false_singoga_examples": r["singoga"]["only_exclusive_examples"][:5],
            }
            for r in results
        ],
    }
    (OUT / "phase3-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main() -> int:
    load_env()
    service_key = os.environ.get("MOLIT_API_KEY") or os.environ.get("DATA_GO_KR_SERVICE_KEY")
    if not service_key:
        print("MOLIT_API_KEY missing", file=sys.stderr)
        return 1

    only: set[str] = set()
    for arg in sys.argv[1:]:
        if arg.startswith("--only="):
            only.update(x.strip() for x in arg.split("=", 1)[1].split(",") if x.strip())
    for complex_cfg in COMPLEXES:
        if only and complex_cfg["key"] not in only:
            continue
        print(f"=== {complex_cfg['key']} ===", flush=True)
        analyze_complex(service_key, complex_cfg)

    summary = build_summary_from_disk()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
