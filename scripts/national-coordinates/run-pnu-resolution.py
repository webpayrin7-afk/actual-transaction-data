"""National PNU dry-run for the 12,558 KAPT-linked SAFE rows. No Production write."""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pnu_resolve import RESOLVER_VERSION, resolve_row

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data/poc/national-coordinates"
UNIVERSE_SHA = "77129a57c8249d2ac1f311fc3fd56e1058a33b63ef6300a204b5215c6cda49d4"
LAWD_SHA = "d07f6e418df638fdf5176d2b551bdef46bfda20d1f3a15f91fabb7c7543f32a7"
KAPT_SOURCE_VERSION = "20260918_단지_기본정보.xlsx seq=135448 boardType=03"
LAWD_SOURCE_VERSION = "code.go.kr/etc/codeFullDown.do codeseId=법정동코드"
LAWD_SOURCE_DATE = "2026-09-19"
EXPECTED_TARGETS = 12558

STATUSES = (
    "PNU_EXACT",
    "NO_PARCEL_ADDRESS",
    "LAWD_UNRESOLVED",
    "LOT_PARSE_FAILED",
    "AMBIGUOUS_LAWD",
    "INVALID_PNU",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_targets() -> list[dict]:
    rows = []
    seen = set()
    for name in (
        "wave1-manifest.json",
        "wave2-manifest.json",
        "wave3-manifest.json",
        "wave4-manifest.json",
    ):
        doc = json.loads((ROOT / "data/poc/national-master" / name).read_text(encoding="utf-8"))
        for wave in doc["waves"]:
            for row in wave["inserts"]:
                key = row["source_key"]
                if key in seen:
                    raise SystemExit(f"duplicate source_key {key}")
                seen.add(key)
                rows.append(
                    {
                        "complex_id": row["complex_id"],
                        "sido": row["sido"],
                        "sido_code": row["sido_code"],
                        "source_key": key,
                    }
                )
    rows.sort(key=lambda row: row["complex_id"])
    ids = [row["complex_id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate complex_id in manifests")
    return rows


def load_active(path: Path) -> tuple[dict[str, dict], str]:
    source_version = ""
    active = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            source_version = row.get("source_version") or source_version
            if row.get("status") == "active" and row.get("level") in ("emd", "ri"):
                active[row["full_legal_code"]] = row
    return active, source_version


def load_universe(path: Path, keys: set[str]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            key = row.get("source_key")
            if key not in keys:
                continue
            if key in found:
                found[key] = None
            else:
                found[key] = row
    return found


def main() -> None:
    universe_path = Path("/tmp/national-inputs/kapt-complex-universe.jsonl")
    lawd_path = Path("/tmp/national-inputs/lawd-resolver.jsonl")
    repo_universe = ROOT / "data/poc/national-expansion/kapt-complex-universe.jsonl"
    repo_lawd = ROOT / "data/poc/national-expansion/lawd-resolver.jsonl"
    if repo_universe.exists():
        universe_path = repo_universe
    if repo_lawd.exists():
        lawd_path = repo_lawd
    if sha256_file(universe_path) != UNIVERSE_SHA:
        raise SystemExit("universe hash drift")
    if sha256_file(lawd_path) != LAWD_SHA:
        raise SystemExit("lawd hash drift")

    targets = load_targets()
    if len(targets) != EXPECTED_TARGETS:
        raise SystemExit(f"target count {len(targets)} != {EXPECTED_TARGETS}")
    active, lawd_version = load_active(lawd_path)
    universe = load_universe(universe_path, {row["source_key"] for row in targets})

    resolved = []
    for target in targets:
        src = universe.get(target["source_key"])
        if not src:
            item = {
                "parcel_address": "",
                "lawd_code": "",
                "full_legal_code": "",
                "mountain_flag": None,
                "main_lot": None,
                "sub_lot": None,
                "pnu": None,
                "resolution_status": "LAWD_UNRESOLVED",
            }
        else:
            item = resolve_row(src, active)
        resolved.append(
            {
                "complex_id": target["complex_id"],
                "sido": target["sido"],
                "sido_code": target["sido_code"],
                "source_key": target["source_key"],
                **item,
            }
        )

    ids = [row["complex_id"] for row in resolved]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate complex_id in resolution")
    invalid = sum(1 for row in resolved if row["resolution_status"] == "PNU_EXACT" and (not row["pnu"] or len(row["pnu"]) != 19))
    if invalid:
        raise SystemExit("invalid exact pnu")

    OUT.mkdir(parents=True, exist_ok=True)
    jsonl_path = OUT / "pnu-resolution.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as handle:
        for row in resolved:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    artifact_hash = sha256_file(jsonl_path)

    by_sido: dict[str, Counter] = defaultdict(Counter)
    total = Counter()
    samples = []
    for row in resolved:
        status = row["resolution_status"]
        total[status] += 1
        by_sido[row["sido"]][status] += 1
        by_sido[row["sido"]]["targets"] += 1
        if row["parcel_address"]:
            by_sido[row["sido"]]["parcel_address_available"] += 1
        if status == "PNU_EXACT" and len(samples) < 20:
            samples.append(
                {
                    "complex_id": row["complex_id"],
                    "sido": row["sido"],
                    "source_key": row["source_key"],
                    "pnu": row["pnu"],
                    "mountain_flag": row["mountain_flag"],
                    "main_lot": row["main_lot"],
                    "sub_lot": row["sub_lot"],
                }
            )

    safe = total["PNU_EXACT"]
    unresolved = len(resolved) - safe
    summary = {
        "resolver_version": RESOLVER_VERSION,
        "production_write": False,
        "targets": len(resolved),
        "parcel_address_available": sum(1 for row in resolved if row["parcel_address"]),
        "counts": {status: total[status] for status in STATUSES},
        "pnu_exact": safe,
        "unresolved": unresolved,
        "coverage": round(safe / len(resolved), 6) if resolved else 0,
        "duplicate_complex_id": 0,
        "invalid_exact_pnu": 0,
        "by_sido": [
            {
                "sido": sido,
                "targets": bucket["targets"],
                "parcel_address_available": bucket["parcel_address_available"],
                "PNU_EXACT": bucket["PNU_EXACT"],
                "unresolved": bucket["targets"] - bucket["PNU_EXACT"],
                **{status: bucket[status] for status in STATUSES if status != "PNU_EXACT"},
            }
            for sido, bucket in sorted(by_sido.items(), key=lambda item: -item[1]["targets"])
        ],
        "samples": samples,
    }
    (OUT / "pnu-resolution-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "resolver_version": RESOLVER_VERSION,
        "input_count": len(resolved),
        "safe_count": safe,
        "artifact": "data/poc/national-coordinates/pnu-resolution.jsonl",
        "artifact_sha256": artifact_hash,
        "sources": {
            "kapt_universe": {
                "source_version": KAPT_SOURCE_VERSION,
                "sha256": UNIVERSE_SHA,
            },
            "lawd_resolver": {
                "source_version": lawd_version or LAWD_SOURCE_VERSION,
                "source_date": LAWD_SOURCE_DATE,
                "sha256": LAWD_SHA,
            },
            "wave_manifests": [
                "data/poc/national-master/wave1-manifest.json",
                "data/poc/national-master/wave2-manifest.json",
                "data/poc/national-master/wave3-manifest.json",
                "data/poc/national-master/wave4-manifest.json",
            ],
        },
        "pnu_format": "10-digit legal code + cadastral plat 1/2 + bonbun 4 + bubun 4",
        "production_write": False,
    }
    (OUT / "pnu-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"targets": len(resolved), "pnu_exact": safe, "unresolved": unresolved, "sha256": artifact_hash}))


if __name__ == "__main__":
    main()
