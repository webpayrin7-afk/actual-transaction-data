"""Stream the official K-apt 단지 기본정보 xlsx (inline strings, sparse cells)."""

from __future__ import annotations

import zipfile
from xml.etree.ElementTree import iterparse

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# Row 2 header of the 2026-09-18 official workbook.
COLUMNS = {
    "A": "sido",
    "B": "sigungu",
    "C": "eupmyeon",
    "D": "dongri",
    "E": "kapt_code",
    "F": "apt_name",
    "H": "parcel_address",
    "J": "road_address",
}


def iter_kapt_rows(path: str):
    with zipfile.ZipFile(path) as zf, zf.open("xl/worksheets/sheet1.xml") as handle:
        for _event, elem in iterparse(handle, events=("end",)):
            if elem.tag != NS + "row":
                continue
            row_no = int(elem.get("r") or 0)
            cells: dict[str, str] = {}
            for cell in list(elem):
                if cell.tag != NS + "c":
                    continue
                ref = cell.get("r") or ""
                col = "".join(ch for ch in ref if ch.isalpha())
                if col not in COLUMNS:
                    continue
                text = ""
                for node in cell.iter(NS + "t"):
                    text = node.text or ""
                    break
                cells[COLUMNS[col]] = text.strip()
            elem.clear()
            if row_no < 3:
                continue
            yield cells
