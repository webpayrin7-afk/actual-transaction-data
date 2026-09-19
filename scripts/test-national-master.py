"""Fixture tests for warehouse complex_id and national match classes."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "national-master"))

from classify import classify_universe, select_wave, sido_report
from identity import complex_id


def expect(cond: bool, message: str) -> None:
    if not cond:
        raise SystemExit(message)


def sigungu(code: str, sido_code: str, sido_name: str, name: str) -> dict:
    return {
        "sigungu_code": code,
        "sido_code": sido_code,
        "sido_name": sido_name,
        "sigungu_name": name,
        "status": "active",
        "level": "sigungu",
    }


def legal(code: str, sigungu_code: str, leaf: str) -> dict:
    return {
        "full_legal_code": code,
        "sigungu_code": sigungu_code,
        "bjdong_code": code[5:],
        "bjdong_name": leaf,
        "status": "active",
    }


def kapt(**kwargs) -> dict:
    base = {
        "source_key": "A10000001",
        "kapt_code": "A10000001",
        "apt_name": "테스트",
        "apt_name_norm": "테스트",
        "sido": "부산광역시",
        "sigungu": "중구",
        "lawd_cd": "26110",
        "full_legal_code": "2611010100",
        "road_address": "부산광역시 중구 테스트로 1",
        "lawd_resolved": True,
        "quality": "READY",
        "source_version": "test",
    }
    base.update(kwargs)
    return base


def main() -> None:
    raw = "molit:11710:잠실엘스"
    expect(
        complex_id("11710", "잠실엘스") == "cx_" + hashlib.sha1(raw.encode()).hexdigest()[:16],
        "formula",
    )
    # Production sample captured read-only. lawd 11260 / sg타워.
    expect(complex_id("11260", "sg타워") == "cx_0000802f1c42d195", "sample parity")

    sigungu_index = {
        "26110": sigungu("26110", "26", "부산광역시", "중구"),
        "11110": sigungu("11110", "11", "서울특별시", "종로구"),
    }
    legal_index = {
        "2611010100": legal("2611010100", "26110", "영주동"),
        "1111010100": legal("1111010100", "11110", "청운동"),
    }
    master = [
        {
            "complex_id": complex_id("11110", "삼흥"),
            "lawd_cd": "11110",
            "apt_name_norm": "삼흥",
            "sido": "서울특별시",
            "sido_code": "11",
        }
    ]
    rows = classify_universe(
        [
            kapt(source_key="A10000001", kapt_code="A10000001"),
            kapt(
                source_key="A10000002",
                kapt_code="A10000002",
                apt_name="삼흥",
                apt_name_norm="삼흥",
                sido="서울특별시",
                lawd_cd="11110",
                full_legal_code="1111010100",
            ),
            kapt(
                source_key="A10000003",
                kapt_code="A10000003",
                apt_name="없는단지",
                apt_name_norm="없는단지",
                sido="서울특별시",
                lawd_cd="11110",
                full_legal_code="1111010100",
            ),
            kapt(source_key="A10000009", kapt_code="A10000009", apt_name="중복", apt_name_norm="중복"),
            kapt(source_key="A10000009", kapt_code="A10000009", apt_name="중복2", apt_name_norm="중복2"),
            kapt(
                source_key="A50010008",
                kapt_code="A50010008",
                quality="REGION_UNRESOLVED",
                lawd_resolved=False,
                lawd_cd="",
            ),
            kapt(source_key="A10000004", kapt_code="A10000004", apt_name="같은", apt_name_norm="같은"),
            kapt(source_key="A10000005", kapt_code="A10000005", apt_name="같은", apt_name_norm="같은"),
        ],
        master,
        [{"source_key": "A10000002", "complex_id": master[0]["complex_id"]}],
        sigungu_index,
        legal_index,
    )
    by_key = {}
    for row in rows:
        by_key.setdefault(row["source_key"], []).append(row["match_class"])
    expect(by_key["A10000001"] == ["NEW_SAFE"], "new safe")
    expect(by_key["A10000002"] == ["EXISTING_EXACT"], "link wins")
    expect(rows[[r["source_key"] for r in rows].index("A10000002")]["complex_id"] == master[0]["complex_id"], "id kept")
    expect(by_key["A10000003"] == ["NO_MATCH"], "capital unmatched")
    expect(by_key["A10000009"] == ["DUPLICATE_SOURCE_KEY", "DUPLICATE_SOURCE_KEY"], "dup excluded")
    expect(by_key["A50010008"] == ["REGION_UNRESOLVED"], "unresolved")
    expect(by_key["A10000004"] == ["AMBIGUOUS"], "same identity")
    expect(by_key["A10000005"] == ["AMBIGUOUS"], "same identity pair")
    new = next(row for row in rows if row["source_key"] == "A10000001")
    expect(new["complex_id"] == complex_id("26110", "테스트"), "new id rule")

    report = sido_report(rows)
    chosen, _rest = select_wave(
        [
            {
                "sido": "부산광역시",
                "ready": 1000,
                "NEW_SAFE": 990,
                "AMBIGUOUS": 10,
                "REGION_UNRESOLVED": 0,
                "kapt_rows": 1000,
                "deterministic_rate": 0.99,
                "ambiguous_ratio": 0.01,
                "unresolved_ratio": 0,
                "EXISTING_EXACT": 0,
            },
            {
                "sido": "서울특별시",
                "ready": 3000,
                "NEW_SAFE": 0,
                "AMBIGUOUS": 0,
                "REGION_UNRESOLVED": 0,
                "kapt_rows": 3000,
                "deterministic_rate": 0,
                "ambiguous_ratio": 0,
                "unresolved_ratio": 0,
                "EXISTING_EXACT": 10,
            },
            {
                "sido": "대구광역시",
                "ready": 100,
                "NEW_SAFE": 50,
                "AMBIGUOUS": 0,
                "REGION_UNRESOLVED": 0,
                "kapt_rows": 100,
                "deterministic_rate": 0.5,
                "ambiguous_ratio": 0,
                "unresolved_ratio": 0,
                "EXISTING_EXACT": 0,
            },
        ]
    )
    expect([row["sido"] for row in chosen] == ["부산광역시"], "selector")
    expect(report[0]["sido"], "report")
    print('{"ok":true}')


if __name__ == "__main__":
    main()
