/**
 * Materialize price-position-v2.3 / v2.3.1 / v2.3.2 for every supply-pyeong decade.
 * Does not update or delete older version rows.
 *
 * Usage:
 *   tsx scripts/region-ranking/build-price-position-v23.mts
 *   tsx scripts/region-ranking/build-price-position-v23.mts --apply
 *   tsx scripts/region-ranking/build-price-position-v23.mts --v231
 *   tsx scripts/region-ranking/build-price-position-v23.mts --v231 --apply
 *   tsx scripts/region-ranking/build-price-position-v23.mts --v232
 *   tsx scripts/region-ranking/build-price-position-v23.mts --v232 --apply
 *   tsx scripts/region-ranking/build-price-position-v23.mts --confidence
 *   tsx scripts/region-ranking/build-price-position-v23.mts --confidence --apply
 *
 * --v232 is a freshness patch of V2.3.1 (same methodology). Dry-run compares
 * rebuilt regional price cells against stored V2.3.1; --apply inserts V2.3.2 only.
 *
 * --confidence updates sample-confidence-v2 metadata on the current V2.3
 * snapshot only. It does not insert a snapshot and does not change prices.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import { median } from "../../src/lib/region-ranking/objective-rank";
import { buildComplexMonthValues } from "../../src/lib/region-ranking/price-position-v21-audit";
import { pooledWindowMean, resolveRegionWindowV23 } from "../../src/lib/region-ranking/region-trend-window";
import {
  changePercentV2,
  exactSupplyPyeong,
  pricePerSupplyPyeong,
  type ComplexIdentityV2,
  type SupplySalePoint,
} from "../../src/lib/region-ranking/price-position-v2";
import {
  applyExactComplexMarketLabel,
  PRICE_POSITION_V21_AS_OF,
  TREND_HORIZONS_V21,
  type PricePositionBodyV21,
  type TrendCellV21,
} from "../../src/lib/region-ranking/price-position-v21";
import { decadeCohortForLabel, pricePositionV22SnapshotId } from "../../src/lib/region-ranking/price-position-v22";
import {
  DECADE_COHORTS_V22,
  METHODOLOGY_FINGERPRINT_V23,
  METHODOLOGY_FINGERPRINT_V231,
  METHODOLOGY_FINGERPRINT_V232,
  PRICE_POSITION_V23_VERSION,
  PRICE_POSITION_V231_VERSION,
  PRICE_POSITION_V232_VERSION,
  buildPricePositionV23,
  buildPricePositionV231,
  buildPricePositionV232,
  pricePositionV23SnapshotId,
  pricePositionV231SnapshotId,
  pricePositionV232SnapshotId,
  type ContributorAuditRow,
} from "../../src/lib/region-ranking/price-position-v23";
import { SAMPLE_CONFIDENCE_VERSION } from "../../src/lib/region-ranking/sample-confidence-v2";

const AS_OF = PRICE_POSITION_V21_AS_OF;
const FLOOR_YM = "202107";
const ASOF_YM = "202609";
const APPLY = process.argv.includes("--apply");
const CONFIDENCE = process.argv.includes("--confidence");
const AUDIT_CONTRIBUTORS = process.argv.includes("--audit-contributors");
const V231 = process.argv.includes("--v231");
const V232 = process.argv.includes("--v232");
const SNAP23 = pricePositionV23SnapshotId();
const SNAP231 = pricePositionV231SnapshotId();
const SNAP232 = pricePositionV232SnapshotId();
const SNAP22 = pricePositionV22SnapshotId();
const BATCH = 40;
const REPORT = "/tmp/building-hub-bulk/external-evidence/v23-publish-report.json";
/** Freshness dry-run fails if regional value changes exceed this (expected ~133). */
const V232_MAX_UNEXPECTED_REGIONAL_CHANGES = 400;
const JAMSIL = "cx_4c63d9a100973c60";
const PILOTS: Record<string, string> = {
  잠실엘스: JAMSIL,
  파크리오: "cx_ed52bf895d064c11",
  리센츠: "cx_caf229b5ac63cfbd",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  은마: "cx_0320fd9e007e1f8c",
  도곡렉슬: "cx_c9ed0235ecca960c",
  트리지움: "cx_85cd8a4b2d5dc3d0",
};

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso env");
  return createClient({ url, authToken });
}

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function countSnap(db: Client, snapshotId: string): Promise<{ rows: number; complexes: number }> {
  const rows = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [snapshotId] })).rows[0]?.n,
  );
  const complexes = num(
    (
      await db.execute({
        sql: `SELECT COUNT(DISTINCT complex_id) n FROM complex_region_price_position WHERE snapshot_id=?`,
        args: [snapshotId],
      })
    ).rows[0]?.n,
  );
  return { rows, complexes };
}

