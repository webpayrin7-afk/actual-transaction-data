/**
 * Phase 7.2 — Complex Detail v1 server composition (enrichment only).
 * Market data continues to use the existing apt-detail path.
 */
import type { RegionDef } from "@/lib/constants/regions";
import { getDb } from "@/lib/db/client";
import type {
  ComplexDetailBasic,
  ComplexDetailBuilding,
  ComplexDetailIdentity,
} from "@/lib/unit-type/complex-detail-contract";

export type ComplexEnrichmentStatus =
  | "READY"
  | "PENDING"
  | "MISSING"
  | "UNKNOWN";

export type ComplexMgmtMonthV1 = {
  periodYyyymm: string;
  commonFee: number | null;
  individualFee: number | null;
  longTermRepairReserve: number | null;
  /** Label-only sum of the three components (not an official bill total). */
  componentSum: number | null;
  perHouseholdComponentSum: number | null;
};

/** Portal OpenAPI derived 원/㎡ (COMPLETE months only for selected-pyeong calc). */
export type PortalAreaFeeMonthV1 = {
  periodYyyymm: string;
  privArea: number;
  commonTotal: number | null;
  individualTotal: number | null;
  reserveTotal: number | null;
  portalTotal: number | null;
  perAreaCommon: number | null;
  perAreaIndividual: number | null;
  perAreaReserve: number | null;
  perAreaTotal: number | null;
  areaBasis: "residential_exclusive" | string | null;
  feeStatus: "COMPLETE" | "INCOMPLETE" | string | null;
  source: string | null;
  sourceVersion: string | null;
};

export type ComplexManagementV1 = {
  available: true;
  householdCount: number;
  latest: ComplexMgmtMonthV1;
  /** Months used for the average (latest available, max 12). */
  averageMonthCount: number;
  averageLabel: string;
  average: {
    commonFee: number | null;
    individualFee: number | null;
    longTermRepairReserve: number | null;
    componentSum: number | null;
    perHouseholdComponentSum: number | null;
  };
  /** Chronological oldest → newest for charts. */
  monthlySeries: ComplexMgmtMonthV1[];
  /**
   * Portal-derived per-area months (COMPLETE only), newest first.
   * Empty when pilot derived data is absent — never invent from household avg.
   */
  portalAreaFees: PortalAreaFeeMonthV1[];
  disclaimer: string;
};

/** 평형 구성 원천: unit_type_household_counts (ui_safe=1). 추정 없음. */
export type ComplexUnitMixRowV1 = {
  exclusiveSqm: number;
  supplySqm: number | null;
  householdCount: number;
};

export type ComplexUnitMixV1 = {
  rows: ComplexUnitMixRowV1[];
  sourceAsOf: string | null;
};

/** NAVER geocoded complex center (complex_map_anchor) — matches the NAVER map label position. */
export type ComplexMapAnchorV1 = { lat: number; lng: number; matchedAddress: string | null };

export type ComplexDetailV1 = {
  resolved: boolean;
  unitMix?: ComplexUnitMixV1 | null;
  mapAnchor?: ComplexMapAnchorV1 | null;
  identity: ComplexDetailIdentity | null;
  basic: ComplexDetailBasic | null;
  building: ComplexDetailBuilding | null;
  management: ComplexManagementV1 | null;
  statuses: {
    basic: ComplexEnrichmentStatus;
    building: ComplexEnrichmentStatus;
    management: ComplexEnrichmentStatus;
  };
  coverage: "full" | "partial" | "minimum";
  timingMs: {
    total: number;
    master: number;
    profile: number;
    fees: number;
  };
};

const MGMT_DISCLAIMER =
  "단지 전체 관리비를 세대수로 나눈 단순 환산값입니다. 선택 평형의 실제 관리비·개별 사용량 청구액과는 다를 수 있습니다.";

/** Previous calendar month as YYYYMM. */
export function prevYyyymm(yyyymm: string): string {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  if (m <= 1) return `${y - 1}12`;
  return `${y}${String(m - 1).padStart(2, "0")}`;
}

/**
 * From newest→oldest rows, keep a contiguous streak ending at latest (max `limit`).
 * Gaps stop the window — missing months are not invented.
 */
export function continuousMonthsFromLatest<T extends { periodYyyymm: string }>(
  monthsDesc: T[],
  limit = 12,
): T[] {
  if (monthsDesc.length === 0) return [];
  const out: T[] = [monthsDesc[0]!];
  for (let i = 1; i < monthsDesc.length && out.length < limit; i++) {
    const newer = out[out.length - 1]!;
    const older = monthsDesc[i]!;
    if (prevYyyymm(newer.periodYyyymm) !== older.periodYyyymm) break;
    out.push(older);
  }
  return out;
}

