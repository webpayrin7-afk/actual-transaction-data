"""How many G2 10-digit codes are abolished in LSCT_LAWDCD."""
import csv
import json
import zipfile
from collections import Counter
from pathlib import Path

raw = zipfile.ZipFile(r"C:\data\bubjung\LSCT_LAWDCD.zip").read("LSCT_LAWDCD.csv")
rows = list(csv.DictReader(raw.decode("cp949").splitlines()))
by = {r["LAWD_CD"].strip(): r for r in rows}
status = Counter()
samples = []
for line in Path("data/poc/supply/g2-pnu.jsonl").read_text(encoding="utf-8").splitlines():
    row = json.loads(line)
    rec = by.get(row["code10"])
    if rec is None:
        kind = "MISSING"
    elif (rec.get("DEL_DT") or "").strip():
        kind = "ABOLISHED"
    else:
        kind = "LIVE"
    status[kind] += 1
    if kind != "LIVE" and len(samples) < 12:
        samples.append(
            {
                "code": row["code10"],
                "kind": kind,
                "name": row["aptName"],
                "sigungu": row["sigungu"],
                "dong": row["dong"],
                "del": "" if rec is None else rec.get("DEL_DT", ""),
                "sgg": "" if rec is None else rec.get("SGG_NM", ""),
                "umd": "" if rec is None else rec.get("UMD_NM", ""),
            }
        )
Path("data/admin-codes/g2-code-liveness.json").write_text(
    json.dumps({"status": status, "samples": samples}, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
print(json.dumps(status))
