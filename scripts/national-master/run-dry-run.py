"""National master dry-run. Reads Acquisition artifacts. Does not write Production."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify import (
    CADASTRAL_SIDO,
    active_legal,
    active_sigungu,
    classify_universe,
    load_jsonl,
    select_wave,
    sido_report,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def insert_row(row: dict) -> dict:
    return {
        "complex_id": row["complex_id"],
        "apt_name": row["apt_name"],
        "apt_name_norm": row["apt_name_norm"],
        "sido": row["sido"],
        "sido_code": row["sido_code"],
        "sigungu": row.get("sigungu_official") or "",
        "lawd_cd": row["lawd_cd"],
        "legal_dong_name": row.get("legal_dong_name") or "",
        "bjdong_cd": row.get("bjdong_cd") or "",
        "road_address": row.get("road_address") or "",
        "source_key": row["source_key"],
        "source_version": row.get("source_version") or "",
        "full_legal_code": row.get("full_legal_code") or "",
        "identity_status": "IDENTITY-READY",
        "identity_reason_codes": "[]",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", required=True)
    parser.add_argument("--lawd", required=True)
    parser.add_argument("--master-index", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    universe_path = Path(args.universe)
    lawd_path = Path(args.lawd)
    index = json.loads(Path(args.master_index).read_text(encoding="utf-8"))
    lawd_rows = load_jsonl(lawd_path)
    universe = load_jsonl(universe_path)
    classified = classify_universe(
        universe,
        index["master"],
        index["links"],
        active_sigungu(lawd_rows),
        active_legal(lawd_rows),
    )
    counts = Counter(row["match_class"] for row in classified)
    ready = sum(1 for row in classified if row["quality_in"] == "READY")
    duplicate_keys = len(
        {
            row["source_key"]
            for row in classified
            if row["match_class"] == "DUPLICATE_SOURCE_KEY" and row["source_key"]
        }
    )
    by_sido = sido_report(classified)
    chosen, rest = select_wave(by_sido)
    chosen_names = {row["sido"] for row in chosen}
    waves = []
    for sido_row in chosen:
        inserts = [
            insert_row(row)
            for row in classified
            if row["sido"] == sido_row["sido"] and row["match_class"] == "NEW_SAFE"
        ]
        inserts.sort(key=lambda row: row["complex_id"])
        ids = [row["complex_id"] for row in inserts]
        keys = [row["source_key"] for row in inserts]
        if len(ids) != len(set(ids)) or len(keys) != len(set(keys)):
            raise SystemExit(f"wave plan not unique {sido_row['sido']}")
        if len(inserts) != sido_row["NEW_SAFE"]:
            raise SystemExit(f"wave count drift {sido_row['sido']}")
        waves.append(
            {
                "sido": sido_row["sido"],
                "sido_code": inserts[0]["sido_code"] if inserts else "",
                "expected_inserts": len(inserts),
                "inserts": inserts,
                "cadastral_source_available": sido_row["sido"] in CADASTRAL_SIDO,
                "coordinate_phase_ready": False,
            }
        )
    samples = []
    for row in classified:
        if row["sido"] in chosen_names and row["match_class"] == "NEW_SAFE":
            samples.append(
                {
                    "match_class": row["match_class"],
                    "sido": row["sido"],
                    "source_key": row["source_key"],
                    "complex_id": row["complex_id"],
                    "apt_name": row["apt_name"],
                    "lawd_cd": row["lawd_cd"],
                }
            )
        if len(samples) >= 20:
            break
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {
        "production_write": False,
        "ready_input": ready,
        "counts": dict(counts),
        "duplicate_source_keys": duplicate_keys,
        "by_sido": [{k: v for k, v in row.items()} for row in by_sido],
        "wave_sido": [row["sido"] for row in chosen],
        "wave_rejected_or_deferred": [
            {"sido": row["sido"], "reason": row.get("reason", "deferred_rank"), "NEW_SAFE": row["NEW_SAFE"]}
            for row in rest
            if row["sido"] not in ("서울특별시", "경기도")
        ],
        "samples": samples,
        "universe_sha256": sha256_file(universe_path),
        "lawd_sha256": sha256_file(lawd_path),
        "master_rows": len(index["master"]),
        "kapt_links": len(index["links"]),
    }
    (out / "national-dry-run.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "initial": {
            "master": len(index["master"]),
            "seoul": sum(1 for row in index["master"] if row.get("sido") == "서울특별시"),
            "gyeonggi": sum(1 for row in index["master"] if row.get("sido") == "경기도"),
            "kapt_links": len(index["links"]),
        },
        "waves": waves,
    }
    (out / "wave1-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ready": ready,
                "counts": dict(counts),
                "duplicate_source_keys": duplicate_keys,
                "wave": [row["sido"] for row in chosen],
                "wave_inserts": [row["expected_inserts"] for row in waves],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
