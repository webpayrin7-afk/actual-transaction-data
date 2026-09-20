#!/usr/bin/env python3
"""Enrich empty-jibun manifest rows from KAPT universe parcel_address before bulk filter."""
from __future__ import annotations

import json
import re
from pathlib import Path

MANIFEST = Path("/tmp/building-hub-bulk/manifest-parcels.jsonl")
KAPT = Path("/tmp/national-inputs/kapt-complex-universe.jsonl")
OUT = Path("/tmp/building-hub-bulk/manifest-parcels.jsonl")

JIBUN_RE = re.compile(r"(?:산\s*)?(\d+(?:-\d+)?)\s+\S+$")


def parse_jibun_token(token: str) -> dict | None:
    raw = token.strip()
    mountain = raw.startswith("산")
    body = re.sub(r"^산\s*", "", raw)
    if not re.fullmatch(r"\d+(?:-\d+)?", body):
        return None
    a, _, b = body.partition("-")
    bun = int(a)
    ji = int(b or 0)
    if bun < 0 or ji < 0 or bun > 9999 or ji > 9999:
        return None
    return {
        "platGbCd": "1" if mountain else "0",
        "bun": f"{bun:04d}",
        "ji": f"{ji:04d}",
    }


def jibun_from_parcel_address(addr: str) -> str | None:
    m = JIBUN_RE.search(addr.strip())
    if not m:
        return None
    return m.group(1)


def main() -> None:
    kapt_by_code: dict[str, dict] = {}
    for line in KAPT.read_text().splitlines():
        if not line:
            continue
        row = json.loads(line)
        kapt_by_code[row["kapt_code"]] = row

    # Need complex_id -> kapt_code from DB export; rebuild with a side file if present.
    links = Path("/tmp/building-hub-bulk/kapt-links.jsonl")
    code_by_complex: dict[str, str] = {}
    if links.exists():
        for line in links.read_text().splitlines():
            row = json.loads(line)
            code_by_complex[row["complexId"]] = row["kaptCode"]

    enriched = 0
    still_empty = 0
    out_rows = []
    for line in MANIFEST.read_text().splitlines():
        row = json.loads(line)
        if row.get("parcelKey"):
            out_rows.append(row)
            continue
        code = code_by_complex.get(row["complexId"])
        universe = kapt_by_code.get(code or "")
        if not universe:
            still_empty += 1
            out_rows.append(row)
            continue
        token = jibun_from_parcel_address(universe.get("parcel_address") or "")
        parcel = parse_jibun_token(token or "")
        lawd = universe.get("lawd_cd") or row["lawdCd"]
        bjd = (universe.get("bjdong_code") or row["bjdongCd"] or "").zfill(5)[-5:]
        if not parcel or not lawd or not bjd:
            still_empty += 1
            out_rows.append(row)
            continue
        row["jibun"] = token
        row["lawdCd"] = lawd
        row["bjdongCd"] = bjd
        row["platGbCd"] = parcel["platGbCd"]
        row["bun"] = parcel["bun"]
        row["ji"] = parcel["ji"]
        row["parcelKey"] = f"{lawd}|{bjd}|{parcel['platGbCd']}|{parcel['bun']}|{parcel['ji']}"
        row["pnu"] = f"{lawd}{bjd}{parcel['platGbCd']}{parcel['bun']}{parcel['ji']}"
        row["fromKaptUniverse"] = True
        enriched += 1
        out_rows.append(row)

    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out_rows) + "\n")
    print(json.dumps({"enriched": enriched, "still_empty": still_empty, "total": len(out_rows)}))


if __name__ == "__main__":
    main()
