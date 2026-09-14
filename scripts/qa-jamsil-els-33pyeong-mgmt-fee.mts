/**
 * Phase 2.6 QA — 잠실엘스 33평 selected-pyeong fee from portal OpenAPI derived rows.
 * No screenshots. Read-only DB.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { resolve } from "node:path";
import {
  estimateSelectedPyeongFromPortal,
  formatWonRangeAsManwon,
  reconcileLatestComponents,
  computeSameYearSummerPerM2,
} from "../src/lib/complex-detail/selected-pyeong-mgmt-fee";
import type { PortalAreaFeeMonthV1 } from "../src/lib/complex-detail/get-complex-detail-v1";

config({ path: resolve(process.cwd(), ".env.local") });

const COMPLEX_ID = "cx_4c63d9a100973c60";
const PRIV_AREA_TARGET = 470_139.94;
const PER_M2_TARGET = 3978.64;

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");

  const db = createClient({ url, authToken });
  const res = await db.execute({
    sql: `SELECT period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
                 total_fee, per_area_common_fee, per_area_individual_fee,
                 per_area_reserve_fee, per_area_total_fee, area_basis_sqm,
                 area_basis, fee_status, source, source_version
          FROM apt_complex_mgmt_fee_monthly
          WHERE complex_id = ?
          ORDER BY period_yyyymm DESC
          LIMIT 24`,
    args: [COMPLEX_ID],
  });

  const monthsDesc: PortalAreaFeeMonthV1[] = [];
  for (const row of res.rows) {
    const feeStatus = String(row.fee_status ?? "");
    const perAreaTotal = Number(row.per_area_total_fee);
    const privArea = Number(row.area_basis_sqm);
    const portalTotal = Number(row.total_fee);
    if (
      feeStatus !== "COMPLETE" ||
      !Number.isFinite(perAreaTotal) ||
      !(privArea > 0) ||
      !(portalTotal > 0)
    ) {
      continue;
    }
    monthsDesc.push({
      periodYyyymm: String(row.period_yyyymm),
      privArea,
      commonTotal: Number(row.common_fee),
      individualTotal: Number(row.individual_fee),
      reserveTotal: Number(row.long_term_repair_reserve),
      portalTotal,
      perAreaCommon: Number(row.per_area_common_fee),
      perAreaIndividual: Number(row.per_area_individual_fee),
      perAreaReserve: Number(row.per_area_reserve_fee),
      perAreaTotal,
      areaBasis: String(row.area_basis ?? "residential_exclusive"),
      feeStatus,
      source: row.source == null ? null : String(row.source),
      sourceVersion:
        row.source_version == null ? null : String(row.source_version),
    });
  }

  const july = monthsDesc.find((m) => m.periodYyyymm === "202607");
  if (!july) {
    console.error("FAIL: 202607 COMPLETE month missing");
    process.exit(1);
  }

  const estimate = estimateSelectedPyeongFromPortal({
    monthsDesc,
    exclusiveAreaMin: 84.8,
    exclusiveAreaMax: 84.97,
    kaptCode: "A13822004",
  });
  if (!estimate) {
    console.error("FAIL: estimate null");
    process.exit(1);
  }

  const winter = estimate.winter;
  const summer = estimate.summer;
  const trailing = estimate.trailingAverage;
  const common = estimate.components.common;
  const individual = estimate.components.individual;
  const reserve = estimate.components.reserve;
  if (!winter || !summer || !trailing || !common || !individual || !reserve) {
    console.error("FAIL: missing period/component");
    process.exit(1);
  }

  const reconcile = reconcileLatestComponents(estimate);
  const summerRate = computeSameYearSummerPerM2(monthsDesc, "202607");

  const latestManwon = formatWonRangeAsManwon(
    estimate.latest.wonMin,
    estimate.latest.wonMax,
  );
  const winterManwon = formatWonRangeAsManwon(winter.wonMin, winter.wonMax);
  const summerManwon = formatWonRangeAsManwon(summer.wonMin, summer.wonMax);
  const avgManwon = formatWonRangeAsManwon(trailing.wonMin, trailing.wonMax);

  const privOk = Math.abs(july.privArea - PRIV_AREA_TARGET) < 0.01;
  const perM2Ok = Math.abs((july.perAreaTotal ?? 0) - PER_M2_TARGET) < 0.01;
  const latestWonOk =
    estimate.latest.wonMin >= 337_000 &&
    estimate.latest.wonMax <= 339_000;

  const out = {
    privArea: july.privArea,
    perM2_202607: july.perAreaTotal,
    portalTotal_202607: july.portalTotal,
    components_202607: {
      common: july.commonTotal,
      individual: july.individualTotal,
      reserve: july.reserveTotal,
      sum:
        (july.commonTotal ?? 0) +
        (july.individualTotal ?? 0) +
        (july.reserveTotal ?? 0),
    },
    monthsComplete: monthsDesc.map((m) => m.periodYyyymm),
    latest: latestManwon,
    latestWon: [estimate.latest.wonMin, estimate.latest.wonMax],
    winter: winterManwon,
    winterMonths: winter.monthsUsed,
    summer: summerManwon,
    summerHint: summer.hint,
    summerMonths: summer.monthsUsed,
    summerPerM2: summerRate,
    average: avgManwon,
    averageMonths: trailing.monthCount,
    components: {
      common: formatWonRangeAsManwon(common.wonMin, common.wonMax),
      individual: formatWonRangeAsManwon(individual.wonMin, individual.wonMax),
      reserve: formatWonRangeAsManwon(reserve.wonMin, reserve.wonMax),
    },
    reconcile,
    sourceLabel: estimate.sourceLabelKo,
  };

  console.log(JSON.stringify(out, null, 2));

  const checks = [
    ["privArea", privOk],
    ["perM2", perM2Ok],
    ["latestWonRange", latestWonOk],
    ["latestLabel", latestManwon === "34만원"],
    ["summerHint", summer.hint === "2개월 평균"],
    [
      "summerMonths",
      JSON.stringify(summer.monthsUsed) ===
        JSON.stringify(["202606", "202607"]),
    ],
    [
      "winterMonths",
      JSON.stringify(winter.monthsUsed) ===
        JSON.stringify(["202512", "202601", "202602"]),
    ],
    ["reconcile", reconcile.ok === true],
    ["completeCount", monthsDesc.length >= 12],
    [
      "componentReconcilePortal",
      Math.abs(
        (july.commonTotal ?? 0) +
          (july.individualTotal ?? 0) +
          (july.reserveTotal ?? 0) -
          (july.portalTotal ?? 0),
      ) < 1,
    ],
  ] as const;

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) {
    console.log("QA PASS");
    process.exit(0);
  }
  console.error(
    "QA FAIL",
    failed.map(([name]) => name),
    out,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
