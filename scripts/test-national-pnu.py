import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "national-coordinates"))

from coordinate_apply import (
    CoordinateGuardError,
    classify_exact_join,
    exact_pnu_hit,
    parse_cadastral_pnu,
    parse_wgs84_pair,
    refuse_write,
    validate_payload,
)
from pnu_resolve import resolve_row

JAMSIL = {
    "parcel_address": "서울특별시 송파구 잠실동 19 잠실엘스",
    "lawd_cd": "11710",
    "full_legal_code": "1171010100",
    "bjdong_name": "잠실동",
    "lawd_resolved": True,
}
ACTIVE = {
    "1171010100": {
        "full_legal_code": "1171010100",
        "sigungu_code": "11710",
        "bjdong_name": "잠실동",
        "status": "active",
    }
}


def test_jamsil_parity() -> None:
    row = resolve_row(JAMSIL, ACTIVE)
    assert row["resolution_status"] == "PNU_EXACT", row
    assert row["pnu"] == "1171010100100190000"
    assert row["mountain_flag"] is False
    assert row["main_lot"] == "0019"
    assert row["sub_lot"] == "0000"


def test_mountain_and_rejects() -> None:
    legal = {
        "4812313600": {
            "sigungu_code": "48123",
            "bjdong_name": "신월동",
        }
    }
    mountain = resolve_row(
        {
            "parcel_address": "경상남도 창원성산구 신월동 산 12-3 아파트",
            "lawd_cd": "48123",
            "full_legal_code": "4812313600",
            "bjdong_name": "신월동",
            "lawd_resolved": True,
        },
        legal,
    )
    assert mountain["pnu"] == "4812313600200120003"
    assert mountain["mountain_flag"] is True
    hyphen = resolve_row(
        {
            "parcel_address": "경상남도 창원성산구 신월동 1547- 아파트",
            "lawd_cd": "48123",
            "full_legal_code": "4812313600",
            "bjdong_name": "신월동",
            "lawd_resolved": True,
        },
        legal,
    )
    assert hyphen["resolution_status"] == "LOT_PARSE_FAILED"
    assert hyphen["pnu"] is None
    zero = resolve_row(
        {
            "parcel_address": "경상남도 창원성산구 신월동 0 아파트",
            "lawd_cd": "48123",
            "full_legal_code": "4812313600",
            "bjdong_name": "신월동",
            "lawd_resolved": True,
        },
        legal,
    )
    assert zero["resolution_status"] == "INVALID_PNU"
    empty = resolve_row(
        {
            "parcel_address": "",
            "lawd_cd": "48123",
            "full_legal_code": "4812313600",
            "bjdong_name": "신월동",
            "lawd_resolved": True,
        },
        legal,
    )
    assert empty["resolution_status"] == "NO_PARCEL_ADDRESS"


def test_join_classes() -> None:
    assert classify_exact_join("1" * 19, duplicate_pnu=True, coordinate=("129.0", "35.1"), sido_code="26") == "DUPLICATE_PNU"
    assert classify_exact_join("1" * 19, duplicate_pnu=False, coordinate=None, sido_code="26") == "PNU_NOT_FOUND"
    assert classify_exact_join("1" * 18, duplicate_pnu=False, coordinate=("129.0", "35.1"), sido_code="26") == "INVALID_COORDINATE"
    assert classify_exact_join("1" * 19, duplicate_pnu=False, coordinate=("129.0", "10.0"), sido_code="26") == "INVALID_COORDINATE"
    assert classify_exact_join("1" * 19, duplicate_pnu=False, coordinate=("129.0", "35.1"), sido_code="26") == "MATCHED_EXACT"
    assert parse_wgs84_pair("0", "0") == (None, None)
    assert parse_cadastral_pnu("1171010100100190000") == "1171010100100190000"
    assert parse_cadastral_pnu("1171010100000190000") is None


def test_coordinate_guards() -> None:
    try:
        refuse_write(["--write"])
        raise AssertionError("write was allowed")
    except CoordinateGuardError as exc:
        assert exc.code == "WRITE_DISABLED"
    assert exact_pnu_hit({"1" * 19: [(35.1, 129.1), (35.1, 129.1)]}, "1" * 19) == (35.1, 129.1)
    assert exact_pnu_hit({"1" * 19: [(35.1, 129.1), (35.2, 129.1)]}, "1" * 19) is None
    row = {
        "complex_id": "cx_1",
        "sido_code": "26",
        "resolution_status": "PNU_EXACT",
        "pnu": "2" * 19,
        "expected_pnu": "2" * 19,
        "latitude": 35.1,
        "longitude": 129.0,
        "semantics": "PARCEL_REPRESENTATIVE_POINT",
    }
    validate_payload([row], expected=1, existing_coords=set())
    try:
        validate_payload([row], expected=1, existing_coords={"cx_1"})
        raise AssertionError("overwrite was allowed")
    except CoordinateGuardError as exc:
        assert exc.code == "EXISTING_COORDINATE"


def test_cli_refuses_write() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/national-coordinates/prepare-coordinate-apply.py", "--write"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2


if __name__ == "__main__":
    test_jamsil_parity()
    test_mountain_and_rejects()
    test_coordinate_guards()
    test_join_classes()
    test_cli_refuses_write()
    print(json.dumps({"ok": True, "jamsil_pnu": "1171010100100190000"}))
