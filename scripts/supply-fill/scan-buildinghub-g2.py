"""Stream mart_djy_06 and keep 전유공용 rows whose registry PNU is a G2 candidate.

No API. Name is not used as a join key.
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

ZIP = Path(r"C:\data\buildinghub\2026-08") / "국토교통부_건축물대장_전유공용면적+(2026년+08월).zip"
SRC = Path("data/poc/supply/g2-pnu.jsonl")
OUT = Path("data/poc/supply/g2-expos.jsonl")


def pad4(value: str) -> str:
    digits = "".join(ch for ch in value if ch.isdigit())
    if not digits:
        return "0000"
    return digits.zfill(4)[-4:]


def main() -> None:
    targets: set[str] = set()
    for line in SRC.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        pnu = row.get("pnu") or ""
        if len(pnu) == 19:
            targets.add(pnu)
    print(json.dumps({"targetPnus": len(targets)}), flush=True)
    kept = 0
    scanned = 0
    hit_pnus: set[str] = set()
    with zipfile.ZipFile(ZIP) as zf, OUT.open("w", encoding="utf-8") as out:
        name = zf.namelist()[0]
        with zf.open(name) as fh:
            for raw in fh:
                scanned += 1
                if scanned % 5_000_000 == 0:
                    print(json.dumps({"scanned": scanned, "kept": kept, "hitPnus": len(hit_pnus)}), flush=True)
                # Identity columns are ASCII. Decode the line only after the PNU matches.
                try:
                    line = raw.decode("utf-8")
                except UnicodeDecodeError:
                    continue
                parts = line.rstrip("\n\r").split("|")
                if len(parts) < 38:
                    continue
                sigungu, bjdong, plat = parts[8], parts[9], parts[10] or "0"
                if len(sigungu) != 5 or len(bjdong) != 5 or plat not in ("0", "1"):
                    continue
                pnu = f"{sigungu}{bjdong}{plat}{pad4(parts[11])}{pad4(parts[12])}"
                if pnu not in targets:
                    continue
                if len(parts) >= 39:
                    expos_nm, main_atch, purps, etc, area = parts[27], parts[29], parts[35], parts[36], parts[37]
                    expos_cd, atch_cd, purps_cd = parts[26], parts[28], parts[34]
                    dong, ho, floor = parts[21], parts[22], parts[25]
                else:
                    expos_nm, main_atch, purps, etc, area = parts[26], parts[28], parts[33], parts[34], parts[35]
                    expos_cd, atch_cd, purps_cd = "", parts[27], parts[32]
                    dong, ho, floor = parts[21], parts[22], parts[25]
                out.write(
                    json.dumps(
                        {
                            "pnu": pnu,
                            "dongNm": dong,
                            "hoNm": ho,
                            "flrNo": floor,
                            "exposPubuseGbCdNm": expos_nm,
                            "mainAtchGbCdNm": main_atch,
                            "mainPurpsCdNm": purps,
                            "etcPurps": etc,
                            "area": area,
                            "exposCd": expos_cd,
                            "mainAtchCd": atch_cd,
                            "mainPurpsCd": purps_cd,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                kept += 1
                hit_pnus.add(pnu)
    print(json.dumps({"scanned": scanned, "kept": kept, "hitPnus": len(hit_pnus)}), flush=True)


if __name__ == "__main__":
    main()
