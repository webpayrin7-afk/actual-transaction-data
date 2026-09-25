import csv, json, zipfile
raw = zipfile.ZipFile(r"C:\data\bubjung\LSCT_LAWDCD.zip").read("LSCT_LAWDCD.csv")
rows = list(csv.DictReader(raw.decode("cp949").splitlines()))
want = {"소사본동", "괴안동", "고강동", "반송동", "상리", "산척동", "원종동", "목동"}
out = []
for r in rows:
    umd = (r.get("UMD_NM") or "").strip()
    ri = (r.get("RI_NM") or "").strip()
    sgg = (r.get("SGG_NM") or "").strip()
    sido = (r.get("SIDO_NM") or "").strip()
    if umd in want and ("부천" in sgg or "화성" in sgg or "부천" in sido or "화성" in sido):
        out.append({
            "cd": r["LAWD_CD"],
            "sgg": sgg,
            "umd": umd,
            "ri": ri,
            "cre": r.get("CRE_DT") or "",
            "del": r.get("DEL_DT") or "",
        })
Path = __import__("pathlib").Path
Path("data/admin-codes/bucheon-hwaseong-sample.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("n", len(out))
