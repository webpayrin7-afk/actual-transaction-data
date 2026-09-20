import { exclusiveCents } from "@/lib/unit-type/canonical";

/** Residential common allowlist. Other common and 부속건축물 are never added. */
export const SUPPLY_RES_RE = /계단|엘리베이터|승강기|복도|현관|홀|대피소|벽체|발코니초과/;
const PARTIAL_RE = /공유면적|일부공유/;

export type ExposRow = {
  dongNm?: string;
  hoNm?: string;
  flrNo?: string | number;
  exposPubuseGbCdNm?: string;
  mainAtchGbCdNm?: string;
  mainPurpsCdNm?: string;
  etcPurps?: string;
  area?: string | number;
  bldNm?: string;
  mgmBldrgstPk?: string | number;
  crtnDay?: string;
  platGbCd?: string;
  bun?: string;
  ji?: string;
};

export type NormalizedUnit = {
  dong: string;
  floor: string;
  ho: string;
  exclusiveArea: number;
  residentialCommonArea: number;
  otherCommonArea: number;
  explicitSupplyArea: null;
  contractArea: null;
  sourceBuildingId: string;
  partial: boolean;
  derivable: boolean;
  sourceAsOf: string;
};

export type DerivedSupply = {
  exclusiveCents: number;
  supplyCents: number;
  exclusiveArea: number;
  supplyArea: number;
  residentialCommonArea: number;
  householdCount: number;
  formula: "exclusive_plus_residential_common";
};

export type DerivationResult = {
  units: NormalizedUnit[];
  supplies: DerivedSupply[];
  residentialCommonRatio: number;
  distinguishable: boolean;
  matchedRows: number;
  rejectedNameRows: number;
};

export function roundArea(n: number): number {
  return Math.round((n + 1e-12) * 100) / 100;
}

export function parseParcelJibun(jibun: string): { platGbCd: string; bun: string; ji: string } | null {
  const raw = jibun.trim();
  if (!raw) return null;
  const mountain = raw.startsWith("산");
  const body = raw.replace(/^산\s*/, "").trim();
  if (!/^\d+(?:-\d+)?$/.test(body)) return null;
  const [a, b] = body.split("-");
  const bun = Number(a);
  const ji = Number(b || 0);
  if (!Number.isInteger(bun) || !Number.isInteger(ji) || bun < 0 || ji < 0 || bun > 9999 || ji > 9999) return null;
  return {
    platGbCd: mountain ? "1" : "0",
    bun: String(bun).padStart(4, "0"),
    ji: String(ji).padStart(4, "0"),
  };
}

export function parcelPnu(lawdCd: string, bjdongCd: string, platGbCd: string, bun: string, ji: string): string {
  return `${lawdCd.padStart(5, "0")}${bjdongCd.padStart(5, "0")}${platGbCd}${bun}${ji}`;
}

export function namesMatch(buildingName: string, aptName: string): boolean {
  const building = buildingName.replace(/\s+/g, "").replace(/아파트/g, "").replace(/[()]/g, "");
  const apt = aptName.replace(/\s+/g, "").replace(/아파트/g, "").replace(/[()]/g, "");
  if (building.length < 2 || apt.length < 2) return false;
  return building.includes(apt) || apt.includes(building);
}

