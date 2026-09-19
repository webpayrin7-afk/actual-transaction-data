"""Build national lawd resolver + KAPT identity universe. No Production writes."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify import address_complete, classify_quality, normalize_apt_name, parcel_sido_contradicts
from kapt_xlsx import iter_kapt_rows
from lawd import SOURCE_DATE, SOURCE_VERSION, load_lawd_rows, parent_gaps, ActiveLawdIndex

KAPT_SOURCE = "K-apt 공동주택관리정보시스템 자료실 기본정보"
KAPT_SOURCE_VERSION = "20260918_단지_기본정보.xlsx seq=135448 boardType=03"
KAPT_SOURCE_DATE = "2026-09-18"
KAPT_SOURCE_URL = "https://www.k-apt.go.kr/board/getFileDownload.do?seq=135448&boardType=03"

LAWD_FIELDS = (
    "full_legal_code",
    "sido_code",
    "sido_name",
    "sigungu_code",
    "sigungu_name",
    "bjdong_code",
    "bjdong_name",
    "level",
    "active",
    "status",
    "full_name",
    "source_version",
    "source_date",
)
KAPT_FIELDS = (
    "kapt_code",
    "source_key",
    "apt_name",
    "apt_name_norm",
    "sido",
    "sigungu",
    "eupmyeon",
    "dongri",
    "bjdong_name",
    "bjdong_code",
    "lawd_cd",
    "full_legal_code",
    "road_address",
    "parcel_address",
    "lawd_resolved",
    "quality",
    "source_version",
    "source_date",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_jsonl(path: Path, rows: list[dict], fields: tuple[str, ...]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            payload = {key: row[key] for key in fields}
            handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def build_kapt(rows_iter, index: ActiveLawdIndex) -> list[dict]:
    sido_names = sorted(index.sido.keys(), key=len, reverse=True)
    staged: list[dict] = []
    for raw in rows_iter:
        kapt_code = raw.get("kapt_code", "")
        apt_name = raw.get("apt_name", "")
        road = raw.get("road_address", "")
        parcel = raw.get("parcel_address", "")
        eup = raw.get("eupmyeon", "")
        dong = raw.get("dongri", "")
        hit = index.resolve(raw.get("sido", ""), raw.get("sigungu", ""), eup, dong)
        resolved = hit is not None and not parcel_sido_contradicts(
            parcel, hit["sido_name"], sido_names
        )
        bjdong_name = " ".join(part for part in (eup, dong) if part)
        staged.append(
            {
                "kapt_code": kapt_code,
                "source_key": kapt_code,
                "apt_name": apt_name,
                "apt_name_norm": normalize_apt_name(apt_name),
                "sido": raw.get("sido", ""),
                "sigungu": raw.get("sigungu", ""),
                "eupmyeon": eup,
                "dongri": dong,
                "bjdong_name": bjdong_name,
                "bjdong_code": hit["bjdong_code"] if resolved else "",
                "lawd_cd": hit["sigungu_code"] if resolved else "",
                "full_legal_code": hit["full_legal_code"] if resolved else "",
                "road_address": road,
                "parcel_address": parcel,
                "lawd_resolved": resolved,
                "name_address_ok": address_complete(apt_name, road, parcel),
                "source_version": KAPT_SOURCE_VERSION,
                "source_date": KAPT_SOURCE_DATE,
            }
        )
    counts = Counter(row["source_key"] for row in staged if row["source_key"])
    for row in staged:
        duplicate = bool(row["source_key"]) and counts[row["source_key"]] > 1
        row["quality"] = classify_quality(
            kapt_code=row["kapt_code"],
            duplicate=duplicate,
            name_address_ok=row["name_address_ok"],
            lawd_resolved=row["lawd_resolved"],
        )
        del row["name_address_ok"]
    staged.sort(key=lambda row: (row["source_key"], row["parcel_address"], row["apt_name"]))
    return staged


def sido_coverage(kapt_rows: list[dict]) -> list[dict]:
    bucket: dict[str, Counter] = defaultdict(Counter)
    for row in kapt_rows:
        key = row["sido"] or "(blank)"
        bucket[key]["total"] += 1
        bucket[key]["ready"] += int(row["quality"] == "READY")
        bucket[key]["lawd_resolved"] += int(row["lawd_resolved"])
        bucket[key]["unresolved"] += int(not row["lawd_resolved"])
        bucket[key]["duplicate"] += int(row["quality"] == "DUPLICATE_SOURCE_KEY")
        bucket[key]["missing_address"] += int(row["quality"] == "ADDRESS_INCOMPLETE")
        bucket[key]["invalid"] += int(row["quality"] == "INVALID")
    out = []
    for sido, counts in sorted(bucket.items(), key=lambda item: (-item[1]["total"], item[0])):
        out.append({"sido": sido, **counts})
    return out


CADASTRAL_SIDO_FILES = [
    "서울특별시",
    "부산광역시",
    "대구광역시",
    "인천광역시",
    "광주광역시",
    "대전광역시",
    "울산광역시",
    "세종특별자치시",
    "경기도",
    "강원특별자치도",
    "충청북도",
    "충청남도",
    "전북특별자치도",
    "전라남도",
    "경상북도",
    "경상남도",
    "제주특별자치도",
]


def production_link_check(path: str | None, kapt_rows: list[dict]) -> dict:
    if not path:
        return {"checked": False}
    links = json.loads(Path(path).read_text(encoding="utf-8"))
    by_key: dict[str, list[dict]] = defaultdict(list)
    for row in kapt_rows:
        by_key[row["source_key"]].append(row)
    missing = []
    collisions = []
    matched = []
    for link in links:
        key = str(link["source_key"])
        hits = by_key.get(key, [])
        if len(hits) == 0:
            missing.append(key)
            collisions.append({"source_key": key, "reason": "missing_from_universe"})
        elif len(hits) > 1:
            collisions.append({"source_key": key, "reason": "duplicate_in_universe", "rows": len(hits)})
        else:
            matched.append({"source_key": key, "quality": hits[0]["quality"], "sido": hits[0]["sido"]})
    return {
        "checked": True,
        "read_only": True,
        "link_count": len(links),
        "compatible": len(links) > 0 and not missing and not collisions and all(item["quality"] == "READY" for item in matched),
        "collisions": collisions,
        "missing": missing,
        "matched": matched,
    }


def write_manifest(path: Path, summary: dict, links: dict) -> None:
    duplicate_keys = 0
    # recomputed by caller via summary
    manifest = {
        "production_write": False,
        "management_fee_write": False,
        "lawd": {
            "source": "행정안전부 행정표준코드관리시스템 법정동코드 전체자료",
            "source_url": "https://www.code.go.kr/etc/codeFullDown.do",
            "source_version": SOURCE_VERSION,
            "source_date": SOURCE_DATE,
            "source_sha256": summary["lawd_source_sha256"],
            "artifact": "data/poc/national-expansion/lawd-resolver.jsonl",
            "artifact_sha256": summary["lawd_sha256"],
            "row_count": summary["lawd_rows"],
            "active_rows": summary["lawd_active"],
            "inactive_rows": summary["lawd_inactive"],
            "parent_gaps": summary["lawd_parent_gaps"],
            "sido_coverage": summary["lawd_active_sido"],
            "unresolved_parent_rows": summary["lawd_parent_gaps"],
        },
        "kapt_universe": {
            "source": KAPT_SOURCE,
            "source_url": KAPT_SOURCE_URL,
            "source_version": KAPT_SOURCE_VERSION,
            "source_date": KAPT_SOURCE_DATE,
            "source_sha256": summary["kapt_source_sha256"],
            "artifact": "data/poc/national-expansion/kapt-complex-universe.jsonl",
            "artifact_sha256": summary["kapt_sha256"],
            "row_count": summary["kapt_rows"],
            "unique_source_keys": summary["kapt_unique_keys"],
            "duplicate_source_keys": summary["duplicate_source_keys"],
            "quality": summary["kapt_quality"],
            "lawd_resolved": summary["kapt_lawd_resolved"],
            "lawd_unresolved": summary["kapt_rows"] - summary["kapt_lawd_resolved"],
            "sido_coverage": summary["by_sido"],
            "identity_fields": list(KAPT_FIELDS),
        },
        "identity_fields": {
            "lawd": list(LAWD_FIELDS),
            "kapt": list(KAPT_FIELDS),
            "complex_id_assigned": False,
        },
        "production_kapt_links": links,
        "coordinate_source_inventory": {
            "conversion_executed": False,
            "nationwide_availability": "file",
            "missing_sido": ["전남광주통합특별시"],
            "sources": [
                {
                    "name": "국토교통부 일별연속지적도형정보",
                    "portal": "https://www.data.go.kr/data/15045882/fileData.do",
                    "locator": "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=23",
                    "form": "file",
                    "format": "SHP",
                    "crs": "EPSG:5186",
                    "source_date": "portal record modified 2025-09-08; update cycle 수시. Individual file dates were not read.",
                    "expected_scale": "38352207 parcels nationwide on the portal record. Per-sido counts were not measured.",
                    "sido_files": CADASTRAL_SIDO_FILES,
                    "api": "VWorld data API exists for this product family and was not called.",
                    "note": "Catalog still lists 광주광역시 and 전라남도 separately. 전남광주통합특별시 has no own file in that list.",
                }
            ],
        },
        "checkpoint": {
            "resumable": False,
            "reason": "Two official bulk files. No regional API loop, so there is no partial-region checkpoint.",
            "api_calls": 0,
            "http_429": False,
        },
        "known_limitations": [
            "K-apt 기본정보는 관리비 공개 의무단지이다. 전국 모든 아파트가 아니다.",
            f"{summary['duplicate_source_keys']} source keys are repeated in the workbook ({summary['kapt_quality'].get('DUPLICATE_SOURCE_KEY', 0)} rows). Those rows are DUPLICATE_SOURCE_KEY. Rows were not merged.",
            "A50010008 (한국부동산원테스트1) is REGION_UNRESOLVED because the parcel text leads with 서울특별시 while the structured region is 대구광역시 동구.",
            "Compound districts are matched by an exact mechanical alias only: 수원시 장안구 → 수원장안구. This is not an apt-name merge.",
            "세종특별자치시 has no 3600000000 sido row. The active root is sigungu 36110. K-apt leaves sigungu blank.",
            "Inactive legal codes stay in the resolver. READY requires one active eup/myeon/dong or ri code.",
            "apt_name_norm matches src/lib/db/repository.ts (strip whitespace, lower). It is stored, not used to join rows.",
            "No complex_id, apt_complex_master row, or apt_complex_source_links insert is created here.",
            "src/lib/constants/nationwide-lawd.json is a 5-digit sigungu catalog and is not this resolver.",
            "Cadastral SHP files were not downloaded and were not converted.",
        ],
    }
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lawd-zip", required=True)
    parser.add_argument("--kapt-xlsx", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--production-links")
    args = parser.parse_args()
    out = Path(args.out)
    lawd_rows = load_lawd_rows(args.lawd_zip)
    index = ActiveLawdIndex(lawd_rows)
    kapt_rows = build_kapt(iter_kapt_rows(args.kapt_xlsx), index)

    lawd_path = out / "lawd-resolver.jsonl"
    kapt_path = out / "kapt-complex-universe.jsonl"
    write_jsonl(lawd_path, lawd_rows, LAWD_FIELDS)
    write_jsonl(kapt_path, kapt_rows, KAPT_FIELDS)

    key_counts = Counter(row["source_key"] for row in kapt_rows)
    active_sido = sorted({row["sido_name"] for row in lawd_rows if row["status"] == "active" and row["sido_name"]})
    quality = Counter(row["quality"] for row in kapt_rows)
    summary = {
        "lawd_rows": len(lawd_rows),
        "lawd_active": sum(1 for row in lawd_rows if row["status"] == "active"),
        "lawd_inactive": sum(1 for row in lawd_rows if row["status"] == "inactive"),
        "lawd_parent_gaps": parent_gaps(lawd_rows),
        "lawd_active_sido": active_sido,
        "kapt_rows": len(kapt_rows),
        "kapt_quality": dict(quality),
        "kapt_unique_keys": len(key_counts),
        "duplicate_source_keys": sum(1 for count in key_counts.values() if count > 1),
        "kapt_lawd_resolved": sum(1 for row in kapt_rows if row["lawd_resolved"]),
        "by_sido": sido_coverage(kapt_rows),
        "lawd_sha256": sha256_file(lawd_path),
        "kapt_sha256": sha256_file(kapt_path),
        "lawd_source_sha256": sha256_file(Path(args.lawd_zip)),
        "kapt_source_sha256": sha256_file(Path(args.kapt_xlsx)),
    }
    links = production_link_check(args.production_links, kapt_rows)
    write_manifest(out / "national-source-manifest.json", summary, links)
    print(json.dumps({k: summary[k] for k in summary if k != "by_sido"}, ensure_ascii=False))
    print("compatible", links.get("compatible"))


if __name__ == "__main__":
    main()
