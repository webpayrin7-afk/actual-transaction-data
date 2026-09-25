/** Official-only profile field rules. No name matching, no estimates. */

export const HALL_VALUES = ["계단식", "복도식", "혼합식"] as const;
export type HallValue = (typeof HALL_VALUES)[number];

export type Prov = {
  source: string;
  source_key: string;
  derived: boolean;
  derived_tag: string | null;
  raw: unknown;
};

export function cadastralToRegistryPnu(pnu: string): string {
  if (!/^\d{19}$/.test(pnu)) return "";
  const land = pnu[10];
  const plat = land === "1" ? "0" : land === "2" ? "1" : "";
  if (!plat) return "";
  return `${pnu.slice(0, 10)}${plat}${pnu.slice(11)}`;
}

export function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 건축물대장·K-apt 의 0 은 '미기재'. 용적률 0%, 세대수 0, 주차 0 대는 쓰지 않는다. */
export function positive(value: number | null): number | null {
  return value != null && value > 0 ? value : null;
}

export function positiveOrNull(value: unknown): number | null {
  return positive(numOrNull(value));
}

export function hallOrNull(value: unknown): HallValue | null {
  const s = value == null ? "" : String(value).trim();
  return (HALL_VALUES as readonly string[]).includes(s) ? (s as HallValue) : null;
}

/** 4 decimals, matching rows already stored from 총괄표제부. */
export function parkingPerHousehold(parking: number, households: number): number | null {
  if (!Number.isInteger(parking) || !Number.isInteger(households) || households <= 0) return null;
  if (parking < 0) return null;
  return Number((parking / households).toFixed(4));
}

export type HubNumbers = {
  far: number | null;
  bcr: number | null;
  household: number | null;
  parking: number | null;
  rule: "RECAP" | "TITLE_SINGLE" | "TITLE_SUM_MAIN_APT";
};

type Row = Record<string, unknown>;

function parkingOf(row: Row): number | null {
  const tot = numOrNull(row.totPkngCnt);
  if (tot != null) return tot;
  const parts = [row.indrAutoUtcnt, row.oudrAutoUtcnt, row.indrMechUtcnt, row.oudrMechUtcnt].map(numOrNull);
  if (parts.every((n) => n == null)) return null;
  return parts.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

function sameOrNull(values: Array<number | null>): number | null {
  const present = values.filter((n): n is number => n != null);
  if (present.length === 0) return null;
  if (present.length !== values.length) return null;
  return present.every((n) => n === present[0]) ? present[0]! : null;
}

function sumOrNull(values: Array<number | null>): number | null {
  if (values.some((n) => n == null)) return null;
  return values.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

/**
 * 총괄표제부가 있으면 그 행만 쓴다. 여러 총괄행이면 용적률·건폐율은 값이 모두 같을 때만,
 * 세대수·주차는 모든 행에 숫자가 있을 때만 합산한다.
 * 총괄이 없고 아파트 주건축물 표제부가 1동이면 그 행. 여러 동이면 같은 합산 규칙.
 */
export function hubFromRows(recap: Row[], title: Row[]): HubNumbers | null {
  const recapRows = recap.length > 0 ? recap : [];
  if (recapRows.length === 1) {
    const row = recapRows[0]!;
    return {
      far: positiveOrNull(row.vlRat),
      bcr: positiveOrNull(row.bcRat),
      household: positive(numOrNull(row.hhldCnt)),
      parking: positive(parkingOf(row)),
      rule: "RECAP",
    };
  }
  if (recapRows.length > 1) {
    return {
      far: sameOrNull(recapRows.map((r) => positiveOrNull(r.vlRat))),
      bcr: sameOrNull(recapRows.map((r) => positiveOrNull(r.bcRat))),
      household: positive(sumOrNull(recapRows.map((r) => numOrNull(r.hhldCnt)))),
      parking: positive(sumOrNull(recapRows.map((r) => parkingOf(r)))),
      rule: "RECAP",
    };
  }
  const mains = title.filter((r) => r.mainAtchGbCdNm === "주건축물" && r.mainPurpsCdNm === "아파트");
  if (mains.length === 0) return null;
  if (mains.length === 1) {
    const row = mains[0]!;
    return {
      far: positiveOrNull(row.vlRat),
      bcr: positiveOrNull(row.bcRat),
      household: positive(numOrNull(row.hhldCnt)),
      parking: positive(parkingOf(row)),
      rule: "TITLE_SINGLE",
    };
  }
  return {
    far: sameOrNull(mains.map((r) => positiveOrNull(r.vlRat))),
    bcr: sameOrNull(mains.map((r) => positiveOrNull(r.bcRat))),
    household: positive(sumOrNull(mains.map((r) => numOrNull(r.hhldCnt)))),
    parking: positive(sumOrNull(mains.map((r) => parkingOf(r)))),
    rule: "TITLE_SUM_MAIN_APT",
  };
}

/** K-apt 주차 = 지상(kaptdPcnt) + 지하(kaptdPcntu). 둘 중 하나라도 없으면 합산하지 않는다. */
export function kaptParking(detail: Row | null): number | null {
  if (!detail) return null;
  const ground = numOrNull(detail.kaptdPcnt);
  const under = numOrNull(detail.kaptdPcntu);
  if (ground == null || under == null) return null;
  return positive(ground + under);
}

export function pickAgreed(a: number | null, b: number | null): { value: number | null; conflict: boolean } {
  if (a == null) return { value: b, conflict: false };
  if (b == null) return { value: a, conflict: false };
  if (a === b) return { value: a, conflict: false };
  return { value: null, conflict: true };
}
