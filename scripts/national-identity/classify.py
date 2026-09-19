"""KAPT row quality. Exclusive, no fuzzy apt-name merge."""

from __future__ import annotations

import re

KAPT_CODE_RE = re.compile(r"^A\d{8}$")

# INVALID > DUPLICATE_SOURCE_KEY > ADDRESS_INCOMPLETE > REGION_UNRESOLVED > READY
QUALITY_PRIORITY = (
    "INVALID",
    "DUPLICATE_SOURCE_KEY",
    "ADDRESS_INCOMPLETE",
    "REGION_UNRESOLVED",
    "READY",
)


def normalize_apt_name(name: str) -> str:
    """Same rule as src/lib/db/repository.ts normalizeAptName. Not a match key."""
    return re.sub(r"\s+", "", name).lower()


def address_complete(apt_name: str, road_address: str, parcel_address: str) -> bool:
    if not apt_name.strip():
        return False
    return bool(road_address.strip() or parcel_address.strip())


def parcel_sido_contradicts(parcel_address: str, resolved_sido: str, sido_names: list[str]) -> bool:
    """True only when the parcel address names a different active sido.

    K-apt parcel text often drops the 시 syllable inside a compound district
    (수원장안구). That is not a contradiction. A leading active sido name that
    is not the resolved sido is.
    """
    if not parcel_address.strip() or not resolved_sido:
        return False
    parcel = re.sub(r"\s+", " ", parcel_address).strip()
    matches = [name for name in sido_names if name and parcel.startswith(name)]
    if not matches:
        return False
    return max(matches, key=len) != resolved_sido


def classify_quality(
    *,
    kapt_code: str,
    duplicate: bool,
    name_address_ok: bool,
    lawd_resolved: bool,
) -> str:
    if not KAPT_CODE_RE.fullmatch(kapt_code or ""):
        return "INVALID"
    if duplicate:
        return "DUPLICATE_SOURCE_KEY"
    if not name_address_ok:
        return "ADDRESS_INCOMPLETE"
    if not lawd_resolved:
        return "REGION_UNRESOLVED"
    return "READY"