/** Season month numbers. Winter spans Dec of prior calendar year. */
export const MGMT_WINTER_MONTHS = [12, 1, 2] as const;
export const MGMT_SUMMER_MONTHS = [6, 7, 8] as const;
/** Prefer ≥2 valid months in-season; do not fabricate. */
export const MGMT_SEASON_MIN_MONTHS = 2;

export type MgmtSeasonMetric = {
  valueWon: number | null;
  monthsAvailable: string[];
  monthsUsed: string[];
  /** Winter: year of Jan/Feb. Summer: calendar year of Jun–Aug. */
  seasonYear: number | null;
};

function yyyymm(year: number, month: number): string {
  return `${year}${String(month).padStart(2, "0")}`;
}

/**
 * Most recent winter (Dec Y-1, Jan Y, Feb Y) or summer (Jun–Aug Y)
 * with at least MGMT_SEASON_MIN_MONTHS valid per-household values ≤ latestYm.
 */
export function computeSeasonMetric(
  seriesAsc: ComplexMgmtMonthV1[],
  latestYm: string,
  kind: "winter" | "summer",
): MgmtSeasonMetric {
  const byYm = new Map<string, number>();
  for (const m of seriesAsc) {
    if (m.perHouseholdComponentSum != null && m.perHouseholdComponentSum > 0) {
      byYm.set(m.periodYyyymm, m.perHouseholdComponentSum);
    }
  }
  const latestY = Number(latestYm.slice(0, 4));
  const empty: MgmtSeasonMetric = {
    valueWon: null,
    monthsAvailable: [],
    monthsUsed: [],
    seasonYear: null,
  };
  if (!Number.isFinite(latestY)) return empty;

  for (let y = latestY; y >= latestY - 3; y--) {
    const keys =
      kind === "summer"
        ? MGMT_SUMMER_MONTHS.map((mo) => yyyymm(y, mo))
        : [
            yyyymm(y - 1, 12),
            yyyymm(y, 1),
            yyyymm(y, 2),
          ];
    const onOrBefore = keys.filter((k) => k <= latestYm);
    const available = onOrBefore.filter((k) => byYm.has(k));
    if (available.length < MGMT_SEASON_MIN_MONTHS) continue;
    const vals = available.map((k) => byYm.get(k)!);
    return {
      valueWon: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
      monthsAvailable: available,
      monthsUsed: available,
      seasonYear: y,
    };
  }
  return empty;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeAptName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

function statusFromRow(v: unknown): ComplexEnrichmentStatus {
  const s = asStr(v)?.toUpperCase();
  if (s === "READY") return "READY";
  if (s === "PENDING") return "PENDING";
  if (!s) return "MISSING";
  return "UNKNOWN";
}

function sumComponents(
  common: number | null,
  individual: number | null,
  reserve: number | null,
): number | null {
  if (common == null && individual == null && reserve == null) return null;
  return (common ?? 0) + (individual ?? 0) + (reserve ?? 0);
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function approvalYear(approvalDate: string | null): number | null {
  if (!approvalDate) return null;
  const digits = approvalDate.replace(/\D/g, "");
  if (digits.length >= 4) {
    const y = Number(digits.slice(0, 4));
    return y >= 1900 && y <= 2100 ? y : null;
  }
  return null;
}

export function formatApprovalYearLabel(
  approvalDate: string | null,
): string | null {
  const y = approvalYear(approvalDate);
  return y != null ? `${y}년 준공` : null;
}

/** KRW → compact 만원 display (e.g. 293935 → "29만원") */
export function formatWonAsManwon(won: number | null | undefined): string {
  if (won == null || !Number.isFinite(won) || won <= 0) return "—";
  const man = Math.round(won / 10000);
  if (man >= 10000) {
    const eok = man / 10000;
    const rounded = Math.round(eok * 100) / 100;
    return `${rounded}억`;
  }
  return `${man.toLocaleString("ko-KR")}만원`;
}

export function formatYyyymmLabel(yyyymm: string): string {
  if (yyyymm.length !== 6) return yyyymm;
  return `${yyyymm.slice(0, 4)}.${yyyymm.slice(4, 6)}`;
}

/** e.g. 202609 → "2026년 09월 기준" */
export function formatYyyymmBasisLabel(yyyymm: string): string {
  if (yyyymm.length !== 6) return yyyymm;
  return `${yyyymm.slice(0, 4)}년 ${yyyymm.slice(4, 6)}월 기준`;
}

/**
 * 단지 식별용 법정동코드 후보 — molit/apt resolveDetailLawdCodes 와 같은 규칙.
 * 구명이 맞으면 그 구만, 아니면 지역 전체(다구 도시: 성남·수원·고양 등).
 * lawdCodes[0]만 쓰면 분당구 단지가 수정구(41131)로 조회돼 상세가 비었다.
 */
export function resolveComplexLawdCodes(
  region: RegionDef | undefined,
  gu?: string,
): string[] {
  if (!region) return [];
  const needle = gu?.trim();
  if (!needle) return [...region.lawdCodes];
  const hit = region.districts.find(
    (d) => needle === d.name || needle.includes(d.name) || d.name.includes(needle),
  );
  if (hit) return [hit.code];
  return [...region.lawdCodes];
}

export async function getComplexDetailV1(params: {
  aptName: string;
  lawdCodes?: string[];
}): Promise<ComplexDetailV1> {
  const t0 = performance.now();
  const empty: ComplexDetailV1 = {
    resolved: false,
    identity: null,
    basic: null,
    building: null,
    management: null,
    statuses: {
      basic: "MISSING",
      building: "MISSING",
      management: "MISSING",
    },
    coverage: "minimum",
    timingMs: { total: 0, master: 0, profile: 0, fees: 0 },
  };

  const db = getDb();
  if (!db) {
    empty.timingMs.total = Math.round(performance.now() - t0);
    return empty;
  }

  const aptNorm = normalizeAptName(params.aptName);
  if (!aptNorm) {
    empty.timingMs.total = Math.round(performance.now() - t0);
    return empty;
  }

  const tMaster = performance.now();
  const lawdCodes = [
    ...new Set((params.lawdCodes ?? []).map((c) => c.trim()).filter(Boolean)),
  ];
  // 후보 순서(첫 구 우선) → IDENTITY-READY 우선. idx_acm_lawd_norm 으로 코드별 SEARCH.
  const masterResult = lawdCodes.length
    ? await db.execute({
        sql: `SELECT complex_id, apt_name, apt_name_norm, sido, sigungu,
                     legal_dong_name, jibun, road_address, lawd_cd, bjdong_cd
              FROM apt_complex_master
              WHERE apt_name_norm = ? AND lawd_cd IN (${lawdCodes.map(() => "?").join(",")})
              ORDER BY CASE lawd_cd ${lawdCodes.map((_, i) => `WHEN ? THEN ${i}`).join(" ")} END,
                       CASE WHEN identity_status = 'IDENTITY-READY' THEN 0 ELSE 1 END
              LIMIT 1`,
        args: [aptNorm, ...lawdCodes, ...lawdCodes],
      })
    : await db.execute({
        sql: `SELECT complex_id, apt_name, apt_name_norm, sido, sigungu,
                     legal_dong_name, jibun, road_address, lawd_cd, bjdong_cd
              FROM apt_complex_master
              WHERE apt_name_norm = ?
              ORDER BY CASE WHEN identity_status = 'IDENTITY-READY' THEN 0 ELSE 1 END
              LIMIT 1`,
        args: [aptNorm],
      });
  const masterMs = Math.round(performance.now() - tMaster);
  const master = masterResult.rows[0];
  if (!master) {
    empty.timingMs = {
      total: Math.round(performance.now() - t0),
      master: masterMs,
      profile: 0,
      fees: 0,
    };
    return empty;
  }

  const complexId = String(master.complex_id);
  const identity: ComplexDetailIdentity = {
    complexId,
    aptName: String(master.apt_name),
    aptNameNorm: String(master.apt_name_norm),
    sido: asStr(master.sido),
    sigungu: asStr(master.sigungu),
    legalDongName: asStr(master.legal_dong_name),
    lawdCd: asStr(master.lawd_cd),
    bjdongCd: asStr(master.bjdong_cd),
    jibun: asStr(master.jibun),
    roadAddress: asStr(master.road_address),
  };

  // master 뒤 조회는 서로 독립 — 한 번에 병렬(왕복 4→2). profile·fees 시간은 같은 묶음.
  const tProfile = performance.now();
  const [profileRes, stateRes, unitMixRes, feeRes, anchorRes] = await Promise.all([
    db.execute({
      sql: `SELECT household_count, building_count, approval_date, heating_type,
                   management_type, parking_total, parking_per_household,
                   max_floor, structure_type, main_purpose, far_ratio, bcr_ratio,
                   land_area_sqm, total_area_sqm
            FROM apt_complex_profile WHERE complex_id = ? LIMIT 1`,
      args: [complexId],
    }),
    db.execute({
      sql: `SELECT domain, status FROM apt_complex_enrichment_state
            WHERE complex_id = ?`,
      args: [complexId],
    }),
    db.execute({
      sql: `SELECT exclusive_cents, supply_cents,
                   SUM(household_count) AS household_count,
                   MAX(source_as_of) AS source_as_of
            FROM unit_type_household_counts
            WHERE complex_id = ? AND ui_safe = 1 AND household_count > 0
            GROUP BY exclusive_cents, supply_cents
            ORDER BY exclusive_cents`,
      args: [complexId],
    }),
    // Read up to 24 months for season windows; averages still use ≤12 continuous.
    db.execute({
      sql: `SELECT period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
                   household_basis,
                   per_area_common_fee, per_area_individual_fee, per_area_reserve_fee,
                   per_area_total_fee, area_basis_sqm, area_basis, fee_status,
                   total_fee, source, source_version
            FROM apt_complex_mgmt_fee_monthly
            WHERE complex_id = ?
            ORDER BY period_yyyymm DESC
            LIMIT 24`,
      args: [complexId],
    }),
    // Optional table (scripts/map-anchor) — absent until the first apply; never fail the page on it.
    db
      .execute({
        sql: `SELECT lat, lng, matched_road, matched_jibun FROM complex_map_anchor WHERE complex_id = ? LIMIT 1`,
        args: [complexId],
      })
      .catch(() => null),
  ]);
  const profileMs = Math.round(performance.now() - tProfile);
  const feesMs = profileMs;

  const statusMap = new Map<string, ComplexEnrichmentStatus>();
  for (const row of stateRes.rows) {
    statusMap.set(String(row.domain), statusFromRow(row.status));
  }

  const profile = profileRes.rows[0] ?? null;
  let basic: ComplexDetailBasic | null = null;
  let building: ComplexDetailBuilding | null = null;
  if (profile) {
    basic = {
      householdCount: asNum(profile.household_count),
      buildingCount: asNum(profile.building_count),
      approvalDate: asStr(profile.approval_date),
      heatingType: asStr(profile.heating_type),
      managementType: asStr(profile.management_type),
      parkingTotal: asNum(profile.parking_total),
      parkingPerHousehold: asNum(profile.parking_per_household),
    };
    const candidate: ComplexDetailBuilding = {
      maxFloor: asNum(profile.max_floor),
      structureType: asStr(profile.structure_type),
      mainPurpose: asStr(profile.main_purpose),
      farRatio: asNum(profile.far_ratio),
      bcrRatio: asNum(profile.bcr_ratio),
      landAreaSqm: asNum(profile.land_area_sqm),
      totalAreaSqm: asNum(profile.total_area_sqm),
    };
    // Include FAR/BCR so header metadata can surface them even without floor/structure.
    const hasBuilding =
      candidate.maxFloor != null ||
      candidate.structureType != null ||
      candidate.mainPurpose != null ||
      candidate.farRatio != null ||
      candidate.bcrRatio != null;
    building = hasBuilding ? candidate : null;
  }

  const householdCount =
    basic?.householdCount && basic.householdCount > 0
      ? basic.householdCount
      : asNum(feeRes.rows[0]?.household_basis);

  let management: ComplexManagementV1 | null = null;
  if (feeRes.rows.length > 0) {
    const hh =
      householdCount != null && householdCount > 0 ? householdCount : 0;
    const monthsDesc: ComplexMgmtMonthV1[] = feeRes.rows.map((row) => {
      const commonFee = asNum(row.common_fee);
      const individualFee = asNum(row.individual_fee);
      const longTermRepairReserve = asNum(row.long_term_repair_reserve);
      const componentSum = sumComponents(
        commonFee,
        individualFee,
        longTermRepairReserve,
      );
      return {
        periodYyyymm: String(row.period_yyyymm),
        commonFee,
        individualFee,
        longTermRepairReserve,
        componentSum,
        perHouseholdComponentSum:
          componentSum != null && hh > 0
            ? Math.round(componentSum / hh)
            : null,
      };
    });

    const portalAreaFees = feeRes.rows
      .map((row) => {
        const feeStatus = asStr(row.fee_status);
        const perAreaTotal = asNum(row.per_area_total_fee);
        const privArea = asNum(row.area_basis_sqm);
        if (
          feeStatus !== "COMPLETE" ||
          perAreaTotal == null ||
          !(privArea != null && privArea > 0) ||
          // Unpublished all-zero payloads must not drive selected-pyeong calc.
          (asNum(row.total_fee) ?? 0) <= 0
        ) {
          return null;
        }
        const month: PortalAreaFeeMonthV1 = {
          periodYyyymm: String(row.period_yyyymm),
          privArea,
          commonTotal: asNum(row.common_fee),
          individualTotal: asNum(row.individual_fee),
          reserveTotal: asNum(row.long_term_repair_reserve),
          portalTotal: asNum(row.total_fee),
          perAreaCommon: asNum(row.per_area_common_fee),
          perAreaIndividual: asNum(row.per_area_individual_fee),
          perAreaReserve: asNum(row.per_area_reserve_fee),
          perAreaTotal,
          areaBasis: asStr(row.area_basis) ?? "residential_exclusive",
          feeStatus,
          source: asStr(row.source),
          sourceVersion: asStr(row.source_version),
        };
        return month;
      })
      .filter((r): r is PortalAreaFeeMonthV1 => r != null);

    const seriesAsc = [...monthsDesc].reverse();
    const latest = monthsDesc[0]!;
    const continuous = continuousMonthsFromLatest(monthsDesc, 12);
    const n = continuous.length;

    management = {
      available: true,
      householdCount: hh,
      latest,
      averageMonthCount: n,
      averageLabel: n >= 12 ? "최근 12개월 평균" : `최근 ${n}개월 평균`,
      average: {
        commonFee: avg(
          continuous
            .map((m) => m.commonFee)
            .filter((v): v is number => v != null),
        ),
        individualFee: avg(
          continuous
            .map((m) => m.individualFee)
            .filter((v): v is number => v != null),
        ),
        longTermRepairReserve: avg(
          continuous
            .map((m) => m.longTermRepairReserve)
            .filter((v): v is number => v != null),
        ),
        componentSum: avg(
          continuous
            .map((m) => m.componentSum)
            .filter((v): v is number => v != null),
        ),
        perHouseholdComponentSum: avg(
          continuous
            .map((m) => m.perHouseholdComponentSum)
            .filter((v): v is number => v != null),
        ),
      },
      monthlySeries: seriesAsc,
      portalAreaFees,
      disclaimer: MGMT_DISCLAIMER,
    };
  }

  const statuses = {
    basic: statusMap.get("BASIC_INFO") ?? (basic ? "READY" : "MISSING"),
    building:
      statusMap.get("BUILDING_INFO") ?? (building ? "READY" : "MISSING"),
    management:
      statusMap.get("MANAGEMENT_FEE") ??
      (management ? "READY" : "MISSING"),
  };

  const hasProfile = basic != null;
  const hasMgmt = management != null;
  const coverage: ComplexDetailV1["coverage"] =
    hasProfile && hasMgmt
      ? "full"
      : hasProfile || hasMgmt
        ? "partial"
        : "minimum";

  const unitMixRows: ComplexUnitMixRowV1[] = unitMixRes.rows
    .map((r) => ({
      exclusiveSqm: Number(r.exclusive_cents) / 100,
      supplySqm: r.supply_cents == null ? null : Number(r.supply_cents) / 100,
      householdCount: Number(r.household_count),
    }))
    .filter((r) => r.exclusiveSqm > 0 && r.householdCount > 0);
  const unitMixAsOf = unitMixRes.rows
    .map((r) => asStr(r.source_as_of))
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const unitMix: ComplexUnitMixV1 | null =
    unitMixRows.length > 0
      ? { rows: unitMixRows, sourceAsOf: unitMixAsOf ?? null }
      : null;

  let mapAnchor: ComplexMapAnchorV1 | null = null;
  const anchorRow = anchorRes?.rows[0];
  if (
    anchorRow &&
    Number.isFinite(Number(anchorRow.lat)) &&
    Number.isFinite(Number(anchorRow.lng))
  ) {
    mapAnchor = {
      lat: Number(anchorRow.lat),
      lng: Number(anchorRow.lng),
      matchedAddress: asStr(anchorRow.matched_road) ?? asStr(anchorRow.matched_jibun),
    };
  }

  return {
    resolved: true,
    unitMix,
    mapAnchor,
    identity,
    basic,
    building,
    management,
    statuses,
    coverage,
    timingMs: {
      total: Math.round(performance.now() - t0),
      master: masterMs,
      profile: profileMs,
      fees: feesMs,
    },
  };
}
