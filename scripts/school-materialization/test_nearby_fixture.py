"""Fixture parity for nearby grid search and NULL school_code annotation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nearby_index import (  # noqa: E402
    NULL_SCHOOL_CODE_REASON,
    SchoolGrid,
    annotate_nearby_db_candidate,
    nearest_linear,
)

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    origin_lat, origin_lng = 37.55, 127.02
    schools = [
        {"name": "near-a", "lat": 37.552, "lng": 127.021, "level": "elementary"},
        {"name": "near-b", "lat": 37.552, "lng": 127.021, "level": "elementary"},
        {"name": "edge", "lat": 37.5625, "lng": 127.02, "level": "elementary"},
        {"name": "far", "lat": 37.70, "lng": 127.20, "level": "elementary"},
        {"name": "west", "lat": 37.548, "lng": 126.998, "level": "elementary"},
    ]
    linear = nearest_linear(schools, origin_lat, origin_lng)
    grid = SchoolGrid(schools).nearest(origin_lat, origin_lng)
    assert linear == grid, (linear, grid)
    assert [row["name"] for row in linear] == ["near-a", "near-b", "edge"]
    assert all("far" != row["name"] for row in linear)
    again = SchoolGrid(schools).nearest(origin_lat, origin_lng)
    assert again == grid

    kept = annotate_nearby_db_candidate(
        {"school_name": "서울잠신초등학교", "school_code": None, "distance_m": 567.0}
    )
    assert kept["school_name"] == "서울잠신초등학교"
    assert kept["db_candidate"] is False
    assert kept["unresolved_reason"] == NULL_SCHOOL_CODE_REASON
    assert kept["school_code"] is None

    coded = annotate_nearby_db_candidate({"school_name": "서울잠일초등학교", "school_code": "7130153"})
    assert coded["db_candidate"] is True
    assert coded["unresolved_reason"] is None

    sample = json.loads(
        (ROOT / "data/poc/school-materialization/school-materialization-sample.json").read_text(
            encoding="utf-8"
        )
    )
    proc = subprocess.run(
        ["npx", "tsx", "scripts/school-materialization/chunk_cursor.ts"],
        input=json.dumps({"command": "annotate-nearby", "rows": sample["jamsil_nearby_top"]}),
        text=True,
        capture_output=True,
        cwd=str(ROOT),
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    remote = json.loads(proc.stdout)["rows"]
    local = [annotate_nearby_db_candidate(row) for row in sample["jamsil_nearby_top"]]
    assert remote == local
    assert any(row["db_candidate"] is False and row["school_name"] for row in local)
    print(json.dumps({"ok": True, "nearby": len(linear), "null_kept": sum(1 for row in local if not row["db_candidate"])}))


if __name__ == "__main__":
    main()
