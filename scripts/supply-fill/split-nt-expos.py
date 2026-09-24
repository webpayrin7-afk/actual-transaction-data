"""Split nt-expos.jsonl by the target complex's sido prefix (DB code), so each fill run loads one sido."""
import json
from pathlib import Path

owner = {}
for line in Path("data/poc/supply/nt-pnu-cadastre.jsonl").read_text(encoding="utf-8").splitlines():
    if line:
        r = json.loads(line)
        for p in r.get("registryPnus") or []:
            owner[p] = r["lawdCd"][:2]
outs = {}
counts = {}
with open("data/poc/supply/nt-expos.jsonl", encoding="utf-8") as fh:
    for line in fh:
        pnu = line[9:28]  # {"pnu": "XXXXXXXXXXXXXXXXXXX"
        pre = owner.get(pnu)
        if pre is None:
            pnu = json.loads(line)["pnu"]
            pre = owner.get(pnu, "xx")
        if pre not in outs:
            outs[pre] = open(f"data/poc/supply/nt-expos-{pre}.jsonl", "w", encoding="utf-8")
        outs[pre].write(line)
        counts[pre] = counts.get(pre, 0) + 1
for f in outs.values():
    f.close()
print(json.dumps(counts))
