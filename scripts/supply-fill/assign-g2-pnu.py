"""Assign a registry PNU to each G2 complex from the 1:1 legal-dong successor map.

No name matching. A code that is not a 1:1 successor is used as-is.
Split/merge holds and unresolved chains stay held.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

MASTER = Path("data/poc/supply/g2-master.jsonl")
PAIRS = Path("data/admin-codes/lawd-successor.csv")
HOLDS = Path("data/admin-codes/lawd-successor-holds.csv")
LAWD_ZIP = Path(r"C:\data\bubjung\LSCT_LAWDCD.zip")
OUT = Path("data/poc/supply/g2-pnu.jsonl")


def parse_jibun(jibun: str):
    raw = jibun.strip()
    if not raw:
        return None
    mountain = raw.startswith("산")
    body = re.sub(r"^산\s*", "", raw).strip()
    if not re.fullmatch(r"\d+(?:-\d+)?", body):
        return None
    a, _, b = body.partition("-")
    bun, ji = int(a), int(b or "0")
    if bun > 9999 or ji > 9999:
        return None
    return ("1" if mountain else "0", f"{bun:04d}", f"{ji:04d}")


def dong_parts(dong: str) -> tuple[str, str]:
    parts = dong.strip().split()
    if len(parts) >= 2 and parts[0].endswith(("읍", "면")):
        return parts[0], "".join(parts[1:])
    return dong.strip(), ""


def main() -> None:
    import zipfile

    raw = zipfile.ZipFile(LAWD_ZIP).read("LSCT_LAWDCD.csv")
    lawd_rows = list(csv.DictReader(raw.decode("cp949").splitlines()))
    known = {r["LAWD_CD"].strip(): (r.get("DEL_DT") or "").strip() for r in lawd_rows}

    resolved: dict[str, str] = {}
    direct_dead: set[str] = set()
    by_bjdong: dict[tuple[str, str, str, str], list[str]] = {}
    with PAIRS.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            old = row["old_lawd_cd"]
            if row["resolved_lawd_cd"]:
                resolved[old] = row["resolved_lawd_cd"]
                key = (row["sido_nm"], old[-5:], row["umd_nm"], row["ri_nm"])
                by_bjdong.setdefault(key, []).append(row["resolved_lawd_cd"])
            else:
                direct_dead.add(old)
    held_codes: set[str] = set()
    with HOLDS.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            held_codes.update(c for c in row["old_codes"].split("|") if c)

    counts: dict[str, int] = {}
    rows_out = []
    for line in MASTER.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        code = f"{row['lawdCd']}{row['bjdongCd']}"
        status = "AS_IS"
        new_code = code
        if code in held_codes:
            status = "HOLD_SPLIT_MERGE"
            new_code = ""
        elif code in direct_dead or (code in known and known[code]):
            if code in resolved:
                status = "REMAPPED"
                new_code = resolved[code]
            else:
                status = "HOLD_ABOLISHED"
                new_code = ""
        elif code in resolved:
            status = "REMAPPED"
            new_code = resolved[code]
        elif code not in known:
            # Master kept a new sigungu code beside the old 5-digit bjdong.
            umd, ri = dong_parts(row["dong"])
            hits = by_bjdong.get((row["sido"], row["bjdongCd"], umd, ri), [])
            unique = sorted(set(hits))
            if len(unique) == 1:
                status = "REMAPPED_BJDONG"
                new_code = unique[0]
            elif len(unique) == 0:
                status = "HOLD_NO_SUCCESSOR"
                new_code = ""
            else:
                status = "HOLD_AMBIGUOUS_BJDONG"
                new_code = ""
        parcel = parse_jibun(row["jibun"])
        if status.startswith("HOLD"):
            pass
        elif not parcel:
            status = "HOLD_BAD_JIBUN"
            new_code = ""
        elif len(new_code) != 10 or not new_code.isdigit():
            status = "HOLD_BAD_CODE"
            new_code = ""
        pnu = ""
        cadastre_pnu = ""
        if new_code and parcel:
            plat, bun, ji = parcel
            pnu = f"{new_code}{plat}{bun}{ji}"
            cad_plat = "1" if plat == "0" else "2" if plat == "1" else ""
            cadastre_pnu = f"{new_code}{cad_plat}{bun}{ji}" if cad_plat else ""
            if len(pnu) != 19:
                status = "HOLD_BAD_PNU"
                pnu = ""
                cadastre_pnu = ""
        counts[status] = counts.get(status, 0) + 1
        rows_out.append(
            {
                **row,
                "code10": code,
                "newCode10": new_code,
                "pnu": pnu,
                "cadastrePnu": cadastre_pnu,
                "identityStatus": status,
            }
        )
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows_out) + "\n", encoding="utf-8")
    print(json.dumps({"complexes": len(rows_out), **counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
