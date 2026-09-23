#!/usr/bin/env python3
"""Self-tests for the national coordinate backfill runner helpers."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "runner",
    ROOT / "scripts/living/run-national-coordinate-backfill.py",
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def main() -> int:
    pnu, status = mod.build_pnu("11710", "10100", "19")
    assert pnu == "1171010100100190000" and status == "EXACT_JIBUN"
    pnu, status = mod.build_pnu("41111", "13700", "226-1")
    assert pnu == "4111113700102260001"
    assert mod.build_pnu("11710", "10100", "19,20")[1] == "AMBIGUOUS_JIBUN"
    assert mod.build_pnu("11710", "10100", "")[1] == "NO_JIBUN"
    assert mod.in_bbox(37.51413457, 127.07932524, "11")
    assert not mod.in_bbox(128.5, 36.2, "11")
    row = {
        "complex_id": "cx_test",
        "apt_name": "t",
        "sido": "서울특별시",
        "sido_code": "11",
        "sigungu": "x",
        "legal_dong_name": "잠실동",
        "lawd_cd": "11710",
        "bjdong_cd": "10100",
        "jibun": "19",
    }
    classified = mod.classify_target(row, {}, set())
    assert classified["klass"] == "HAS_PNU_NO_GEOMETRY"
    classified2 = mod.classify_target({**row, "jibun": ""}, {}, set())
    assert classified2["klass"] == "NO_PNU_IDENTITY_GAP"
    print("runner-self-test PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
