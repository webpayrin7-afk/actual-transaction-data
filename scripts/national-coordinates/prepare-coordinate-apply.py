"""Guarded entrypoint. Refuses every write flag before opening a database."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coordinate_apply import refuse_write


def main() -> int:
    try:
        refuse_write(sys.argv[1:])
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print('{"status":"READY","write_executed":false,"semantics":"PARCEL_REPRESENTATIVE_POINT"}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
