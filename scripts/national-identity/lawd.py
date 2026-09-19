"""Official 법정동 code table (code.go.kr 전체자료) → resolver rows."""

from __future__ import annotations

import zipfile
from collections import defaultdict

SOURCE_VERSION = "code.go.kr/etc/codeFullDown.do codeseId=법정동코드"
SOURCE_DATE = "2026-09-19"


def level_of(code: str) -> str:
    if len(code) != 10 or not code.isdigit():
        return "invalid"
    if code.endswith("00000000"):
        return "sido"
    if code.endswith("00000"):
        return "sigungu"
    if code.endswith("00"):
        return "emd"
    return "ri"


def load_lawd_rows(zip_path: str) -> list[dict]:
    with zipfile.ZipFile(zip_path) as zf:
        name = zf.namelist()[0]
        text = zf.read(name).decode("cp949")
    raw: list[tuple[str, str, str]] = []
    for i, line in enumerate(text.splitlines()):
        if i == 0 or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        code, full_name, flag = parts[0].strip(), parts[1].strip(), parts[2].strip()
        raw.append((code, full_name, flag))

    sido_name_by_code: dict[str, str] = {}
    for code, full_name, _flag in raw:
        if level_of(code) == "sido":
            sido_name_by_code[code[:2]] = full_name

    missing_sido = sorted({c[:2] for c, _, _ in raw if c[:2] not in sido_name_by_code})
    for prefix in missing_sido:
        names = [n for c, n, _ in raw if c.startswith(prefix)]
        if not names:
            continue
        head = names[0].split()[0]
        if all(n == head or n.startswith(head + " ") for n in names):
            sido_name_by_code[prefix] = head

    sigungu_name_by_code: dict[str, str] = {}
    rows: list[dict] = []
    for code, full_name, flag in raw:
        level = level_of(code)
        if level == "invalid":
            continue
        sido_code = code[:2]
        sido_name = sido_name_by_code.get(sido_code, "")
        rest = full_name[len(sido_name) :].strip() if full_name.startswith(sido_name) else full_name
        active = flag == "존재"
        sigungu_code = ""
        sigungu_name = ""
        bjdong_code = ""
        bjdong_name = ""
        if level == "sigungu":
            sigungu_code = code[:5]
            sigungu_name = rest or sido_name
            sigungu_name_by_code[sigungu_code] = sigungu_name
        elif level in ("emd", "ri"):
            sigungu_code = code[:5]
            sigungu_name = sigungu_name_by_code.get(sigungu_code, "")
            bjdong_code = code[5:]
            bjdong_name = rest.split()[-1] if rest else ""
        rows.append(
            {
                "full_legal_code": code,
                "sido_code": sido_code,
                "sido_name": sido_name,
                "sigungu_code": sigungu_code,
                "sigungu_name": sigungu_name,
                "bjdong_code": bjdong_code,
                "bjdong_name": bjdong_name,
                "level": level,
                "active": active,
                "status": "active" if active else "inactive",
                "full_name": full_name,
                "source_version": SOURCE_VERSION,
                "source_date": SOURCE_DATE,
            }
        )
    rows.sort(key=lambda r: r["full_legal_code"])
    # second pass: sigungu names for emd/ri that appeared before their parent
    by_sigungu = {
        r["sigungu_code"]: r["sigungu_name"]
        for r in rows
        if r["level"] == "sigungu" and r["sigungu_code"]
    }
    for row in rows:
        if row["level"] in ("emd", "ri") and not row["sigungu_name"]:
            row["sigungu_name"] = by_sigungu.get(row["sigungu_code"], "")
    return rows


def parent_gaps(rows: list[dict]) -> int:
    sigungu = {r["sigungu_code"] for r in rows if r["level"] == "sigungu"}
    emd = {r["full_legal_code"] for r in rows if r["level"] == "emd"}
    gaps = 0
    for row in rows:
        if row["level"] in ("emd", "ri") and row["sigungu_code"] not in sigungu:
            gaps += 1
        if row["level"] == "ri":
            parent = row["full_legal_code"][:8] + "00"
            if parent not in emd:
                gaps += 1
    return gaps


def sigungu_aliases(sigungu_name: str) -> set[str]:
    """Exact aliases only.

    K-apt stores 일반구 as 시 name with the 시 syllable and the space removed:
    수원시 장안구 → 수원장안구. The form is mechanical and must be unique.
    """
    aliases = {sigungu_name}
    parts = sigungu_name.split()
    if parts:
        aliases.add(parts[-1])
    if len(parts) == 2 and parts[0].endswith("시") and parts[1].endswith("구"):
        aliases.add(parts[0][:-1] + parts[1])
    aliases.discard("")
    return aliases


class ActiveLawdIndex:
    """Exact active-code lookup. No fuzzy name merge."""

    def __init__(self, rows: list[dict]):
        self.sido: dict[str, list[dict]] = defaultdict(list)
        self.sigungu_by_sido: dict[str, list[dict]] = defaultdict(list)
        self.emd: dict[tuple[str, str], list[dict]] = defaultdict(list)
        self.ri: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
        self.ri_by_leaf: dict[tuple[str, str], list[dict]] = defaultdict(list)
        emd_leaf: dict[str, str] = {}
        for row in rows:
            if row["status"] != "active":
                continue
            if row["level"] == "sido":
                self.sido[row["sido_name"]].append(row)
            elif row["level"] == "sigungu":
                self.sigungu_by_sido[row["sido_code"]].append(row)
            elif row["level"] == "emd":
                emd_leaf[row["full_legal_code"]] = row["bjdong_name"]
                self.emd[(row["sigungu_code"], row["bjdong_name"])].append(row)
        for row in rows:
            if row["status"] != "active" or row["level"] != "ri":
                continue
            parent = row["full_legal_code"][:8] + "00"
            emd_name = emd_leaf.get(parent, "")
            self.ri[(row["sigungu_code"], emd_name, row["bjdong_name"])].append(row)
            self.ri_by_leaf[(row["sigungu_code"], row["bjdong_name"])].append(row)
        # 세종 has no 3600000000 sido row. The active root is sigungu 36110.
        # Register that official sido_name only when no sido-level row exists.
        for sido_code, sigs in self.sigungu_by_sido.items():
            names = {row["sido_name"] for row in sigs if row["sido_name"]}
            if len(names) != 1:
                continue
            name = next(iter(names))
            if name in self.sido:
                continue
            self.sido[name].append(
                {
                    "sido_code": sido_code,
                    "sido_name": name,
                    "level": "sido",
                    "status": "active",
                    "full_legal_code": "",
                }
            )

    def resolve(self, sido: str, sigungu: str, eupmyeon: str, dongri: str) -> dict | None:
        sidos = self.sido.get(sido, [])
        if len(sidos) != 1:
            return None
        sigs = self.sigungu_by_sido.get(sidos[0]["sido_code"], [])
        if sigungu:
            matched = [s for s in sigs if sigungu in sigungu_aliases(s["sigungu_name"])]
        else:
            matched = sigs
        if len(matched) != 1:
            return None
        sigungu_code = matched[0]["sigungu_code"]
        if eupmyeon and dongri:
            cands = self.ri.get((sigungu_code, eupmyeon, dongri), [])
        elif dongri:
            emds = self.emd.get((sigungu_code, dongri), [])
            ris = self.ri_by_leaf.get((sigungu_code, dongri), [])
            if emds and ris:
                return None
            cands = emds or ris
        elif eupmyeon:
            cands = self.emd.get((sigungu_code, eupmyeon), [])
        else:
            return None
        if len(cands) != 1:
            return None
        return cands[0]
