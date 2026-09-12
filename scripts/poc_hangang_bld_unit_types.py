#!/usr/bin/env python3
"""Hangang Daewoo building-ledger unit-type master PoC (phase 2). Local JSON only."""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "poc"
CACHE = OUT / "hangang-daewoo-bld-expos-cache.json"
TYPES_OUT = OUT / "hangang-daewoo-unit-types-phase2.json"
UNITS_OUT = OUT / "hangang-daewoo-units-phase2.json"
REPORT_OUT = OUT / "hangang-daewoo-phase2-report.json"

SIGUNGU, BJDONG, BUN, JI = "11170", "12900", "0415", "0000"
KAPT, NAME_NORM, LAWD = "A14003105", "한강(대우)", "11170"
PAGE_SIZE = 50  # API hard cap


def load_env() -> None:
    env = ROOT / ".env.local"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def r2(n: float) -> float:
    return round(n + 1e-12, 2)


def cents(n: float) -> int:
    return int(round(n * 100))


def is_exclusive(i: dict) -> bool:
    return (
        i.get("exposPubuseGbCdNm") == "전유"
        and i.get("mainAtchGbCdNm") == "주건축물"
        and i.get("mainPurpsCdNm") == "아파트"
    )


def is_res_common(i: dict) -> bool:
    if i.get("exposPubuseGbCdNm") != "공용" or i.get("mainAtchGbCdNm") != "주건축물":
        return False
    etc = i.get("etcPurps") or ""
    return bool(re.search(r"계단|엘리베이터|복도|현관|대피소", etc))


def market_label(supply: float) -> str | None:
    # 81.x: 공개 표기 24/25 혼재, round(supply/3.3)=25 → 자동 확정 금지.
    if 80 <= supply < 85:
        return None
    if 108 <= supply < 120:
        return "33평형"
    if 162 <= supply < 164.2:
        return "49평형"
    if 164.2 <= supply < 168:
        return "50평형"
    return None


def fetch_page(service_key: str, page: int, retries: int = 10) -> tuple[list[dict], int]:
    qs = urllib.parse.urlencode(
        {
            "serviceKey": service_key,
            "sigunguCd": SIGUNGU,
            "bjdongCd": BJDONG,
            "bun": BUN,
            "ji": JI,
            "numOfRows": str(PAGE_SIZE),
            "pageNo": str(page),
            "_type": "xml",
        }
    )
    url = f"https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?{qs}"
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                xml = resp.read().decode("utf-8", errors="replace")
            if not xml.strip():
                raise RuntimeError("empty response body")
            root = ET.fromstring(xml)
            result = (root.findtext(".//resultCode") or "").strip()
            if result and result not in ("00", "0", "000"):
                raise RuntimeError(f"API {result}: {root.findtext('.//resultMsg')}")
            total = int(root.findtext(".//totalCount") or "0")
            items = []
            for it in root.findall(".//item"):
                row = {c.tag: (c.text or "").strip() for c in it}
                try:
                    row["_area"] = float(row.get("area") or 0)
                except ValueError:
                    row["_area"] = 0.0
                items.append(row)
            return items, total
        except Exception as e:  # noqa: BLE001 — retry transient API empties/timeouts
            last_err = e
            time.sleep(min(60.0, 1.0 * (2**attempt)))
    raise RuntimeError(f"page {page} failed after {retries} retries: {last_err}")


