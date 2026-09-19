"""Deterministic PNU from an already resolved legal code plus the parcel address.

Cadastral plat digit follows the Seoul parcel contract:
1 = 일반, 2 = 임야. The mountain flag is kept as its own field.
No fuzzy dong match, no apartment-name guess, no road-address lot.
"""

from __future__ import annotations

import re

RESOLVER_VERSION = "pnu-cadastral-v1"
PLAT_LAND = "1"
PLAT_MOUNTAIN = "2"

LOT_RE = re.compile(r"^(산\s*)?(\d+)(?:-(\d+))?(?:번지)?(?=\s|$)")


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def anchor_ends(address: str, anchor: str) -> list[int]:
    if not anchor:
        return []
    pattern = re.compile(rf"(?:(?<=^)|(?<=\s)){re.escape(anchor)}(?=\s|$)")
    return [match.end() for match in pattern.finditer(address)]


def parse_lot(rest: str) -> tuple[bool, str, str] | str | None:
    match = LOT_RE.match(rest)
    if not match:
        return None
    bun = int(match.group(2))
    ji = int(match.group(3) or "0")
    if bun > 9999 or ji > 9999 or bun == 0:
        return "invalid"
    return bool(match.group(1)), f"{bun:04d}", f"{ji:04d}"


def build_pnu(full_legal_code: str, mountain: bool, bun: str, ji: str) -> str | None:
    plat = PLAT_MOUNTAIN if mountain else PLAT_LAND
    pnu = f"{full_legal_code}{plat}{bun}{ji}"
    if not re.fullmatch(r"\d{19}", pnu):
        return None
    if pnu[10] not in (PLAT_LAND, PLAT_MOUNTAIN):
        return None
    if pnu[:10] != full_legal_code or int(bun) == 0:
        return None
    return pnu


def resolve_row(universe: dict, active: dict[str, dict]) -> dict:
    """Return one resolution record. PNU is set only for PNU_EXACT."""
    parcel = normalize_space(universe.get("parcel_address") or "")
    code = str(universe.get("full_legal_code") or "")
    anchor = normalize_space(universe.get("bjdong_name") or "")
    base = {
        "parcel_address": parcel,
        "lawd_code": str(universe.get("lawd_cd") or ""),
        "full_legal_code": code,
        "mountain_flag": None,
        "main_lot": None,
        "sub_lot": None,
        "pnu": None,
        "resolution_status": "LAWD_UNRESOLVED",
    }
    if not parcel:
        base["resolution_status"] = "NO_PARCEL_ADDRESS"
        return base
    legal = active.get(code)
    if not universe.get("lawd_resolved") or legal is None:
        return base
    leaf = str(legal.get("bjdong_name") or "")
    if (
        legal.get("sigungu_code") != universe.get("lawd_cd")
        or not anchor
        or anchor.split()[-1] != leaf
    ):
        base["resolution_status"] = "AMBIGUOUS_LAWD"
        return base
    ends = anchor_ends(parcel, anchor)
    if not ends:
        return base
    lots: list[tuple[bool, str, str]] = []
    saw_invalid = False
    for end in ends:
        parsed = parse_lot(parcel[end:].lstrip())
        if parsed == "invalid":
            saw_invalid = True
        elif parsed:
            lots.append(parsed)
    unique = set(lots)
    if len(unique) > 1:
        base["resolution_status"] = "LOT_PARSE_FAILED"
        return base
    if len(unique) == 0:
        base["resolution_status"] = "INVALID_PNU" if saw_invalid else "LOT_PARSE_FAILED"
        return base
    mountain, bun, ji = next(iter(unique))
    pnu = build_pnu(code, mountain, bun, ji)
    if pnu is None:
        base["resolution_status"] = "INVALID_PNU"
        return base
    base.update(
        {
            "mountain_flag": mountain,
            "main_lot": bun,
            "sub_lot": ji,
            "pnu": pnu,
            "resolution_status": "PNU_EXACT",
        }
    )
    return base
