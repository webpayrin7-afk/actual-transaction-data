"""Parcel relink helper: list the registry PNUs present in the phase-3 local caches (read-only).

Usage: python cache-pnus.py OUT.json CACHE.jsonl [CACHE.jsonl ...]
"""
import json
import sys

out = {}
for path in sys.argv[2:]:
    seen = set()
    with open(path, "rb") as fh:
        for line in fh:
            seen.add(line[9:28].decode("ascii", "replace"))
    out[path] = sorted(seen)
    print(json.dumps({"cache": path, "pnus": len(seen)}), flush=True)
json.dump(out, open(sys.argv[1], "w"))
