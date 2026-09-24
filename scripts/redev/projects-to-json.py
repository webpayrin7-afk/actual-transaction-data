r"""
서울시 정비사업 추진현황 XLSX(머리글 4줄, 3줄 병합) → redev_projects 적재용 JSON. 표준 라이브러리만. DB 쓰기 없음.

  python scripts/redev/projects-to-json.py "C:/data/redev/★(26년 6월기준) 서울시 정비사업 추진현황.xlsx" C:/data/redev/out/projects.json

열 위치는 원천 머리글을 확인한 뒤 고정 매핑(머리글이 다르면 중단). 날짜 열은 엑셀 일련번호 → YYYY-MM-DD,
'-'(해당 없음)는 NULL, 그 밖에 일련번호가 아닌 값은 원문 그대로 두고 건수를 센다. 나머지 값은 원문(앞뒤 공백만 제거).
"""
import datetime
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
T = "{%s}t" % NS["m"]

# 열 → (필드, 머리글 확인 문자열, 종류)
COLS = {
    "A": ("code", "CODE", "text"),
    "C": ("gu", "자치구", "text"),
    "D": ("zone_name", "구역명", "text"),
    "E": ("addr_jibun", "위치1(지번주소)", "text"),
    "F": ("addr_road", "위치2(도로명주소)", "text"),
    "G": ("public_private", "공공/민간", "text"),
    "H": ("district_type", "일반/재촉지구", "text"),
    "I": ("project_type", "사업유형", "text"),
    "J": ("stage", "사업추진단계", "text"),
    "K": ("households_before", "기존 가구수", "int"),
    "L": ("zone_designated_first", "구역지정|최초", "date"),
    "M": ("zone_designated_last", "구역지정|변경(최종)", "date"),
    "N": ("committee_approved", "추진위원회", "date"),
    "O": ("association_approved", "조합설립인가", "date"),
    "P": ("building_review", "건축심의", "date"),
    "Q": ("project_approved_first", "사업시행인가|최초", "date"),
    "R": ("project_approved_last", "사업시행인가|변경(최종)", "date"),
    "S": ("disposal_approved_first", "관리처분|최초", "date"),
    "T": ("disposal_approved_last", "관리처분|변경(최종)", "date"),
    "U": ("relocation_start", "이주|이주시작일", "date"),
    "V": ("relocation_end", "이주|이주종료일", "date"),
    "W": ("construction_start", "착공", "date"),
    "X": ("households_total", "총합계", "int"),
    "Y": ("households_sale", "분양", "int"),
    "Z": ("households_rent", "임대", "int"),
}
HEADER_ROWS = 4


def read_sheet(path):
    z = zipfile.ZipFile(path)
    shared = ["".join(t.text or "" for t in si.iter(T)) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = {}
    for r in root.find("m:sheetData", NS).findall("m:row", NS):
        vals = {}
        for c in r.findall("m:c", NS):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", NS)
            if v is None:
                inline = c.find("m:is", NS)
                vals[col] = "".join(t.text or "" for t in inline.iter(T)) if inline is not None else None
            else:
                vals[col] = shared[int(v.text)] if c.get("t") == "s" else v.text
        rows[int(r.get("r"))] = vals
    merges = [m.get("ref") for m in root.find("m:mergeCells", NS).findall("m:mergeCell", NS)]
    return rows, merges


def header_text(rows, merges, col):
    """병합을 풀어 한 열의 머리글 1~4행을 '|'로 잇는다(같은 글자는 한 번)."""
    def owner(c, r):
        for ref in merges:
            a, b = ref.split(":")
            ca, ra = re.match(r"([A-Z]+)(\d+)", a).groups()
            cb, rb = re.match(r"([A-Z]+)(\d+)", b).groups()
            if ca <= c <= cb and int(ra) <= r <= int(rb) and len(c) == len(ca):
                return ca, int(ra)
        return c, r

    parts = []
    for r in range(1, HEADER_ROWS + 1):
        oc, orow = owner(col, r)
        t = (rows.get(orow, {}).get(oc) or "").replace("\n", "").strip()
        if t and t not in parts:
            parts.append(t)
    return "|".join(parts)


def serial_to_date(s):
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(s))).isoformat()


def main(src, dst):
    rows, merges = read_sheet(src)
    for col, (_, want, _) in COLS.items():
        got = header_text(rows, merges, col)
        assert all(w in got for w in want.split("|")), (col, want, got)

    stats = Counter()
    out = []
    for n in sorted(k for k in rows if k > HEADER_ROWS):
        raw = rows[n]
        if not any((v or "").strip() for v in raw.values()):
            continue
        rec = {}
        for col, (field, _, kind) in COLS.items():
            v = (raw.get(col) or "").strip() or None
            if v is not None and kind == "date":
                if re.fullmatch(r"\d{5}(\.0+)?", v):
                    v = serial_to_date(float(v))
                elif v == "-":
                    stats[f"date_dash_as_null:{field}"] += 1
                    v = None
                else:
                    stats[f"date_not_serial:{field}"] += 1
            elif v is not None and kind == "int":
                if re.fullmatch(r"-?\d+(\.0+)?", v):
                    v = int(float(v))
                else:
                    stats[f"int_not_number:{field}"] += 1
            rec[field] = v
        if not rec["code"]:
            stats["no_code_skipped"] += 1
            continue
        out.append(rec)

    codes = Counter(r["code"] for r in out)
    dup = {c: k for c, k in codes.items() if k > 1}
    assert not dup, dup
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print(json.dumps({"rows": len(out), **stats}, ensure_ascii=False, indent=2))
    for k, v in Counter(r["stage"] for r in out).most_common():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