function sameNum(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

function priceLevelEqual(left: PricePositionBodyV21, right: PricePositionBodyV21): boolean {
  if (left.priceLevel.length !== right.priceLevel.length) return false;
  for (const scope of ["COMPLEX", "DONG", "GU", "SEOUL"] as const) {
    const a = left.priceLevel.find((cell) => cell.scope === scope);
    const b = right.priceLevel.find((cell) => cell.scope === scope);
    if (!a || !b) return false;
    if (a.status !== b.status) return false;
    if (!sameNum(a.meanPricePerSupplyPyeong, b.meanPricePerSupplyPyeong)) return false;
    if (!sameNum(a.tradeCount, b.tradeCount)) return false;
    if (!sameNum(a.sampleCount, b.sampleCount)) return false;
    if (!sameNum(a.contributingComplexCount, b.contributingComplexCount)) return false;
    if (a.referenceMonth !== b.referenceMonth) return false;
  }
  return true;
}

function complexTrendEqual(left: PricePositionBodyV21, right: PricePositionBodyV21): boolean {
  for (const horizon of TREND_HORIZONS_V21) {
    const a = left.trends[horizon].find((cell) => cell.scope === "COMPLEX");
    const b = right.trends[horizon].find((cell) => cell.scope === "COMPLEX");
    if (!a || !b) return false;
    if (a.status !== b.status || !sameNum(a.changePercent, b.changePercent)) return false;
    if (a.actualCurrentMonth !== b.actualCurrentMonth || a.actualBaselineMonth !== b.actualBaselineMonth) return false;
  }
  const leftLabels = Object.keys(left.complexExactByMarketLabel ?? {}).sort();
  const rightLabels = Object.keys(right.complexExactByMarketLabel ?? {}).sort();
  if (leftLabels.join(",") !== rightLabels.join(",")) return false;
  for (const label of leftLabels) {
    for (const horizon of TREND_HORIZONS_V21) {
      const a = left.complexExactByMarketLabel[label]?.trends[horizon];
      const b = right.complexExactByMarketLabel[label]?.trends[horizon];
      if (!a || !b) return false;
      if (a.status !== b.status || !sameNum(a.changePercent, b.changePercent)) return false;
      if (!sameNum(a.currentMean, b.currentMean) || !sameNum(a.baselineMean, b.baselineMean)) return false;
    }
  }
  return true;
}

function payloadPricesEqual(stored: PricePositionBodyV21, rebuilt: PricePositionBodyV21): boolean {
  if (stored.referenceMonth !== rebuilt.referenceMonth || stored.status !== rebuilt.status) return false;
  if (stored.methodologyFingerprint !== rebuilt.methodologyFingerprint) return false;
  if (!priceLevelEqual(stored, rebuilt) || !complexTrendEqual(stored, rebuilt)) return false;
  for (const horizon of TREND_HORIZONS_V21) {
    const left = stored.trends[horizon]?.find((cell) => cell.scope === "COMPLEX");
    const right = rebuilt.trends[horizon]?.find((cell) => cell.scope === "COMPLEX");
    if (!left || !right) return false;
    if (!sameNum(left.currentMean, right.currentMean) || !sameNum(left.baselineMean, right.baselineMean)) return false;
  }
  return true;
}

function regionalStructureEqual(stored: TrendCellV21, rebuilt: TrendCellV21): boolean {
  if (stored.currentMonth !== rebuilt.currentMonth || stored.baselineMonth !== rebuilt.baselineMonth) return false;
  if ((stored.currentWindow ?? null) !== (rebuilt.currentWindow ?? null)) return false;
  if ((stored.baselineWindow ?? null) !== (rebuilt.baselineWindow ?? null)) return false;
  if ((stored.windowStatus ?? null) !== (rebuilt.windowStatus ?? null)) return false;
  if ((stored.historyAvailableCount ?? null) !== (rebuilt.historyAvailableCount ?? null)) return false;
  if ((stored.canonicalHistoryAvailableCount ?? null) !== (rebuilt.canonicalHistoryAvailableCount ?? null)) return false;
  if ((stored.cohortUniverseCount ?? null) !== (rebuilt.cohortUniverseCount ?? null)) return false;
  if ((stored.sampleStatus ?? null) !== (rebuilt.sampleStatus ?? null)) return false;
  if ((stored.matchedComplexCount ?? null) !== (rebuilt.matchedComplexCount ?? null)) return false;
  if (!sameNum(stored.sampleCoverageRatio, rebuilt.sampleCoverageRatio)) return false;
  if ((stored.sampleConfidenceVersion ?? null) !== (rebuilt.sampleConfidenceVersion ?? null)) return false;
  if ((stored.dataCoverageStatus ?? null) !== (rebuilt.dataCoverageStatus ?? null)) return false;
  return true;
}

function regionalValueEqual(stored: TrendCellV21, rebuilt: TrendCellV21): boolean {
  if (stored.status !== rebuilt.status) return false;
  if (!sameNum(stored.changePercent, rebuilt.changePercent)) return false;
  if (!sameNum(stored.currentMean, rebuilt.currentMean) || !sameNum(stored.baselineMean, rebuilt.baselineMean)) return false;
  if (stored.currentMonth !== rebuilt.currentMonth || stored.baselineMonth !== rebuilt.baselineMonth) return false;
  if (stored.actualCurrentMonth !== rebuilt.actualCurrentMonth || stored.actualBaselineMonth !== rebuilt.actualBaselineMonth) return false;
  if ((stored.currentWindow ?? null) !== (rebuilt.currentWindow ?? null)) return false;
  if ((stored.baselineWindow ?? null) !== (rebuilt.baselineWindow ?? null)) return false;
  if ((stored.windowStatus ?? null) !== (rebuilt.windowStatus ?? null)) return false;
  if ((stored.historyAvailableCount ?? null) !== (rebuilt.historyAvailableCount ?? null)) return false;
  if (!sameNum(stored.matchedCoverageRatio, rebuilt.matchedCoverageRatio)) return false;
  return true;
}

type RegionalPriceCell = {
  status: string;
  mean: number | null;
  contributingComplexCount: number | null;
  tradeCount: number | null;
  sampleCount: number | null;
};

function regionalPriceKey(
  cohortKey: string,
  scope: string,
  region: string,
  referenceMonth: string | null,
): string {
  return `${cohortKey}|${scope}|${region}|${referenceMonth ?? ""}`;
}

function pctAbsDelta(a: number, b: number): number {
  if (a === 0) return b === 0 ? 0 : 100;
  return (Math.abs(b - a) / Math.abs(a)) * 100;
}

function nearestSorted(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function summarizeContributorAudit(rows: ContributorAuditRow[]) {
  const absDeltas: number[] = [];
  const signedDeltas: number[] = [];
  let affected = 0;
  let unaffected = 0;
  let valueChanged = 0;
  let numericChanged = 0;
  let nullTransitions = 0;
  let legacyOnly = 0;
  let canonicalOnly = 0;
  let nonCanonicalSlots = 0;
  const uniqueNonCanonical = new Set<string>();
  const byScope: Record<string, { cells: number; affected: number; valueChanged: number }> = {};
  const examples: {
    cohortKey: string;
    cacheKey: string;
    legacyContributors: number;
    canonicalContributors: number;
    nonCanonicalContributors: number;
    legacyMedian: number | null;
    canonicalMedian: number | null;
    delta: number | null;
  }[] = [];
  const jamsil: Record<string, unknown> = {};
  for (const row of rows) {
    const scope = row.cacheKey.split("|")[0] ?? "";
    const bucket = byScope[scope] ?? { cells: 0, affected: 0, valueChanged: 0 };
    bucket.cells += 1;
    const moved = row.legacyMedian !== row.canonicalMedian;
    if (row.nonCanonicalContributors > 0) {
      affected += 1;
      bucket.affected += 1;
      nonCanonicalSlots += row.nonCanonicalContributors;
      for (const id of row.nonCanonicalIds) uniqueNonCanonical.add(`${row.cohortKey}|${id}`);
    } else unaffected += 1;
    if (moved) {
      valueChanged += 1;
      bucket.valueChanged += 1;
      if (row.legacyMedian != null && row.canonicalMedian != null) {
        numericChanged += 1;
        const delta = Math.round((row.canonicalMedian - row.legacyMedian) * 100) / 100;
        absDeltas.push(Math.abs(delta));
        signedDeltas.push(delta);
        examples.push({
          cohortKey: row.cohortKey,
          cacheKey: row.cacheKey,
          legacyContributors: row.legacyContributors,
          canonicalContributors: row.canonicalContributors,
          nonCanonicalContributors: row.nonCanonicalContributors,
          legacyMedian: row.legacyMedian,
          canonicalMedian: row.canonicalMedian,
          delta,
        });
      } else {
        nullTransitions += 1;
        if (row.legacyMedian != null) legacyOnly += 1;
        if (row.canonicalMedian != null) canonicalOnly += 1;
      }
    }
    byScope[scope] = bucket;
    if (
      row.cohortKey === "30" &&
      row.referenceMonth === "2026-09" &&
      (row.cacheKey.startsWith("DONG|1171010100|") ||
        row.cacheKey.startsWith("GU|11710|") ||
        row.cacheKey.startsWith("SEOUL|SEOUL|"))
    ) {
      const delta =
        row.legacyMedian != null && row.canonicalMedian != null
          ? Math.round((row.canonicalMedian - row.legacyMedian) * 100) / 100
          : null;
      jamsil[`${row.horizon}|${scope}`] = {
        legacyContributors: row.legacyContributors,
        canonicalContributors: row.canonicalContributors,
        nonCanonicalContributors: row.nonCanonicalContributors,
        legacyMedian: row.legacyMedian,
        canonicalMedian: row.canonicalMedian,
        delta,
        nonCanonicalIds: row.nonCanonicalIds,
      };
    }
  }
  absDeltas.sort((a, b) => a - b);
  signedDeltas.sort((a, b) => a - b);
  examples.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const nearest = (sorted: number[], p: number) => {
    if (!sorted.length) return null;
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  };
  return {
    summary: {
      totalRegionalCells: rows.length,
      affectedCells: affected,
      unaffectedCells: unaffected,
      valueChangedCells: valueChanged,
      numericChangedCells: numericChanged,
      nullTransitions,
      legacyMedianOnly: legacyOnly,
      canonicalMedianOnly: canonicalOnly,
      nonCanonicalContributorSlots: nonCanonicalSlots,
      uniqueCohortComplexes: uniqueNonCanonical.size,
      absDeltaP50: nearest(absDeltas, 0.5),
      absDeltaP90: nearest(absDeltas, 0.9),
      absDeltaP99: nearest(absDeltas, 0.99),
      maxAbsDelta: absDeltas.at(-1) ?? null,
      signedDeltaP50: nearest(signedDeltas, 0.5),
      signedDeltaMin: signedDeltas[0] ?? null,
      signedDeltaMax: signedDeltas.at(-1) ?? null,
      byScope,
    },
    largest: examples.slice(0, 15),
    jamsil,
  };
}

function regionTrendChanged(left: PricePositionBodyV21, right: PricePositionBodyV21): boolean {
  for (const horizon of TREND_HORIZONS_V21) {
    for (const scope of ["DONG", "GU", "SEOUL"] as const) {
      const a = left.trends[horizon].find((cell) => cell.scope === scope);
      const b = right.trends[horizon].find((cell) => cell.scope === scope);
      if (!sameNum(a?.changePercent ?? null, b?.changePercent ?? null)) return true;
      if ((a?.matchedComplexCount ?? null) !== (b?.matchedComplexCount ?? null)) return true;
    }
  }
  return false;
}

async function main() {
  const db = client();
  const before23 = await countSnap(db, SNAP23);
  const before22 = await countSnap(db, SNAP22);
  const beforeV2 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
  );
  const beforeV21 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
  );
  console.log(`before v2=${beforeV2} v21=${beforeV21} v22=${before22.rows}/${before22.complexes} v23=${before23.rows}/${before23.complexes}`);

  const lawds = seoulLawdCodes();
  const identities = new Map<string, ComplexIdentityV2>();
  const byName = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  for (const lawd of lawds) {
    const masters = await db.execute({
      sql: `SELECT complex_id, bjdong_cd, apt_name, apt_name_norm, legal_dong_name
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
        legalDongName: String(row.legal_dong_name ?? ""),
      });
      if ((norms.get(norm) ?? 0) === 1) byName.set(`${lawd}|${norm}`, id);
    }
    console.log(`masters ${lawd} ${masters.rows.length}`);
  }

  const canonical = new Map<string, Set<string>>();
  const points = new Map<string, SupplySalePoint[]>();
  for (const cohort of DECADE_COHORTS_V22) {
    canonical.set(cohort.key, new Set());
    points.set(cohort.key, []);
  }
  const sawTrade = new Set<string>();
  const unresolvedTrade = new Set<string>();
  const under10Complexes = new Set<string>();
  let ambiguousTrades = 0;
  let noSupplyTrades = 0;
  let under10Trades = 0;
  let mappedTrades = 0;

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
  console.log(`floor keys ${floorSupply.size}`);

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
      const exclusives = new Map<string, { exact: boolean; labels: Set<number> }>();
      for (const row of supplyRows.rows) {
        const id = String(row.complex_id);
        const key = `${id}|${num(row.exclusive_cents)}`;
        const supplyArea = num(row.supply_area);
        if (!(supplyArea > 0)) continue;
        const bucket = exclusives.get(key) ?? { exact: false, labels: new Set<number>() };
        const label = marketPyeongLabelInteger(supplyArea);
        if (label != null) bucket.labels.add(label);
        if (String(row.status) === "EXACT_SINGLE") {
          bucket.exact = true;
          exactKeys.add(key);
        }
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
      sawTrade.add(complexId);
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
        const labels = [...new Set(areas.map((area) => marketPyeongLabelInteger(area)).filter((item): item is number => item != null))];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas[0] ?? null;
        } else if (labels.length > 1) {
          ambiguousTrades += 1;
          unresolvedTrade.add(complexId);
          continue;
        } else {
          noSupplyTrades += 1;
          unresolvedTrade.add(complexId);
          continue;
        }
      }
      if (label == null || supplyArea == null || !(label > 0)) {
        noSupplyTrades += 1;
        unresolvedTrade.add(complexId);
        continue;
      }
      const cohort = decadeCohortForLabel(label);
      if (!cohort) {
        under10Trades += 1;
        under10Complexes.add(complexId);
        continue;
      }
      mappedTrades += 1;
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
    console.log(`trades ${lawd} rows=${tx.rows.length} mapped=${mappedTrades}`);
  }

  const coverage: Record<string, unknown> = {};
  let priceMismatch = 0;
  let complexMismatch = 0;
  let regionChanged = 0;
  let parityCompared = 0;
  let rowLoss = 0;
  const priceMismatchExamples: string[] = [];
  const complexMismatchExamples: string[] = [];
  const rowLossExamples: string[] = [];
  const pilotOut: Record<string, unknown> = {};
  let seoul5yDistribution: Record<string, unknown> | null = null;
  let jamsil: Record<string, unknown> = {};
  const confidencePatches: { complexId: string; areaBand: string; payload: string }[] = [];
  const confidence = {
    scanned: 0,
    metadataChanges: 0,
    priceChanges: 0,
    missingRebuilt: 0,
    matchedCountChanges: 0,
    cohortUniverseChanges: 0,
    priceExamples: [] as string[],
  };
  const oldBaKeys = new Set<string>();
  const oldCaKeys = new Set<string>();
  const matchedCountKeys = new Set<string>();
  const cohortUniverseKeys = new Set<string>();
  const sampleStatusKeys = new Set<string>();
  const newViolationKeys = new Set<string>();
  const newViolationExamples: string[] = [];
  const uniqueConfidence = new Map<string, { scope: string; horizon: string; status: string; window: string | null }>();
  const confidenceJamsil: Record<string, unknown> = {};
  const v231Stats = {
    scanned: 0,
    missingRebuilt: 0,
    priceMismatch: 0,
    complexMismatch: 0,
    structuralMismatch: 0,
    regionalValueCells: new Set<string>(),
    statusOnlyCells: new Set<string>(),
    invariantKeys: new Set<string>(),
    sampleStatus: new Map<string, string>(),
  };
  const v232Fresh = {
    storedOkCells: new Map<string, RegionalPriceCell>(),
    rebuiltOkCells: new Map<string, RegionalPriceCell>(),
    rebuiltBodies: 0,
    selfVsStored232: {
      scanned: 0,
      priceMismatch: 0,
      complexMismatch: 0,
      missingRebuilt: 0,
    },
    jamsil: null as null | Record<string, unknown>,
    impossibleContributor: 0,
    nullPriceWrites: 0,
  };
  let smallArea: Record<string, unknown> | null = null;
  let largeArea: Record<string, unknown> | null = null;
  let duplicateKeys = 0;
  const invariantFailures: string[] = [];
  let invariantFailureCount = 0;
  function fail(message: string) {
    invariantFailureCount += 1;
    if (invariantFailures.length < 20) invariantFailures.push(message);
  }
  let totalRows = 0;
  let totalSlices = 0;
  const uniqueComplexes = new Set<string>();
  const insufficient = { DONG: 0, GU: 0, SEOUL: 0 };
  const gatePass = { DONG: 0, GU: 0, SEOUL: 0 };
  const bodiesDir = "/tmp/v23-bodies";
  mkdirSync(bodiesDir, { recursive: true });
  const contributorAudit: ContributorAuditRow[] = [];

  for (const cohort of DECADE_COHORTS_V22) {
    const started = Date.now();
    const buildFn = V232 ? buildPricePositionV232 : V231 ? buildPricePositionV231 : buildPricePositionV23;
    const built = buildFn({
      cohort,
      points: points.get(cohort.key) ?? [],
      identities,
      cohortUniverse: canonical.get(cohort.key),
      transactionAsOf: AS_OF,
      contributorAudit: AUDIT_CONTRIBUTORS || V231 || V232 ? contributorAudit : undefined,
    });
    const seen = new Set<string>();
    let slices = 0;
    let dongPass = 0;
    let guPass = 0;
    let seoulPass = 0;
    let dongFail = 0;
    let guFail = 0;
    let seoulFail = 0;
    const reasons: Record<string, number> = {};
    const expectedVersion = V232
      ? PRICE_POSITION_V232_VERSION
      : V231
        ? PRICE_POSITION_V231_VERSION
        : PRICE_POSITION_V23_VERSION;
    const expectedFingerprint = V232
      ? METHODOLOGY_FINGERPRINT_V232
      : V231
        ? METHODOLOGY_FINGERPRINT_V231
        : METHODOLOGY_FINGERPRINT_V23;
    for (const body of built.bodies) {
      if (seen.has(body.complexId)) duplicateKeys += 1;
      seen.add(body.complexId);
      uniqueComplexes.add(body.complexId);
      if (body.version !== expectedVersion) fail(`${cohort.key} version`);
      if (body.methodologyFingerprint !== expectedFingerprint) fail(`${cohort.key} fingerprint`);
      if (body.areaBand !== cohort.key || body.cohortKey !== cohort.key || body.regionPyeongDecade !== cohort.label) {
        fail(`${cohort.key} cohort identity ${body.complexId}`);
      }
      const sliceLabels = Object.keys(body.complexExactByMarketLabel ?? {});
      if (!sliceLabels.length) fail(`${cohort.key} empty slices ${body.complexId}`);
      for (const label of sliceLabels) {
        const value = Number(label);
        if (!(value >= cohort.min && value < cohort.max)) fail(`${cohort.key} slice ${label}`);
      }
      slices += sliceLabels.length;
      for (const scope of ["DONG", "GU", "SEOUL"] as const) {
        const cell = body.priceLevel.find((row) => row.scope === scope);
        if (cell?.status === "ok") {
          if (scope === "DONG") dongPass += 1;
          if (scope === "GU") guPass += 1;
          if (scope === "SEOUL") seoulPass += 1;
        } else {
          if (scope === "DONG") dongFail += 1;
          if (scope === "GU") guFail += 1;
          if (scope === "SEOUL") seoulFail += 1;
          reasons[`${scope}_INSUFFICIENT`] = (reasons[`${scope}_INSUFFICIENT`] ?? 0) + 1;
        }
      }
    }
    totalRows += built.bodies.length;
    totalSlices += slices;
    gatePass.DONG += dongPass;
    gatePass.GU += guPass;
    gatePass.SEOUL += seoulPass;
    insufficient.DONG += dongFail;
    insufficient.GU += guFail;
    insufficient.SEOUL += seoulFail;
    const usable = new Set((points.get(cohort.key) ?? []).map((point) => point.complexId));
    coverage[cohort.label] = {
      deterministicComplexes: canonical.get(cohort.key)!.size,
      usableTradeComplexes: usable.size,
      rows: built.bodies.length,
      exactSlices: slices,
      dongPass,
      guPass,
      seoulPass,
      dongFail,
      guFail,
      seoulFail,
      reasons,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    console.log(`built ${cohort.label}`, coverage[cohort.label]);
    if (AUDIT_CONTRIBUTORS) {
      points.set(cohort.key, []);
      continue;
    }
    for (const body of built.bodies) {
      const gu = seoulGuName(identities.get(body.complexId)?.lawdCd ?? "") || "구";
      for (const cell of body.priceLevel) if (cell.scope === "GU") cell.label = gu;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) if (cell.scope === "GU") cell.label = gu;
      }
    }
    if (V231) {
      const stored23 = await db.execute({
        sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
        args: [SNAP23, cohort.key],
      });
      const rebuiltById = new Map(built.bodies.map((body) => [body.complexId, body]));
      const storedIds = new Set<string>();
      for (const row of stored23.rows) {
        v231Stats.scanned += 1;
        const complexId = String(row.complex_id);
        storedIds.add(complexId);
        const rebuilt = rebuiltById.get(complexId);
        if (!rebuilt) {
          v231Stats.missingRebuilt += 1;
          continue;
        }
        const storedBody = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
        if (!priceLevelEqual(storedBody, rebuilt)) v231Stats.priceMismatch += 1;
        if (!complexTrendEqual(storedBody, rebuilt)) v231Stats.complexMismatch += 1;
        const ident = identities.get(complexId);
        for (const horizon of TREND_HORIZONS_V21) {
          for (const scope of ["DONG", "GU", "SEOUL"] as const) {
            const src = rebuilt.trends[horizon].find((cell) => cell.scope === scope);
            const dst = storedBody.trends[horizon]?.find((cell) => cell.scope === scope);
            if (!src || !dst) {
              v231Stats.structuralMismatch += 1;
              continue;
            }
            const region =
              scope === "DONG" ? `${ident?.lawdCd}|${ident?.bjdongCd}` : scope === "GU" ? ident?.lawdCd ?? "" : "SEOUL";
            const key = `${cohort.key}|${scope}|${region}|${horizon}|${rebuilt.referenceMonth}`;
            const nextA = src.cohortUniverseCount ?? 0;
            const nextB = src.canonicalHistoryAvailableCount ?? 0;
            const nextC = src.matchedComplexCount ?? 0;
            if (!(nextC <= nextB && nextB <= nextA)) v231Stats.invariantKeys.add(key);
            if (!regionalStructureEqual(dst, src)) v231Stats.structuralMismatch += 1;
            if ((dst.changePercent ?? null) !== (src.changePercent ?? null)) v231Stats.regionalValueCells.add(key);
            if ((dst.status ?? null) !== (src.status ?? null) && (src.changePercent ?? null) != null) {
              v231Stats.statusOnlyCells.add(key);
            }
            if (!v231Stats.sampleStatus.has(key)) v231Stats.sampleStatus.set(key, src.sampleStatus ?? "");
          }
        }
      }
      for (const id of rebuiltById.keys()) {
        if (!storedIds.has(id)) v231Stats.missingRebuilt += 1;
      }
    }
    if (V232) {
      v232Fresh.rebuiltBodies += built.bodies.length;
      for (const body of built.bodies) {
        const ident = identities.get(body.complexId);
        if (!ident) continue;
        for (const cell of body.priceLevel) {
          if (cell.scope === "COMPLEX") continue;
          if (cell.meanPricePerSupplyPyeong != null && !Number.isFinite(cell.meanPricePerSupplyPyeong)) {
            v232Fresh.nullPriceWrites += 1;
          }
          if (
            cell.status === "ok" &&
            (cell.contributingComplexCount == null ||
              cell.contributingComplexCount < 1 ||
              (cell.sampleCount != null && cell.contributingComplexCount > cell.sampleCount))
          ) {
            v232Fresh.impossibleContributor += 1;
          }
          const region =
            cell.scope === "DONG"
              ? `${ident.lawdCd}${ident.bjdongCd}`
              : cell.scope === "GU"
                ? ident.lawdCd
                : "SEOUL";
          const key = regionalPriceKey(cohort.key, cell.scope, region, body.referenceMonth);
          if (cell.status === "ok" && cell.meanPricePerSupplyPyeong != null) {
            v232Fresh.rebuiltOkCells.set(key, {
              status: cell.status,
              mean: cell.meanPricePerSupplyPyeong,
              contributingComplexCount: cell.contributingComplexCount ?? null,
              tradeCount: cell.tradeCount ?? null,
              sampleCount: cell.sampleCount ?? null,
            });
          } else if (!v232Fresh.rebuiltOkCells.has(key)) {
            // keep unavailable markers only when no ok witness exists yet
            v232Fresh.rebuiltOkCells.set(key, {
              status: cell.status,
              mean: cell.meanPricePerSupplyPyeong ?? null,
              contributingComplexCount: cell.contributingComplexCount ?? null,
              tradeCount: cell.tradeCount ?? null,
              sampleCount: cell.sampleCount ?? null,
            });
          }
        }
        if (body.complexId === JAMSIL && cohort.key === "30") {
          const dong = body.priceLevel.find((c) => c.scope === "DONG");
          const gu = body.priceLevel.find((c) => c.scope === "GU");
          const seoul = body.priceLevel.find((c) => c.scope === "SEOUL");
          const complex = body.priceLevel.find((c) => c.scope === "COMPLEX");
          const overlaid = applyExactComplexMarketLabel(body, 33, "exact");
          const complexExact = overlaid.priceLevel.find((c) => c.scope === "COMPLEX");
          const ref = body.referenceMonth ?? "";
          const tables = buildComplexMonthValues(points.get(cohort.key) ?? []);
          const canon = canonical.get(cohort.key) ?? new Set<string>();
          const contributors: { complexId: string; aptName: string; mean: number; trades: number }[] = [];
          for (const cid of canon) {
            const ident = identities.get(cid);
            if (!ident || `${ident.lawdCd}${ident.bjdongCd}` !== "1171010100") continue;
            const cell = tables.get(cid)?.get(ref);
            if (!cell || cell.tradeCount < 1) continue;
            contributors.push({
              complexId: cid,
              aptName: ident.aptName,
              mean: Math.round(cell.meanPrice * 10000) / 10000,
              trades: cell.tradeCount,
            });
          }
          contributors.sort((a, b) => a.mean - b.mean);
          const cohortDong = [...canon].filter((cid) => {
            const ident = identities.get(cid);
            return ident && `${ident.lawdCd}${ident.bjdongCd}` === "1171010100";
          }).length;
          v232Fresh.jamsil = {
            referenceMonth: body.referenceMonth,
            complexDecadeMean: complex?.meanPricePerSupplyPyeong ?? null,
            complexExact33: complexExact?.meanPricePerSupplyPyeong ?? null,
            dongCohort: cohortDong,
            dongContributors: contributors,
            dong: {
              status: dong?.status ?? null,
              value: dong?.meanPricePerSupplyPyeong ?? null,
              contributors: dong?.contributingComplexCount ?? null,
              trades: dong?.tradeCount ?? null,
            },
            gu: {
              status: gu?.status ?? null,
              value: gu?.meanPricePerSupplyPyeong ?? null,
              contributors: gu?.contributingComplexCount ?? null,
            },
            seoul: {
              status: seoul?.status ?? null,
              value: seoul?.meanPricePerSupplyPyeong ?? null,
              contributors: seoul?.contributingComplexCount ?? null,
            },
            complexEqualsDong:
              complexExact?.meanPricePerSupplyPyeong != null &&
              dong?.meanPricePerSupplyPyeong != null &&
              complexExact.meanPricePerSupplyPyeong === dong.meanPricePerSupplyPyeong,
          };
        }
      }
      const stored231 = await db.execute({
        sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
        args: [SNAP231, cohort.key],
      });
      for (const row of stored231.rows) {
        const storedBody = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
        const ident = identities.get(String(row.complex_id));
        if (!ident) continue;
        for (const cell of storedBody.priceLevel ?? []) {
          if (cell.scope === "COMPLEX") continue;
          const region =
            cell.scope === "DONG"
              ? `${ident.lawdCd}${ident.bjdongCd}`
              : cell.scope === "GU"
                ? ident.lawdCd
                : "SEOUL";
          const key = regionalPriceKey(cohort.key, cell.scope, region, storedBody.referenceMonth);
          if (cell.status === "ok" && cell.meanPricePerSupplyPyeong != null) {
            v232Fresh.storedOkCells.set(key, {
              status: cell.status,
              mean: cell.meanPricePerSupplyPyeong,
              contributingComplexCount: cell.contributingComplexCount ?? null,
              tradeCount: cell.tradeCount ?? null,
              sampleCount: cell.sampleCount ?? null,
            });
          } else if (!v232Fresh.storedOkCells.has(key)) {
            v232Fresh.storedOkCells.set(key, {
              status: cell.status,
              mean: cell.meanPricePerSupplyPyeong ?? null,
              contributingComplexCount: cell.contributingComplexCount ?? null,
              tradeCount: cell.tradeCount ?? null,
              sampleCount: cell.sampleCount ?? null,
            });
          }
        }
      }
      // Post-apply / idempotent self-check against existing V232 rows when present
      const stored232 = await db.execute({
        sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
        args: [SNAP232, cohort.key],
      });
      if (stored232.rows.length) {
        const rebuiltById = new Map(built.bodies.map((body) => [body.complexId, body]));
        const storedIds = new Set<string>();
        for (const row of stored232.rows) {
          v232Fresh.selfVsStored232.scanned += 1;
          const complexId = String(row.complex_id);
          storedIds.add(complexId);
          const rebuilt = rebuiltById.get(complexId);
          if (!rebuilt) {
            v232Fresh.selfVsStored232.missingRebuilt += 1;
            continue;
          }
          const storedBody = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
          if (!priceLevelEqual(storedBody, rebuilt)) v232Fresh.selfVsStored232.priceMismatch += 1;
          if (!complexTrendEqual(storedBody, rebuilt)) v232Fresh.selfVsStored232.complexMismatch += 1;
        }
        for (const id of rebuiltById.keys()) {
          if (!storedIds.has(id)) v232Fresh.selfVsStored232.missingRebuilt += 1;
        }
      }
    }
    if (CONFIDENCE) {
      const stored23 = await db.execute({
        sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
        args: [SNAP23, cohort.key],
      });
      const rebuiltById = new Map(built.bodies.map((body) => [body.complexId, body]));
      for (const row of stored23.rows) {
        confidence.scanned += 1;
        const complexId = String(row.complex_id);
        const rebuilt = rebuiltById.get(complexId);
        const storedBody = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
        if (!rebuilt) {
          confidence.missingRebuilt += 1;
          continue;
        }
        if (!payloadPricesEqual(storedBody, rebuilt)) {
          confidence.priceChanges += 1;
          if (confidence.priceExamples.length < 8) confidence.priceExamples.push(`${cohort.key}|${complexId}`);
          continue;
        }
        const patched = storedBody;
        patched.sampleConfidenceVersion = SAMPLE_CONFIDENCE_VERSION;
        const ident = identities.get(complexId);
        let rowChanged = false;
        let rowPriceOk = true;
        for (const horizon of TREND_HORIZONS_V21) {
          for (const scope of ["DONG", "GU", "SEOUL"] as const) {
            const src = rebuilt.trends[horizon].find((cell) => cell.scope === scope);
            const dst = patched.trends[horizon].find((cell) => cell.scope === scope);
            if (!src || !dst) {
              confidence.priceChanges += 1;
              rowPriceOk = false;
              continue;
            }
            if (!regionalValueEqual(dst, src)) {
              confidence.priceChanges += 1;
              rowPriceOk = false;
              if (confidence.priceExamples.length < 8) confidence.priceExamples.push(`${cohort.key}|${complexId}|${scope}|${horizon}`);
              continue;
            }
            const region =
              scope === "DONG" ? `${ident?.lawdCd}|${ident?.bjdongCd}` : scope === "GU" ? ident?.lawdCd ?? "" : "SEOUL";
            const key = `${cohort.key}|${scope}|${region}|${horizon}|${storedBody.referenceMonth}`;
            const oldA = dst.cohortUniverseCount ?? 0;
            const oldB = dst.historyAvailableCount ?? 0;
            const oldC = dst.matchedComplexCount ?? 0;
            if (oldB > oldA) oldBaKeys.add(key);
            if (oldC > oldA) oldCaKeys.add(key);
            if ((dst.matchedComplexCount ?? null) !== (src.matchedComplexCount ?? null)) matchedCountKeys.add(key);
            if ((dst.cohortUniverseCount ?? null) !== (src.cohortUniverseCount ?? null)) {
              confidence.cohortUniverseChanges += 1;
              cohortUniverseKeys.add(key);
              dst.cohortUniverseCount = src.cohortUniverseCount;
              rowChanged = true;
            }
            const previousStatus = dst.sampleStatus ?? null;
            const before = JSON.stringify({
              sampleStatus: dst.sampleStatus,
              matchedComplexCount: dst.matchedComplexCount,
              canonicalHistoryAvailableCount: dst.canonicalHistoryAvailableCount,
              sampleCoverageRatio: dst.sampleCoverageRatio,
              supplyCoverageRatio: dst.supplyCoverageRatio,
              historyCoverageRatio: dst.historyCoverageRatio,
              historyDataCoverageRatio: dst.historyDataCoverageRatio,
              dataCoverageStatus: dst.dataCoverageStatus,
              sampleConfidenceVersion: dst.sampleConfidenceVersion,
            });
            dst.sampleStatus = src.sampleStatus;
            dst.matchedComplexCount = src.matchedComplexCount;
            dst.canonicalHistoryAvailableCount = src.canonicalHistoryAvailableCount;
            dst.sampleCoverageRatio = src.sampleCoverageRatio;
            dst.supplyCoverageRatio = src.supplyCoverageRatio;
            dst.historyCoverageRatio = src.historyCoverageRatio;
            dst.historyDataCoverageRatio = src.historyDataCoverageRatio;
            dst.dataCoverageStatus = src.dataCoverageStatus;
            dst.sampleConfidenceVersion = SAMPLE_CONFIDENCE_VERSION;
            const after = JSON.stringify({
              sampleStatus: dst.sampleStatus,
              matchedComplexCount: dst.matchedComplexCount,
              canonicalHistoryAvailableCount: dst.canonicalHistoryAvailableCount,
              sampleCoverageRatio: dst.sampleCoverageRatio,
              supplyCoverageRatio: dst.supplyCoverageRatio,
              historyCoverageRatio: dst.historyCoverageRatio,
              historyDataCoverageRatio: dst.historyDataCoverageRatio,
              dataCoverageStatus: dst.dataCoverageStatus,
              sampleConfidenceVersion: dst.sampleConfidenceVersion,
            });
            if (before !== after) rowChanged = true;
            if (previousStatus !== (dst.sampleStatus ?? null)) sampleStatusKeys.add(key);
            const nextA = dst.cohortUniverseCount ?? 0;
            const nextB = dst.canonicalHistoryAvailableCount ?? 0;
            const nextC = dst.matchedComplexCount ?? 0;
            if (!(nextC <= nextB && nextB <= nextA)) {
              newViolationKeys.add(key);
              if (newViolationExamples.length < 8) newViolationExamples.push(`${key}|C${nextC}|B${nextB}|A${nextA}`);
            }
            if (!uniqueConfidence.has(key)) {
              uniqueConfidence.set(key, {
                scope,
                horizon,
                status: dst.sampleStatus ?? "",
                window: dst.windowStatus ?? null,
              });
            }
            if (complexId === JAMSIL && cohort.key === "30") {
              confidenceJamsil[`${horizon}|${scope}`] = {
                A: nextA,
                B: nextB,
                C: nextC,
                sampleCoverageRatio: dst.sampleCoverageRatio,
                historyDataCoverageRatio: dst.historyDataCoverageRatio,
                sampleStatus: dst.sampleStatus,
                windowStatus: dst.windowStatus,
                dataCoverageStatus: dst.dataCoverageStatus,
                changePercent: dst.changePercent,
                legacyHistory: dst.historyAvailableCount,
              };
            }
          }
        }
        if (rowChanged && rowPriceOk) {
          confidence.metadataChanges += 1;
          if (APPLY) {
            confidencePatches.push({
              complexId,
              areaBand: cohort.key,
              payload: JSON.stringify(patched),
            });
          }
        }
      }
    }
    const sink = createWriteStream(`${bodiesDir}/${cohort.key}.jsonl`);
    for (const body of built.bodies) {
      if (!sink.write(`${JSON.stringify(body)}\n`)) await once(sink, "drain");
    }
    await new Promise<void>((resolve, reject) => {
      sink.on("error", reject);
      sink.end(() => resolve());
    });

    if (cohort.key === "10" && !smallArea) {
      const body = built.bodies.find((row) => row.status === "ok");
      if (body) smallArea = summarizeBody(body);
    }
    if ((cohort.key === "50" || cohort.key === "60" || cohort.key === "70") && !largeArea) {
      const body = built.bodies.find((row) => row.status === "ok");
      if (body) largeArea = summarizeBody(body);
    }
    for (const [name, id] of Object.entries(PILOTS)) {
      const body = built.bodies.find((row) => row.complexId === id);
      if (!body) continue;
      const list = (pilotOut[name] as unknown[]) ?? [];
      list.push(summarizeBody(body));
      pilotOut[name] = list;
    }

    const stored = await db.execute({
      sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
      args: [SNAP22, cohort.key],
    });
    const v23ById = new Map(built.bodies.map((body) => [body.complexId, body]));
    const v22Ids = new Set(stored.rows.map((row) => String(row.complex_id)));
    for (const id of v23ById.keys()) {
      if (!v22Ids.has(id)) rowLoss += 1;
    }
    for (const row of stored.rows) {
      const id = String(row.complex_id);
      const right = v23ById.get(id);
      if (!right) {
        rowLoss += 1;
        if (rowLossExamples.length < 8) rowLossExamples.push(`${cohort.key}|${id}`);
        continue;
      }
      parityCompared += 1;
      const left = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
      if (!priceLevelEqual(left, right)) {
        priceMismatch += 1;
        if (priceMismatchExamples.length < 8) priceMismatchExamples.push(`${cohort.key}|${id}`);
      }
      if (!complexTrendEqual(left, right)) {
        complexMismatch += 1;
        if (complexMismatchExamples.length < 8) complexMismatchExamples.push(`${cohort.key}|${id}`);
      }
      if (regionTrendChanged(left, right)) regionChanged += 1;
      if (cohort.key === "30" && id === JAMSIL) {
        const exact22 = applyExactComplexMarketLabel(left, 33, "exact");
        const exact23 = applyExactComplexMarketLabel(right, 33, "exact");
        const trend = (body: PricePositionBodyV21, scope: "COMPLEX" | "DONG" | "GU" | "SEOUL", horizon: (typeof TREND_HORIZONS_V21)[number]) =>
          body.trends[horizon].find((cell) => cell.scope === scope);
        jamsil = {
          complex1Y: exact23.trends["1Y"].find((cell) => cell.scope === "COMPLEX"),
          complex1Yv22: exact22.trends["1Y"].find((cell) => cell.scope === "COMPLEX")?.changePercent ?? null,
          dong1Y: trend(exact23, "DONG", "1Y"),
          gu1Y: trend(exact23, "GU", "1Y"),
          seoul1Y: trend(exact23, "SEOUL", "1Y"),
          seoul5Y: trend(exact23, "SEOUL", "5Y"),
          dong5Y: trend(exact23, "DONG", "5Y"),
          gu5Y: trend(exact23, "GU", "5Y"),
          sixMonthWindow: trend(exact23, "SEOUL", "6M"),
        };
      }
    }
    if (cohort.key === "30") {
      const referenceMonth = "2026-09";
      const window = resolveRegionWindowV23({
        referenceMonth,
        horizonShift: 60,
        historyFloor: "2021-07",
      });
      const tables = buildComplexMonthValues(points.get(cohort.key) ?? []);
      const changes: number[] = [];
      if (window) {
        for (const cells of tables.values()) {
          const current = pooledWindowMean(cells, window.currentStart, window.currentEnd, referenceMonth);
          const baseline = pooledWindowMean(cells, window.baselineStart, window.baselineEnd, referenceMonth);
          if (!current || !baseline) continue;
          const change = changePercentV2(current.mean, baseline.mean);
          if (change == null) continue;
          changes.push(change);
        }
      }
      changes.sort((a, b) => a - b);
      const nearest = (p: number) => {
        if (!changes.length) return null;
        return changes[Math.max(0, Math.ceil(p * changes.length) - 1)] ?? null;
      };
      seoul5yDistribution = {
        referenceMonth,
        n: changes.length,
        min: changes[0] ?? null,
        p10: nearest(0.1),
        p25: nearest(0.25),
        median: median(changes),
        p75: nearest(0.75),
        p90: nearest(0.9),
        max: changes.at(-1) ?? null,
        windowStatus: window?.status ?? null,
        length: window?.length ?? null,
        currentWindow: window ? `${window.currentStart}..${window.currentEnd}` : null,
        baselineWindow: window ? `${window.baselineStart}..${window.baselineEnd}` : null,
      };
    }
    points.set(cohort.key, []);
  }

  if (AUDIT_CONTRIBUTORS) {
    const report = summarizeContributorAudit(contributorAudit);
    const auditPath = "/tmp/building-hub-bulk/external-evidence/canonical-contributor-audit.json";
    mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
    writeFileSync(auditPath, JSON.stringify(report));
    console.log(`contributor audit ${auditPath}`);
    console.log(JSON.stringify(report.summary));
    console.log(JSON.stringify(report.jamsil));
    return;
  }

  const withDecade = uniqueComplexes.size;
  let noTrade = 0;
  let unresolvedOnly = 0;
  let under10Only = 0;
  let noTradeNoLabel = 0;
  const anyCanonical = new Set<string>();
  for (const set of canonical.values()) for (const id of set) anyCanonical.add(id);
  for (const id of identities.keys()) {
    if (uniqueComplexes.has(id)) continue;
    if (anyCanonical.has(id)) noTrade += 1;
    else if (under10Complexes.has(id) && !unresolvedTrade.has(id)) under10Only += 1;
    else if (unresolvedTrade.has(id) || sawTrade.has(id)) unresolvedOnly += 1;
    else noTradeNoLabel += 1;
  }
  const explainedMissing = noTrade + unresolvedOnly + under10Only + noTradeNoLabel;
  const unknown = identities.size - withDecade - explainedMissing;

  const jamsilComplex1Y = (jamsil.complex1Y as { changePercent?: number } | undefined)?.changePercent;
  const seoul6 = jamsil.sixMonthWindow as { currentWindow?: string; baselineWindow?: string; windowStatus?: string } | undefined;
  const windowsValid =
    seoul6?.windowStatus === "FULL_WINDOW" &&
    seoul6.currentWindow === "2026-04..2026-09" &&
    seoul6.baselineWindow === "2025-10..2026-03";
  const invariantOk =
    duplicateKeys === 0 &&
    invariantFailureCount === 0 &&
    unknown === 0 &&
    rowLoss === 0 &&
    priceMismatch === 0 &&
    complexMismatch === 0 &&
    regionChanged > 0 &&
    jamsilComplex1Y === 0.91 &&
    windowsValid;
  const report = {
    apply: APPLY,
    snapshot: SNAP23,
    fingerprint: METHODOLOGY_FINGERPRINT_V23,
    before: { v2: beforeV2, v22: before22, v23: before23 },
    parity: {
      compared: parityCompared,
      priceMismatch,
      complexMismatch,
      regionChanged,
      rowLoss,
      priceMismatchExamples,
      complexMismatchExamples,
      rowLossExamples,
      windowsValid,
      jamsilComplex1Y,
    },
    mappedTrades,
    ambiguousTrades,
    noSupplyTrades,
    under10Trades,
    ambiguousNames: ambiguousNames.size,
    coverage,
    totals: {
      uniqueComplexes: uniqueComplexes.size,
      decadeRows: totalRows,
      exactSlices: totalSlices,
      insufficient,
      gatePass,
      duplicateKeys,
      invariantFailures,
      invariantFailureCount,
      missingExisting: 0,
    },
    jamsil,
    seoul5yDistribution,
    pilots: pilotOut,
    smallArea,
    largeArea,
    seoulMaster: identities.size,
    withDecade,
    withoutDecade: identities.size - withDecade,
    explainedMissing: {
      noTradeDespiteCanonicalLabel: noTrade,
      under10Only,
      unresolvedOrUnmappedTrade: unresolvedOnly,
      noTradeNoDecadeLabel: noTradeNoLabel,
    },
    unknown,
    invariantOk,
  };
  mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report));
  console.log(`report ${REPORT} invariantOk=${invariantOk} priceMismatch=${priceMismatch} complexMismatch=${complexMismatch} regionChanged=${regionChanged} rowLoss=${rowLoss} jamsil1Y=${jamsilComplex1Y}`);

  if (CONFIDENCE) {
    const tally = {
      SAMPLE_ADEQUATE: 0,
      SAMPLE_LIMITED: 0,
      SAMPLE_SEVERELY_LIMITED: 0,
      HORIZON_UNAVAILABLE: 0,
      other: 0,
      fullWindow: 0,
      partialWindow: 0,
      nullWindow: 0,
      partialAdequate: 0,
      byScope: {} as Record<string, Record<string, number>>,
      byHorizon: {} as Record<string, Record<string, number>>,
    };
    for (const cell of uniqueConfidence.values()) {
      const status = cell.status || "other";
      if (status === "SAMPLE_ADEQUATE") tally.SAMPLE_ADEQUATE += 1;
      else if (status === "SAMPLE_LIMITED") tally.SAMPLE_LIMITED += 1;
      else if (status === "SAMPLE_SEVERELY_LIMITED") tally.SAMPLE_SEVERELY_LIMITED += 1;
      else if (status === "HORIZON_UNAVAILABLE") tally.HORIZON_UNAVAILABLE += 1;
      else tally.other += 1;
      if (cell.window === "FULL_WINDOW") tally.fullWindow += 1;
      else if (cell.window === "PARTIAL_HISTORY_WINDOW") {
        tally.partialWindow += 1;
        if (status === "SAMPLE_ADEQUATE") tally.partialAdequate += 1;
      } else tally.nullWindow += 1;
      tally.byScope[cell.scope] ??= {};
      tally.byScope[cell.scope][status] = (tally.byScope[cell.scope][status] ?? 0) + 1;
      tally.byHorizon[cell.horizon] ??= {};
      tally.byHorizon[cell.horizon][status] = (tally.byHorizon[cell.horizon][status] ?? 0) + 1;
    }
    const gate =
      confidence.priceChanges === 0 &&
      newViolationKeys.size === 0 &&
      confidence.missingRebuilt === 0 &&
      invariantOk;
    const confidenceReport = {
      version: SAMPLE_CONFIDENCE_VERSION,
      apply: APPLY,
      scanned: confidence.scanned,
      metadataChanges: confidence.metadataChanges,
      priceChanges: confidence.priceChanges,
      priceExamples: confidence.priceExamples,
      missingRebuilt: confidence.missingRebuilt,
      matchedCountCellChanges: matchedCountKeys.size,
      cohortUniverseCellWrites: confidence.cohortUniverseChanges,
      cohortUniverseUniqueCells: cohortUniverseKeys.size,
      sampleStatusUniqueCells: sampleStatusKeys.size,
      oldBaViolations: oldBaKeys.size,
      oldCaViolations: oldCaKeys.size,
      newInvariantViolations: newViolationKeys.size,
      newViolationExamples,
      uniqueCells: uniqueConfidence.size,
      tally,
      jamsil: confidenceJamsil,
      invariantOk,
      gate,
      unrelatedWrites: 0,
    };
    const confidenceReportPath = "/tmp/building-hub-bulk/external-evidence/sample-confidence-v2-report.json";
    writeFileSync(confidenceReportPath, JSON.stringify(confidenceReport));
    console.log(`confidence report ${confidenceReportPath} gate=${gate}`);
    console.log(JSON.stringify({
      scanned: confidence.scanned,
      metadataChanges: confidence.metadataChanges,
      priceChanges: confidence.priceChanges,
      missingRebuilt: confidence.missingRebuilt,
      matchedCountCellChanges: matchedCountKeys.size,
      oldBa: oldBaKeys.size,
      oldCa: oldCaKeys.size,
      newViolations: newViolationKeys.size,
      uniqueCells: uniqueConfidence.size,
      tally,
      gate,
    }));
    if (!gate) {
      console.log("confidence gate failed; no write");
      process.exitCode = 2;
      return;
    }
    if (!APPLY) {
      console.log("confidence dry-run only");
      return;
    }
    let updatedBatches = 0;
    for (let offset = 0; offset < confidencePatches.length; offset += BATCH) {
      const slice = confidencePatches.slice(offset, offset + BATCH).map((row) => ({
        sql: `UPDATE complex_region_price_position
                SET payload_json=?
              WHERE snapshot_id=? AND complex_id=? AND area_band=?`,
        args: [row.payload, SNAP23, row.complexId, row.areaBand],
      }));
      let last: unknown = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await db.batch(slice, "write");
          last = null;
          break;
        } catch (error) {
          last = error;
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (last) throw last;
      updatedBatches += 1;
    }
    const after23 = await countSnap(db, SNAP23);
    const after22 = await countSnap(db, SNAP22);
    const afterV2 = num(
      (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
    );
    const after21 = num(
      (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
    );
    const delta = {
      v23Rows: after23.rows - before23.rows,
      v22Rows: after22.rows - before22.rows,
      v21Rows: after21 - beforeV21,
      v2Rows: afterV2 - beforeV2,
      updates: confidence.metadataChanges,
      inserts: 0,
      deletes: 0,
      batches: updatedBatches,
    };
    writeFileSync(confidenceReportPath, JSON.stringify({ ...confidenceReport, delta }));
    console.log("confidence delta", delta);
    if (delta.v23Rows !== 0 || delta.v22Rows !== 0 || delta.v21Rows !== 0 || delta.v2Rows !== 0) {
      throw new Error("unrelated snapshot changed");
    }
    return;
  }

  if (V232) {
    let contributorFail = 0;
    for (const row of contributorAudit) {
      if (row.publishedMedian !== row.canonicalMedian) contributorFail += 1;
      if (row.publishedContributors !== row.canonicalContributors) contributorFail += 1;
    }
    const allKeys = new Set([...v232Fresh.storedOkCells.keys(), ...v232Fresh.rebuiltOkCells.keys()]);
    let unchanged = 0;
    let changed = 0;
    let newlyAvailable = 0;
    let newlyUnavailable = 0;
    let contributorCountChanged = 0;
    const absDeltas: number[] = [];
    const pctDeltas: number[] = [];
    let materialGe1 = 0;
    for (const key of allKeys) {
      const stored = v232Fresh.storedOkCells.get(key);
      const rebuilt = v232Fresh.rebuiltOkCells.get(key);
      const storedOk = stored?.status === "ok" && stored.mean != null;
      const rebuiltOk = rebuilt?.status === "ok" && rebuilt.mean != null;
      if (storedOk && rebuiltOk) {
        if ((stored!.contributingComplexCount ?? null) !== (rebuilt!.contributingComplexCount ?? null)) {
          contributorCountChanged += 1;
        }
        if (sameNum(stored!.mean, rebuilt!.mean)) {
          unchanged += 1;
        } else {
          changed += 1;
          const abs = Math.abs(rebuilt!.mean! - stored!.mean!);
          absDeltas.push(abs);
          const pct = pctAbsDelta(stored!.mean!, rebuilt!.mean!);
          pctDeltas.push(pct);
          if (pct >= 1) materialGe1 += 1;
        }
      } else if (!storedOk && rebuiltOk) {
        newlyAvailable += 1;
      } else if (storedOk && !rebuiltOk) {
        newlyUnavailable += 1;
      } else {
        unchanged += 1;
      }
    }
    absDeltas.sort((a, b) => a - b);
    pctDeltas.sort((a, b) => a - b);
    const freshnessUnexpected = changed > V232_MAX_UNEXPECTED_REGIONAL_CHANGES;
    const integrityOk =
      v232Fresh.impossibleContributor === 0 &&
      v232Fresh.nullPriceWrites === 0 &&
      duplicateKeys === 0 &&
      contributorFail === 0 &&
      invariantFailureCount === 0;
    const selfParityOk =
      v232Fresh.selfVsStored232.scanned === 0 ||
      (v232Fresh.selfVsStored232.priceMismatch === 0 &&
        v232Fresh.selfVsStored232.complexMismatch === 0 &&
        v232Fresh.selfVsStored232.missingRebuilt === 0);
    // Do not require V2.2→V2.3 publish invariantOk (priceMismatch vs SNAP22).
    // V2.3.2 is a freshness patch of V2.3.1; gate on integrity + expected delta only.
    const gate = integrityOk && !freshnessUnexpected && selfParityOk;
    const v232Report = {
      version: PRICE_POSITION_V232_VERSION,
      snapshot: SNAP232,
      previousSnapshot: SNAP231,
      fingerprint: METHODOLOGY_FINGERPRINT_V232,
      methodologyChanged: false,
      rebuiltBodies: v232Fresh.rebuiltBodies,
      regionalCells: allKeys.size,
      storedRegionalOk: [...v232Fresh.storedOkCells.values()].filter((c) => c.status === "ok").length,
      rebuiltRegionalOk: [...v232Fresh.rebuiltOkCells.values()].filter((c) => c.status === "ok").length,
      unchanged,
      changed,
      newlyAvailable,
      newlyUnavailable,
      contributorCountChanged,
      deltaAbs: {
        p50: nearestSorted(absDeltas, 0.5),
        p90: nearestSorted(absDeltas, 0.9),
        p99: nearestSorted(absDeltas, 0.99),
        max: absDeltas.length ? absDeltas[absDeltas.length - 1]! : 0,
      },
      deltaPct: {
        p50: nearestSorted(pctDeltas, 0.5),
        p90: nearestSorted(pctDeltas, 0.9),
        p99: nearestSorted(pctDeltas, 0.99),
        max: pctDeltas.length ? pctDeltas[pctDeltas.length - 1]! : 0,
        ge1: materialGe1,
      },
      baselineExpectedStale: 133,
      maxAllowedChanged: V232_MAX_UNEXPECTED_REGIONAL_CHANGES,
      unexpectedChanges: freshnessUnexpected,
      impossibleContributor: v232Fresh.impossibleContributor,
      nullPriceWrites: v232Fresh.nullPriceWrites,
      contributorParityFails: contributorFail,
      auditCells: contributorAudit.length,
      jamsil: v232Fresh.jamsil,
      selfVsStored232: v232Fresh.selfVsStored232,
      invariantOk,
      integrityOk,
      selfParityOk,
      gate,
    };
    const v232Path = "/tmp/building-hub-bulk/external-evidence/v232-publish-report.json";
    mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
    writeFileSync(v232Path, JSON.stringify(v232Report));
    console.log(`v232 report ${v232Path} gate=${gate}`);
    console.log(JSON.stringify(v232Report));
    if (!gate) {
      console.log("v232 gate failed; no write");
      process.exitCode = 2;
      return;
    }
    if (!APPLY) {
      console.log("v232 dry-run only");
      return;
    }
    const before232 = await countSnap(db, SNAP232);
    const before231 = await countSnap(db, SNAP231);
    const now = new Date().toISOString();
    let insertedBatches = 0;
    let insertedRows = 0;
    for (const cohort of DECADE_COHORTS_V22) {
      const pending: PricePositionBodyV21[] = [];
      const rl = createInterface({ input: createReadStream(`${bodiesDir}/${cohort.key}.jsonl`), crlfDelay: Infinity });
      const flush = async () => {
        if (!pending.length) return;
        const slice = pending.splice(0, pending.length).map((body) => ({
          sql: `INSERT INTO complex_region_price_position (
                  snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
                  reference_month, status, payload_json, calculated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
          args: [
            SNAP232,
            body.complexId,
            body.areaBand,
            body.transactionAsOf,
            body.areaBandVersion,
            body.referenceMonth,
            body.status,
            JSON.stringify(body),
            now,
          ],
        }));
        let last: unknown = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            await db.batch(slice, "write");
            last = null;
            break;
          } catch (error) {
            last = error;
            await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
          }
        }
        if (last) throw last;
        insertedBatches += 1;
        insertedRows += slice.length;
      };
      for await (const line of rl) {
        if (!line) continue;
        pending.push(JSON.parse(line) as PricePositionBodyV21);
        if (pending.length >= BATCH) await flush();
      }
      await flush();
      console.log(`inserted v232 cohort ${cohort.key}`);
    }
    const after232 = await countSnap(db, SNAP232);
    const after231 = await countSnap(db, SNAP231);
    const after23 = await countSnap(db, SNAP23);
    const after22 = await countSnap(db, SNAP22);
    const afterV2 = num(
      (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
    );
    const after21 = num(
      (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
    );
    let postValueMismatch = 0;
    let postContributorMismatch = 0;
    let postUnavailableMismatch = 0;
    let postRebuiltCells = 0;
    for (const cohort of DECADE_COHORTS_V22) {
      const stored232 = await db.execute({
        sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
        args: [SNAP232, cohort.key],
      });
      const rebuiltById = new Map<string, PricePositionBodyV21>();
      const rl = createInterface({ input: createReadStream(`${bodiesDir}/${cohort.key}.jsonl`), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        const body = JSON.parse(line) as PricePositionBodyV21;
        rebuiltById.set(body.complexId, body);
      }
      for (const row of stored232.rows) {
        const storedBody = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
        const rebuilt = rebuiltById.get(String(row.complex_id));
        if (!rebuilt) {
          postUnavailableMismatch += 1;
          continue;
        }
        for (const scope of ["DONG", "GU", "SEOUL"] as const) {
          const a = storedBody.priceLevel.find((c) => c.scope === scope);
          const b = rebuilt.priceLevel.find((c) => c.scope === scope);
          if (!a || !b) {
            postUnavailableMismatch += 1;
            continue;
          }
          postRebuiltCells += 1;
          if ((a.status ?? null) !== (b.status ?? null)) postUnavailableMismatch += 1;
          if (!sameNum(a.meanPricePerSupplyPyeong, b.meanPricePerSupplyPyeong)) postValueMismatch += 1;
          if ((a.contributingComplexCount ?? null) !== (b.contributingComplexCount ?? null)) postContributorMismatch += 1;
        }
      }
    }
    const postParityGate = postValueMismatch === 0 && postContributorMismatch === 0 && postUnavailableMismatch === 0;
    const delta = {
      v232Rows: after232.rows - before232.rows,
      v231Rows: after231.rows - before231.rows,
      v23Rows: after23.rows - before23.rows,
      v22Rows: after22.rows - before22.rows,
      v21Rows: after21 - beforeV21,
      v2Rows: afterV2 - beforeV2,
      batches: insertedBatches,
      attempted: insertedRows,
      postParity: {
        rebuiltCells: postRebuiltCells,
        valueMismatches: postValueMismatch,
        contributorMismatches: postContributorMismatch,
        unavailableStateMismatches: postUnavailableMismatch,
        gate: postParityGate,
      },
    };
    writeFileSync(v232Path, JSON.stringify({ ...v232Report, delta }));
    console.log("v232 delta", delta);
    if (delta.v231Rows !== 0 || delta.v23Rows !== 0 || delta.v22Rows !== 0 || delta.v21Rows !== 0 || delta.v2Rows !== 0) {
      throw new Error("unrelated snapshot changed");
    }
    if (!postParityGate) {
      console.log("v232 post-apply parity failed");
      process.exitCode = 2;
      return;
    }
    return;
  }

  if (V231) {
    let contributorFail = 0;
    for (const row of contributorAudit) {
      if (row.publishedMedian !== row.canonicalMedian) contributorFail += 1;
      if (row.publishedContributors !== row.canonicalContributors) contributorFail += 1;
    }
    const sampleTally: Record<string, number> = {};
    for (const status of v231Stats.sampleStatus.values()) sampleTally[status] = (sampleTally[status] ?? 0) + 1;
    const gate =
      invariantOk &&
      v231Stats.priceMismatch === 0 &&
      v231Stats.complexMismatch === 0 &&
      v231Stats.structuralMismatch === 0 &&
      v231Stats.missingRebuilt === 0 &&
      v231Stats.invariantKeys.size === 0 &&
      v231Stats.statusOnlyCells.size === 0 &&
      contributorFail === 0;
    const v231Report = {
      version: PRICE_POSITION_V231_VERSION,
      snapshot: SNAP231,
      fingerprint: METHODOLOGY_FINGERPRINT_V231,
      scanned: v231Stats.scanned,
      priceMismatch: v231Stats.priceMismatch,
      complexMismatch: v231Stats.complexMismatch,
      structuralMismatch: v231Stats.structuralMismatch,
      missingRebuilt: v231Stats.missingRebuilt,
      regionalValueCells: v231Stats.regionalValueCells.size,
      statusOnlyCells: v231Stats.statusOnlyCells.size,
      invariantViolations: v231Stats.invariantKeys.size,
      contributorParityFails: contributorFail,
      auditCells: contributorAudit.length,
      sampleTally,
      jamsilComplex1Y,
      invariantOk,
      gate,
    };
    const v231Path = "/tmp/building-hub-bulk/external-evidence/v231-publish-report.json";
    mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
    writeFileSync(v231Path, JSON.stringify(v231Report));
    console.log(`v231 report ${v231Path} gate=${gate}`);
    console.log(JSON.stringify(v231Report));
    if (!gate) {
      console.log("v231 gate failed; no write");
      process.exitCode = 2;
      return;
    }
    if (!APPLY) {
      console.log("v231 dry-run only");
      return;
    }
    const before231 = await countSnap(db, SNAP231);
    const now = new Date().toISOString();
    let insertedBatches = 0;
    let insertedRows = 0;
    for (const cohort of DECADE_COHORTS_V22) {
      const pending: PricePositionBodyV21[] = [];
      const rl = createInterface({ input: createReadStream(`${bodiesDir}/${cohort.key}.jsonl`), crlfDelay: Infinity });
      const flush = async () => {
        if (!pending.length) return;
        const slice = pending.splice(0, pending.length).map((body) => ({
          sql: `INSERT INTO complex_region_price_position (
                  snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
                  reference_month, status, payload_json, calculated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
          args: [
            SNAP231,
            body.complexId,
            body.areaBand,
            body.transactionAsOf,
            body.areaBandVersion,
            body.referenceMonth,
            body.status,
            JSON.stringify(body),
            now,
          ],
        }));
        let last: unknown = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            await db.batch(slice, "write");
            last = null;
            break;
          } catch (error) {
            last = error;
            await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
          }
        }
        if (last) throw last;
        insertedBatches += 1;
        insertedRows += slice.length;
      };
      for await (const line of rl) {
        if (!line) continue;
        pending.push(JSON.parse(line) as PricePositionBodyV21);
        if (pending.length >= BATCH) await flush();
      }
      await flush();
      console.log(`inserted v231 cohort ${cohort.key}`);
    }
    const after231 = await countSnap(db, SNAP231);
    const after23 = await countSnap(db, SNAP23);
    const after22 = await countSnap(db, SNAP22);
    const afterV2 = num(
      (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
    );
    const after21 = num(
      (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
    );
    const delta = {
      v231Rows: after231.rows - before231.rows,
      v23Rows: after23.rows - before23.rows,
      v22Rows: after22.rows - before22.rows,
      v21Rows: after21 - beforeV21,
      v2Rows: afterV2 - beforeV2,
      batches: insertedBatches,
      attempted: insertedRows,
    };
    writeFileSync(v231Path, JSON.stringify({ ...v231Report, delta }));
    console.log("v231 delta", delta);
    if (delta.v23Rows !== 0 || delta.v22Rows !== 0 || delta.v21Rows !== 0 || delta.v2Rows !== 0) {
      throw new Error("unrelated snapshot changed");
    }
    return;
  }

  if (!invariantOk) {
    console.log("invariant failure; no write");
    process.exitCode = 2;
    return;
  }
  if (!APPLY) {
    console.log("dry-run only");
    return;
  }

  const now = new Date().toISOString();
  let insertedBatches = 0;
  for (const cohort of DECADE_COHORTS_V22) {
    const pending: PricePositionBodyV21[] = [];
    const rl = createInterface({ input: createReadStream(`${bodiesDir}/${cohort.key}.jsonl`), crlfDelay: Infinity });
    const flush = async () => {
      if (!pending.length) return;
      const slice = pending.splice(0, pending.length).map((body) => ({
        sql: `INSERT INTO complex_region_price_position (
                snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
                reference_month, status, payload_json, calculated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
        args: [
          SNAP23,
          body.complexId,
          body.areaBand,
          body.transactionAsOf,
          body.areaBandVersion,
          body.referenceMonth,
          body.status,
          JSON.stringify(body),
          now,
        ],
      }));
      let last: unknown = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await db.batch(slice, "write");
          last = null;
          break;
        } catch (error) {
          last = error;
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (last) throw last;
      insertedBatches += 1;
    };
    for await (const line of rl) {
      if (!line) continue;
      pending.push(JSON.parse(line) as PricePositionBodyV21);
      if (pending.length >= BATCH) await flush();
    }
    await flush();
    console.log(`inserted cohort ${cohort.key}`);
  }
  const after23 = await countSnap(db, SNAP23);
  const after22 = await countSnap(db, SNAP22);
  const afterV2 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
  );
  const after21 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
  );
  const delta = {
    v23Rows: after23.rows - before23.rows,
    v22Rows: after22.rows - before22.rows,
    v21Rows: after21 - beforeV21,
    v2Rows: afterV2 - beforeV2,
    after23,
    batches: insertedBatches,
  };
  writeFileSync(REPORT, JSON.stringify({ ...report, delta }));
  console.log("delta", delta);
  if (delta.v22Rows !== 0 || delta.v21Rows !== 0 || delta.v2Rows !== 0) {
    throw new Error("unrelated snapshot changed");
  }
}

function summarizeBody(body: PricePositionBodyV21) {
  const price = (scope: "COMPLEX" | "DONG" | "GU" | "SEOUL") => body.priceLevel.find((cell) => cell.scope === scope);
  return {
    complexId: body.complexId,
    aptName: body.aptName,
    decade: body.regionPyeongDecade,
    status: body.status,
    referenceMonth: body.referenceMonth,
    slices: Object.keys(body.complexExactByMarketLabel ?? {}),
    complex: price("COMPLEX")?.meanPricePerSupplyPyeong ?? null,
    dong: price("DONG")?.status,
    dongN: price("DONG")?.contributingComplexCount ?? null,
    gu: price("GU")?.status,
    seoul: price("SEOUL")?.status,
    trend6: body.trends["6M"].find((cell) => cell.scope === "COMPLEX")?.changePercent ?? null,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
