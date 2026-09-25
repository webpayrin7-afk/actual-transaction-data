"""Parcel relink, step 5 (local files only): per-reason dry-run report and 20 samples.

Joins accept.jsonl with the fill plans (nt-plan-all-rows.jsonl, g2-plan-rows.jsonl).
Usage: python report.py WORK_DIR
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

WORK = Path(sys.argv[1])
acc = [json.loads(l) for l in (WORK / "accept.jsonl").read_text(encoding="utf-8").splitlines() if l]
nt_rows = {}
for l in (WORK / "nt-plan-all-rows.jsonl").read_text(encoding="utf-8").splitlines():
    if l:
        r = json.loads(l)
        nt_rows[r["complexId"]] = len(r["types"])
g2_rows = Counter()
for l in (WORK / "g2-plan-rows.jsonl").read_text(encoding="utf-8").splitlines():
    if l:
        g2_rows[json.loads(l)["complexId"]] += 1

by = defaultdict(lambda: Counter())
for r in acc:
    key = f"{r['kind']}|{r['reason']}"
    s = by[key]
    s["targets"] += 1
    if r["evals"]:
        s["candidate"] += 1
    if r["decision"] == "ACCEPTED":
        s["accepted"] += 1
        n = nt_rows.get(r["complexId"], 0) if r["kind"] == "nt" else g2_rows.get(r["complexId"], 0)
        if n:
            s["fillComplexes"] += 1
            s["fillTypes"] += n
    else:
        s["held:" + r["decision"]] += 1
report = {k: dict(v) for k, v in sorted(by.items())}

samples = []
filled = [r for r in acc if r["decision"] == "ACCEPTED" and (nt_rows.get(r["complexId"]) or g2_rows.get(r["complexId"]))]
filled.sort(key=lambda r: r["complexId"])
step = max(1, len(filled) // 20)
for r in filled[::step][:20]:
    e = r["chosen"]
    samples.append({
        "kind": r["kind"], "reason": r["reason"], "aptName": r["aptName"],
        "address": f"{r['sido']} {r['sigungu']} {r['roadAddress']}".strip(),
        "cadastrePnu": e["pnu"], "registryPnu": e["registryPnu"], "lot": e["lot"], "jimok": e["jimok"],
        "method": "+".join(e["methods"]), "parcelAptUnits": e["units"], "kaptHouseholds": r["kaptHouseholds"],
        "complexExclusives": [x / 100 for x in r["required"]], "parcelExclusives": [x / 100 for x in e["exclusives"]],
    })
(WORK / "dryrun-report.json").write_text(json.dumps({"byReason": report, "samples": samples}, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=1))
