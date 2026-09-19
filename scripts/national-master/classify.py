"""Classify KAPT universe rows against the existing master. No fuzzy match."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

from identity import CAPITAL_SIDO_NAMES, KAPT_CODE_RE, complex_id, is_capital

# Outside Seoul/Gyeonggi. Thresholds are fixed before looking at names.
MIN_NEW_SAFE = 100
MAX_AMBIGUOUS_RATIO = 0.02
MAX_UNRESOLVED_RATIO = 0.01
MIN_DETERMINISTIC_RATE = 0.95
MAX_WAVE_SIDO = 3

CADASTRAL_SIDO = frozenset(
    {
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
    }
)


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def active_sigungu(lawd_rows: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in lawd_rows:
        if row.get("status") != "active" or row.get("level") != "sigungu":
            continue
        code = row.get("sigungu_code") or ""
        if code:
            out[code] = row
    return out


def active_legal(lawd_rows: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in lawd_rows:
        if row.get("status") != "active":
            continue
        code = row.get("full_legal_code") or ""
        if code:
            out[code] = row
    return out


def classify_universe(
    universe: list[dict],
    master_rows: list[dict],
    kapt_links: list[dict],
    sigungu_index: dict[str, dict],
    legal_index: dict[str, dict],
) -> list[dict]:
    by_identity: dict[tuple[str, str], list[dict]] = defaultdict(list)
    by_id: dict[str, dict] = {}
    for row in master_rows:
        key = (str(row["lawd_cd"]), str(row["apt_name_norm"]))
        by_identity[key].append(row)
        by_id[str(row["complex_id"])] = row
    link_by_key = {str(row["source_key"]): str(row["complex_id"]) for row in kapt_links}
    key_counts = Counter(str(row.get("source_key") or "") for row in universe)

    staged: list[dict] = []
    for row in universe:
        source_key = str(row.get("source_key") or "")
        lawd = str(row.get("lawd_cd") or "")
        norm = str(row.get("apt_name_norm") or "")
        sido = str(row.get("sido") or "")
        base = {
            "source_key": source_key,
            "kapt_code": source_key,
            "apt_name": row.get("apt_name") or "",
            "apt_name_norm": norm,
            "sido": sido,
            "sigungu": row.get("sigungu") or "",
            "lawd_cd": lawd,
            "full_legal_code": row.get("full_legal_code") or "",
            "road_address": row.get("road_address") or "",
            "source_version": row.get("source_version") or "",
            "quality_in": row.get("quality") or "",
            "match_class": "",
            "complex_id": "",
            "sido_code": lawd[:2] if len(lawd) >= 2 else "",
        }
        if not source_key or key_counts[source_key] > 1 or row.get("quality") == "DUPLICATE_SOURCE_KEY":
            base["match_class"] = "DUPLICATE_SOURCE_KEY"
            staged.append(base)
            continue
        if row.get("quality") == "REGION_UNRESOLVED" or not row.get("lawd_resolved") or not lawd:
            base["match_class"] = "REGION_UNRESOLVED"
            staged.append(base)
            continue
        if not KAPT_CODE_RE.fullmatch(source_key):
            base["match_class"] = "REGION_UNRESOLVED"
            staged.append(base)
            continue

        linked = link_by_key.get(source_key)
        if linked:
            master = by_id.get(linked)
            if master is None:
                base["match_class"] = "AMBIGUOUS"
            else:
                base["match_class"] = "EXISTING_EXACT"
                base["complex_id"] = linked
                base["sido_code"] = str(master.get("sido_code") or base["sido_code"])
                base["sido"] = str(master.get("sido") or sido)
            staged.append(base)
            continue

        hits = by_identity.get((lawd, norm), [])
        if len(hits) > 1:
            base["match_class"] = "AMBIGUOUS"
            staged.append(base)
            continue
        if len(hits) == 1:
            base["match_class"] = "EXISTING_EXACT"
            base["complex_id"] = str(hits[0]["complex_id"])
            base["sido_code"] = str(hits[0].get("sido_code") or base["sido_code"])
            base["sido"] = str(hits[0].get("sido") or sido)
            staged.append(base)
            continue

        if is_capital(base["sido_code"], sido):
            base["match_class"] = "NO_MATCH"
            staged.append(base)
            continue
        legal = legal_index.get(base["full_legal_code"])
        sigungu = sigungu_index.get(lawd)
        if legal is None or sigungu is None or legal.get("status") != "active":
            base["match_class"] = "REGION_UNRESOLVED"
            staged.append(base)
            continue
        if str(legal.get("sigungu_code") or "") != lawd:
            base["match_class"] = "AMBIGUOUS"
            staged.append(base)
            continue
        if not norm or not str(row.get("apt_name") or "").strip():
            base["match_class"] = "AMBIGUOUS"
            staged.append(base)
            continue
        base["match_class"] = "NEW_PENDING"
        base["complex_id"] = complex_id(lawd, norm)
        base["sido_code"] = str(sigungu.get("sido_code") or base["sido_code"])
        base["sido"] = str(sigungu.get("sido_name") or sido)
        base["sigungu_official"] = sigungu.get("sigungu_name") or ""
        base["legal_dong_name"] = legal.get("bjdong_name") or ""
        base["bjdong_cd"] = legal.get("bjdong_code") or ""
        staged.append(base)

    id_groups: dict[str, list[dict]] = defaultdict(list)
    for row in staged:
        if row["match_class"] == "NEW_PENDING":
            id_groups[row["complex_id"]].append(row)
    existing_ids = set(by_id)
    for group in id_groups.values():
        if len(group) != 1 or group[0]["complex_id"] in existing_ids:
            for row in group:
                row["match_class"] = "AMBIGUOUS"
                row["complex_id"] = ""
        else:
            group[0]["match_class"] = "NEW_SAFE"
    return staged


def sido_report(rows: list[dict]) -> list[dict]:
    bucket: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        key = row["sido"] or "(blank)"
        bucket[key]["kapt_rows"] += 1
        kind = row["match_class"]
        bucket[key][kind] += 1
        if row["quality_in"] == "READY":
            bucket[key]["ready"] += 1
    out = []
    for sido, counts in sorted(bucket.items(), key=lambda item: (-item[1]["kapt_rows"], item[0])):
        ready = counts["ready"]
        new_safe = counts["NEW_SAFE"]
        ambiguous = counts["AMBIGUOUS"]
        unresolved = counts["REGION_UNRESOLVED"]
        existing = counts["EXISTING_EXACT"]
        deterministic = existing + new_safe
        out.append(
            {
                "sido": sido,
                "kapt_rows": counts["kapt_rows"],
                "ready": ready,
                "EXISTING_EXACT": existing,
                "NEW_SAFE": new_safe,
                "AMBIGUOUS": ambiguous,
                "DUPLICATE_SOURCE_KEY": counts["DUPLICATE_SOURCE_KEY"],
                "REGION_UNRESOLVED": unresolved,
                "NO_MATCH": counts["NO_MATCH"],
                "deterministic_rate": round(deterministic / ready, 6) if ready else 0,
                "ambiguous_ratio": round(ambiguous / ready, 6) if ready else 0,
                "unresolved_ratio": round(unresolved / counts["kapt_rows"], 6) if counts["kapt_rows"] else 0,
            }
        )
    return out


def select_wave(sido_rows: list[dict]) -> tuple[list[dict], list[dict]]:
    eligible = []
    rejected = []
    for row in sido_rows:
        if row["sido"] in CAPITAL_SIDO_NAMES or row["sido"] == "(blank)":
            rejected.append({**row, "reason": "capital_or_blank"})
            continue
        reasons = []
        if row["NEW_SAFE"] < MIN_NEW_SAFE:
            reasons.append("new_safe_below_min")
        if row["ambiguous_ratio"] > MAX_AMBIGUOUS_RATIO:
            reasons.append("ambiguous_ratio")
        if row["unresolved_ratio"] > MAX_UNRESOLVED_RATIO:
            reasons.append("unresolved_ratio")
        if row["ready"] and row["deterministic_rate"] < MIN_DETERMINISTIC_RATE:
            reasons.append("deterministic_rate")
        if reasons:
            rejected.append({**row, "reason": ",".join(reasons)})
            continue
        eligible.append(row)
    eligible.sort(
        key=lambda row: (
            -row["NEW_SAFE"],
            -row["deterministic_rate"],
            row["ambiguous_ratio"] + row["unresolved_ratio"],
            row["sido"],
        )
    )
    return eligible[:MAX_WAVE_SIDO], eligible[MAX_WAVE_SIDO:] + rejected
