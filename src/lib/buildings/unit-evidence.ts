/**
 * Header-first mapping for BuildingHUB 전유공용면적 / filtered unit-area bulk.
 * Never treat a 호별/전유부 PK as the 표제부 building PK.
 */

export const UNIT_PK_ALIASES = [
  "mgmbldrgstpk",
  "mgm_bldrgst_pk",
  "unit_register_pk",
  "unitpk",
  "expospubusepk",
  "hopk",
];

export const PARENT_BUILDING_PK_ALIASES = [
  "mgmupbldrgstpk",
  "mgm_up_bldrgst_pk",
  "upperbldrgstpk",
  "relatmgmbldrgstpk",
  "parent_mgm_bldrgst_pk",
  "title_mgm_bldrgst_pk",
  "bldmgmbldrgstpk",
  "mgmbldrgstpk_title",
  "parent_building_pk",
  "titlepk",
];

const COMPLEX_ALIASES = ["complex_id", "complexid", "cx_id"];
const PNU_ALIASES = ["pnu", "platpnu", "bldgpnu"];
const DONG_ALIASES = ["dongnm", "dong_nm", "dong", "dong_label", "donglabel"];
const HO_ALIASES = ["honm", "ho_nm", "ho"];
const FLOOR_ALIASES = ["flrno", "flr_no", "floor", "flrnonm", "flr_no_nm"];
const EXCLUSIVE_ALIASES = ["exclusive_area", "exposarea", "exclu_area"];
const AREA_ALIASES = ["area"];
const COMMON_ALIASES = ["residential_common_area", "res_common_area", "residentialcommonarea"];
const SUPPLY_ALIASES = ["supply_area", "supplyarea"];
const CATEGORY_ALIASES = [
  "expospubusegbcdnm",
  "expos_pubuse_gb_cd_nm",
  "expospubusegbcd",
  "area_category",
  "areacategory",
];
const USAGE_ALIASES = ["mainpurpscdnm", "main_purps_cd_nm", "main_usage", "mainusage"];
const ATCH_ALIASES = ["mainatchgbcdnm", "main_atch_gb_cd_nm", "mainatchgbcd"];
const ETC_ALIASES = ["etcpurps", "etc_purps"];
const SOURCE_ROW_ALIASES = ["source_key", "source_row_id", "rnum", "registserialno"];
const SOURCE_VERSION_ALIASES = ["source_version", "sourceversion", "crtnday", "crtn_day"];

export type ColumnMapping = {
  header: string[];
  index: Record<string, number>;
  complexId: string | null;
  pnu: string | null;
  unitPk: string | null;
  parentBuildingPk: string | null;
  dong: string | null;
  ho: string | null;
  floor: string | null;
  exclusiveArea: string | null;
  area: string | null;
  residentialCommon: string | null;
  supplyArea: string | null;
  areaCategory: string | null;
  mainUsage: string | null;
  mainAtch: string | null;
  etcPurps: string | null;
  sourceRow: string | null;
  sourceVersion: string | null;
  parentBuildingKeyPresent: boolean;
  unitPkWouldBeMistakenForTitle: boolean;
  flattenedExclusive: boolean;
};

function norm(name: string): string {
  return name.replace(/^\uFEFF/, "").trim().replace(/[^a-zA-Z0-9가-힣]/g, "").toLowerCase();
}

function pick(index: Record<string, number>, aliases: string[]): string | null {
  for (const alias of aliases) {
    if (alias in index) {
      const orig = Object.keys(index).find((k) => k === alias);
      return orig ?? alias;
    }
  }
  for (const alias of aliases) {
    const hit = Object.keys(index).find((k) => k === alias || k.replace(/_/g, "") === alias.replace(/_/g, ""));
    if (hit) return hit;
  }
  return null;
}

export function mapUnitEvidenceColumns(header: string[]): ColumnMapping {
  const index: Record<string, number> = {};
  const originalByNorm: Record<string, string> = {};
  header.forEach((col, i) => {
    const key = norm(col);
    if (!key) return;
    index[key] = i;
    originalByNorm[key] = col.trim();
  });
  const named = (aliases: string[]): string | null => {
    const n = pick(index, aliases.map(norm));
    return n ? originalByNorm[n] ?? n : null;
  };
  const unitPk = named(UNIT_PK_ALIASES);
  const parentBuildingPk = named(PARENT_BUILDING_PK_ALIASES.filter((a) => a !== "mgmbldrgstpk"));
  return {
    header,
    index,
    complexId: named(COMPLEX_ALIASES),
    pnu: named(PNU_ALIASES),
    unitPk,
    parentBuildingPk,
    dong: named(DONG_ALIASES),
    ho: named(HO_ALIASES),
    floor: named(FLOOR_ALIASES),
    exclusiveArea: named(EXCLUSIVE_ALIASES),
    area: named(AREA_ALIASES),
    residentialCommon: named(COMMON_ALIASES),
    supplyArea: named(SUPPLY_ALIASES),
    areaCategory: named(CATEGORY_ALIASES),
    mainUsage: named(USAGE_ALIASES),
    mainAtch: named(ATCH_ALIASES),
    etcPurps: named(ETC_ALIASES),
    sourceRow: named(SOURCE_ROW_ALIASES),
    sourceVersion: named(SOURCE_VERSION_ALIASES),
    parentBuildingKeyPresent: Boolean(parentBuildingPk),
    unitPkWouldBeMistakenForTitle: Boolean(unitPk) && !parentBuildingPk,
    flattenedExclusive: Boolean(named(EXCLUSIVE_ALIASES)),
  };
}

