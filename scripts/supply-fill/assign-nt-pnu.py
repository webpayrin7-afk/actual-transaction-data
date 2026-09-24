"""Assign PNU candidates to no-trade target complexes (phase 3). No name matching.

The no-trade targets have no jibun in apt_complex_master. Their parcel comes from the
deterministic K-apt 법정동주소 → PNU resolution (commit c6f016e,
data/poc/national-coordinates/pnu-resolution.jsonl, copied to
data/poc/supply/kapt-pnu-resolution.jsonl). Only PNU_EXACT rows whose legal code equals
the master lawd_cd+bjdong_cd are used. The PNU is in cadastre form (plat 1/2).

DB / cadastre codes are NEW (전남광주 12xxx, 강원 51xxx, 전북 52xxx, 인천 new gu). The
2026-08 building-registry file may still carry the predecessor code, so registry
candidates are the DB code first, then its predecessor (LSCT OLD_LAWDCD when it differs,
or the 42→51 / 45→52 renumbering when that old code exists as an abolished row).
The fill uses exactly ONE registry code per complex (the first with rows), never both.
A dead legal code goes through the 1:1 successor map (data/admin-codes/lawd-successor.csv).

A cadastre PNU owned by two master complexes (targets plus every complex in
C:\\data\\cadastre\\2026-09\\out\\target_complex_pnu.csv) is held as SHARED_PNU.
"""
from __future__ import annotations

import csv
import json
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

MASTER = Path("data/poc/supply/nt-master.jsonl")
RESOLUTION = Path("data/poc/supply/kapt-pnu-resolution.jsonl")
OTHER_PNUS = Path(r"C:\data\cadastre\2026-09\out\target_complex_pnu.csv")
PAIRS = Path("data/admin-codes/lawd-successor.csv")
HOLDS = Path("data/admin-codes/lawd-successor-holds.csv")
LAWD_ZIP = Path(r"C:\data\bubjung\LSCT_LAWDCD.zip")
OUT = Path("data/poc/supply/nt-pnu.jsonl")

SIDO_RENUMBER = {"51": "42", "52": "45"}


def main() -> None:
    raw = zipfile.ZipFile(LAWD_ZIP).read("LSCT_LAWDCD.csv")
    known = {r["LAWD_CD"].strip(): r for r in csv.DictReader(raw.decode("cp949").splitlines())}
    resolved: dict[str, str] = {}
    with PAIRS.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["resolved_lawd_cd"]:
                resolved[row["old_lawd_cd"]] = row["resolved_lawd_cd"]
    held_codes: set[str] = set()
    with HOLDS.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            held_codes.update(c for c in row["old_codes"].split("|") if c)

    def live(code: str) -> bool:
        r = known.get(code)
        return bool(r) and not (r.get("DEL_DT") or "").strip()

    def predecessors(code: str) -> list[str]:
        out: list[str] = []
        r = known.get(code)
        old = (r.get("OLD_LAWDCD") or "").strip() if r else ""
        if old and old != code and len(old) == 10:
            out.append(old)
        swap = SIDO_RENUMBER.get(code[:2])
        if swap:
            cand = swap + code[2:]
            cr = known.get(cand)
            if cr and (cr.get("DEL_DT") or "").strip() and cand not in out:
                out.append(cand)
        return out

    resolution = {}
    for line in RESOLUTION.read_text(encoding="utf-8").splitlines():
        if line:
            r = json.loads(line)
            resolution[r["complex_id"]] = r

    master = [json.loads(line) for line in MASTER.read_text(encoding="utf-8").splitlines() if line]
    targets = [r for r in master if r["target"]]
    counts: Counter = Counter()
    for row in targets:
        code = f"{row['lawdCd']}{row['bjdongCd']}"
        res = resolution.get(row["complexId"])
        status = "AS_IS"
        new_code = ""
        cad = ""
        if not res:
            status = "HOLD_NO_KAPT_PARCEL"
        elif res["resolution_status"] != "PNU_EXACT":
            status = f"HOLD_{res['resolution_status']}"
        elif res["full_legal_code"] != code:
            status = "HOLD_LEGAL_CODE_MISMATCH"
        elif len(res["pnu"]) != 19 or res["pnu"][10] not in "12":
            status = "HOLD_BAD_PNU"
        elif code in held_codes:
            status = "HOLD_SPLIT_MERGE"
        elif not live(code):
            if code in resolved and live(resolved[code]):
                status, new_code = "REMAPPED", resolved[code]
            else:
                status = "HOLD_ABOLISHED"
        else:
            new_code = code
        registry: list[str] = []
        if new_code:
            lots = res["pnu"][11:]
            plat = "0" if res["pnu"][10] == "1" else "1"
            cad = f"{new_code}{res['pnu'][10]}{lots}"
            registry = [f"{c}{plat}{lots}" for c in [new_code, *predecessors(new_code)]]
        row.update({
            "code10": code,
            "newCode10": new_code,
            "cadastrePnu": cad,
            "pnu": registry[0] if registry else "",
            "registryPnus": registry,
            "identityStatus": status,
            "parcelAddress": res["parcel_address"] if res else "",
        })

    owners: dict[str, set[str]] = defaultdict(set)
    with OTHER_PNUS.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if len(r["pnu"]) == 19:
                owners[r["pnu"]].add(r["complex_id"])
    for row in targets:
        if row["cadastrePnu"]:
            owners[row["cadastrePnu"]].add(row["complexId"])
    for row in targets:
        row["pnuOwners"] = len(owners.get(row["cadastrePnu"], ())) if row["cadastrePnu"] else 0
        counts[row["identityStatus"]] += 1
        if row["pnuOwners"] > 1:
            counts["shared_pnu"] += 1
        if len(row["registryPnus"]) > 1:
            counts["has_predecessor_code"] += 1
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in targets) + "\n", encoding="utf-8")
    print(json.dumps({"targets": len(targets), **counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
