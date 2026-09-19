"""Build the next-wave insert manifest from the saved dry-run counts.

Does not rewrite national-dry-run.json and does not invent an identity rule.
The universe and lawd files must match the hashes already stored on that dry-run.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify import CADASTRAL_SIDO, active_legal, active_sigungu, classify_universe, load_jsonl, sido_report

spec = importlib.util.spec_from_file_location(
    "national_run_dry",
    Path(__file__).resolve().parent / "run-dry-run.py",
)
run_dry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_dry)


def load_checkpoint(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("universe")
    parser.add_argument("lawd")
    parser.add_argument("index")
    parser.add_argument("--checkpoint", default="data/poc/national-master/wave1-checkpoint.json")
    parser.add_argument("--prior", action="append", default=[])
    parser.add_argument("--out", default="data/poc/national-master/wave2-manifest.json")
    parser.add_argument("--new-only-coordinate", action="store_true")
    args = parser.parse_args()
    dry = json.loads((ROOT / "data/poc/national-master/national-dry-run.json").read_text(encoding="utf-8"))
    checkpoint_path = ROOT / args.checkpoint
    checkpoint = load_checkpoint(checkpoint_path)
    prior_paths = [ROOT / args.checkpoint, *[ROOT / item for item in args.prior]]
    universe_path = Path(args.universe)
    lawd_path = Path(args.lawd)
    index_path = Path(args.index)
    if run_dry.sha256_file(universe_path) != dry["universe_sha256"]:
        raise SystemExit("universe hash drift")
    if run_dry.sha256_file(lawd_path) != dry["lawd_sha256"]:
        raise SystemExit("lawd hash drift")

    saved = {row["sido"]: row for row in dry["by_sido"]}
    chosen_names = list(checkpoint["remaining"][:3])
    if len(chosen_names) != 3:
        raise SystemExit(f"wave size {chosen_names}")
    for name in chosen_names:
        row = saved[name]
        if row["NEW_SAFE"] < 100 or row["ambiguous_ratio"] > 0.02 or row["unresolved_ratio"] > 0.01:
            raise SystemExit(f"saved gate fail {name}")
        if row["deterministic_rate"] < 0.95:
            raise SystemExit(f"saved deterministic fail {name}")

    index = json.loads(index_path.read_text(encoding="utf-8"))
    lawd_rows = load_jsonl(lawd_path)
    classified = classify_universe(
        load_jsonl(universe_path),
        index["master"],
        index["links"],
        active_sigungu(lawd_rows),
        active_legal(lawd_rows),
    )
    live_report = {row["sido"]: row for row in sido_report(classified)}
    waves = []
    for name in chosen_names:
        expected = saved[name]["NEW_SAFE"]
        live = live_report.get(name)
        if live is None or live["NEW_SAFE"] != expected:
            raise SystemExit(f"count drift {name} live={None if live is None else live['NEW_SAFE']} saved={expected}")
        if live["AMBIGUOUS"] != saved[name]["AMBIGUOUS"]:
            raise SystemExit(f"ambiguous drift {name}")
        inserts = [
            run_dry.insert_row(row)
            for row in classified
            if row["sido"] == name and row["match_class"] == "NEW_SAFE"
        ]
        inserts.sort(key=lambda row: row["complex_id"])
        if len(inserts) != expected or len({row["complex_id"] for row in inserts}) != expected:
            raise SystemExit(f"insert drift {name}")
        if len({row["source_key"] for row in inserts}) != expected:
            raise SystemExit(f"source key drift {name}")
        waves.append(
            {
                "sido": name,
                "sido_code": inserts[0]["sido_code"],
                "expected_inserts": expected,
                "inserts": inserts,
                "cadastral_source_available": name in CADASTRAL_SIDO,
                "coordinate_phase_ready": False,
            }
        )

    done = {row["sido"] for row in checkpoint["completed"]}
    inserted_prior = 0
    protected = [
        {"sido": "서울특별시", "n": 8437},
        {"sido": "경기도", "n": 6529},
    ]
    seen = {"서울특별시", "경기도"}
    for path in prior_paths:
        for row in load_checkpoint(path)["completed"]:
            if row["sido"] in seen:
                continue
            seen.add(row["sido"])
            inserted_prior += int(row["inserted"])
            protected.append({"sido": row["sido"], "n": int(row["inserted"])})
    coordinate_next = []
    if not args.new_only_coordinate:
        for row in checkpoint["completed"]:
            coordinate_next.append(
                {
                    "sido": row["sido"],
                    "cadastral_source_available": bool(row["cadastral_source_available"]),
                    "blocker": "verified PNU input 없음. cadastral parcel file 없음",
                }
            )
    for wave in waves:
        coordinate_next.append(
            {
                "sido": wave["sido"],
                "cadastral_source_available": False,
                "blocker": "verified PNU input 없음. cadastral parcel file 없음",
            }
        )

    manifest = {
        "initial": {
            "master": 14966 + inserted_prior,
            "seoul": 8437,
            "gyeonggi": 6529,
            "kapt_links": 11 + inserted_prior,
        },
        "new_safe_total": dry["counts"]["NEW_SAFE"],
        "new_safe_remaining_before": dry["counts"]["NEW_SAFE"] - inserted_prior,
        "protected": protected,
        "coordinate_next": coordinate_next,
        "waves": waves,
    }
    out = ROOT / args.out
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "sido": [wave["sido"] for wave in waves],
                "inserts": [wave["expected_inserts"] for wave in waves],
                "skipped_completed": sorted(done),
                "classes": dict(Counter(row["match_class"] for row in classified if row["sido"] in chosen_names)),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
