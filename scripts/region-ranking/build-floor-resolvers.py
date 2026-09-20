#!/usr/bin/env python3
"""Build EXACT_FLOOR / EXACT_DONG_FLOOR resolvers from local unit shards.

Transactions have no building-dong, so EXACT_DONG_FLOOR rows are stored for
future identity but are not applied to current trades.
"""
from __future__ import annotations

import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path("/tmp/building-hub-bulk/matched-shards")
OUT = Path("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl")
IDS = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/building-hub-bulk/external-evidence/resolver-complexes.txt")

RES_RE_PARTS = ("계단", "엘리베이터", "승강기", "복도", "현관", "홀", "대피소", "벽체", "발코니초과")
PARTIAL_PARTS = ("공유면적", "일부공유")


def names_ok(building: str, apt: str) -> bool:
    b = building.replace(" ", "").replace("아파트", "").replace("(", "").replace(")", "")
    a = apt.replace(" ", "").replace("아파트", "").replace("(", "").replace(")", "")
    if len(b) < 2 or len(a) < 2:
        return True
    return b in a or a in b


def norm_floor(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    neg = s.startswith("-")
    digits = "".join(ch for ch in s if ch.isdigit())
    if not digits:
        return ""
    n = int(digits)
    return f"-{n}" if neg else str(n)


def cents(area: float) -> int:
    return int(round(area * 100))


def main() -> int:
    targets: dict[str, str] = {}
    for line in IDS.read_text().splitlines():
        if not line.strip():
            continue
        cid, _, name = line.partition("\t")
        targets[cid] = name
    print(f"targets {len(targets)}", flush=True)

    # key -> set of supply cents
    floor_map: dict[tuple[str, int, str], set[int]] = defaultdict(set)
    dong_floor_map: dict[tuple[str, int, str, str], set[int]] = defaultdict(set)
    scanned = 0
    missing = 0

    for cid, apt in targets.items():
        digest = hashlib.sha1(cid.encode()).hexdigest()[:2]
        path = ROOT / digest / f"{cid}.jsonl"
        if not path.exists():
            missing += 1
            continue
        scanned += 1
        by_unit: dict[str, list[dict]] = defaultdict(list)
        main_common = 0
        main_res = 0
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                bld = (row.get("bldNm") or "").strip()
                if bld and not names_ok(bld, apt):
                    continue
                dong = (row.get("dongNm") or "").strip()
                ho = (row.get("hoNm") or "").strip()
                if not dong and "-" in ho:
                    head, rest = ho.split("-", 1)
                    if head and rest:
                        dong, ho = head, rest
                if not dong or not ho:
                    continue
                by_unit[f"{dong}\t{ho}"].append(row)
                if row.get("exposPubuseGbCdNm") == "공용" and row.get("mainAtchGbCdNm") == "주건축물":
                    main_common += 1
                    etc = row.get("etcPurps") or ""
                    if any(p in etc for p in RES_RE_PARTS) or etc.strip() == "":
                        main_res += 1
        if main_common and (main_res / main_common) < 0.9:
            continue
        for key, group in by_unit.items():
            dong, ho = key.split("\t", 1)
            exclusives = [
                r for r in group
                if r.get("exposPubuseGbCdNm") == "전유"
                and r.get("mainAtchGbCdNm") == "주건축물"
                and r.get("mainPurpsCdNm") == "아파트"
            ]
            if not exclusives:
                continue
            if any(any(p in (r.get("etcPurps") or "") for p in PARTIAL_PARTS) for r in exclusives):
                continue
            res_rows = []
            unknown = []
            for r in group:
                if r.get("exposPubuseGbCdNm") != "공용" or r.get("mainAtchGbCdNm") != "주건축물":
                    continue
                etc = r.get("etcPurps") or ""
                if any(p in etc for p in RES_RE_PARTS) or etc.strip() == "":
                    res_rows.append(r)
                else:
                    unknown.append(r)
            if unknown:
                continue
            exclusive = sum(float(r.get("area") or 0) for r in exclusives)
            residential = sum(float(r.get("area") or 0) for r in res_rows)
            if exclusive <= 0 or residential <= 0:
                continue
            supply = exclusive + residential
            ex_c = cents(exclusive)
            su_c = cents(supply)
            if ex_c <= 0 or su_c <= 0 or su_c <= ex_c:
                continue
            floor = norm_floor(str(exclusives[0].get("flrNo") or ""))
            if not floor:
                continue
            floor_map[(cid, ex_c, floor)].add(su_c)
            dong_floor_map[(cid, ex_c, dong, floor)].add(su_c)
        if scanned % 200 == 0:
            print(json.dumps({"scanned": scanned, "missing": missing, "floor_keys": len(floor_map)}), flush=True)

    written = 0
    with OUT.open("w", encoding="utf-8") as out:
        for (cid, ex_c, floor), supplies in floor_map.items():
            if len(supplies) != 1:
                continue
            su = next(iter(supplies))
            out.write(json.dumps({
                "complexId": cid,
                "exclusiveCents": ex_c,
                "buildingDong": "",
                "floor": floor,
                "supplyCents": su,
                "level": "EXACT_FLOOR",
                "status": "EXACT_FLOOR",
            }, ensure_ascii=False) + "\n")
            written += 1
        for (cid, ex_c, dong, floor), supplies in dong_floor_map.items():
            if len(supplies) != 1:
                continue
            su = next(iter(supplies))
            out.write(json.dumps({
                "complexId": cid,
                "exclusiveCents": ex_c,
                "buildingDong": dong,
                "floor": floor,
                "supplyCents": su,
                "level": "EXACT_DONG_FLOOR",
                "status": "EXACT_DONG_FLOOR",
            }, ensure_ascii=False) + "\n")
            written += 1
    print(json.dumps({
        "scanned": scanned,
        "missing_shard": missing,
        "floor_keys": len(floor_map),
        "exact_floor": sum(1 for s in floor_map.values() if len(s) == 1),
        "exact_dong_floor": sum(1 for s in dong_floor_map.values() if len(s) == 1),
        "written": written,
        "out": str(OUT),
    }), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
