"""Dry-run REAL_VARIANT representative picks. No database writes.

Household count is source_unit_count from the local building-hub evidence file,
matched on exact exclusive/supply cents. A variant with no count is a hold.
"""
from __future__ import annotations

import csv
import gzip
import json
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

VARIANTS = Path("data/poc/supply/real-variant.jsonl")
EVIDENCE = Path(r"C:\data\buildinghub\2026-08\resolved\national_supply_area_evidence.csv.gz")
OUT = Path("data/poc/supply/real-variant-plan.json")


def cents(text: str) -> int | None:
    raw = text.strip()
    if not raw:
        return None
    try:
        return int((Decimal(raw) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except Exception:
        return None


def main() -> None:
    groups: dict[tuple[str, int], dict[int, dict]] = defaultdict(dict)
    for line in VARIANTS.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        key = (row["complexId"], int(row["exclusiveCents"]))
        bucket = groups[key]
        held = int(row["heldSupplyCents"])
        slot = bucket.setdefault(held, {"supplyCents": held, "household": None, "sources": set()})
        if row.get("heldHousehold") is not None:
            slot["household"] = int(row["heldHousehold"])
            slot["sources"].add("canonical")
        prov = json.loads(row["provenance"] or "{}")
        for pair in prov.get("incoming") or []:
            if not isinstance(pair, list) or len(pair) < 2:
                continue
            su = cents(str(pair[1]))
            if su is None:
                continue
            bucket.setdefault(su, {"supplyCents": su, "household": None, "sources": set()})

    needed = {complex_id for complex_id, _ex in groups}
    with gzip.open(EVIDENCE, "rt", encoding="utf-8", newline="") as fh:
        for rec in csv.DictReader(fh):
            complex_id = rec["complex_id"]
            if complex_id not in needed:
                continue
            ex = cents(rec["exclusive_area"])
            su = cents(rec["supply_area"])
            if ex is None or su is None:
                continue
            slot = groups.get((complex_id, ex), {}).get(su)
            if slot is None:
                continue
            count = int(rec["source_unit_count"] or "0")
            if count > 0:
                slot["household"] = count
                slot["sources"].add("evidence")

    decided = 0
    held = 0
    hold_reasons: dict[str, int] = defaultdict(int)
    decisions = []
    for (complex_id, exclusive), variants in groups.items():
        items = list(variants.values())
        missing = [v for v in items if v["household"] is None]
        if len(items) < 2:
            held += 1
            hold_reasons["SINGLE_SUPPLY"] += 1
            continue
        if missing:
            held += 1
            hold_reasons["NO_HOUSEHOLD"] += 1
            continue
        items.sort(key=lambda v: (-int(v["household"]), int(v["supplyCents"])))
        winner = items[0]
        decided += 1
        decisions.append(
            {
                "complexId": complex_id,
                "exclusiveCents": exclusive,
                "representativeSupplyCents": winner["supplyCents"],
                "representativeHousehold": winner["household"],
                "variants": [
                    {"supplyCents": v["supplyCents"], "householdCount": v["household"]}
                    for v in sorted(items, key=lambda v: v["supplyCents"])
                ],
            }
        )
    summary = {
        "conflictExclusives": len(groups),
        "decided": decided,
        "held": held,
        "holdReasons": dict(hold_reasons),
    }
    OUT.write_text(json.dumps({"summary": summary, "decisions": decisions}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
