"""Parcel relink, step 2 (local files only): candidate PNUs for complexes held for a parcel reason.

Targets (from universe.jsonl written by export.mts):
  no-trade (nt)  still without any canonical unit row, phase-3 hold in
                 HOLD_LOT_PARSE_FAILED / HOLD_INVALID_PNU / CADASTRE_ABSENT / NO_EXPOS_ROWS
  G2             still with a NO_SOURCE row, phase-3 hold in
                 CADASTRE_ABSENT / NO_EXPOS_ROWS / HOLD_ABOLISHED / HOLD_NO_SUCCESSOR / HOLD_BAD_JIBUN
  The 844 부천·화성 complexes (bjdong remap 2026-09-25) are excluded: another agent owns them.

Candidate sources (exact only, never a name):
  PIP        anchor point (complex_map_anchor, else master lat/lng; WGS84 -> cadastre CRS from the
             archive .prj, EPSG:5186) inside a 연속지적도 polygon (every DBF/SHP part of the archive).
  PIP_ROAD   the containing parcel is a road (지목 '도'): every non-road parcel within 30 m.
  KAPT_LOT   K-apt 법정동주소 lot parsed strictly ('316-', '546,…546-' with the same lot) on the
             K-apt legal code.
  ANCHOR_LOT NAVER matched_jibun lot, only when its legal-dong token equals the master's legal dong
             and the master code is live.
Every candidate must exist in the cadastre. Registry (건축HUB) PNUs are the cadastre code first,
then its predecessors (LSCT OLD_LAWDCD, reverse 1:1 successor map, 42->51 / 45->52 renumbering).

Usage: python candidates.py WORK_DIR
Writes WORK_DIR/targets.jsonl, WORK_DIR/candidates.jsonl, WORK_DIR/registry-scan-src.jsonl
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import struct
import sys
import time
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from pyproj import CRS, Transformer

WORK = Path(sys.argv[1])
CAD = Path(r"C:\data\cadastre\2026-09")
LAWD_ZIP = Path(r"C:\data\bubjung\LSCT_LAWDCD.zip")
PAIRS = Path("data/admin-codes/lawd-successor.csv")
OTHER_PNUS = CAD / "out" / "target_complex_pnu.csv"
KAPT = Path("data/poc/supply/kapt-pnu-resolution.jsonl")
NEAR_M = 30.0
CELL = 200.0

NT_REASONS = {"HOLD_LOT_PARSE_FAILED", "HOLD_INVALID_PNU", "CADASTRE_ABSENT", "NO_EXPOS_ROWS"}
G2_REASONS = {"CADASTRE_ABSENT", "NO_EXPOS_ROWS", "HOLD_ABOLISHED", "HOLD_NO_SUCCESSOR", "HOLD_BAD_JIBUN"}
SIDO_RENUMBER = {"51": "42", "52": "45"}


# ---------------------------------------------------------------- lots
LOT_RE = re.compile(r"^(산\s*)?(\d{1,4})(?:-(\d{1,4}))?-?$")


def parse_lot(token: str):
    m = LOT_RE.match(token.strip())
    if not m:
        return None
    return ("2" if m.group(1) else "1", f"{int(m.group(2)):04d}", f"{int(m.group(3) or 0):04d}")


def kapt_lot(address: str):
    """Lot right after the legal dong/ri token. 'A 546,A 546- NAME' is accepted only when both lots agree."""
    lots = []
    for chunk in address.split(","):
        toks = chunk.split()
        found = None
        for i, tok in enumerate(toks):
            if i >= 2 and toks[i - 1].endswith(("동", "리", "가")) and parse_lot(tok):
                found = parse_lot(tok)
                break
            if i >= 2 and tok == "산" and i + 1 < len(toks) and toks[i - 1].endswith(("동", "리", "가")):
                found = parse_lot("산" + toks[i + 1])
                break
        if found:
            lots.append(found)
    if not lots or len(set(lots)) != 1:
        return None
    return lots[0]


def anchor_lot(jibun_addr: str, dong_name: str):
    """NAVER matched_jibun '… 재송동 939-2' → lot, only if the token before it is the master legal dong."""
    toks = jibun_addr.split()
    want = dong_name.split()[-1] if dong_name else ""
    for i, tok in enumerate(toks):
        lot = parse_lot(tok)
        if lot and i >= 1 and want and toks[i - 1] == want:
            return lot
        if tok == "산" and i + 1 < len(toks) and i >= 1 and toks[i - 1] == want:
            return parse_lot("산" + toks[i + 1])
    return None


# ---------------------------------------------------------------- codes
def load_codes():
    raw = zipfile.ZipFile(LAWD_ZIP).read("LSCT_LAWDCD.csv")
    known = {r["LAWD_CD"].strip(): r for r in csv.DictReader(raw.decode("cp949").splitlines())}
    reverse: dict[str, set[str]] = defaultdict(set)
    with PAIRS.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["resolved_lawd_cd"]:
                reverse[row["resolved_lawd_cd"]].add(row["old_lawd_cd"])
    return known, reverse


def registry_codes(code: str, known, reverse) -> list[str]:
    out = [code]
    r = known.get(code)
    old = (r.get("OLD_LAWDCD") or "").strip() if r else ""
    if old and len(old) == 10 and old not in out:
        out.append(old)
    for o in sorted(reverse.get(code, ())):
        if o not in out:
            out.append(o)
    swap = SIDO_RENUMBER.get(code[:2])
    if swap and swap + code[2:] in known and swap + code[2:] not in out:
        out.append(swap + code[2:])
    return out


def live(code: str, known) -> bool:
    r = known.get(code)
    return bool(r) and not (r.get("DEL_DT") or "").strip()


def to_registry(cad_pnu: str, code: str) -> str:
    return f"{code}{'0' if cad_pnu[10] == '1' else '1'}{cad_pnu[11:]}"


# ---------------------------------------------------------------- cadastre scan
def dbf_layout(fh):
    head32 = fh.read(32)
    nrec, hlen, rlen = struct.unpack("<IHH", head32[4:12])
    header = head32 + fh.read(hlen - 32)
    offs = {}
    offset, pos = 1, 32
    while pos + 32 <= len(header) and header[pos] != 0x0D:
        name = header[pos:pos + 11].split(b"\x00", 1)[0].decode("ascii", "replace")
        flen = header[pos + 16]
        offs[name] = (offset, flen)
        offset += flen
        pos += 32
    return nrec, rlen, offs


def ring_stats(px, py, xs, ys, parts):
    """Even-odd inside test over all rings and min distance to any edge."""
    inside = False
    best = math.inf
    bounds = list(parts) + [len(xs)]
    for k in range(len(parts)):
        a, b = bounds[k], bounds[k + 1]
        x1, y1 = xs[a:b - 1], ys[a:b - 1]
        x2, y2 = xs[a + 1:b], ys[a + 1:b]
        if len(x1) == 0:
            continue
        cond = (y1 > py) != (y2 > py)
        with np.errstate(divide="ignore", invalid="ignore"):
            xin = (x2 - x1) * (py - y1) / (y2 - y1) + x1
        crossings = np.count_nonzero(cond & (px < xin))
        if crossings % 2 == 1:
            inside = not inside
        dx, dy = x2 - x1, y2 - y1
        l2 = dx * dx + dy * dy
        with np.errstate(divide="ignore", invalid="ignore"):
            t = np.clip(np.where(l2 > 0, ((px - x1) * dx + (py - y1) * dy) / l2, 0), 0, 1)
        d = np.hypot(x1 + t * dx - px, y1 + t * dy - py)
        best = min(best, float(d.min()))
    return inside, best


def scan_sido(prefix: str, points: dict[str, tuple[float, float]], wanted_pnus: list[str]):
    """points: complexId -> (lng, lat). Returns hits per complex, existence of wanted PNUs, stats."""
    zpath = CAD / f"AL_D002_{prefix}_20260908.zip"
    t0 = time.time()
    hits: dict[str, list[dict]] = defaultdict(list)
    exists: dict[str, str] = {}
    want = {p.encode("ascii") for p in wanted_pnus}
    with zipfile.ZipFile(zpath) as zf:
        names = zf.namelist()
        prj = next(n for n in names if n.lower().endswith(".prj"))
        crs = CRS.from_wkt(zf.read(prj).decode("utf-8", "ignore"))
        tr = Transformer.from_crs(CRS.from_epsg(4326), crs, always_xy=True)
        pts = {cid: tr.transform(lng, lat) for cid, (lng, lat) in points.items()}
        grid: dict[tuple[int, int], list[str]] = defaultdict(list)
        for cid, (x, y) in pts.items():
            grid[(int(x // CELL), int(y // CELL))].append(cid)
        all_ids = list(pts)
        bases = sorted(n[:-4] for n in names if n.lower().endswith(".shp"))
        scanned = 0
        for base in bases:
            shp_name = next(n for n in names if n.lower() == (base + ".shp").lower())
            dbf_name = next(n for n in names if n.lower() == (base + ".dbf").lower())
            part_hits: dict[int, list[tuple[str, bool, float]]] = defaultdict(list)
            with zf.open(shp_name) as raw:
                fh = io.BufferedReader(raw, buffer_size=1 << 24)
                fh.read(100)
                idx = -1
                while True:
                    hdr = fh.read(8)
                    if len(hdr) < 8:
                        break
                    idx += 1
                    clen = int.from_bytes(hdr[4:8], "big") * 2
                    content = fh.read(clen)
                    if clen < 44:
                        continue
                    xmin, ymin, xmax, ymax = struct.unpack_from("<4d", content, 4)
                    xmin -= NEAR_M
                    ymin -= NEAR_M
                    xmax += NEAR_M
                    ymax += NEAR_M
                    ix0, ix1 = int(xmin // CELL), int(xmax // CELL)
                    iy0, iy1 = int(ymin // CELL), int(ymax // CELL)
                    if (ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 400:
                        cands = all_ids
                    else:
                        cands = []
                        for gx in range(ix0, ix1 + 1):
                            for gy in range(iy0, iy1 + 1):
                                got = grid.get((gx, gy))
                                if got:
                                    cands.extend(got)
                    if not cands:
                        continue
                    geom = None
                    for cid in cands:
                        px, py = pts[cid]
                        if not (xmin <= px <= xmax and ymin <= py <= ymax):
                            continue
                        if geom is None:
                            nparts, npoints = struct.unpack_from("<2i", content, 36)
                            parts = struct.unpack_from(f"<{nparts}i", content, 44)
                            arr = np.frombuffer(content, dtype="<f8", count=npoints * 2, offset=44 + 4 * nparts)
                            geom = (arr[0::2], arr[1::2], parts)
                        inside, dist = ring_stats(px, py, *geom)
                        if inside or dist <= NEAR_M:
                            part_hits[idx].append((cid, inside, 0.0 if inside else round(dist, 1)))
            scanned += idx + 1
            with zf.open(dbf_name) as raw:
                fh = io.BufferedReader(raw, buffer_size=1 << 24)
                nrec, rlen, offs = dbf_layout(fh)
                a1, _ = offs["A1"]
                a5, a5len = offs["A5"]
                i = 0
                while i < nrec:
                    n = min(nrec - i, 20000)
                    buf = fh.read(rlen * n)
                    if not buf:
                        break
                    n = len(buf) // rlen
                    for j in range(n):
                        at = j * rlen
                        pnu = buf[at + a1: at + a1 + 19]
                        rec = i + j
                        if pnu in want and buf[at] != 0x2A:
                            exists[pnu.decode("ascii")] = buf[at + a5: at + a5 + a5len].decode("cp949", "replace").strip()
                        if rec in part_hits and buf[at] != 0x2A:
                            lot = buf[at + a5: at + a5 + a5len].decode("cp949", "replace").strip()
                            for cid, inside, dist in part_hits[rec]:
                                hits[cid].append({"pnu": pnu.decode("ascii"), "lot": lot, "jimok": lot[-1:] if lot else "",
                                                  "inside": inside, "dist": dist})
                    i += n
    stats = {"prefix": prefix, "parts": len(bases), "scanned": scanned, "points": len(points),
             "withHit": sum(1 for c in points if hits.get(c)), "sec": round(time.time() - t0, 1)}
    return prefix, dict(hits), exists, stats


# ---------------------------------------------------------------- targets
def phase3_reason(u, cache_nt: set[str], cache_g2: set[str], owners_g2: Counter) -> str | None:
    p = u["phase3"]
    if u["kind"] == "nt":
        if p["identityStatus"] not in ("AS_IS", "REMAPPED"):
            return p["identityStatus"]
        if p["cadastre"] != "EXISTS":
            return "CADASTRE_ABSENT"
        if (p["pnuOwners"] or 0) > 1:
            return "SHARED_PNU"
        if not any(r in cache_nt for r in p["registryPnus"]):
            return "NO_EXPOS_ROWS"
        return None
    if not p["registryPnus"] or p["cadastre"] != "EXISTS":
        return "CADASTRE_ABSENT" if p["cadastre"] == "ABSENT" else p["identityStatus"]
    if owners_g2[p["registryPnus"][0]] > 1:
        return "SHARED_PNU"
    if p["registryPnus"][0] not in cache_g2:
        return "NO_EXPOS_ROWS"
    return None


def main() -> None:
    universe = [json.loads(l) for l in (WORK / "universe.jsonl").read_text(encoding="utf-8").splitlines() if l]
    caches = json.loads((WORK / "cache-pnus.json").read_text())
    cache_nt = set(next(v for k, v in caches.items() if "nt-expos" in k))
    cache_g2 = set(next(v for k, v in caches.items() if "g2-expos" in k))
    owners_g2 = Counter(u["phase3"]["registryPnus"][0] for u in universe if u["kind"] == "g2" and u["phase3"]["registryPnus"])
    kapt = {}
    for line in KAPT.read_text(encoding="utf-8").splitlines():
        if line:
            r = json.loads(line)
            kapt[r["complex_id"]] = r
    known, reverse = load_codes()

    # cadastre PNU ownership: DB parcel coordinates + phase-3 master PNUs + nt/g2 resolved PNUs
    owners: dict[str, set[str]] = defaultdict(set)
    for cid, pnu in json.loads((WORK / "pnu-owners-db.json").read_text()):
        if len(pnu) == 19:
            owners[pnu].add(cid)
    with OTHER_PNUS.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if len(r["pnu"]) == 19:
                owners[r["pnu"]].add(r["complex_id"])
    for u in universe:
        cp = u["phase3"]["cadastrePnu"]
        if cp and u["phase3"]["cadastre"] == "EXISTS":
            owners[cp].add(u["complexId"])

    targets = []
    skipped = Counter()
    for u in universe:
        if u["in844"]:
            skipped["IN_844_READ_ONLY"] += 1
            continue
        reason = phase3_reason(u, cache_nt, cache_g2, owners_g2)
        if u["kind"] == "nt":
            if reason not in NT_REASONS:
                continue
            if u["canonical"]:
                skipped["NT_ALREADY_HAS_ROWS_NOW"] += 1
                continue
        else:
            if reason not in G2_REASONS:
                continue
            if not any(c[2] == "NO_SOURCE" for c in u["canonical"]):
                skipped["G2_NO_NO_SOURCE_LEFT"] += 1
                continue
        lat, lng, src = u.get("anchorLat"), u.get("anchorLng"), "ANCHOR"
        if lat is None or lng is None:
            lat, lng, src = u.get("masterLat"), u.get("masterLng"), "MASTER"
        u["reason"] = reason
        u["point"] = [lng, lat] if lat is not None and lng is not None else None
        u["pointSource"] = src if u["point"] else "NONE"
        # strict lot candidates (cadastre form)
        lots = []
        k = kapt.get(u["complexId"])
        if u["kind"] == "nt" and k and k.get("full_legal_code") and len(k["full_legal_code"]) == 10:
            lot = kapt_lot(k.get("parcel_address") or "")
            if lot:
                lots.append({"method": "KAPT_LOT", "pnu": k["full_legal_code"] + "".join(lot)})
        code = f"{u.get('lawdCd', '')}{u.get('bjdongCd', '')}"
        if u.get("anchorJibun") and len(code) == 10 and live(code, known):
            lot = anchor_lot(u["anchorJibun"], u.get("dong") or "")
            if lot:
                lots.append({"method": "ANCHOR_LOT", "pnu": code + "".join(lot)})
        if u["kind"] == "g2" and u.get("jibun") and len(code) == 10 and live(code, known):
            lot = parse_lot(u["jibun"])
            if lot:
                lots.append({"method": "MASTER_JIBUN", "pnu": code + "".join(lot)})
        u["lotCandidates"] = lots
        targets.append(u)

    by_sido: dict[str, dict] = defaultdict(lambda: {"points": {}, "pnus": set()})
    for u in targets:
        pre = (u.get("lawdCd") or "")[:2]
        pre = {"42": "51", "45": "52", "46": "12", "29": "12"}.get(pre, pre)
        u["sidoArchive"] = pre
        if u["point"]:
            by_sido[pre]["points"][u["complexId"]] = tuple(u["point"])
        for c in u["lotCandidates"]:
            by_sido[c["pnu"][:2]]["pnus"].add(c["pnu"])
    hits: dict[str, list] = {}
    exists: dict[str, str] = {}
    with ProcessPoolExecutor(max_workers=3) as pool:
        futs = [pool.submit(scan_sido, p, v["points"], sorted(v["pnus"])) for p, v in sorted(by_sido.items(), key=lambda kv: -len(kv[1]["points"]))]
        for f in futs:
            _p, h, e, stats = f.result()
            hits.update(h)
            exists.update(e)
            print(json.dumps(stats), flush=True)

    out, scan_src = [], []
    counts = Counter()
    for u in targets:
        h = hits.get(u["complexId"], [])
        inside = [x for x in h if x["inside"]]
        cands = []
        for x in inside:
            cands.append({"method": "PIP", "pnu": x["pnu"], "lot": x["lot"], "jimok": x["jimok"], "dist": 0})
        road = bool(inside) and all(x["jimok"] == "도" for x in inside)
        if road:
            for x in sorted((x for x in h if not x["inside"] and x["jimok"] != "도"), key=lambda x: x["dist"]):
                cands.append({"method": "PIP_ROAD", "pnu": x["pnu"], "lot": x["lot"], "jimok": x["jimok"], "dist": x["dist"]})
        for c in u["lotCandidates"]:
            lot = exists.get(c["pnu"])
            cands.append({"method": c["method"], "pnu": c["pnu"], "lot": lot or "", "jimok": (lot or "")[-1:],
                          "dist": None, "inCadastre": lot is not None})
        merged: dict[str, dict] = {}
        for c in cands:
            if c.get("inCadastre") is False:
                continue
            m = merged.setdefault(c["pnu"], {**c, "methods": []})
            m["methods"].append(c["method"])
        for pnu, c in merged.items():
            c["registryPnus"] = [to_registry(pnu, code) for code in registry_codes(pnu[:10], known, reverse)]
            c["owners"] = sorted(owners.get(pnu, set()) - {u["complexId"]})
        u["pipInside"] = [{"pnu": x["pnu"], "jimok": x["jimok"], "lot": x["lot"]} for x in inside]
        u["onRoad"] = road
        u["candidates"] = list(merged.values())
        counts[(u["kind"], u["reason"], "with_candidate" if merged else "no_candidate")] += 1
        out.append({k: u[k] for k in ("kind", "complexId", "aptName", "reason", "lawdCd", "bjdongCd", "dong", "sido", "sigungu",
                                        "roadAddress", "jibun", "point", "pointSource", "anchorJibun", "kaptHouseholds",
                                        "canonical", "pairs", "phase3", "pipInside", "onRoad", "candidates", "lotCandidates")
                    if k in u})
        for c in merged.values():
            scan_src.append({"registryPnus": c["registryPnus"], "cadastre": "EXISTS"})
    (WORK / "candidates.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out) + "\n", encoding="utf-8")
    (WORK / "registry-scan-src.jsonl").write_text("\n".join(json.dumps(r) for r in scan_src) + "\n", encoding="utf-8")
    summary = {"targets": len(targets), "skipped": dict(skipped),
               "byReason": {"|".join(k): v for k, v in sorted(counts.items())},
               "noPoint": sum(1 for u in targets if not u["point"]),
               "onRoad": sum(1 for u in targets if u.get("onRoad"))}
    (WORK / "candidates-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
