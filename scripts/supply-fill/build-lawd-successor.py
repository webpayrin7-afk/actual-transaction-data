"""Build a 1:1 abolished→created legal-dong map from LSCT_LAWDCD.csv.

OLD_LAWDCD is the row's own code, not a successor. Pairing is:
  abolished row DEL_DT=D with created row CRE_DT=D,
  same sido, same city stem ("화성시" matches "화성시 만세구"),
  exact UMD_NM and RI_NM.
Only groups with exactly one abolished code and one created code are kept.
"""
from __future__ import annotations

import csv
import json
import zipfile
from collections import defaultdict
from pathlib import Path

SRC = Path(r"C:\data\bubjung\LSCT_LAWDCD.zip")
OUT_DIR = Path("data/admin-codes")
PAIRS = OUT_DIR / "lawd-successor.csv"
HOLDS = OUT_DIR / "lawd-successor-holds.csv"
SUMMARY = OUT_DIR / "lawd-successor-summary.json"


def city_stem(sgg: str) -> str:
    sgg = sgg.strip()
    if not sgg:
        return ""
    head = sgg.split()[0]
    if head.endswith("시") or head.endswith("군"):
        return head
    return sgg


def main() -> None:
    with zipfile.ZipFile(SRC) as zf:
        raw = zf.read("LSCT_LAWDCD.csv")
    text = raw.decode("cp949")
    rows = list(csv.DictReader(text.splitlines()))

    live = {r["LAWD_CD"] for r in rows if not (r.get("DEL_DT") or "").strip()}
    abolished_by: dict[tuple, list] = defaultdict(list)
    created_by: dict[tuple, list] = defaultdict(list)

    for row in rows:
        cre = (row.get("CRE_DT") or "").strip()
        deleted = (row.get("DEL_DT") or "").strip()
        umd = (row.get("UMD_NM") or "").strip()
        ri = (row.get("RI_NM") or "").strip()
        sido = (row.get("SIDO_NM") or "").strip()
        sgg = (row.get("SGG_NM") or "").strip()
        code = (row.get("LAWD_CD") or "").strip()
        if len(code) != 10 or not code.isdigit():
            continue
        if deleted:
            key = (deleted, sido, city_stem(sgg), umd, ri)
            abolished_by[key].append(row)
        if cre:
            key = (cre, sido, city_stem(sgg), umd, ri)
            created_by[key].append(row)

    pairs: list[dict] = []
    holds: list[dict] = []
    keys = set(abolished_by) | set(created_by)
    for key in sorted(keys):
        olds = abolished_by.get(key, [])
        news = created_by.get(key, [])
        # A code is not its own successor.
        old_codes = {r["LAWD_CD"].strip() for r in olds}
        new_rows = [r for r in news if r["LAWD_CD"].strip() not in old_codes]
        if len(olds) == 1 and len(new_rows) == 1:
            old = olds[0]
            new = new_rows[0]
            pairs.append(
                {
                    "old_lawd_cd": old["LAWD_CD"].strip(),
                    "new_lawd_cd": new["LAWD_CD"].strip(),
                    "change_date": key[0],
                    "sido_nm": key[1],
                    "city_stem": key[2],
                    "sgg_old": (old.get("SGG_NM") or "").strip(),
                    "sgg_new": (new.get("SGG_NM") or "").strip(),
                    "umd_nm": key[3],
                    "ri_nm": key[4],
                }
            )
            continue
        if not olds or not new_rows:
            continue
        holds.append(
            {
                "change_date": key[0],
                "sido_nm": key[1],
                "city_stem": key[2],
                "umd_nm": key[3],
                "ri_nm": key[4],
                "old_n": len(olds),
                "new_n": len(new_rows),
                "old_codes": "|".join(sorted(old_codes)),
                "new_codes": "|".join(sorted(r["LAWD_CD"].strip() for r in new_rows)),
                "reason": "SPLIT_OR_MERGE",
            }
        )

    direct = {p["old_lawd_cd"]: p["new_lawd_cd"] for p in pairs}
    # Unique 1:1 chain to a code that is still live. A branch or a dead end stays unresolved.
    resolved = 0
    unresolved = 0
    for pair in pairs:
        seen = {pair["old_lawd_cd"]}
        cur = pair["new_lawd_cd"]
        ok = True
        while cur in direct:
            if cur in seen:
                ok = False
                break
            seen.add(cur)
            cur = direct[cur]
        if ok and cur in live and cur != pair["old_lawd_cd"]:
            pair["resolved_lawd_cd"] = cur
            resolved += 1
        else:
            pair["resolved_lawd_cd"] = ""
            unresolved += 1

    regions = sorted({(p["sido_nm"], p["city_stem"], p["sgg_old"], p["sgg_new"]) for p in pairs})
    region_counts: dict[str, int] = defaultdict(int)
    for p in pairs:
        region_counts[f"{p['sido_nm']} {p['city_stem']} ({p['sgg_old']} → {p['sgg_new']})"] += 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fields = [
        "old_lawd_cd",
        "new_lawd_cd",
        "resolved_lawd_cd",
        "change_date",
        "sido_nm",
        "city_stem",
        "sgg_old",
        "sgg_new",
        "umd_nm",
        "ri_nm",
    ]
    with PAIRS.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(pairs)
    hold_fields = [
        "change_date",
        "sido_nm",
        "city_stem",
        "umd_nm",
        "ri_nm",
        "old_n",
        "new_n",
        "old_codes",
        "new_codes",
        "reason",
    ]
    with HOLDS.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=hold_fields)
        writer.writeheader()
        writer.writerows(holds)

    summary = {
        "rows": len(rows),
        "pairs_1to1": len(pairs),
        "pairs_resolved_to_live": resolved,
        "pairs_unresolved_chain": unresolved,
        "holds_split_or_merge": len(holds),
        "hold_old_codes": sum(h["old_n"] for h in holds),
        "regions": [
            {"label": label, "pairs": n}
            for label, n in sorted(region_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    }
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
