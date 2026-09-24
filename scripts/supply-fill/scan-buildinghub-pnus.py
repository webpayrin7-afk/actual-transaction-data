"""Stream mart_djy_06 (전유공용면적, 2026-08) once and keep rows whose registry PNU is a candidate.

Candidates are every entry of `registryPnus` (DB code first, predecessor codes after).
The fill later picks ONE code per complex, so a unit is never counted under two codes.
No API. Name is not a join key (bldNm is kept for the report only).

Usage: python scan-buildinghub-pnus.py SRC.jsonl OUT.jsonl
"""
from __future__ import annotations

import json
import sys
import time
import zipfile
from pathlib import Path

ZIP = Path(r"C:\data\buildinghub\2026-08") / "국토교통부_건축물대장_전유공용면적+(2026년+08월).zip"
SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])


def pad4(value: bytes) -> bytes:
    digits = bytes(ch for ch in value if 48 <= ch <= 57)
    if not digits:
        return b"0000"
    return digits.zfill(4)[-4:]


def main() -> None:
    targets: set[bytes] = set()
    for line in SRC.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        if row.get("cadastre") not in (None, "EXISTS"):
            continue
        for pnu in row.get("registryPnus") or []:
            if len(pnu) == 19:
                targets.add(pnu.encode("ascii"))
    print(json.dumps({"targetPnus": len(targets)}), flush=True)
    kept = 0
    scanned = 0
    hit: set[bytes] = set()
    t0 = time.time()
    with zipfile.ZipFile(ZIP) as zf, OUT.open("w", encoding="utf-8") as out:
        with zf.open(zf.namelist()[0]) as fh:
            for raw in fh:
                scanned += 1
                if scanned % 10_000_000 == 0:
                    print(json.dumps({"scanned": scanned, "kept": kept, "hitPnus": len(hit), "sec": round(time.time() - t0)}), flush=True)
                head = raw.split(b"|", 13)
                if len(head) < 14:
                    continue
                sigungu, bjdong, plat = head[8], head[9], head[10] or b"0"
                if len(sigungu) != 5 or len(bjdong) != 5 or plat not in (b"0", b"1"):
                    continue
                pnu = sigungu + bjdong + plat + pad4(head[11]) + pad4(head[12])
                if pnu not in targets:
                    continue
                try:
                    parts = raw.decode("utf-8").rstrip("\n\r").split("|")
                except UnicodeDecodeError:
                    continue
                if len(parts) >= 39:
                    expos_nm, main_atch, purps, etc, area = parts[27], parts[29], parts[35], parts[36], parts[37]
                    expos_cd, atch_cd, purps_cd = parts[26], parts[28], parts[34]
                elif len(parts) >= 38:
                    expos_nm, main_atch, purps, etc, area = parts[26], parts[28], parts[33], parts[34], parts[35]
                    expos_cd, atch_cd, purps_cd = "", parts[27], parts[32]
                else:
                    continue
                out.write(json.dumps({
                    "pnu": pnu.decode("ascii"),
                    "mgmPk": parts[0],
                    "bldNm": parts[7],
                    "dongNm": parts[21],
                    "hoNm": parts[22],
                    "flrNo": parts[25],
                    "exposPubuseGbCdNm": expos_nm,
                    "mainAtchGbCdNm": main_atch,
                    "mainPurpsCdNm": purps,
                    "etcPurps": etc,
                    "area": area,
                    "exposCd": expos_cd,
                    "mainAtchCd": atch_cd,
                    "mainPurpsCd": purps_cd,
                }, ensure_ascii=False) + "\n")
                kept += 1
                hit.add(pnu)
    print(json.dumps({"scanned": scanned, "kept": kept, "hitPnus": len(hit), "sec": round(time.time() - t0)}), flush=True)


if __name__ == "__main__":
    main()