function areaOf(row: ExposRow): number {
  const n = Number(row.area ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isExclusive(row: ExposRow): boolean {
  return row.exposPubuseGbCdNm === "전유" && row.mainAtchGbCdNm === "주건축물" && row.mainPurpsCdNm === "아파트";
}

function hasPartial(row: ExposRow): boolean {
  return PARTIAL_RE.test(row.etcPurps || "");
}

function isResCommon(row: ExposRow, allowBlank: boolean): boolean {
  if (row.exposPubuseGbCdNm !== "공용" || row.mainAtchGbCdNm !== "주건축물") return false;
  const etc = row.etcPurps || "";
  if (SUPPLY_RES_RE.test(etc)) return true;
  return allowBlank && etc.trim() === "";
}

function isMainCommon(row: ExposRow): boolean {
  return row.exposPubuseGbCdNm === "공용" && row.mainAtchGbCdNm === "주건축물";
}

/**
 * Supply = exclusive + residential common only.
 * 부속건축물 and non-residential common stay in other_common_area.
 * A unit with partial-common exclusive, or with main-building common that is neither
 * residential nor blank, is kept but not derivable.
 */
export function deriveOfficialSupplies(rows: ExposRow[], aptName: string): DerivationResult {
  let matchedRows = 0;
  let rejectedNameRows = 0;
  const byUnit = new Map<string, ExposRow[]>();
  let mainCommon = 0;
  let mainResidential = 0;
  for (const row of rows) {
    const building = (row.bldNm || "").trim();
    if (building && !namesMatch(building, aptName)) {
      rejectedNameRows += 1;
      continue;
    }
    matchedRows += 1;
    const dong = (row.dongNm || "").trim();
    const ho = (row.hoNm || "").trim();
    if (!dong || !ho) continue;
    const key = `${dong}\t${ho}`;
    const list = byUnit.get(key);
    if (list) list.push(row);
    else byUnit.set(key, [row]);
    if (isMainCommon(row)) {
      mainCommon += 1;
      if (SUPPLY_RES_RE.test(row.etcPurps || "") || (row.etcPurps || "").trim() === "") mainResidential += 1;
    }
  }
  const residentialCommonRatio = mainCommon === 0 ? 0 : mainResidential / mainCommon;
  const units: NormalizedUnit[] = [];
  for (const [key, group] of byUnit) {
    const [dong, ho] = key.split("\t");
    const exclusiveRows = group.filter(isExclusive);
    if (exclusiveRows.length === 0) continue;
    const partial = exclusiveRows.some(hasPartial);
    const residentialRows = group.filter((row) => isResCommon(row, !partial));
    const residential = residentialRows.reduce((sum, row) => sum + areaOf(row), 0);
    const exclusive = exclusiveRows.reduce((sum, row) => sum + areaOf(row), 0);
    const other = group
      .filter((row) => row.exposPubuseGbCdNm === "공용" && !residentialRows.includes(row))
      .reduce((sum, row) => sum + areaOf(row), 0);
    const unknownMain = group.filter((row) => isMainCommon(row) && !residentialRows.includes(row));
    const derivable = exclusive > 0 && !partial && residential > 0 && unknownMain.length === 0;
    const floor = String(exclusiveRows[0]?.flrNo ?? "").trim();
    const sourceAsOf = group.map((row) => row.crtnDay || "").sort().at(-1) || "";
    units.push({
      dong: dong!,
      floor,
      ho: ho!,
      exclusiveArea: roundArea(exclusive),
      residentialCommonArea: roundArea(residential),
      otherCommonArea: roundArea(other),
      explicitSupplyArea: null,
      contractArea: null,
      sourceBuildingId: String(exclusiveRows[0]?.mgmBldrgstPk ?? ""),
      partial,
      derivable,
      sourceAsOf,
    });
  }
  const buckets = new Map<string, { exclusive: number; supply: number; common: number; n: number }>();
  for (const unit of units) {
    if (!unit.derivable) continue;
    const supply = roundArea(unit.exclusiveArea + unit.residentialCommonArea);
    const exCents = exclusiveCents(unit.exclusiveArea);
    const suCents = exclusiveCents(supply);
    if (exCents < 0 || suCents < 0) continue;
    const id = `${exCents}|${suCents}`;
    const bucket = buckets.get(id);
    if (bucket) bucket.n += 1;
    else buckets.set(id, { exclusive: unit.exclusiveArea, supply, common: unit.residentialCommonArea, n: 1 });
  }
  const supplies: DerivedSupply[] = [];
  for (const [id, bucket] of buckets) {
    if (bucket.n < 3) continue;
    const [ex, su] = id.split("|").map(Number);
    supplies.push({
      exclusiveCents: ex!,
      supplyCents: su!,
      exclusiveArea: areaFromStored(ex!),
      supplyArea: areaFromStored(su!),
      residentialCommonArea: roundArea(bucket.common),
      householdCount: bucket.n,
      formula: "exclusive_plus_residential_common",
    });
  }
  supplies.sort((a, b) => a.exclusiveCents - b.exclusiveCents || a.supplyCents - b.supplyCents);
  return {
    units,
    supplies,
    residentialCommonRatio,
    distinguishable: residentialCommonRatio >= 0.9 && supplies.length > 0,
    matchedRows,
    rejectedNameRows,
  };
}

function areaFromStored(cents: number): number {
  return cents / 100;
}

export function priorityRank(lawdCd: string, recentTrades: number): number {
  const prefix = lawdCd.slice(0, 2);
  const recent = recentTrades > 0;
  if (prefix === "11" && recent) return 1;
  if (prefix === "41" && recent) return 2;
  if (prefix === "11") return 3;
  if (prefix === "41") return 4;
  if (prefix === "28") return 5;
  if (prefix === "26") return 6;
  if (prefix === "27") return 7;
  if (prefix === "30") return 8;
  if (prefix === "12") return 9;
  if (prefix === "31") return 10;
  return 11;
}
