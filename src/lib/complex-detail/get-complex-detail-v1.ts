/**
 * Phase 7.2 — Complex Detail v1 server composition (enrichment only).
 * Market data continues to use the existing apt-detail path.
 */
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
  disclaimer: string;
};

export type ComplexDetailV1 = {
  resolved: boolean;
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
  "단지 총액을 세대수로 나눈 환산값으로, 실제 세대별 청구액은 면적·사용량 등에 따라 다를 수 있습니다.";

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

export async function getComplexDetailV1(params: {
  aptName: string;
  lawdCd?: string;
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
  const masterResult = params.lawdCd?.trim()
    ? await db.execute({
        sql: `SELECT complex_id, apt_name, apt_name_norm, sido, sigungu,
                     legal_dong_name, jibun, road_address, lawd_cd
              FROM apt_complex_master
              WHERE apt_name_norm = ? AND lawd_cd = ?
              LIMIT 1`,
        args: [aptNorm, params.lawdCd.trim()],
      })
    : await db.execute({
        sql: `SELECT complex_id, apt_name, apt_name_norm, sido, sigungu,
                     legal_dong_name, jibun, road_address, lawd_cd
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
    jibun: asStr(master.jibun),
    roadAddress: asStr(master.road_address),
  };

  const tProfile = performance.now();
  const [profileRes, stateRes] = await Promise.all([
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
  ]);
  const profileMs = Math.round(performance.now() - tProfile);

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

  const tFees = performance.now();
  const feeRes = await db.execute({
    sql: `SELECT period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
                 household_basis
          FROM apt_complex_mgmt_fee_monthly
          WHERE complex_id = ?
          ORDER BY period_yyyymm DESC
          LIMIT 12`,
    args: [complexId],
  });
  const feesMs = Math.round(performance.now() - tFees);

  const householdCount =
    basic?.householdCount && basic.householdCount > 0
      ? basic.householdCount
      : asNum(feeRes.rows[0]?.household_basis);

  let management: ComplexManagementV1 | null = null;
  if (feeRes.rows.length > 0 && householdCount != null && householdCount > 0) {
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
          componentSum != null
            ? Math.round(componentSum / householdCount)
            : null,
      };
    });

    const seriesAsc = [...monthsDesc].reverse();
    const latest = monthsDesc[0]!;
    const n = monthsDesc.length;

    management = {
      available: true,
      householdCount,
      latest,
      averageMonthCount: n,
      averageLabel: n >= 12 ? "최근 12개월 평균" : `최근 ${n}개월 평균`,
      average: {
        commonFee: avg(
          monthsDesc
            .map((m) => m.commonFee)
            .filter((v): v is number => v != null),
        ),
        individualFee: avg(
          monthsDesc
            .map((m) => m.individualFee)
            .filter((v): v is number => v != null),
        ),
        longTermRepairReserve: avg(
          monthsDesc
            .map((m) => m.longTermRepairReserve)
            .filter((v): v is number => v != null),
        ),
        componentSum: avg(
          monthsDesc
            .map((m) => m.componentSum)
            .filter((v): v is number => v != null),
        ),
        perHouseholdComponentSum: avg(
          monthsDesc
            .map((m) => m.perHouseholdComponentSum)
            .filter((v): v is number => v != null),
        ),
      },
      monthlySeries: seriesAsc,
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

  return {
    resolved: true,
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