def fetch_all(service_key: str, force: bool = False) -> list[dict]:
    if CACHE.exists() and not force:
        data = json.loads(CACHE.read_text())
        if data.get("pageSize") == PAGE_SIZE and len(data.get("items") or []) >= int(
            data.get("totalCount") or 0
        ):
            print(f"cache hit {len(data['items'])}")
            return data["items"]
        # Resume partial cache when total known and incomplete.
        if (
            not force
            and data.get("pageSize") == PAGE_SIZE
            and data.get("items")
            and int(data.get("totalCount") or 0) > len(data["items"])
        ):
            items = list(data["items"])
            total = int(data["totalCount"])
            start = (len(items) // PAGE_SIZE) + 1
            pages = math.ceil(total / PAGE_SIZE)
            print(f"resume from page {start}/{pages} have={len(items)}")
            for p in range(start, pages + 1):
                time.sleep(0.25)
                chunk, _ = fetch_page(service_key, p)
                # Drop overlapping partial last page if any
                expected_start = (p - 1) * PAGE_SIZE
                if len(items) > expected_start:
                    items = items[:expected_start]
                items.extend(chunk)
                if p % 10 == 0 or p == pages:
                    print(f"page {p}/{pages} cumulative={len(items)}")
                    CACHE.write_text(
                        json.dumps(
                            {
                                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                                "totalCount": total,
                                "pageSize": PAGE_SIZE,
                                "count": len(items),
                                "items": items,
                            },
                            ensure_ascii=False,
                        )
                    )
            return items

    page1, total = fetch_page(service_key, 1)
    pages = math.ceil(total / PAGE_SIZE) if total else 1
    items = list(page1)
    print(f"page 1/{pages} total={total} got={len(page1)}")
    CACHE.write_text(
        json.dumps(
            {
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "totalCount": total,
                "pageSize": PAGE_SIZE,
                "count": len(items),
                "items": items,
            },
            ensure_ascii=False,
        )
    )
    for p in range(2, pages + 1):
        time.sleep(0.25)
        chunk, _ = fetch_page(service_key, p)
        items.extend(chunk)
        if p % 10 == 0 or p == pages:
            print(f"page {p}/{pages} cumulative={len(items)}")
            CACHE.write_text(
                json.dumps(
                    {
                        "fetchedAt": datetime.now(timezone.utc).isoformat(),
                        "totalCount": total,
                        "pageSize": PAGE_SIZE,
                        "count": len(items),
                        "items": items,
                    },
                    ensure_ascii=False,
                )
            )
    return items


def build_units(items: list[dict]) -> list[dict]:
    by_unit: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for i in items:
        dong, ho = i.get("dongNm") or "", i.get("hoNm") or ""
        if not dong or not ho:
            continue
        if is_exclusive(i) or is_res_common(i):
            by_unit[(dong, ho)].append(i)

    units = []
    for (dong, ho), rows in sorted(by_unit.items()):
        excl = sum(x["_area"] for x in rows if is_exclusive(x))
        common = sum(x["_area"] for x in rows if is_res_common(x))
        if excl <= 0:
            continue
        supply = r2(excl + common)
        units.append(
            {
                "dong": dong,
                "ho": ho,
                "exclusive_area_sqm": r2(excl),
                "residential_common_area_sqm": r2(common),
                "supply_area_sqm": supply,
                "market_pyeong_label": market_label(supply),
                "naïve_round_pyeong": round(supply / 3.3058),
            }
        )
    return units


def build_types(units: list[dict]) -> list[dict]:
    buckets: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for u in units:
        buckets[(cents(u["exclusive_area_sqm"]), cents(u["supply_area_sqm"]))].append(u)

    types = []
    for (ex_c, su_c), us in sorted(buckets.items(), key=lambda x: (-len(x[1]), x[0][0])):
        ex = ex_c / 100
        su = su_c / 100
        common = r2(su - ex)
        if common <= 0 and len(us) < 5:
            conf = "ambiguous"
        else:
            conf = "exact"
        types.append(
            {
                "lawd_cd": LAWD,
                "apt_name_norm": NAME_NORM,
                "kapt_code": KAPT,
                "unit_type_key": f"{KAPT}:{ex:.2f}:{su:.2f}",
                "supply_area_sqm": su,
                "exclusive_area_min": ex,
                "exclusive_area_max": ex,
                "residential_common_area_sqm": common,
                "household_count": len(us),
                "type_label": f"{ex:.2f}/{su:.2f}",
                "market_pyeong_label": market_label(su),
                "naïve_round_pyeong": round(su / 3.3058) if su > 0 else None,
                "source": "building_register_expos_pubuse",
                "source_updated_at": datetime.now(timezone.utc).isoformat(),
                "mapping_confidence": conf,
                "sample_units": [{"dong": u["dong"], "ho": u["ho"]} for u in us[:5]],
            }
        )
    return types


def map_trade(ex: float, types: list[dict]) -> dict:
    c = cents(ex)
    matches = [
        t
        for t in types
        if t["mapping_confidence"] != "ambiguous"
        and cents(t["exclusive_area_min"]) <= c <= cents(t["exclusive_area_max"])
    ]
    if not matches and abs(ex - 60) < 0.02:
        matches = [
            t
            for t in types
            if t["mapping_confidence"] != "ambiguous"
            and abs(t["exclusive_area_min"] - 59.98) < 0.02
        ]
    py = {t["market_pyeong_label"] for t in matches if t.get("market_pyeong_label")}
    if len(matches) == 1:
        status = "exact"
    elif len(matches) > 1:
        status = "multi"
    else:
        status = "none"
    return {
        "status": status,
        "candidates": [t["unit_type_key"] for t in matches],
        "market_pyeong_labels": sorted(py),
        "pyeong_status": "exact" if len(py) == 1 else ("multi" if len(py) > 1 else "none"),
    }


def singoga(trades: list[dict], key_fn) -> dict:
    hist: dict[str, float] = {}
    results = []
    for t in sorted(trades, key=lambda x: (x["deal_date"], x["id"])):
        if "취소" in (t.get("dealing_gbn") or ""):
            continue
        k = key_fn(t)
        if k is None:
            results.append({**t, "is_singoga": False, "reason": "ambiguous_or_unmapped"})
            continue
        prev = hist.get(k)
        amt = float(t["deal_amount"])
        ok = prev is not None and amt > prev
        results.append({**t, "is_singoga": ok, "group_key": k, "prev_high": prev})
        hist[k] = max(prev or 0, amt)
    return {
        "count": len(results),
        "singoga_count": sum(1 for r in results if r["is_singoga"]),
        "results": results,
    }


def load_trades() -> list[dict]:
    trades_path = OUT / "hangang-daewoo-trades-readonly.json"
    if not trades_path.exists():
        subprocess.check_call(
            ["npx", "--yes", "tsx", "scripts/poc-export-hangang-trades.ts"],
            cwd=str(ROOT),
        )
    data = json.loads(trades_path.read_text())
    return list(data.get("trades") or [])


def main() -> int:
    load_env()
    key = os.environ.get("MOLIT_API_KEY")
    if not key:
        print("MOLIT_API_KEY missing", file=sys.stderr)
        return 1
    force = "--force" in sys.argv
    items = fetch_all(key, force=force)
    units = build_units(items)
    types = build_types(units)
    OUT.mkdir(parents=True, exist_ok=True)
    TYPES_OUT.write_text(json.dumps({"types": types}, ensure_ascii=False, indent=2))
    UNITS_OUT.write_text(
        json.dumps({"units": units, "count": len(units)}, ensure_ascii=False, indent=2)
    )

    trades = load_trades()
    mapped = []
    for t in trades:
        m = map_trade(float(t["exclusive_area"]), types)
        mapped.append({**t, **m})

    stats = {
        "exact": sum(1 for m in mapped if m["status"] == "exact"),
        "multi": sum(1 for m in mapped if m["status"] == "multi"),
        "none": sum(1 for m in mapped if m["status"] == "none"),
        "pyeong_exact": sum(1 for m in mapped if m["pyeong_status"] == "exact"),
        "pyeong_multi": sum(1 for m in mapped if m["pyeong_status"] == "multi"),
        "pyeong_none": sum(1 for m in mapped if m["pyeong_status"] == "none"),
    }

    excl_sg = singoga(trades, lambda t: f"ex:{cents(float(t['exclusive_area']))}")

    def supply_key(t: dict) -> str | None:
        m = map_trade(float(t["exclusive_area"]), types)
        if m["pyeong_status"] != "exact":
            return None
        return f"py:{m['market_pyeong_labels'][0]}"

    py_sg = singoga(trades, supply_key)

    def summarize(sg: dict) -> list[dict]:
        out = []
        for r in sg["results"]:
            if not r["is_singoga"]:
                continue
            out.append(
                {
                    "deal_date": r["deal_date"],
                    "exclusive_area": r["exclusive_area"],
                    "deal_amount": r["deal_amount"],
                    "group_key": r.get("group_key"),
                    "prev_high": r.get("prev_high"),
                }
            )
        return out

    excl_ids = {r["id"] for r in excl_sg["results"] if r["is_singoga"]}
    py_ids = {r["id"] for r in py_sg["results"] if r["is_singoga"]}

    report = {
        "meta": {
            "kapt_code": KAPT,
            "apt_name_norm": NAME_NORM,
            "fetched_items": len(items),
            "unit_households": len(units),
            "unit_type_count": len(types),
            "trade_count": len(trades),
            "formula": "supply = exclusive(전유) + residential_common(주건축물 공용: 계단/엘리베이터/복도/현관/대피소)",
            "exclude": "부속건축물 주차장·노인정·관리실·주민공동시설 등",
        },
        "types": [
            {
                "unit_type_key": t["unit_type_key"],
                "exclusive": t["exclusive_area_min"],
                "common": t["residential_common_area_sqm"],
                "supply": t["supply_area_sqm"],
                "households": t["household_count"],
                "market_label": t["market_pyeong_label"],
                "naive_round": t["naïve_round_pyeong"],
                "confidence": t["mapping_confidence"],
            }
            for t in types
        ],
        "label_rule": {
            "note": "round(supply/3.3)만으로 확정 불가. 81.x는 공개 표기 24/25 혼재(naive=25) → market_pyeong_label NULL.",
            "observed": [
                {"supply": "81.x", "market": "24/25 혼재(미확정)", "naive": 25},
                {"supply": "109~117", "market": "33평형", "naive": "33~35"},
                {"supply": "163.x", "market": "49평형", "naive": 49},
                {"supply": "164.8~166.7", "market": "50평형", "naive": "50"},
            ],
            "rule": "market_pyeong_label 별도 컬럼 필요. 자동 round 금지.",
        },
        "trade_mapping": stats,
        "by_exclusive": {},
        "singoga": {
            "exclusive_only": {
                "singoga_count": excl_sg["singoga_count"],
                "items": summarize(excl_sg),
            },
            "supply_pyeong_group": {
                "singoga_count": py_sg["singoga_count"],
                "items": summarize(py_sg),
            },
            "only_in_exclusive": sorted(excl_ids - py_ids),
            "only_in_supply_pyeong": sorted(py_ids - excl_ids),
        },
        "separation_49_50": {
            "possible": True,
            "rule": "exclusive 134.13 → 49평(supply 163.34); exclusive 135.27/135.5/135.87 → 50평",
        },
    }

    for t in trades:
        ex = float(t["exclusive_area"])
        k = f"{ex:g}"
        report["by_exclusive"].setdefault(k, {"n": 0, "status": None, "labels": None})
        report["by_exclusive"][k]["n"] += 1
    for ex_s, info in report["by_exclusive"].items():
        m = map_trade(float(ex_s), types)
        info["status"] = m["status"]
        info["labels"] = m["market_pyeong_labels"]
        info["pyeong_status"] = m["pyeong_status"]
        info["candidates"] = m["candidates"]

    REPORT_OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: report[k] for k in ("meta", "types", "trade_mapping", "singoga", "separation_49_50")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
