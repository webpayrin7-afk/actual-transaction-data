/**
 * Semantic audit: exact market-pyeong label vs decade cohort for complex scope.
 * Read-only. Does not mutate V2.1 unless a follow-up fix is applied.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { exactSupplyPyeong } from "../../src/lib/region-ranking/price-position-v2";
import {
  PRICE_POSITION_V21_AS_OF,
  pricePositionV21SnapshotId,
  shiftYearMonthV2,
  TREND_HORIZONS_V21,
  HORIZON_SHIFT_MONTHS_V21,
} from "../../src/lib/region-ranking/price-position-v21";
import { resolveComplexMonth, buildComplexMonthValues, mean } from "../../src/lib/region-ranking/price-position-v21-audit";

const JAMSIL = "cx_4c63d9a100973c60";
const AS_OF = PRICE_POSITION_V21_AS_OF;
const AS_OF_MONTH = AS_OF.slice(0, 7);

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });

  // 1) Published V2.1 payload
  const pub = await db.execute({
    sql: `SELECT payload_json FROM complex_region_price_position WHERE snapshot_id=? AND complex_id=? AND area_band=?`,
    args: [pricePositionV21SnapshotId(), JAMSIL, "84"],
  });
  const body = JSON.parse(String(pub.rows[0]?.payload_json ?? "{}"));

  // 2) Load Jamsil master + supplies
  const master = await db.execute({
    sql: `SELECT lawd_cd, apt_name_norm, apt_name FROM apt_complex_master WHERE complex_id=?`,
    args: [JAMSIL],
  });
  const lawd = String(master.rows[0]?.lawd_cd);
  const norm = String(master.rows[0]?.apt_name_norm);

  const supplies = await db.execute({
    sql: `SELECT exclusive_cents, supply_area, status FROM apt_canonical_unit_types
          WHERE complex_id=? AND supply_cents>=0`,
    args: [JAMSIL],
  });
  const byEx = new Map<number, Array<{ supply: number; label: number | null; status: string }>>();
  for (const row of supplies.rows) {
    const ex = num(row.exclusive_cents);
    const supply = num(row.supply_area);
    const list = byEx.get(ex) ?? [];
    list.push({ supply, label: marketPyeongLabelInteger(supply), status: String(row.status) });
    byEx.set(ex, list);
  }

  const floorSupply = new Map<string, number>();
  try {
    const rl = createInterface({
      input: createReadStream("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl"),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      const row = JSON.parse(line) as {
        level: string;
        complexId: string;
        exclusiveCents: number;
        floor: string;
        buildingDong: string;
        supplyCents: number;
      };
      if (row.complexId !== JAMSIL) continue;
      if (row.level === "EXACT_FLOOR" && !row.buildingDong) {
        floorSupply.set(`${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
      }
    }
  } catch {
    // optional
  }

  function resolveLabel(exclusiveArea: number, floor: number): { label: number | null; supply: number | null; mode: string } {
    const ex = exclusiveCents(exclusiveArea);
    const floorHit = floorSupply.get(`${ex}|${floor}`);
    if (floorHit != null) {
      return { label: marketPyeongLabelInteger(floorHit), supply: floorHit, mode: "floor" };
    }
    const variants = byEx.get(ex) ?? [];
    const exact = variants.filter((v) => v.status === "EXACT_SINGLE");
    if (exact.length === 1) {
      return { label: exact[0]!.label, supply: exact[0]!.supply, mode: "exact_single" };
    }
    const labels = [...new Set(variants.map((v) => v.label).filter((x): x is number => x != null))];
    if (labels.length === 1) return { label: labels[0]!, supply: variants[0]?.supply ?? null, mode: "label_safe" };
    return { label: null, supply: null, mode: "ambiguous" };
  }

  const tx = await db.execute({
    sql: `SELECT deal_date, substr(deal_date,1,7) ym, exclusive_area, deal_amount, floor
          FROM transactions
          WHERE lawd_cd=? AND apt_name_norm=? AND deal_type='trade'
            AND deal_amount>0 AND exclusive_area>0 AND deal_date<=?
            AND deal_date>='2021-07-01'
          ORDER BY deal_date`,
    args: [lawd, norm, AS_OF],
  });

  type Row = { ym: string; label: number | null; price: number | null; exclusive: number; deal: number; mode: string };
  const rows: Row[] = [];
  for (const row of tx.rows) {
    const exclusive = num(row.exclusive_area);
    const deal = num(row.deal_amount);
    const resolved = resolveLabel(exclusive, num(row.floor));
    const price = resolved.label != null ? deal / resolved.label : null;
    rows.push({
      ym: String(row.ym),
      label: resolved.label,
      price,
      exclusive,
      deal,
      mode: resolved.mode,
    });
  }

  const ref = String(body.referenceMonth || AS_OF_MONTH);
  function monthStats(filter: (r: Row) => boolean, month: string) {
    const hit = rows.filter((r) => r.ym === month && filter(r) && r.price != null);
    const prices = hit.map((r) => r.price!);
    const labels = [...new Set(hit.map((r) => r.label))];
    return {
      month,
      n: hit.length,
      labels,
      mean: prices.length ? mean(prices) : null,
      deals: hit.map((r) => ({ exclusive: r.exclusive, label: r.label, deal: r.deal, price: r.price, mode: r.mode })),
    };
  }

  const cohort30 = (r: Row) => r.label != null && r.label >= 30 && r.label < 40;
  const exact33 = (r: Row) => r.label === 33;

  // Build S1 tables for cohort vs exact
  function series(filter: (r: Row) => boolean) {
    const points = rows
      .filter((r) => filter(r) && r.price != null)
      .map((r) => ({
        complexId: JAMSIL,
        lawdCd: lawd,
        bjdongCd: "",
        yearMonth: r.ym,
        pricePerMarketPyeong: r.price!,
        dealAmount: r.deal,
      }));
    return buildComplexMonthValues(points).get(JAMSIL) ?? new Map();
  }
  const cohortTable = series(cohort30);
  const exactTable = series(exact33);

  const horizons: Record<string, unknown> = {};
  for (const h of TREND_HORIZONS_V21) {
    const target = shiftYearMonthV2(ref, -HORIZON_SHIFT_MONTHS_V21[h]);
    const curCohort = resolveComplexMonth({ cells: cohortTable, targetMonth: ref, asOfMonth: AS_OF_MONTH, sparse: "S1", minTrades: 1 });
    const baseCohort = resolveComplexMonth({ cells: cohortTable, targetMonth: target, asOfMonth: AS_OF_MONTH, sparse: "S1", minTrades: 1 });
    const curExact = resolveComplexMonth({ cells: exactTable, targetMonth: ref, asOfMonth: AS_OF_MONTH, sparse: "S1", minTrades: 1 });
    const baseExact = resolveComplexMonth({ cells: exactTable, targetMonth: target, asOfMonth: AS_OF_MONTH, sparse: "S1", minTrades: 1 });
    const ch = (cur: number | null, base: number | null) =>
      cur != null && base != null && base > 0 ? Math.round((cur / base - 1) * 10000) / 100 : null;
    horizons[h] = {
      targetMonth: target,
      published: body.trends?.[h]?.find((c: { scope: string }) => c.scope === "COMPLEX"),
      cohort: {
        currentMonth: curCohort?.month ?? null,
        baselineMonth: baseCohort?.month ?? null,
        currentMean: curCohort?.cell.meanPrice ?? null,
        baselineMean: baseCohort?.cell.meanPrice ?? null,
        currentN: curCohort?.cell.tradeCount ?? 0,
        baselineN: baseCohort?.cell.tradeCount ?? 0,
        change: ch(curCohort?.cell.meanPrice ?? null, baseCohort?.cell.meanPrice ?? null),
      },
      exact33: {
        currentMonth: curExact?.month ?? null,
        baselineMonth: baseExact?.month ?? null,
        currentMean: curExact?.cell.meanPrice ?? null,
        baselineMean: baseExact?.cell.meanPrice ?? null,
        currentN: curExact?.cell.tradeCount ?? 0,
        baselineN: baseExact?.cell.tradeCount ?? 0,
        change: ch(curExact?.cell.meanPrice ?? null, baseExact?.cell.meanPrice ?? null),
      },
      targetExactMonthStats: monthStats(exact33, target),
      targetCohortMonthStats: monthStats(cohort30, target),
      s1ExactBaselineStats: baseExact ? monthStats(exact33, baseExact.month) : null,
      s1CohortBaselineStats: baseCohort ? monthStats(cohort30, baseCohort.month) : null,
    };
  }

  // Reference month detail
  const refCohort = monthStats(cohort30, ref);
  const refExact = monthStats(exact33, ref);

  // Code contract from materialization: one body per area_band decade
  const implementation = {
    materializationGrain: "one row per (complex_id, area_band decade)",
    complexScopeFilter: "all market_pyeong_label in BAND_TO_SUPPLY_COHORT[areaBand] (e.g. 30–39 for band 84)",
    regionScopeFilter: "same decade cohort across complexes",
    selectedExactLabelParameter: "NONE — API takes area_band/exclusive_area only",
    complexUsesExactSelectedLabel: false,
    complexUsesDecadeCohort: true,
    complexTrendSparse: "S1",
  };

  // Prior +2.12% was V2 complex trend on deal-amount means for calendar months (not market pyeong), horizon 6M.
  // After exact-label fix, published COMPLEX with exclusive overlay uses exact-33 S1 market-pyeong.
  const published6 = body.trends?.["6M"]?.find((c: { scope: string }) => c.scope === "COMPLEX");
  const exactSlice6 = body.complexExactByMarketLabel?.["33"]?.trends?.["6M"];
  const classification = {
    publishedStoredComplex6M: published6?.changePercent ?? null,
    publishedExactSlice6M: exactSlice6?.changePercent ?? null,
    priorValidated6M: 2.12,
    cohortS1MarketPyeong6M: (horizons["6M"] as { cohort: { change: number | null } }).cohort.change,
    exact33S1MarketPyeong6M: (horizons["6M"] as { exact33: { change: number | null } }).exact33.change,
    differenceClass: [
      "EXPECTED_PERIOD_METHOD_CHANGE", // V2 deal-amount mean → V2.1 market-pyeong mean + S1
      "EXACT_PYEONG_VS_COHORT_CHANGE", // stored decade COMPLEX was +3.97; exact-33 is +3.42
    ],
    notes: [
      "V2 complex trends used calendar-month mean DEAL AMOUNT, not 만원/평.",
      "V2.1 complex trends use calendar-month mean market-pyeong price with S1.",
      "Stored body COMPLEX remains decade_cohort; exclusive_area read overlays exact market label.",
      "Region scopes stay supply-pyeong decade cohort (P2/T0 unchanged).",
    ],
  };

  const report = {
    implementation: {
      ...implementation,
      complexUsesExactSelectedLabel: "at_read_when_exclusive_area_resolves",
      complexUsesDecadeCohort: "stored_default_and_area_band_only",
      complexExactSlicesPresent: Object.keys(body.complexExactByMarketLabel ?? {}).sort(),
      complexTrendSparse: "S1",
    },
    published: {
      version: body.version,
      referenceMonth: body.referenceMonth,
      cohort: body.supplyPyeongCohort,
      complexScopeBasis: body.complexScopeBasis,
      complexPrice: body.priceLevel?.find((c: { scope: string }) => c.scope === "COMPLEX"),
      complexTrends: Object.fromEntries(
        TREND_HORIZONS_V21.map((h) => [h, body.trends?.[h]?.find((c: { scope: string }) => c.scope === "COMPLEX")]),
      ),
      exact33: body.complexExactByMarketLabel?.["33"] ?? null,
    },
    referenceMonth: { cohort: refCohort, exact33: refExact },
    horizons,
    classification,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
