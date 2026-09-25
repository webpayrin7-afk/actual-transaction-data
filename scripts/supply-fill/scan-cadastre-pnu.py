"""Confirm candidate PNUs exist in the continuous-cadastre DBF (field A1).

Phase 3 fix: large sido archives are split into several DBF parts
(AL_D002_41_20260908.dbf, ...(2).dbf, ... (6).dbf). Phase 2 read only the first part,
so most 경기 PNUs were wrongly marked ABSENT. Every .dbf in the archive is read now.

Usage: python scan-cadastre-pnu.py [SRC.jsonl OUT.jsonl]
  default SRC=data/poc/supply/g2-pnu.jsonl OUT=data/poc/supply/g2-pnu-cadastre.jsonl
"""
from __future__ import annotations

import json
import struct
import sys
import time
import zipfile
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

CAD = Path(r"C:\data\cadastre\2026-09")
SRC = Path(sys.argv[1]) if len(sys.argv) > 2 else Path("data/poc/supply/g2-pnu.jsonl")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/poc/supply/g2-pnu-cadastre.jsonl")


def a1_offset(header: bytes) -> int:
    offset = 1  # deletion flag
    pos = 32
    a1_at = None
    a1_len = None
    while pos + 32 <= len(header) and header[pos] != 0x0D:
        name = header[pos : pos + 11].split(b"\x00", 1)[0].decode("ascii", "replace")
        flen = header[pos + 16]
        if name == "A1":
            a1_at, a1_len = offset, flen
        offset += flen
        pos += 32
    if a1_at is None or a1_len != 19:
        raise SystemExit(f"A1 PNU field missing (at={a1_at} len={a1_len})")
    return a1_at


def scan_prefix(prefix: str, targets: list[str]) -> tuple[str, list[str], dict]:
    zpath = CAD / f"AL_D002_{prefix}_20260908.zip"
    if not zpath.exists():
        return prefix, [], {"prefix": prefix, "zip": "MISSING", "targets": len(targets)}
    want = {t.encode("ascii") for t in targets}
    found: set[bytes] = set()
    scanned = 0
    t0 = time.time()
    with zipfile.ZipFile(zpath) as zf:
        parts = sorted(n for n in zf.namelist() if n.lower().endswith(".dbf"))
        for name in parts:
            with zf.open(name) as fh:
                head32 = fh.read(32)
                nrec, hlen, rlen = struct.unpack("<IHH", head32[4:12])
                a1 = a1_offset(head32 + fh.read(hlen - 32))
                remaining = nrec
                while remaining > 0:
                    n = min(remaining, 20000)
                    buf = fh.read(rlen * n)
                    if not buf:
                        break
                    n = len(buf) // rlen
                    remaining -= n
                    scanned += n
                    for i in range(0, n * rlen, rlen):
                        pnu = buf[i + a1 : i + a1 + 19]
                        if pnu in want and buf[i] != 0x2A:
                            found.add(pnu)
    stats = {"prefix": prefix, "parts": len(parts), "scanned": scanned, "targets": len(targets),
             "found": len(found), "missing": len(targets) - len(found), "sec": round(time.time() - t0, 1)}
    return prefix, [f.decode("ascii") for f in found], stats


def main() -> None:
    rows = [json.loads(line) for line in SRC.read_text(encoding="utf-8").splitlines() if line]
    wanted: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        pnu = row.get("cadastrePnu") or ""
        if len(pnu) == 19:
            wanted[pnu[:2]].add(pnu)
    found: set[str] = set()
    with ProcessPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(scan_prefix, p, sorted(t)) for p, t in sorted(wanted.items(), key=lambda kv: -len(kv[1]))]
        for fut in futures:
            _prefix, hits, stats = fut.result()
            found.update(hits)
            print(json.dumps(stats), flush=True)
    counts = {"in_cadastre": 0, "not_in_cadastre": 0, "no_pnu": 0}
    out_lines = []
    for row in rows:
        pnu = row.get("cadastrePnu") or ""
        if not pnu:
            row["cadastre"] = "NO_PNU"
            counts["no_pnu"] += 1
        elif pnu in found:
            row["cadastre"] = "EXISTS"
            counts["in_cadastre"] += 1
        else:
            row["cadastre"] = "ABSENT"
            counts["not_in_cadastre"] += 1
        out_lines.append(json.dumps(row, ensure_ascii=False))
    OUT.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(json.dumps(counts), flush=True)


if __name__ == "__main__":
    main()
