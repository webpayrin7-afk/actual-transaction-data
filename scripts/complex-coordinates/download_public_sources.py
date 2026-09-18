#!/usr/bin/env python3
"""Download official public-source files used by coordinate dry-run (no geocode).

Writes under COORD_SOURCE_CACHE (default /tmp/coord-source).
Does not write Production DB.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

CACHE = Path(os.environ.get("COORD_SOURCE_CACHE", "/tmp/coord-source"))
DL = CACHE / "downloads"
DL.mkdir(parents=True, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (compatible; jip-lab-coord-source/1.0)"}

DATASETS = [
    # REB complex identity (PNU) — nationwide CSV, we filter Seoul locally
    {"id": "15106861", "label": "reb_complex_basic"},
    # Gu-level apartment status with coordinates (partial coverage)
    {"id": "15055494", "label": "seodaemun_apt"},
    {"id": "15028125", "label": "dobong_apt_2018"},
]


def download_filedata(dataset_id: str) -> Path:
    page_url = f"https://www.data.go.kr/data/{dataset_id}/fileData.do"
    html = urllib.request.urlopen(
        urllib.request.Request(page_url, headers=UA), timeout=90
    ).read().decode("utf-8", "replace")
    files = list(dict.fromkeys(re.findall(r"atchFileId=(FILE_[0-9]+)", html)))
    if not files:
        raise RuntimeError(f"no FILE id for {dataset_id}")
    fid = files[0]
    url = (
        "https://www.data.go.kr/cmm/cmm/fileDownload.do?"
        + urllib.parse.urlencode({"atchFileId": fid, "fileDetailSn": "1"})
    )
    req = urllib.request.Request(url, headers={**UA, "Referer": page_url})
    data = urllib.request.urlopen(req, timeout=300).read()
    out = DL / f"{dataset_id}.bin"
    out.write_bytes(data)
    # decode csv if text
    text = None
    for enc in ("utf-8-sig", "cp949", "utf-8"):
        try:
            text = data.decode(enc)
            break
        except Exception:
            continue
    if text and ("," in text.splitlines()[0] if text.splitlines() else False):
        (DL / f"{dataset_id}.csv").write_text(text)
    meta = {
        "id": dataset_id,
        "file_id": fid,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    (DL / f"{dataset_id}.meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta))
    return out


def filter_reb_seoul(src_bin: Path) -> None:
    raw = src_bin.read_bytes()
    text = None
    for enc in ("utf-8-sig", "cp949", "utf-8"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if not text:
        raise RuntimeError("cannot decode REB csv")
    rows = list(csv.DictReader(text.splitlines()))
    seoul = [r for r in rows if (r.get("주소") or "").startswith("서울")]
    out = CACHE / "reb-seoul-basic.csv"
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(seoul)
    print(json.dumps({"reb_seoul_rows": len(seoul), "path": str(out)}))


def fetch_openapt_sample() -> None:
    url = "http://openapi.seoul.go.kr:8088/sample/json/OpenAptInfo/1/5/"
    data = json.loads(urllib.request.urlopen(url, timeout=30).read())
    rows = data["OpenAptInfo"]["row"]
    (CACHE / "openaptinfo_sample5.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2)
    )
    print(json.dumps({"openapt_sample": len(rows)}))


def main() -> None:
    paths = {}
    for ds in DATASETS:
        paths[ds["id"]] = download_filedata(ds["id"])
    filter_reb_seoul(paths["15106861"])
    fetch_openapt_sample()


if __name__ == "__main__":
    main()