export type PhysicalUnitKey =
  | { kind: "unit_register"; key: string }
  | { kind: "complex_building_dong_floor_ho"; key: string }
  | { kind: "complex_dong_floor_ho"; key: string }
  | { kind: "missing"; key: "" };

export function physicalUnitKey(input: {
  unitRegisterPk?: string | null;
  complexId?: string | null;
  parentBuildingPk?: string | null;
  dong?: string | null;
  floor?: string | null;
  ho?: string | null;
}): PhysicalUnitKey {
  const unitPk = (input.unitRegisterPk ?? "").trim();
  if (/^\d{6,32}$/.test(unitPk)) return { kind: "unit_register", key: `unitpk:${unitPk}` };
  const complexId = (input.complexId ?? "").trim();
  const parent = (input.parentBuildingPk ?? "").trim();
  const dong = (input.dong ?? "").trim();
  const floor = (input.floor ?? "").trim();
  const ho = (input.ho ?? "").trim();
  if (complexId && parent && /^\d{6,32}$/.test(parent) && dong && ho) {
    return {
      kind: "complex_building_dong_floor_ho",
      key: `fb:${complexId}|${parent}|${dong}|${floor}|${ho}`,
    };
  }
  if (complexId && dong && ho) {
    return { kind: "complex_dong_floor_ho", key: `u:${complexId}|${dong}|${floor}|${ho}` };
  }
  return { kind: "missing", key: "" };
}

/** 공용 rows have their own register PK; join to 전유 only by complex+dong+ho. */
export function commonAreaJoinKey(input: {
  complexId?: string | null;
  dong?: string | null;
  floor?: string | null;
  ho?: string | null;
}): string {
  const complexId = (input.complexId ?? "").trim();
  const dong = (input.dong ?? "").trim();
  const floor = (input.floor ?? "").trim();
  const ho = (input.ho ?? "").trim();
  if (!complexId || !dong || !ho) return "";
  return `u:${complexId}|${dong}|${floor}|${ho}`;
}

const RES_COMMON_RE = /계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과/;

export function isExclusiveAreaRow(category: string, mainAtch: string): boolean {
  const cat = category.trim();
  const atch = mainAtch.trim();
  const exclusive = cat === "전유" || cat === "1" || cat.toLowerCase() === "exclusive";
  const main = !atch || atch === "주건축물" || atch === "0";
  return exclusive && main;
}

export function isResidentialCommonRow(category: string, mainAtch: string, etcPurps: string): boolean {
  const cat = category.trim();
  const atch = mainAtch.trim();
  if (!(cat === "공용" || cat === "0" || cat.toLowerCase() === "common")) return false;
  if (atch && atch !== "주건축물" && atch !== "0") return false;
  return RES_COMMON_RE.test(etcPurps);
}

export const COMPACT_OUTPUT_COLUMNS = [
  "complex_id",
  "pnu",
  "unit_register_pk",
  "parent_building_pk",
  "dong_nm",
  "ho_nm",
  "floor",
  "exclusive_area",
  "residential_common_area",
  "supply_area",
  "area_category",
  "main_usage",
  "physical_unit_key",
  "physical_unit_key_kind",
  "source_row_id",
  "source_version",
] as const;

export type CompactUnitRow = Record<(typeof COMPACT_OUTPUT_COLUMNS)[number], string>;

export function cell(row: string[], mapping: ColumnMapping, column: string | null): string {
  if (!column) return "";
  const key = norm(column);
  const i = mapping.index[key];
  if (i == null) return "";
  return (row[i] ?? "").trim();
}

export function parseDelimitedHeader(line: string): { header: string[]; delimiter: "," | "|" | "\t" } {
  const pipe = line.split("|");
  const tab = line.split("\t");
  const comma = splitCsvLine(line);
  if (pipe.length >= comma.length && pipe.length >= tab.length && pipe.length > 1) {
    return { header: pipe.map((s) => s.trim()), delimiter: "|" };
  }
  if (tab.length > comma.length && tab.length > 1) {
    return { header: tab.map((s) => s.trim()), delimiter: "\t" };
  }
  return { header: comma.map((s) => s.trim()), delimiter: "," };
}

export function splitCsvLine(line: string, delimiter: string = ","): string[] {
  if (delimiter !== ",") return line.split(delimiter);
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
