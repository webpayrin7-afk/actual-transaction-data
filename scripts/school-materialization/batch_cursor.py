"""Chunk/resume for the Seoul school dry-run.

Chunk boundaries come from src/lib/school-materialization/scale.ts.
This module does not open a database.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CURSOR = ROOT / "scripts/school-materialization/chunk_cursor.ts"
CHECKPOINT_NAME = "school-materialization-checkpoint.json"
CHUNK_DIR_NAME = "school-mat-chunks"


class CheckpointScopeError(RuntimeError):
    pass


def call_chunk_cursor(payload: dict) -> dict:
    proc = subprocess.run(
        ["npx", "tsx", str(CURSOR)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=str(ROOT),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "chunk cursor failed")
    return json.loads(proc.stdout)


def plan_remaining(
    complex_ids: list[str],
    checkpoint: dict | None,
    chunk_size: int,
    source_version: str,
) -> list[dict]:
    helper = None
    if checkpoint is not None:
        helper = {
            "version": checkpoint["version"],
            "mode": checkpoint["mode"],
            "region": checkpoint["region"],
            "source_version": checkpoint["source_version"],
            "last_completed_complex_id": checkpoint["last_completed_complex_id"],
            "completed_count": checkpoint["completed_count"],
            "total": checkpoint["total"],
        }
    result = call_chunk_cursor(
        {
            "command": "plan",
            "complex_ids": complex_ids,
            "checkpoint": helper,
            "chunk_size": chunk_size,
            "source_version": source_version,
        }
    )
    return result["chunks"]


def checkpoint_path(out_dir: Path) -> Path:
    return out_dir / CHECKPOINT_NAME


def chunk_dir(out_dir: Path) -> Path:
    return out_dir / CHUNK_DIR_NAME


def load_checkpoint(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def assert_checkpoint_scope(
    saved: dict | None,
    school_level: str,
    complex_id_filter: str,
    chunk_size: int,
    sido: str = "",
) -> None:
    if saved is None:
        return
    if (
        saved.get("school_level") != school_level
        or saved.get("complex_id_filter") != complex_id_filter
        or saved.get("chunk_size") != chunk_size
        or (saved.get("sido") or "") != (sido or "")
    ):
        raise CheckpointScopeError(
            "CHECKPOINT_SCOPE_MISMATCH: school_level, complex filter, chunk size, or sido changed"
        )


def save_checkpoint(path: Path, checkpoint: dict, school_level: str, complex_id_filter: str, chunk_size: int, sido: str = "") -> None:
    doc = dict(checkpoint)
    doc["school_level"] = school_level
    doc["complex_id_filter"] = complex_id_filter
    doc["chunk_size"] = chunk_size
    doc["sido"] = sido or ""
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")


def counter_delta(before: dict, after: dict) -> dict:
    keys = sorted(set(before) | set(after))
    return {key: int(after.get(key, 0)) - int(before.get(key, 0)) for key in keys if int(after.get(key, 0)) != int(before.get(key, 0))}


def apply_counter_delta(counter, delta: dict) -> None:
    for key, value in delta.items():
        counter[key] += value


def chunk_file(out_dir: Path, completed_count: int) -> Path:
    return chunk_dir(out_dir) / f"{int(completed_count):04d}.json"


def write_chunk(out_dir: Path, completed_count: int, doc: dict) -> None:
    path = chunk_file(out_dir, completed_count)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def read_chunk(out_dir: Path, completed_count: int) -> dict:
    path = chunk_file(out_dir, completed_count)
    if not path.exists():
        raise FileNotFoundError(f"missing completed chunk artifact: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))
