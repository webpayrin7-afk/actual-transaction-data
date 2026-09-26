r"""
전국도시철도역사정보표준데이터 XLSX → JSON (표준 라이브러리만).
사용: python scripts/rail/xlsx-to-json.py C:\data\rail\전체_도시철도역사정보_20260630.xlsx out.json
첫 시트 첫 행을 머리글로 읽고, 값은 원문 그대로 옮긴다 (가공 없음).
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
T = "{%s}t" % NS["m"]


def main(src: str, dst: str) -> None:
    z = zipfile.ZipFile(src)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(T)))
    sheet = sorted(
        (n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", n)),
        key=lambda n: int(re.findall(r"\d+", n)[0]),
    )[0]
    rows = []
    for r in ET.fromstring(z.read(sheet)).find("m:sheetData", NS).findall("m:row", NS):
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
    out = [{header[k]: row.get(k) for k in header} for row in rows[1:] if any(row.values())]
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"rows={len(out)} cols={list(header.values())}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
