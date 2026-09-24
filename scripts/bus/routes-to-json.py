r"""
서울시 버스노선별 정류소정보 XLSX → JSON (표준 라이브러리만). DB 쓰기 없음.

  python scripts/bus/routes-to-json.py "C:/data/bus/서울시버스노선별정류소정보(20260902).xlsx" C:/data/bus/routes.json

첫 시트 첫 행을 머리글로 읽고 값은 원문 문자열 그대로(ARS_ID 앞자리 0 유지).
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
T = "{%s}t" % NS["m"]
WANT = ["ROUTE_ID", "노선명", "순번", "NODE_ID", "ARS_ID", "정류소명"]


def main(src: str, dst: str) -> None:
    z = zipfile.ZipFile(src)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(T)))
    rows = []
    for r in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).find("m:sheetData", NS).findall("m:row", NS):
        vals = {}
        for c in r.findall("m:c", NS):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", NS)
            if v is None:
                inline = c.find("m:is", NS)
                vals[col] = "".join(t.text or "" for t in inline.iter(T)) if inline is not None else None
            else:
                vals[col] = shared[int(v.text)] if c.get("t") == "s" else v.text
        rows.append(vals)
    header = rows[0]
    missing = [w for w in WANT if w not in header.values()]
    assert not missing, missing
    out = [{header[k]: row.get(k) for k in header} for row in rows[1:] if any(row.values())]
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"rows={len(out)} cols={list(header.values())}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
