/**
 * Targeted QA for season fallback, pyeong label source, and 약-prefix removal.
 * Read-only. No screenshots.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { areaSelectorPyeongLabel } from "../src/lib/apt/area-selector-label";
import { EXPANSION_PILOT_APT_NAMES } from "../src/lib/complex-detail/portal-mgmt-fee-ops";
import type { PortalAreaFeeMonthV1 } from "../src/lib/complex-detail/get-complex-detail-v1";
import {
  estimateSelectedPyeongFromPortal,
  formatWonRangeAsManwon,
} from "../src/lib/complex-detail/selected-pyeong-mgmt-fee";

config({ path: resolve(process.cwd(), ".env.local") });

function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sameYear(months: string[]): boolean {
  return new Set(months.map((ym) => ym.slice(0, 4))).size <= 1;
}

async function main() {
  const labels = {
    heliocityExclusive: areaSelectorPyeongLabel({
      key: "84.98",
      label: "84.98",
      exclusiveArea: 84.98,
      count: 1,
    }),
    jamsilSupply: areaSelectorPyeongLabel({
      key: "jamsil-33",
      label: "33평",
      exclusiveArea: 84.8,
      count: 1,
      exclusiveAreaMin: 84.8,
      exclusiveAreaMax: 84.97,
      supplyAreaMin: 109.29,
      supplyAreaMax: 111.52,
    }),
    parkrioMarket: areaSelectorPyeongLabel({
      key: "parkrio-33",
      label: "33평",
      exclusiveArea: 84.79,
      count: 1,
      exclusiveAreaMin: 84.79,
      exclusiveAreaMax: 84.97,
      marketLabel: 33,
    }),
  };

  const card = readFileSync(
    resolve(process.cwd(), "src/components/apt/ComplexMgmtFeeCard.tsx"),
    "utf8",
  );
  const aboutPrefixGone =
    !card.includes("약{\"") &&
    !card.includes("`약 ${") &&
    !card.includes("약{\" \"}") &&
    !/약\s*\{/.test(card) &&
    !card.includes("약 ");

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const names = ["잠실엘스", ...EXPANSION_PILOT_APT_NAMES];
  const seasons: unknown[] = [];
  for (const name of names) {
    const master = await db.execute({
      sql: `SELECT complex_id FROM apt_complex_master
            WHERE apt_name_norm = ?
            ORDER BY CASE WHEN sido_code = '11' THEN 0 ELSE 1 END
            LIMIT 1`,
      args: [name],
    });
    const complexId = master.rows[0]
      ? String(master.rows[0].complex_id)
      : null;
    if (!complexId) {
      seasons.push({ aptName: name, status: "HOLD", reason: "master_missing" });
      continue;
    }
    const fees = await db.execute({
      sql: `SELECT period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
                   total_fee, per_area_common_fee, per_area_individual_fee,
                   per_area_reserve_fee, per_area_total_fee, area_basis_sqm,
                   area_basis, fee_status, source
            FROM apt_complex_mgmt_fee_monthly
            WHERE complex_id = ?
            ORDER BY period_yyyymm DESC
            LIMIT 24`,
      args: [complexId],
    });
    const monthsDesc: PortalAreaFeeMonthV1[] = [];
    for (const row of fees.rows) {
      const feeStatus = String(row.fee_status ?? "");
      const perAreaTotal = asNum(row.per_area_total_fee);
      const privArea = asNum(row.area_basis_sqm);
      const portalTotal = asNum(row.total_fee);
      if (
        feeStatus !== "COMPLETE" ||
        perAreaTotal == null ||
        !(privArea != null && privArea > 0) ||
        !(portalTotal != null && portalTotal > 0)
      ) {
        continue;
      }
      monthsDesc.push({
        periodYyyymm: String(row.period_yyyymm),
        privArea,
        commonTotal: asNum(row.common_fee),
        individualTotal: asNum(row.individual_fee),
        reserveTotal: asNum(row.long_term_repair_reserve),
        portalTotal,
        perAreaCommon: asNum(row.per_area_common_fee),
        perAreaIndividual: asNum(row.per_area_individual_fee),
        perAreaReserve: asNum(row.per_area_reserve_fee),
        perAreaTotal,
        areaBasis: String(row.area_basis ?? "residential_exclusive"),
        feeStatus,
        source: row.source == null ? null : String(row.source),
        sourceVersion: null,
      });
    }
    const latest = monthsDesc[0];
    const estimate = latest
      ? estimateSelectedPyeongFromPortal({
          monthsDesc,
          exclusiveAreaMin: 84.8,
          exclusiveAreaMax: 84.97,
        })
      : null;
    seasons.push({
      aptName: name,
      latestMonth: latest?.periodYyyymm ?? null,
      summerMonths: estimate?.summer?.monthsUsed ?? [],
      summerSameYear: sameYear(estimate?.summer?.monthsUsed ?? []),
      summer: estimate?.summer
        ? formatWonRangeAsManwon(estimate.summer.wonMin, estimate.summer.wonMax)
        : null,
      winterMonths: estimate?.winter?.monthsUsed ?? [],
      winter: estimate?.winter
        ? formatWonRangeAsManwon(estimate.winter.wonMin, estimate.winter.wonMax)
        : null,
    });
  }

  const out = {
    labels,
    exclusiveDirectConversionRemoved: labels.heliocityExclusive === null,
    jamsilCanonical33: labels.jamsilSupply === "33평",
    parkrioCanonical33: labels.parkrioMarket === "33평",
    aboutPrefixGone,
    seasons,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
