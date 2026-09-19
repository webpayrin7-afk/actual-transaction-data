"""Guarded national coordinate apply. This module never writes Production.

Semantics stay PARCEL_REPRESENTATIVE_POINT. Building centers are not accepted.
Cadastral join is exact full PNU only. Source CRS is EPSG:5186, output is EPSG:4326.
"""

from __future__ import annotations

WRITE_ENABLED = False
SEMANTICS = "PARCEL_REPRESENTATIVE_POINT"
SOURCE_CRS = "EPSG:5186"
OUTPUT_CRS = "EPSG:4326"

# Loose guard bounds, not a geocoder and not a parcel lookup.
SIDO_BBOX = {
    "11": (37.42, 37.72, 126.76, 127.20),
    "12": (34.20, 35.55, 125.95, 127.90),
    "26": (34.85, 35.40, 128.70, 129.35),
    "27": (35.55, 36.05, 128.35, 128.80),
    "28": (37.00, 37.85, 126.05, 126.80),
    "30": (36.20, 36.50, 127.25, 127.55),
    "31": (35.30, 35.75, 129.00, 129.50),
    "36": (36.42, 36.75, 127.15, 127.40),
    "41": (36.85, 38.30, 126.35, 127.85),
    "43": (36.15, 37.25, 127.25, 128.75),
    "44": (35.95, 37.10, 126.05, 127.45),
    "47": (35.45, 37.25, 128.25, 129.60),
    "48": (34.55, 35.95, 127.55, 129.30),
    "50": (33.10, 33.60, 126.10, 126.98),
    "51": (37.00, 38.65, 127.05, 129.40),
    "52": (35.25, 36.15, 126.35, 127.90),
}


class CoordinateGuardError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def refuse_write(argv: list[str]) -> None:
    if WRITE_ENABLED or any(flag in argv for flag in ("--write", "--apply", "--production", "--commit")):
        raise CoordinateGuardError("WRITE_DISABLED")


def exact_pnu_hit(index: dict[str, list[tuple[float, float]]], pnu: str) -> tuple[float, float] | None:
    """One cadastral PNU must map to one representative point. No nearest guess."""
    points = index.get(pnu) or []
    unique = {(round(lat, 8), round(lng, 8)) for lat, lng in points}
    if len(unique) != 1:
        return None
    return next(iter(unique))


def parse_cadastral_pnu(raw: str) -> str | None:
    """Same cadastral key as the Seoul safe-payload parser: 19 digits, plat 1 or 2."""
    if not isinstance(raw, str) or len(raw) != 19 or not raw.isdigit():
        return None
    if raw[10] not in ("1", "2"):
        return None
    return raw


def in_sido_bbox(latitude: float, longitude: float, sido_code: str) -> bool:
    box = SIDO_BBOX.get(str(sido_code))
    if box is None:
        return False
    return box[0] <= latitude <= box[1] and box[2] <= longitude <= box[3]


def classify_exact_join(
    pnu: str,
    *,
    duplicate_pnu: bool,
    coordinate: tuple[str, str] | None,
    sido_code: str,
) -> str:
    """String-equality join classes. coordinate is present only after Core PNU == CSV pnu."""
    if duplicate_pnu:
        return "DUPLICATE_PNU"
    if coordinate is None:
        return "PNU_NOT_FOUND"
    if parse_cadastral_pnu(pnu) is None:
        return "INVALID_COORDINATE"
    longitude, latitude = parse_wgs84_pair(coordinate[0], coordinate[1])
    if longitude is None or latitude is None or not in_sido_bbox(latitude, longitude, sido_code):
        return "INVALID_COORDINATE"
    return "MATCHED_EXACT"


def parse_wgs84_pair(longitude_text: str, latitude_text: str) -> tuple[float | None, float | None]:
    """Reject blank, non-decimal, non-finite, and 0,0. Mirrors isValidWgs84."""
    longitude = _decimal(longitude_text)
    latitude = _decimal(latitude_text)
    if longitude is None or latitude is None:
        return None, None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None, None
    if latitude == 0 and longitude == 0:
        return None, None
    return longitude, latitude


def _decimal(text: str) -> float | None:
    if not isinstance(text, str):
        return None
    if not text or text[0] == "+" or "e" in text or "E" in text:
        return None
    if text.count(".") > 1 or text.count("-") > 1:
        return None
    body = text[1:] if text[0] == "-" else text
    if not body or body.startswith(".") or body.endswith("."):
        return None
    if not all(ch.isdigit() or ch == "." for ch in body):
        return None
    if body.count(".") > 1:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def validate_payload(rows: list[dict], *, expected: int, existing_coords: set[str]) -> None:
    if len(rows) != expected:
        raise CoordinateGuardError("EXPECTED_COUNT")
    ids = [row["complex_id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise CoordinateGuardError("DUPLICATE_COMPLEX_ID")
    for row in rows:
        if row.get("semantics") != SEMANTICS:
            raise CoordinateGuardError("SEMANTICS")
        if row.get("resolution_status") != "PNU_EXACT" or row.get("pnu") != row.get("expected_pnu"):
            raise CoordinateGuardError("PNU_MISMATCH")
        lat = row.get("latitude")
        lng = row.get("longitude")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            raise CoordinateGuardError("INVALID_COORDINATE")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
            raise CoordinateGuardError("INVALID_COORDINATE")
        box = SIDO_BBOX.get(str(row.get("sido_code")))
        if box is None or not (box[0] <= lat <= box[1] and box[2] <= lng <= box[3]):
            raise CoordinateGuardError("BBOX")
        if row["complex_id"] in existing_coords:
            raise CoordinateGuardError("EXISTING_COORDINATE")
