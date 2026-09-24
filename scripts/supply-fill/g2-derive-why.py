"""Why G2 parcels did not derive a supply. Counts only, no writes."""
import json
from collections import Counter
from pathlib import Path

wanted = set()
for line in Path("data/poc/supply/g2-pnu-cadastre.jsonl").read_text(encoding="utf-8").splitlines():
    if not line:
        continue
    row = json.loads(line)
    if row.get("cadastre") == "EXISTS" and row.get("pnu"):
        wanted.add(row["pnu"])

purps = Counter()
pnus_apt = set()
pnus_apt_identity = set()
pnus_any = set()
for line in Path("data/poc/supply/g2-expos.jsonl").open(encoding="utf-8"):
    if not line.strip():
        continue
    row = json.loads(line)
    if row["pnu"] not in wanted:
        continue
    pnus_any.add(row["pnu"])
    code = row.get("mainPurpsCd") or ""
    if row.get("exposCd") == "1":
        purps[code] += 1
    if code == "02001" and row.get("exposCd") == "1":
        pnus_apt.add(row["pnu"])
        if row.get("dongNm") and row.get("hoNm"):
            pnus_apt_identity.add(row["pnu"])

out = {
    "cadastrePnus": len(wanted),
    "pnusWithRows": len(pnus_any),
    "pnusWithAptExclusive": len(pnus_apt),
    "pnusWithAptExclusiveAndDongHo": len(pnus_apt_identity),
    "exclusivePurpsTop": purps.most_common(8),
}
Path("data/poc/supply/g2-derive-why.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(out, ensure_ascii=False))
