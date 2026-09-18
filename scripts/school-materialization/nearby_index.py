"""Nearby school search. Grid prefilter, exact haversine, same rank semantics.

Does not invent school codes and does not write a database.
"""

from __future__ import annotations

import math
from collections import defaultdict

NEARBY_MAX_M = 1500.0
NEARBY_STORE_CAP_PER_LEVEL = 24
NULL_SCHOOL_CODE_REASON = "SCHOOL_CODE_UNRESOLVED"
# ~1.1km. The query window is a conservative degree bbox around 1500m.
CELL_DEG = 0.01


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def annotate_nearby_db_candidate(row: dict) -> dict:
    """Keep the calculated nearby row. NULL code is not a DB candidate."""
    raw = row.get("school_code")
    code = raw.strip() if isinstance(raw, str) else ""
    out = dict(row)
    if not code:
        out["school_code"] = None
        out["db_candidate"] = False
        out["unresolved_reason"] = NULL_SCHOOL_CODE_REASON
    else:
        out["school_code"] = code
        out["db_candidate"] = True
        out["unresolved_reason"] = None
    return out


def _rank(scored: list[dict], cap: int) -> list[dict]:
    scored.sort(key=lambda row: (row["distance_m"], row["_ord"]))
    out = []
    for row in scored[:cap]:
        item = dict(row)
        item.pop("_ord", None)
        out.append(item)
    return out


def nearest_linear(
    schools: list[dict],
    lat: float,
    lng: float,
    max_m: float = NEARBY_MAX_M,
    cap: int = NEARBY_STORE_CAP_PER_LEVEL,
) -> list[dict]:
    scored = []
    for i, school in enumerate(schools):
        dist = haversine_m(lat, lng, school["lat"], school["lng"])
        if dist <= max_m:
            scored.append({**school, "distance_m": round(dist, 1), "_ord": i})
    return _rank(scored, cap)


class SchoolGrid:
    def __init__(
        self,
        schools: list[dict],
        max_m: float = NEARBY_MAX_M,
        cap: int = NEARBY_STORE_CAP_PER_LEVEL,
    ) -> None:
        self.max_m = max_m
        self.cap = cap
        self.buckets: dict[tuple[int, int], list[dict]] = defaultdict(list)
        for i, school in enumerate(schools):
            key = (math.floor(school["lat"] / CELL_DEG), math.floor(school["lng"] / CELL_DEG))
            self.buckets[key].append({**school, "_ord": i})

    def _window(self, lat: float, lng: float) -> tuple[float, float]:
        # Lower meters-per-degree than Seoul so the bbox cannot miss a 1500m hit.
        dlat = self.max_m / 110000.0
        cos = math.cos(math.radians(lat))
        meters_per_lng = 111320.0 * max(0.2, cos) * 0.85
        dlng = self.max_m / meters_per_lng
        return dlat, dlng

    def nearest(self, lat: float, lng: float) -> list[dict]:
        dlat, dlng = self._window(lat, lng)
        lat0 = math.floor((lat - dlat) / CELL_DEG)
        lat1 = math.floor((lat + dlat) / CELL_DEG)
        lng0 = math.floor((lng - dlng) / CELL_DEG)
        lng1 = math.floor((lng + dlng) / CELL_DEG)
        scored = []
        for i in range(lat0, lat1 + 1):
            for j in range(lng0, lng1 + 1):
                for school in self.buckets.get((i, j), ()):
                    dist = haversine_m(lat, lng, school["lat"], school["lng"])
                    if dist <= self.max_m:
                        scored.append({**school, "distance_m": round(dist, 1)})
        return _rank(scored, self.cap)
