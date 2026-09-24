/**
 * READ-ONLY audit: Price Position V3 candidate — REGION REPRESENTATIVE PYEONG
 * LATEST_ACTIVE + equal-complex-weight + MEDIAN.
 *
 * Does NOT write DB, change public pointer, or mutate V2.3.2.
 *
 * Usage:
 *   tsx scripts/region-ranking/audit-price-position-v3-latest.mts
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import { median } from "../../src/lib/region-ranking/objective-rank";
import {
  buildComplexMonthValues,
  complexMonthStat,
} from "../../src/lib/region-ranking/price-position-v21-audit";
import { PRICE_MIN_COMPLEXES_V21 } from "../../src/lib/region-ranking/price-position-v21";
import {
  exactSupplyPyeong,
  pricePerSupplyPyeong,
  roundToV2,
} from "../../src/lib/region-ranking/price-position-v2";
import {
  DECADE_COHORTS_V22,
  decadeCohortForLabel,
} from "../../src/lib/region-ranking/price-position-v22";
import { pricePositionV232SnapshotId } from "../../src/lib/region-ranking/price-position-v23";

const AS_OF = "2026-09-17";
const FLOOR_YM = "202107";
const ASOF_YM = "202609";
const REF = "2026-09";
const SNAP232 = pricePositionV232SnapshotId();
const JAMSIL = "cx_4c63d9a100973c60";
const JAMSIL_DONG = "1171010100";
const OUT = "/tmp/building-hub-bulk/external-evidence/price-position-v3-latest-audit.json";

type Mode = "SAME_MONTH" | "LATEST_ACTIVE" | "LATEST_ACTIVE_24M";
const METHODS: Mode[] = ["SAME_MONTH", "LATEST_ACTIVE", "LATEST_ACTIVE_24M"];

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function dongKey(lawd: string, bjdong: string): string {
  return `${lawd}${bjdong}`;
}

function monthsBetween(earlier: string, later: string): number {
  const [ey, em] = earlier.split("-").map(Number);
  const [ly, lm] = later.split("-").map(Number);
  return (ly - ey) * 12 + (lm - em);
}

function nearest(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function pctiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: nearest(sorted, 0.1),
    p25: nearest(sorted, 0.25),
    p50: nearest(sorted, 0.5),
    p75: nearest(sorted, 0.75),
    p90: nearest(sorted, 0.9),
    p99: nearest(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1]! : null,
    mean: sorted.length ? roundToV2(sorted.reduce((a, b) => a + b, 0) / sorted.length, 4) : null,
    n: sorted.length,
  };
}

function agg(values: number[]) {
  if (!values.length) return { c: 0, median: null as number | null, mean: null as number | null };
  const med = median(values);
  return {
    c: values.length,
    median: med == null ? null : roundToV2(med, 4),
    mean: roundToV2(values.reduce((a, b) => a + b, 0) / values.length, 4),
  };
}

function latestMonth(months: Map<string, { mean: number; trades: number }>, asOf: string): string | null {
  let best: string | null = null;
  for (const m of months.keys()) {
    if (m > asOf) continue;
    if (!best || m > best) best = m;
  }
  return best;
}

type CovBucket = {
  cells: number;
  okCells: number;
  cList: number[];
  cOverA: number[];
  cOverB: number[];
  sparseLe3: number;
  ages: number[];
  ageGt6: number;
  ageGt12: number;
  ageGt24: number;
  ageContributors: number;
  absDeltaVsSame: number[];
  pctDeltaVsSame: number[];
};

function emptyCov(): CovBucket {
  return {
    cells: 0,
    okCells: 0,
    cList: [],
    cOverA: [],
    cOverB: [],
    sparseLe3: 0,
    ages: [],
    ageGt6: 0,
    ageGt12: 0,
    ageGt24: 0,
    ageContributors: 0,
    absDeltaVsSame: [],
    pctDeltaVsSame: [],
  };
}

function summarizeCov(c: CovBucket) {
  const agePct = pctiles(c.ages);
  return {
    cells: c.cells,
    okCells: c.okCells,
    okRate: roundToV2(c.okCells / (c.cells || 1), 4),
    contributor: pctiles(c.cList),
    cOverA: pctiles(c.cOverA),
    cOverB: pctiles(c.cOverB),
    sparseLe3Rate: roundToV2(c.sparseLe3 / (c.cells || 1), 4),
    age: {
      median: agePct.p50,
      p75: agePct.p75,
      p90: agePct.p90,
      gt6Rate: roundToV2(c.ageGt6 / (c.ageContributors || 1), 4),
      gt12Rate: roundToV2(c.ageGt12 / (c.ageContributors || 1), 4),
      gt24Rate: roundToV2(c.ageGt24 / (c.ageContributors || 1), 4),
      n: c.ageContributors,
    },
    valueDeltaAbs: pctiles(c.absDeltaVsSame),
    valueDeltaPct: pctiles(c.pctDeltaVsSame),
  };
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso");
  const db = createClient({ url, authToken });
  const lawds = seoulLawdCodes();

  type Ident = {
    complexId: string;
    lawdCd: string;
    bjdongCd: string;
    aptName: string;
  };
  const identities = new Map<string, Ident>();
  const byName = new Map<string, string>();
  const ambiguousNames = new Set<string>();

  for (const lawd of lawds) {
    const masters = await db.execute({
      sql: `SELECT complex_id, bjdong_cd, apt_name, apt_name_norm
            FROM apt_complex_master WHERE lawd_cd=?`,
      args: [lawd],
    });
    const norms = new Map<string, number>();
    for (const row of masters.rows) {
      const norm = String(row.apt_name_norm);
      norms.set(norm, (norms.get(norm) ?? 0) + 1);
    }
    for (const row of masters.rows) {
      const id = String(row.complex_id);
      const norm = String(row.apt_name_norm);
      if ((norms.get(norm) ?? 0) > 1) ambiguousNames.add(`${lawd}|${norm}`);
      identities.set(id, {
        complexId: id,
        lawdCd: lawd,
        bjdongCd: String(row.bjdong_cd),
        aptName: String(row.apt_name ?? norm),
      });
      if ((norms.get(norm) ?? 0) === 1) byName.set(`${lawd}|${norm}`, id);
    }
  }

  const canonical = new Map<string, Set<string>>();
  const points = new Map<string, Array<{
    complexId: string;
    lawdCd: string;
    bjdongCd: string;
    yearMonth: string;
    pricePerSupplyPyeong: number;
    pricePerMarketPyeong: number;
    marketPyeongLabel: number;
    dealAmount: number;
    exclusiveArea: number;
    supplyArea: number;
    supplyPyeong: number;
  }>>();
  for (const cohort of DECADE_COHORTS_V22) {
    canonical.set(cohort.key, new Set());
    points.set(cohort.key, []);
  }

  const floorSupply = new Map<string, number>();
  const floorPath = "/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl";
  if (existsSync(floorPath)) {
    const rl = createInterface({ input: createReadStream(floorPath), crlfDelay: Infinity });
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
      if (row.level === "EXACT_FLOOR" && !row.buildingDong && identities.has(row.complexId)) {
        floorSupply.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
      }
    }
  }

  for (const lawd of lawds) {
    const ids = [...identities.values()].filter((row) => row.lawdCd === lawd).map((row) => row.complexId);
    const supplies = new Map<string, number[]>();
    const exactKeys = new Set<string>();
    if (ids.length) {
      const supplyRows = await db.execute({
        sql: `SELECT complex_id, exclusive_cents, supply_area, status
              FROM apt_canonical_unit_types
              WHERE complex_id IN (${ids.map(() => "?").join(",")})
                AND supply_cents >= 0 AND status IN ('EXACT_SINGLE', 'AMBIGUOUS_MULTI')`,
        args: ids,
      });
      const exclusives = new Map<string, { labels: Set<number> }>();
      for (const row of supplyRows.rows) {
        const id = String(row.complex_id);
        const key = `${id}|${num(row.exclusive_cents)}`;
        const supplyArea = num(row.supply_area);
        if (!(supplyArea > 0)) continue;
        const label = marketPyeongLabelInteger(supplyArea);
        const bucket = exclusives.get(key) ?? { labels: new Set<number>() };
        if (label != null) bucket.labels.add(label);
        if (String(row.status) === "EXACT_SINGLE") exactKeys.add(key);
        const list = supplies.get(key) ?? [];
        list.push(supplyArea);
        supplies.set(key, list);
        exclusives.set(key, bucket);
      }
      for (const [key, bucket] of exclusives) {
        if (bucket.labels.size !== 1) continue;
        const label = [...bucket.labels][0]!;
        const cohort = decadeCohortForLabel(label);
        if (!cohort) continue;
        canonical.get(cohort.key)!.add(key.slice(0, key.indexOf("|")));
      }
    }

    const tx = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, substr(deal_date,1,7) ym
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND year_month>=? AND year_month<=?
              AND deal_date<=? AND deal_amount>0 AND exclusive_area>0`,
      args: [lawd, FLOOR_YM, ASOF_YM, AS_OF],
    });
    for (const row of tx.rows) {
      const norm = String(row.apt_name_norm);
      if (ambiguousNames.has(`${lawd}|${norm}`)) continue;
      const complexId = byName.get(`${lawd}|${norm}`);
      const id = complexId ? identities.get(complexId) : undefined;
      if (!complexId || !id) continue;
      const exclusiveArea = Number(row.exclusive_area);
      const pair = `${complexId}|${exclusiveCents(exclusiveArea)}`;
      const floorHit = floorSupply.get(`${pair}|${Number(row.floor)}`);
      const areas = supplies.get(pair) ?? [];
      let supplyArea: number | null = null;
      let label: number | null = null;
      if (floorHit != null) {
        supplyArea = floorHit;
        label = marketPyeongLabelInteger(supplyArea);
      } else if (exactKeys.has(pair) && areas.length === 1) {
        supplyArea = areas[0]!;
        label = marketPyeongLabelInteger(supplyArea);
      } else {
        const labels = [
          ...new Set(areas.map((area) => marketPyeongLabelInteger(area)).filter((item): item is number => item != null)),
        ];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas[0] ?? null;
        } else continue;
      }
      if (label == null || supplyArea == null || !(label > 0)) continue;
      const cohort = decadeCohortForLabel(label);
      if (!cohort) continue;
      const dealAmount = Number(row.deal_amount);
      points.get(cohort.key)!.push({
        complexId,
        lawdCd: lawd,
        bjdongCd: id.bjdongCd,
        yearMonth: String(row.ym),
        pricePerSupplyPyeong: pricePerSupplyPyeong(dealAmount, supplyArea) ?? 0,
        pricePerMarketPyeong: dealAmount / label,
        marketPyeongLabel: label,
        dealAmount,
        exclusiveArea,
        supplyArea,
        supplyPyeong: exactSupplyPyeong(supplyArea),
      });
    }
    console.log(`loaded ${lawd}`);
  }

  // Published V2.3.2 regional cells define the comparison universe
  const published = new Set<string>();
  for (const cohort of DECADE_COHORTS_V22) {
    const rows = await db.execute({
      sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
      args: [SNAP232, cohort.key],
    });
    for (const row of rows.rows) {
      const id = identities.get(String(row.complex_id));
      if (!id) continue;
      const body = JSON.parse(String(row.payload_json));
      if (!body.referenceMonth) continue;
      for (const cell of body.priceLevel ?? []) {
        if (cell.scope === "COMPLEX" || cell.status !== "ok" || cell.meanPricePerSupplyPyeong == null) continue;
        const region =
          cell.scope === "DONG" ? dongKey(id.lawdCd, id.bjdongCd) : cell.scope === "GU" ? id.lawdCd : "SEOUL";
        published.add(`${cohort.key}|${cell.scope}|${region}|${body.referenceMonth}`);
      }
    }
    console.log(`published keys ${cohort.key}`);
  }

  const coverage = Object.fromEntries(METHODS.map((m) => [m, emptyCov()])) as Record<Mode, CovBucket>;
  let jamsil: Record<string, unknown> | null = null;
  let jamsilElsScopes: Record<string, unknown> | null = null;

  // Soft-stale cell tallies for LATEST_ACTIVE (policy B)
  const softStale = {
    cells: 0,
    flag12: 0, // share of contributors >12M >= 25%
    flag24: 0, // share of contributors >24M >= 15%
    flagMedianAgeGe6: 0,
  };

  for (const cohort of DECADE_COHORTS_V22) {
    const cohortPoints = points.get(cohort.key) ?? [];
    const tables = buildComplexMonthValues(cohortPoints);
    const complexMonths = new Map<string, Map<string, { mean: number; trades: number }>>();
    for (const [cid, monthMap] of tables) {
      const cm = new Map<string, { mean: number; trades: number }>();
      for (const [ym, cell] of monthMap) {
        if (cell.tradeCount < 1) continue;
        cm.set(ym, { mean: complexMonthStat(cell, "C1_MEAN"), trades: cell.tradeCount });
      }
      if (cm.size) complexMonths.set(cid, cm);
    }

    const canon = canonical.get(cohort.key) ?? new Set<string>();

    type ContributorDetail = {
      complexId: string;
      aptName: string;
      month: string;
      age: number;
      mean: number;
      trades: number;
    };

    function collect(scope: "DONG" | "GU" | "SEOUL", region: string, asOfMonth: string, mode: Mode) {
      const canonMembers = [...canon].filter((id) => {
        const ident = identities.get(id);
        if (!ident) return false;
        if (scope === "DONG") return dongKey(ident.lawdCd, ident.bjdongCd) === region;
        if (scope === "GU") return ident.lawdCd === region;
        return true;
      });
      const A = canonMembers.length;
      const historyUsable = canonMembers.filter((id) => (complexMonths.get(id)?.size ?? 0) > 0);
      const B = historyUsable.length;
      const values: number[] = [];
      const ages: number[] = [];
      const detail: ContributorDetail[] = [];
      const maxAge = mode === "LATEST_ACTIVE_24M" ? 24 : Infinity;

      for (const cid of canonMembers) {
        const months = complexMonths.get(cid);
        if (!months) continue;
        if (mode === "SAME_MONTH") {
          const cell = months.get(asOfMonth);
          if (!cell) continue;
          values.push(cell.mean);
          ages.push(0);
          detail.push({
            complexId: cid,
            aptName: identities.get(cid)?.aptName ?? "",
            month: asOfMonth,
            age: 0,
            mean: roundToV2(cell.mean, 4),
            trades: cell.trades,
          });
          continue;
        }
        const lm = latestMonth(months, asOfMonth);
        if (!lm) continue;
        const age = monthsBetween(lm, asOfMonth);
        if (age > maxAge) continue;
        const cell = months.get(lm)!;
        values.push(cell.mean);
        ages.push(age);
        detail.push({
          complexId: cid,
          aptName: identities.get(cid)?.aptName ?? "",
          month: lm,
          age,
          mean: roundToV2(cell.mean, 4),
          trades: cell.trades,
        });
      }

      const stats = agg(values);
      const min = PRICE_MIN_COMPLEXES_V21[scope];
      const ok = stats.c >= min && stats.median != null;
      const ageSorted = [...ages].sort((a, b) => a - b);
      return {
        A,
        B,
        noHistory: A - B,
        ...stats,
        ok,
        ages,
        ageMedian: nearest(ageSorted, 0.5),
        ageP75: nearest(ageSorted, 0.75),
        ageP90: nearest(ageSorted, 0.9),
        gt6: ages.filter((a) => a > 6).length,
        gt12: ages.filter((a) => a > 12).length,
        gt24: ages.filter((a) => a > 24).length,
        detail: detail.sort((a, b) => a.age - b.age || a.aptName.localeCompare(b.aptName, "ko")),
      };
    }

    if (cohort.key === "30") {
      const matrix: Record<string, unknown> = {};
      for (const mode of METHODS) {
        const r = collect("DONG", JAMSIL_DONG, REF, mode);
        matrix[mode] = {
          A: r.A,
          B: r.B,
          C: r.c,
          ok: r.ok,
          median: r.median,
          mean: r.mean,
          ageMedian: r.ageMedian,
          ageP90: r.ageP90,
          gt12: r.gt12,
          gt24: r.gt24,
          contributors: r.detail,
        };
      }
      const same = matrix.SAME_MONTH as { A: number; B: number; C: number };
      const latest = matrix.LATEST_ACTIVE as { C: number; median: number };
      const latest24 = matrix.LATEST_ACTIVE_24M as { C: number; median: number };
      jamsil = {
        referenceAsOf: REF,
        matrix,
        counts: {
          canonical: same.A,
          historyUsable: same.B,
          sameMonth: same.C,
          latest: latest.C,
          latest24: latest24.C,
        },
      };

      // 잠실엘스 scopes at as-of REF using each mode for region; complex = own latest
      const elsMonths = complexMonths.get(JAMSIL);
      const elsLatest = elsMonths ? latestMonth(elsMonths, REF) : null;
      const elsCell = elsLatest && elsMonths ? elsMonths.get(elsLatest) : null;
      const dongL = collect("DONG", JAMSIL_DONG, REF, "LATEST_ACTIVE");
      const guL = collect("GU", "11710", REF, "LATEST_ACTIVE");
      const seoulL = collect("SEOUL", "SEOUL", REF, "LATEST_ACTIVE");
      jamsilElsScopes = {
        complex: {
          complexId: JAMSIL,
          aptName: identities.get(JAMSIL)?.aptName ?? "잠실엘스",
          latestMonth: elsLatest,
          age: elsLatest ? monthsBetween(elsLatest, REF) : null,
          mean: elsCell ? roundToV2(elsCell.mean, 4) : null,
          trades: elsCell?.trades ?? null,
        },
        DONG: {
          A: dongL.A,
          B: dongL.B,
          C: dongL.c,
          median: dongL.median,
          ageMedian: dongL.ageMedian,
          ageP90: dongL.ageP90,
          gt12Share: dongL.c ? roundToV2(dongL.gt12 / dongL.c, 4) : null,
          gt24Share: dongL.c ? roundToV2(dongL.gt24 / dongL.c, 4) : null,
        },
        GU: {
          A: guL.A,
          B: guL.B,
          C: guL.c,
          median: guL.median,
          ageMedian: guL.ageMedian,
          ageP90: guL.ageP90,
          gt12Share: guL.c ? roundToV2(guL.gt12 / guL.c, 4) : null,
          gt24Share: guL.c ? roundToV2(guL.gt24 / guL.c, 4) : null,
        },
        SEOUL: {
          A: seoulL.A,
          B: seoulL.B,
          C: seoulL.c,
          median: seoulL.median,
          ageMedian: seoulL.ageMedian,
          ageP90: seoulL.ageP90,
          gt12Share: seoulL.c ? roundToV2(seoulL.gt12 / seoulL.c, 4) : null,
          gt24Share: seoulL.c ? roundToV2(seoulL.gt24 / seoulL.c, 4) : null,
        },
      };
      const sameM = matrix.SAME_MONTH as { A: number; B: number; C: number; median: number };
      const latestM = matrix.LATEST_ACTIVE as { C: number; median: number };
      const latest24M = matrix.LATEST_ACTIVE_24M as { C: number; median: number };
      console.log(
        `jamsil same=${sameM.C}/${sameM.median} latest=${latestM.C}/${latestM.median} 24m=${latest24M.C}/${latest24M.median}`,
      );
    }

    for (const key of published) {
      const [ck, scope, region, refMonth] = key.split("|") as [string, "DONG" | "GU" | "SEOUL", string, string];
      if (ck !== cohort.key) continue;
      const results: Partial<Record<Mode, ReturnType<typeof collect>>> = {};
      for (const mode of METHODS) results[mode] = collect(scope, region, refMonth, mode);
      const same = results.SAME_MONTH!;

      for (const mode of METHODS) {
        const r = results[mode]!;
        const bucket = coverage[mode];
        bucket.cells += 1;
        if (r.ok) bucket.okCells += 1;
        bucket.cList.push(r.c);
        if (r.A > 0) bucket.cOverA.push(r.c / r.A);
        if (r.B > 0) bucket.cOverB.push(r.c / r.B);
        if (r.c <= 3) bucket.sparseLe3 += 1;
        for (const age of r.ages) {
          bucket.ages.push(age);
          bucket.ageContributors += 1;
          if (age > 6) bucket.ageGt6 += 1;
          if (age > 12) bucket.ageGt12 += 1;
          if (age > 24) bucket.ageGt24 += 1;
        }
        if (mode !== "SAME_MONTH" && same.median != null && r.median != null) {
          const abs = Math.abs(r.median - same.median);
          bucket.absDeltaVsSame.push(roundToV2(abs, 4));
          if (same.median !== 0) bucket.pctDeltaVsSame.push(roundToV2((abs / Math.abs(same.median)) * 100, 4));
        }
      }

      // Soft-stale flags on PURE LATEST_ACTIVE
      const latest = results.LATEST_ACTIVE!;
      if (latest.c > 0) {
        softStale.cells += 1;
        const share12 = latest.gt12 / latest.c;
        const share24 = latest.gt24 / latest.c;
        if (share12 >= 0.25) softStale.flag12 += 1;
        if (share24 >= 0.15) softStale.flag24 += 1;
        if ((latest.ageMedian ?? 0) >= 6) softStale.flagMedianAgeGe6 += 1;
      }
    }
  }

  const softStaleN = softStale.cells || 1;
  const out = {
    asOf: AS_OF,
    preservedSnapshot: SNAP232,
    writes: 0,
    product: {
      definition:
        "지역 대표 평당가 = 해당 지역·평형대 canonical 단지들의 최근 실거래(월평균)를 단지 동일 가중으로 반영한 중앙값",
      priority: "REGION_REPRESENTATIVENESS + CANONICAL_COMPLEX_COVERAGE over calendar-month purity",
      proposedMethodology: "LATEST_ACTIVE + EQUAL_COMPLEX_WEIGHT + MEDIAN_OF_COMPLEX_MEANS",
      notUsed: ["POOLED_TRANSACTION_MEAN", "EQUAL_COMPLEX_MEAN_AS_PRIMARY", "SAME_MONTH"],
    },
    seoulCoverage: Object.fromEntries(METHODS.map((m) => [m, summarizeCov(coverage[m])])),
    softStalePolicyB: {
      cells: softStale.cells,
      shareFlagGt12_25pct: roundToV2(softStale.flag12 / softStaleN, 4),
      shareFlagGt24_15pct: roundToV2(softStale.flag24 / softStaleN, 4),
      shareMedianAgeGe6: roundToV2(softStale.flagMedianAgeGe6 / softStaleN, 4),
      note: "Diagnostic flags only; no hard exclusion under policy B",
    },
    jamsil30p: jamsil,
    jamsilElsScopes,
    freshnessPolicies: {
      A_PURE_LATEST: {
        description: "history usable이면 age 무제한 latest month 사용",
        coverage: "LATEST_ACTIVE",
      },
      B_SOFT_STALE: {
        description: "PURE LATEST + cell-level stale metadata when contributor age heavy",
        coverage: "same as LATEST_ACTIVE",
        flags: "softStalePolicyB",
      },
      C_HARD_24M: {
        description: "age > 24M contributor 제외",
        coverage: "LATEST_ACTIVE_24M",
      },
    },
    notes: {
      trendUnchanged: true,
      v232Preserved: true,
      pointerUnchanged: true,
      pooledForbidden: true,
    },
  };

  mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`wrote ${OUT}`);
  const jCounts = jamsil?.counts as Record<string, number> | undefined;
  const jMatrix = jamsil?.matrix as Record<string, { C: number; median: number; mean: number }> | undefined;
  console.log(
    JSON.stringify(
      {
        seoul: out.seoulCoverage,
        soft: out.softStalePolicyB,
        jamsilCounts: jCounts,
        jamsilValues: jMatrix
          ? Object.fromEntries(METHODS.map((m) => [m, { C: jMatrix[m]?.C, median: jMatrix[m]?.median, mean: jMatrix[m]?.mean }]))
          : null,
        els: jamsilElsScopes,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
