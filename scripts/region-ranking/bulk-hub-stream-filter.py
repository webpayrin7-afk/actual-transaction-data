#!/usr/bin/env python3
"""
Stream Building Hub bulk 전유공용면적 ZIP and keep only acquisition-manifest parcels.

Does not load the national file into memory. Writes matched rows as JSONL shards.
"""
from __future__ import annotations

import hashlib
import json
import time
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path("/tmp/building-hub-bulk")
ZIP_PATH = ROOT / "mart_djy_06_202608.zip"
MANIFEST = ROOT / "manifest-parcels.jsonl"
SHARD_DIR = ROOT / "matched-shards"
PROGRESS = ROOT / "stream-progress.json"
META = ROOT / "source-meta.json"

# Column indexes from hub schema (0-based)
I_PK = 0
I_BLD = 7
I_SIG = 8
I_BJD = 9
I_PLAT = 10
I_BUN = 11
I_JI = 12
I_DONG = 21
I_HO = 22
I_FLR = 25
I_EX_NM = 27
I_MAIN_NM = 29
I_PURP_NM = 35
I_ETC = 36
I_AREA = 37
I_DAY = 38


def load_index() -> tuple[dict[str, list[dict]], dict[str, dict]]:
    by_parcel: dict[str, list[dict]] = defaultdict(list)
    by_id: dict[str, dict] = {}
    for line in MANIFEST.read_text().splitlines():
        if not line:
            continue
        row = json.loads(line)
        by_id[row["complexId"]] = row
        key = row.get("parcelKey")
        if key:
            by_parcel[key].append(row)
    return by_parcel, by_id


def names_match(building: str, apt: str) -> bool:
    b = building.replace(" ", "").replace("아파트", "").replace("(", "").replace(")", "")
    a = apt.replace(" ", "").replace("아파트", "").replace("(", "").replace(")", "")
    if len(b) < 2 or len(a) < 2:
        return False
    return b in a or a in b


def resolve_complex(candidates: list[dict], building: str) -> tuple[str | None, str]:
    if len(candidates) == 1:
        return candidates[0]["complexId"], "EXACT_PARCEL"
    if not building.strip():
        return None, "IDENTITY_UNRESOLVED"
    matched = [c for c in candidates if names_match(building, c["aptName"])]
    if len(matched) == 1:
        return matched[0]["complexId"], "EXACT_PARCEL_NAME"
    return None, "IDENTITY_UNRESOLVED"


def shard_path(complex_id: str) -> Path:
    digest = hashlib.sha1(complex_id.encode()).hexdigest()[:2]
    d = SHARD_DIR / digest
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{complex_id}.jsonl"


def main() -> int:
    if not ZIP_PATH.exists():
        raise SystemExit(f"missing zip {ZIP_PATH}")
    by_parcel, by_id = load_index()
    print(f"index parcels={len(by_parcel)} complexes={len(by_id)}", flush=True)
    SHARD_DIR.mkdir(parents=True, exist_ok=True)

    # open shard handles lazily
    handles: dict[str, any] = {}
    matched_complexes: set[str] = set()
    identity_hold: set[str] = set()
    stats = {
        "rows_scanned": 0,
        "rows_matched": 0,
        "rows_identity_hold": 0,
        "bytes_read": 0,
        "started_at": time.time(),
    }

    def get_handle(complex_id: str):
        h = handles.get(complex_id)
        if h is None:
            h = shard_path(complex_id).open("a", encoding="utf-8")
            handles[complex_id] = h
        return h

    with zipfile.ZipFile(ZIP_PATH) as zf:
        info = zf.getinfo("mart_djy_06.txt")
        print(f"entry size={info.file_size}", flush=True)
        with zf.open(info, "r") as raw:
            # TextIO wrapper for line iteration without full decode buffer blowups
            import io

            text = io.TextIOWrapper(raw, encoding="utf-8", errors="strict", newline="\n")
            for line in text:
                stats["rows_scanned"] += 1
                if stats["rows_scanned"] % 2_000_000 == 0:
                    elapsed = time.time() - stats["started_at"]
                    print(
                        json.dumps(
                            {
                                **stats,
                                "matched_complexes": len(matched_complexes),
                                "open_shards": len(handles),
                                "elapsed_s": int(elapsed),
                                "rows_per_s": int(stats["rows_scanned"] / max(elapsed, 1)),
                            }
                        ),
                        flush=True,
                    )
                    PROGRESS.write_text(json.dumps({**stats, "matched_complexes": len(matched_complexes)}))
                parts = line.rstrip("\n").split("|")
                if len(parts) < 39:
                    continue
                key = f"{parts[I_SIG]}|{parts[I_BJD]}|{parts[I_PLAT]}|{parts[I_BUN]}|{parts[I_JI]}"
                candidates = by_parcel.get(key)
                if not candidates:
                    continue
                complex_id, how = resolve_complex(candidates, parts[I_BLD])
                if complex_id is None:
                    stats["rows_identity_hold"] += 1
                    for c in candidates:
                        identity_hold.add(c["complexId"])
                    continue
                payload = {
                    "mgmBldrgstPk": parts[I_PK],
                    "bldNm": parts[I_BLD],
                    "sigunguCd": parts[I_SIG],
                    "bjdongCd": parts[I_BJD],
                    "platGbCd": parts[I_PLAT],
                    "bun": parts[I_BUN],
                    "ji": parts[I_JI],
                    "dongNm": parts[I_DONG],
                    "hoNm": parts[I_HO],
                    "flrNo": parts[I_FLR],
                    "exposPubuseGbCdNm": parts[I_EX_NM],
                    "mainAtchGbCdNm": parts[I_MAIN_NM],
                    "mainPurpsCdNm": parts[I_PURP_NM],
                    "etcPurps": parts[I_ETC],
                    "area": parts[I_AREA],
                    "crtnDay": parts[I_DAY],
                }
                get_handle(complex_id).write(json.dumps(payload, ensure_ascii=False) + "\n")
                matched_complexes.add(complex_id)
                stats["rows_matched"] += 1

    for h in handles.values():
        h.close()

    no_data = []
    unresolved = []
    for complex_id, row in by_id.items():
        if not row.get("parcelKey"):
            unresolved.append(complex_id)
        elif complex_id in identity_hold and complex_id not in matched_complexes:
            unresolved.append(complex_id)
        elif complex_id not in matched_complexes:
            no_data.append(complex_id)

    summary = {
        **stats,
        "elapsed_s": int(time.time() - stats["started_at"]),
        "matched_complexes": len(matched_complexes),
        "complete_no_data": len(no_data),
        "identity_unresolved": len(unresolved),
        "manifest_targets": len(by_id),
        "source_meta": json.loads(META.read_text()) if META.exists() else {},
    }
    (ROOT / "stream-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    (ROOT / "complete-no-data.txt").write_text("\n".join(no_data) + ("\n" if no_data else ""))
    (ROOT / "identity-unresolved.txt").write_text("\n".join(unresolved) + ("\n" if unresolved else ""))
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
