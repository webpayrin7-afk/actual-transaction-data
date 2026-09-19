"""Warehouse complex_id. Verified against production master, not a new scheme."""

from __future__ import annotations

import hashlib
import re

KAPT_CODE_RE = re.compile(r"^A\d{8}$")
CAPITAL_SIDO_CODES = frozenset({"11", "41"})
CAPITAL_SIDO_NAMES = frozenset({"서울특별시", "경기도"})


def complex_id(lawd_cd: str, apt_name_norm: str) -> str:
    """phase60 provisional_complex_id, reused by the phase61 bootstrap manifest.

    raw = molit:{lawd_cd}:{apt_name_norm}
    id = cx_ + sha1(raw)[:16]
    """
    raw = f"molit:{lawd_cd}:{apt_name_norm}"
    return "cx_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def is_capital(sido_code: str, sido_name: str) -> bool:
    return sido_code in CAPITAL_SIDO_CODES or sido_name in CAPITAL_SIDO_NAMES
