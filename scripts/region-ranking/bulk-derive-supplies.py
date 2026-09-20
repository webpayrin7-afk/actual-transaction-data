#!/usr/bin/env python3
"""Precompute derived supplies from matched shards for fast Turso upsert."""
from __future__ import annotations

import hashlib
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path("/tmp/building-hub-bulk")
SHARD_DIR = ROOT / "matched-shards"
OUT = ROOT / "derived-supplies.jsonl"
PROGRESS = ROOT / "derive-progress.json"

RES = re.compile(r"계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과")
PARTIAL = re.compile(r"공유면적|일부공유")


def unit_id(row: dict) -> tuple[str, str] | None:
    dong = (row.get("dongNm") or "").strip()
    ho = (row.get("hoNm") or "").strip()
    if not dong and "-" in ho:
        head, *rest = ho.split("-")
        if head and rest:
            dong, ho = head, "-".join(rest)
    if not dong or not ho:
        return None
    return dong, ho


def round2(n: float) -> float:
    return round(n + 1e-12, 2)


def cents(n: float) -> int:
    return int(round(n * 100))


def derive(rows: list[dict], apt_name: str) -> dict:
    by_unit: dict[tuple[str, str], list[dict]] = defaultdict(list)
    matched = 0
    rejected = 0
    main_common = 0
    main_res = 0
    for row in rows:
        building = (row.get("bldNm") or "").strip()
        if building:
            b = building.replace(" ", "").replace("아파트", "").replace("(", "").replace(")", "")
            a = apt_name.replace(" ", "").replace("아파트", "").replace("(", "").replace(")", "")
            if len(b) >= 2 and len(a) >= 2 and not (b in a or a in b):
                rejected += 1
                continue
        matched += 1
        uid = unit_id(row)
        if not uid:
            continue
        by_unit[uid].append(row)
        if row.get("exposPubuseGbCdNm") == "공용" and row.get("mainAtchGbCdNm") == "주건축물":
            main_common += 1
            etc = row.get("etcPurps") or ""
            if RES.search(etc) or etc.strip() == "":
                main_res += 1
    supplies: Counter[tuple[int, int]] = Counter()
    units = 0
    derivable_units = 0
    for group in by_unit.values():
        excl = [
            x
            for x in group
            if x.get("exposPubuseGbCdNm") == "전유"
            and x.get("mainAtchGbCdNm") == "주건축물"
            and x.get("mainPurpsCdNm") == "아파트"
        ]
        if not excl:
            continue
        units += 1
        partial = any(PARTIAL.search(x.get("etcPurps") or "") for x in excl)
        allow_blank = not partial
        res_rows = [
            x
            for x in group
            if x.get("exposPubuseGbCdNm") == "공용"
            and x.get("mainAtchGbCdNm") == "주건축물"
            and (RES.search(x.get("etcPurps") or "") or (allow_blank and not (x.get("etcPurps") or "").strip()))
        ]
        unknown = [
            x
            for x in group
            if x.get("exposPubuseGbCdNm") == "공용"
            and x.get("mainAtchGbCdNm") == "주건축물"
            and x not in res_rows
        ]
        exclusive = round2(sum(float(x.get("area") or 0) for x in excl))
        common = round2(sum(float(x.get("area") or 0) for x in res_rows))
        if exclusive <= 0 or partial or unknown or common <= 0:
            continue
        supply = round2(exclusive + common)
        supplies[(cents(exclusive), cents(supply))] += 1
        derivable_units += 1
    out_supplies = []
    for (ex, su), n in sorted(supplies.items()):
        if n < 3:
            continue
        out_supplies.append(
            {
                "exclusiveCents": ex,
                "supplyCents": su,
                "exclusiveArea": ex / 100.0,
                "supplyArea": su / 100.0,
                "residentialCommonArea": round2(su / 100.0 - ex / 100.0),
                "householdCount": n,
                "formula": "exclusive_plus_residential_common",
            }
        )
    ratio = (main_res / main_common) if main_common else 0.0
    return {
        "units": units,
        "derivableUnits": derivable_units,
        "supplies": out_supplies,
        "residentialCommonRatio": ratio,
        "distinguishable": ratio >= 0.9 and len(out_supplies) > 0,
        "matchedRows": matched,
        "rejectedNameRows": rejected,
        "rawRows": len(rows),
    }


def apt_names() -> dict[str, dict]:
    names: dict[str, dict] = {}
    for file in ("manifest-parcels.jsonl", "pilot-parcels.jsonl"):
        path = ROOT / file
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            if not line:
                continue
            row = json.loads(line)
            names.setdefault(row["complexId"], row)
    return names


def main() -> None:
    names = apt_names()
    out = OUT.open("w", encoding="utf-8")
    n = 0
    distinguishable = 0
    for dig in sorted(os.listdir(SHARD_DIR)):
        d = SHARD_DIR / dig
        if not d.is_dir():
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".jsonl"):
                continue
            complex_id = name[:-6]
            info = names.get(complex_id)
            if not info:
                continue
            rows = [json.loads(line) for line in (d / name).read_text().splitlines() if line]
            derived = derive(rows, info.get("aptName") or "")
            payload = {
                "complexId": complex_id,
                "aptName": info.get("aptName"),
                "pnu": info.get("pnu") or "",
                "parcelKey": info.get("parcelKey"),
                **derived,
            }
            out.write(json.dumps(payload, ensure_ascii=False) + "\n")
            n += 1
            if derived["distinguishable"]:
                distinguishable += 1
            if n % 500 == 0:
                print(json.dumps({"n": n, "distinguishable": distinguishable}), flush=True)
                PROGRESS.write_text(json.dumps({"n": n, "distinguishable": distinguishable}))
    out.close()
    summary = {"complexes": n, "distinguishable": distinguishable, "out": str(OUT)}
    (ROOT / "derive-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
