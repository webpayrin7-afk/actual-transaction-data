"""Fixture tests for national identity classification. No API, no Production."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "national-identity"))

from classify import address_complete, classify_quality, normalize_apt_name, parcel_sido_contradicts
from lawd import ActiveLawdIndex


def lawd_row(**kwargs):
    base = {
        "full_legal_code": "1111010100",
        "sido_code": "11",
        "sido_name": "서울특별시",
        "sigungu_code": "11110",
        "sigungu_name": "종로구",
        "bjdong_code": "10100",
        "bjdong_name": "청운동",
        "level": "emd",
        "active": True,
        "status": "active",
        "full_name": "서울특별시 종로구 청운동",
        "source_version": "test",
        "source_date": "2026-09-19",
    }
    base.update(kwargs)
    return base


def index_fixture():
    rows = [
        lawd_row(
            full_legal_code="1100000000",
            sigungu_code="",
            sigungu_name="",
            bjdong_code="",
            bjdong_name="",
            level="sido",
            full_name="서울특별시",
        ),
        lawd_row(
            full_legal_code="1111000000",
            bjdong_code="",
            bjdong_name="",
            level="sigungu",
            full_name="서울특별시 종로구",
        ),
        lawd_row(),
        lawd_row(
            full_legal_code="1111010100",
            status="inactive",
            active=False,
            full_name="서울특별시 종로구 청운동",
        ),
        lawd_row(
            full_legal_code="3611000000",
            sido_code="36",
            sido_name="세종특별자치시",
            sigungu_code="36110",
            sigungu_name="세종특별자치시",
            bjdong_code="",
            bjdong_name="",
            level="sigungu",
            full_name="세종특별자치시",
        ),
        lawd_row(
            full_legal_code="3600000000",
            sido_code="36",
            sido_name="세종특별자치시",
            sigungu_code="",
            sigungu_name="",
            bjdong_code="",
            bjdong_name="",
            level="sido",
            full_name="세종특별자치시",
        ),
        lawd_row(
            full_legal_code="3611010100",
            sido_code="36",
            sido_name="세종특별자치시",
            sigungu_code="36110",
            sigungu_name="세종특별자치시",
            bjdong_code="10100",
            bjdong_name="반곡동",
            full_name="세종특별자치시 반곡동",
        ),
        lawd_row(
            full_legal_code="4111100000",
            sido_code="41",
            sido_name="경기도",
            sigungu_code="41111",
            sigungu_name="수원시 장안구",
            bjdong_code="",
            bjdong_name="",
            level="sigungu",
            full_name="경기도 수원시 장안구",
        ),
        lawd_row(
            full_legal_code="4100000000",
            sido_code="41",
            sido_name="경기도",
            sigungu_code="",
            sigungu_name="",
            bjdong_code="",
            bjdong_name="",
            level="sido",
            full_name="경기도",
        ),
        lawd_row(
            full_legal_code="4111113500",
            sido_code="41",
            sido_name="경기도",
            sigungu_code="41111",
            sigungu_name="수원시 장안구",
            bjdong_code="13500",
            bjdong_name="파장동",
            full_name="경기도 수원시 장안구 파장동",
        ),
    ]
    return ActiveLawdIndex(rows)


def expect(cond: bool, message: str) -> None:
    if not cond:
        raise SystemExit(message)


def main() -> None:
    expect(normalize_apt_name(" 잠실 엘스 ") == "잠실엘스", "norm")
    expect(address_complete("단지", "", "서울특별시 종로구 청운동 1") is True, "addr parcel")
    expect(address_complete("단지", "", "") is False, "addr empty")
    expect(address_complete("", "도로", "") is False, "name empty")
    expect(parcel_sido_contradicts("경기도 수원장안구 파장동 1", "경기도", ["경기도", "서울특별시"]) is False, "compact ok")
    expect(parcel_sido_contradicts("서울특별시 강남구 삼성동", "대구광역시", ["서울특별시", "대구광역시"]), "cross sido")
    expect(parcel_sido_contradicts("", "서울특별시", ["서울특별시"]) is False, "empty parcel")

    expect(
        classify_quality(kapt_code="BAD", duplicate=True, name_address_ok=False, lawd_resolved=False)
        == "INVALID",
        "invalid wins",
    )
    expect(
        classify_quality(kapt_code="A10000001", duplicate=True, name_address_ok=True, lawd_resolved=True)
        == "DUPLICATE_SOURCE_KEY",
        "dup",
    )
    expect(
        classify_quality(kapt_code="A10000001", duplicate=False, name_address_ok=False, lawd_resolved=True)
        == "ADDRESS_INCOMPLETE",
        "addr",
    )
    expect(
        classify_quality(kapt_code="A10000001", duplicate=False, name_address_ok=True, lawd_resolved=False)
        == "REGION_UNRESOLVED",
        "region",
    )
    expect(
        classify_quality(kapt_code="A10000001", duplicate=False, name_address_ok=True, lawd_resolved=True)
        == "READY",
        "ready",
    )

    index = index_fixture()
    hit = index.resolve("서울특별시", "종로구", "", "청운동")
    expect(hit is not None and hit["full_legal_code"] == "1111010100", "seoul dong")
    expect(index.resolve("폐지특별시", "종로구", "", "청운동") is None, "unknown sido")
    sejong = index.resolve("세종특별자치시", "", "", "반곡동")
    expect(sejong is not None and sejong["sigungu_code"] == "36110", "sejong")
    suwon = index.resolve("경기도", "장안구", "", "파장동")
    expect(suwon is not None and suwon["full_legal_code"] == "4111113500", "gu leaf")
    compact = index.resolve("경기도", "수원장안구", "", "파장동")
    expect(compact is not None and compact["full_legal_code"] == "4111113500", "compact gu")
    expect(index.resolve("서울특별시", "종로구", "", "") is None, "no dong")
    print('{"ok":true}')


if __name__ == "__main__":
    main()
