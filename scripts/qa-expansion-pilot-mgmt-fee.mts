/**
 * Expansion-pilot QA — 5 complexes, portal-derived selected-pyeong fee.
 * Read-only. No screenshots.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXPANSION_PILOT_APT_NAMES } from "../src/lib/complex-detail/portal-mgmt-fee-ops";
import type { PortalAreaFeeMonthV1 } from "../src/lib/complex-detail/get-complex-detail-v1";
import {
  estimateSelectedPyeongFromPortal,
  formatWonRangeAsManwon,
  reconcileLatestComponents,
} from "../src/lib/complex-detail/selected-pyeong-mgmt-fee";
import { SQM_PER_PYEONG } from "../src/lib/apt/area-selector-label";
import { LAWD_TO_REGION } from "../src/lib/constants/regions";
import { pilotByAptNameNorm } from "../src/lib/unit-type/pilot";

config({ path: resolve(process.cwd(), ".env.local") });

function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const rows: unknown[] = [];
  for (const name of EXPANSION_PILOT_APT_NAMES) {
    const master = await db.execute({
      sql: `SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.sido_code, m.sigungu
            FROM apt_complex_master m
            WHERE m.apt_name_norm = ?
            ORDER BY CASE WHEN m.sido_code = '11' THEN 0 ELSE 1 END
            LIMIT 1`,
      args: [name],
    });
    const m = master.rows[0];
    if (!m) {
      rows.push({ aptName: name, status: "HOLD", reason: "master_missing" });
      continue;
    }
    const complexId = String(m.complex_id);
    const kapt = await db.execute({
      sql: `SELECT source_key FROM apt_complex_source_links
            WHERE complex_id = ? AND source = 'KAPT' LIMIT 1`,
      args: [complexId],
    });
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
    let incomplete = 0;
    for (const row of fees.rows) {
      const feeStatus = String(row.fee_status ?? "");
      const perAreaTotal = asNum(row.per_area_total_fee);
      const privArea = asNum(row.area_basis_sqm);
      const portalTotal = asNum(row.total_fee);
      if (feeStatus === "INCOMPLETE") incomplete += 1;
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
    let kaptCode = kapt.rows[0]?.source_key
      ? String(kapt.rows[0].source_key)
      : null;
    if (!kaptCode) {
      try {
        const ingest = JSON.parse(
          readFileSync(
            resolve(process.cwd(), "data/poc/phase26/expansion-ingest-apply.json"),
            "utf8",
          ),
        ) as {
          report?: Array<{ aptName?: string; kaptCode?: string | null }>;
        };
        const hit = ingest.report?.find((r) => r.aptName === name);
        if (hit?.kaptCode) kaptCode = hit.kaptCode;
      } catch {
        /* report-only fallback */
      }
    }
    if (!kaptCode) {
      try {
        const log = readFileSync(
          resolve(process.cwd(), "data/poc/phase26/expansion-ingest.log"),
          "utf8",
        );
        const block = log.split("=== ").find((p) => p.startsWith(name));
        const mKapt = block?.match(/kapt=([A-Z0-9]+)/);
        if (mKapt) kaptCode = mKapt[1];
      } catch {
        /* report-only fallback */
      }
    }
    const pilot = pilotByAptNameNorm(name);
    let areaMin: number | null = null;
    let areaMax: number | null = null;
    if (pilot) {
      const units = await db.execute({
        sql: `SELECT exclusive_area_min, exclusive_area_max, household_count
              FROM apt_unit_types WHERE complex_key = ?`,
        args: [pilot.complexKey],
      });
      const bands = new Map<
        number,
        { min: number; max: number; hh: number }
      >();
      for (const row of units.rows) {
        const lo = asNum(row.exclusive_area_min);
        const hi = asNum(row.exclusive_area_max) ?? lo;
        if (lo == null || hi == null || lo <= 0) continue;
        const pyeong = Math.round(((lo + hi) / 2) / SQM_PER_PYEONG);
        const cur = bands.get(pyeong) ?? { min: lo, max: hi, hh: 0 };
        cur.min = Math.min(cur.min, lo);
        cur.max = Math.max(cur.max, hi);
        cur.hh += asNum(row.household_count) ?? 0;
        bands.set(pyeong, cur);
      }
      const best = [...bands.values()].sort((a, b) => b.hh - a.hh)[0];
      if (best) {
        areaMin = best.min;
        areaMax = best.max;
      }
    }

    if (areaMin == null) {
      const tx = await db.execute({
        sql: `SELECT exclusive_area AS exclusiveArea, COUNT(*) AS cnt
              FROM transactions
              WHERE apt_name_norm = ? AND lawd_cd = ? AND exclusive_area > 0
              GROUP BY ROUND(exclusive_area * 100)
              ORDER BY cnt DESC
              LIMIT 40`,
        args: [name, String(m.lawd_cd)],
      });
      const bands = new Map<number, { min: number; max: number; n: number }>();
      for (const row of tx.rows) {
        const area = asNum(row.exclusiveArea);
        const n = asNum(row.cnt) ?? 0;
        if (area == null || area <= 0) continue;
        const pyeong = Math.round(area / SQM_PER_PYEONG);
        const cur = bands.get(pyeong) ?? { min: area, max: area, n: 0 };
        cur.min = Math.min(cur.min, area);
        cur.max = Math.max(cur.max, area);
        cur.n += n;
        bands.set(pyeong, cur);
      }
      const best = [...bands.values()].sort((a, b) => b.n - a.n)[0];
      if (best) {
        areaMin = best.min;
        areaMax = best.max;
      }
    }

    if (areaMin == null) {
      const region = LAWD_TO_REGION[String(m.lawd_cd)];
      const slug = region?.slug;
      if (slug) {
        const url =
          `http://127.0.0.1:3000/api/apt-detail?aptName=${encodeURIComponent(name)}` +
          `&region=${encodeURIComponent(slug)}&months=3`;
        try {
          const res = await fetch(url);
          const data = (await res.json()) as {
            areas?: Array<{
              exclusiveArea?: number;
              exclusiveAreaMin?: number;
              exclusiveAreaMax?: number;
            }>;
          };
          const bands = new Map<number, { min: number; max: number; n: number }>();
          for (const a of data.areas ?? []) {
            const lo = a.exclusiveAreaMin ?? a.exclusiveArea;
            const hi = a.exclusiveAreaMax ?? a.exclusiveArea ?? lo;
            if (lo == null || hi == null || lo <= 0) continue;
            const pyeong = Math.round(((lo + hi) / 2) / SQM_PER_PYEONG);
            const cur = bands.get(pyeong) ?? { min: lo, max: hi, n: 0 };
            cur.min = Math.min(cur.min, lo);
            cur.max = Math.max(cur.max, hi);
            cur.n += 1;
            bands.set(pyeong, cur);
          }
          const best = [...bands.values()].sort((a, b) => b.n - a.n)[0];
          if (best) {
            areaMin = best.min;
            areaMax = best.max;
          }
        } catch {
          /* area remains missing */
        }
      }
    }

    const estimate =
      latest && areaMin != null && areaMax != null
        ? estimateSelectedPyeongFromPortal({
            monthsDesc,
            exclusiveAreaMin: areaMin,
            exclusiveAreaMax: areaMax,
            kaptCode,
          })
        : null;
    const rec = estimate ? reconcileLatestComponents(estimate) : null;
    const latestRow = latest;
    const componentOk =
      latestRow != null &&
      Math.abs(
        (latestRow.commonTotal ?? 0) +
          (latestRow.individualTotal ?? 0) +
          (latestRow.reserveTotal ?? 0) -
          (latestRow.portalTotal ?? 0),
      ) < 1;

    const summerYears = new Set(
      (estimate?.summer?.monthsUsed ?? []).map((ym) => ym.slice(0, 4)),
    );
    const winterYearsOk = (() => {
      const used = estimate?.winter?.monthsUsed ?? [];
      if (used.length === 0) return true;
      const months = used.map((ym) => ym.slice(4, 6)).sort().join(",");
      return months === "01,02,12" || months === "01,12" || months === "02,12" || months === "01,02";
    })();

    let status: "PASS" | "HOLD" = "HOLD";
    let reason = "";
    if (!latest) {
      reason = "no_complete_months";
    } else if (areaMin == null || areaMax == null) {
      reason = "missing_area";
    } else if (!estimate) {
      reason = "estimate_null";
    } else if (!rec?.ok || !componentOk) {
      reason = "reconcile_fail";
    } else if (summerYears.size > 1) {
      reason = "summer_cross_season";
    } else if (!winterYearsOk) {
      reason = "winter_cross_season";
    } else {
      status = "PASS";
    }

    rows.push({
      aptName: name,
      sigungu: String(m.sigungu),
      complexId,
      kaptCode,
      privArea: latest?.privArea ?? null,
      monthsComplete: monthsDesc.length,
      monthsIncomplete: incomplete,
      selectedArea:
        areaMin != null && areaMax != null ? `${areaMin}~${areaMax}` : null,
      latestMonth: latest?.periodYyyymm ?? null,
      latest: estimate
        ? formatWonRangeAsManwon(estimate.latest.wonMin, estimate.latest.wonMax)
        : null,
      winter: estimate?.winter
        ? formatWonRangeAsManwon(estimate.winter.wonMin, estimate.winter.wonMax)
        : null,
      summer: estimate?.summer
        ? formatWonRangeAsManwon(estimate.summer.wonMin, estimate.summer.wonMax)
        : null,
      average: estimate?.trailingAverage
        ? formatWonRangeAsManwon(
            estimate.trailingAverage.wonMin,
            estimate.trailingAverage.wonMax,
          )
        : null,
      summerHint: estimate?.summer?.hint ?? null,
      winterMonths: estimate?.winter?.monthsUsed ?? [],
      summerMonths: estimate?.summer?.monthsUsed ?? [],
      latestWon:
        estimate != null
          ? {
              min: Math.round(estimate.latest.wonMin),
              max: Math.round(estimate.latest.wonMax),
              perM2: Number(estimate.latest.perM2.toFixed(5)),
            }
          : null,
      reconcile: rec?.ok ?? false,
      componentOk,
      status,
      reason,
    });
  }

  const out = { generatedAt: new Date().toISOString(), complexes: rows };
  const outPath = resolve(
    process.cwd(),
    "data/poc/phase26/expansion-qa.json",
  );
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
