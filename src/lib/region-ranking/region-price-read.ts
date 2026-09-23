/**
 * Read-only regional Price Position from published COMPLEX cells.
 *
 * Regional representative =
 *   LATEST_ACTIVE COMPLEX means already materialized per complex
 *   + EQUAL_COMPLEX_WEIGHT
 *   + MEDIAN_OF_COMPLEX_MEANS
 *
 * Does NOT use SAME_MONTH DONG/GU/SEOUL cells from a single host payload —
 * those inherit the host complex referenceMonth and can leak COMPLEX values.
 */
import type { RankingReader } from "./query";
import {
  PRICE_POSITION_PUBLIC_VERSION,
  seoulLawdCodes,
} from "./price-position-read";
import {
  pricePositionStorageBand,
  pricePositionV231SnapshotId,
} from "./price-position-v23";
import { DECADE_KEYS_V3, decadeCohortByKey } from "./ranking-v3";
import type { PricePositionBodyV21 } from "./price-position-v21";

export type RegionalPriceScope = "GU" | "DONG";

export type RegionalPriceCell = {
  scope: RegionalPriceScope | "SEOUL";
  label: string;
  meanPricePerSupplyPyeong: number | null;
  status: string;
};

export type RegionalTrendCell = {
  period: "6M" | "1Y" | "2Y" | "5Y";
  scope: RegionalPriceScope;
  changePercent: number | null;
  status: string;
};

export type RegionalPricePositionResult =
  | { status: "unavailable"; reason: string }
  | {
      status: "ok";
      version: string;
      regionCode: string;
      scope: RegionalPriceScope;
      areaBand: string;
      supplyPyeongCohort: string | null;
      /** First contributor id (deterministic) — not the price source alone. */
      hostComplexId: string;
      price: RegionalPriceCell;
      comparisons: RegionalPriceCell[];
      trends: RegionalTrendCell[];
      transactionAsOf: string | null;
      referenceMonth: null;
      asOfMonth: string | null;
      contributorCount: number;
    };

const TREND_PERIODS = ["6M", "1Y", "2Y", "5Y"] as const;

type Contributor = {
  complexId: string;
  mean: number;
  body: PricePositionBodyV21 | null;
};

const seoulMeanCache = new Map<string, number[]>();

function scopeOf(regionCode: string): RegionalPriceScope | null {
  if (/^[0-9]{5}$/.test(regionCode)) return "GU";
  if (/^[0-9]{10}$/.test(regionCode)) return "DONG";
  return null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Fast COMPLEX mean extract without full JSON parse when possible. */
function extractComplexMean(payload: string): number | null {
  const idx = payload.indexOf('"scope":"COMPLEX"');
  if (idx < 0) return null;
  const slice = payload.slice(idx, idx + 280);
  if (!/"status"\s*:\s*"ok"/.test(slice)) return null;
  const m = /"meanPricePerSupplyPyeong"\s*:\s*([0-9]+(?:\.[0-9]+)?)/.exec(slice);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function complexTrends(
  body: PricePositionBodyV21,
): Partial<Record<(typeof TREND_PERIODS)[number], number>> {
  const out: Partial<Record<(typeof TREND_PERIODS)[number], number>> = {};
  for (const period of TREND_PERIODS) {
    const row = (body.trends?.[period] ?? []).find(
      (item) => item.scope === "COMPLEX",
    );
    if (
      row &&
      row.status === "ok" &&
      row.changePercent != null &&
      Number.isFinite(Number(row.changePercent))
    ) {
      out[period] = Number(row.changePercent);
    }
  }
  return out;
}

async function loadContributors(
  db: RankingReader,
  query: {
    lawd: string | null;
    bjdong: string | null;
    areaBand: string;
    /** When true, parse full bodies for trend aggregation. */
    withBodies: boolean;
    seoulOnly?: boolean;
  },
): Promise<Contributor[]> {
  const snapshotId = pricePositionV231SnapshotId();
  const storageBand = pricePositionStorageBand(query.areaBand);

  let sql: string;
  let args: Array<string>;
  if (query.seoulOnly) {
    const lawds = seoulLawdCodes();
    if (!lawds.length) return [];
    const placeholders = lawds.map(() => "?").join(",");
    sql = `SELECT p.complex_id, p.payload_json
           FROM complex_region_price_position p
           JOIN apt_complex_master m ON m.complex_id = p.complex_id
           WHERE p.snapshot_id = ? AND p.area_band = ?
             AND m.lawd_cd IN (${placeholders})
           ORDER BY p.complex_id ASC`;
    args = [snapshotId, storageBand, ...lawds];
  } else if (query.bjdong != null) {
    sql = `SELECT p.complex_id, p.payload_json
           FROM complex_region_price_position p
           JOIN apt_complex_master m ON m.complex_id = p.complex_id
           WHERE p.snapshot_id = ? AND p.area_band = ?
             AND m.lawd_cd = ? AND m.bjdong_cd = ?
           ORDER BY p.complex_id ASC`;
    args = [snapshotId, storageBand, query.lawd!, query.bjdong];
  } else {
    sql = `SELECT p.complex_id, p.payload_json
           FROM complex_region_price_position p
           JOIN apt_complex_master m ON m.complex_id = p.complex_id
           WHERE p.snapshot_id = ? AND p.area_band = ? AND m.lawd_cd = ?
           ORDER BY p.complex_id ASC`;
    args = [snapshotId, storageBand, query.lawd!];
  }

  const rows = await db.execute({ sql, args });
  const out: Contributor[] = [];
  for (const row of rows.rows) {
    const payload = String(row.payload_json);
    const mean = extractComplexMean(payload);
    if (mean == null) continue;
    let body: PricePositionBodyV21 | null = null;
    if (query.withBodies) {
      try {
        body = JSON.parse(payload) as PricePositionBodyV21;
      } catch {
        continue;
      }
    }
    out.push({ complexId: String(row.complex_id), mean, body });
  }
  return out;
}

async function seoulMeans(
  db: RankingReader,
  areaBand: string,
): Promise<number[]> {
  const key = `${pricePositionV231SnapshotId()}|${pricePositionStorageBand(areaBand)}`;
  const cached = seoulMeanCache.get(key);
  if (cached) return cached;
  const rows = await loadContributors(db, {
    lawd: null,
    bjdong: null,
    areaBand,
    withBodies: false,
    seoulOnly: true,
  });
  const means = rows.map((r) => r.mean);
  seoulMeanCache.set(key, means);
  return means;
}

function buildTrends(
  contributors: Contributor[],
  scope: RegionalPriceScope,
): RegionalTrendCell[] {
  const out: RegionalTrendCell[] = [];
  for (const period of TREND_PERIODS) {
    const values: number[] = [];
    for (const item of contributors) {
      if (!item.body) continue;
      const hit = complexTrends(item.body)[period];
      if (hit != null) values.push(hit);
    }
    const med = median(values);
    out.push({
      period,
      scope,
      changePercent: med == null ? null : round4(med),
      status: med == null ? "unavailable" : "ok",
    });
  }
  return out;
}

function scopeLabel(
  contributors: Contributor[],
  scope: RegionalPriceScope,
): string {
  const body = contributors.find((c) => c.body)?.body;
  const hit = (body?.priceLevel ?? []).find((c) => c.scope === scope);
  if (hit?.label) return String(hit.label);
  return scope === "DONG" ? "동" : "구";
}

export async function readRegionalPricePosition(
  db: RankingReader,
  query: {
    regionCode: string;
    areaBand: string;
    /** Ignored for the representative value — API compatibility only. */
    preferredComplexId?: string | null;
  },
): Promise<RegionalPricePositionResult> {
  const scope = scopeOf(query.regionCode);
  if (!scope) {
    return { status: "unavailable", reason: "bad_region" };
  }
  if (!DECADE_KEYS_V3.has(query.areaBand) && query.areaBand !== "ALL") {
    return { status: "unavailable", reason: "bad_band" };
  }
  if (query.areaBand === "ALL") {
    return { status: "unavailable", reason: "no_composite_price" };
  }

  const lawd = query.regionCode.slice(0, 5);
  const bjdong = scope === "DONG" ? query.regionCode.slice(5) : null;

  const [primary, guMeans, seoul] = await Promise.all([
    loadContributors(db, {
      lawd,
      bjdong,
      areaBand: query.areaBand,
      withBodies: true,
    }),
    scope === "DONG"
      ? loadContributors(db, {
          lawd,
          bjdong: null,
          areaBand: query.areaBand,
          withBodies: false,
        }).then((rows) => rows.map((r) => r.mean))
      : Promise.resolve([] as number[]),
    seoulMeans(db, query.areaBand),
  ]);

  if (!primary.length) {
    return { status: "unavailable", reason: "no_host" };
  }

  const primaryMedian = median(primary.map((row) => row.mean));
  if (primaryMedian == null) {
    return { status: "unavailable", reason: "no_cell" };
  }

  const comparisons: RegionalPriceCell[] = [];
  if (scope === "DONG") {
    const guMed = median(guMeans);
    if (guMed != null) {
      comparisons.push({
        scope: "GU",
        label: scopeLabel(primary, "GU"),
        meanPricePerSupplyPyeong: round4(guMed),
        status: "ok",
      });
    }
  }
  const seoulMed = median(seoul);
  if (seoulMed != null) {
    comparisons.push({
      scope: "SEOUL",
      label: "서울",
      meanPricePerSupplyPyeong: round4(seoulMed),
      status: "ok",
    });
  }

  const asOfCandidates = primary
    .map((row) => row.body?.transactionAsOf?.trim() || "")
    .filter(Boolean)
    .sort();
  const asOf = asOfCandidates.length
    ? asOfCandidates[asOfCandidates.length - 1]!
    : null;
  const asOfMonth = asOf && asOf.length >= 7 ? asOf.slice(0, 7) : null;
  const cohort =
    primary.find((c) => c.body)?.body?.supplyPyeongCohort?.trim() ||
    decadeCohortByKey(query.areaBand)?.label ||
    null;

  return {
    status: "ok",
    version: PRICE_POSITION_PUBLIC_VERSION,
    regionCode: query.regionCode,
    scope,
    areaBand: query.areaBand,
    supplyPyeongCohort: cohort,
    hostComplexId: primary[0]!.complexId,
    price: {
      scope,
      label: scopeLabel(primary, scope),
      meanPricePerSupplyPyeong: round4(primaryMedian),
      status: "ok",
    },
    comparisons,
    trends: buildTrends(primary, scope),
    transactionAsOf: asOf,
    referenceMonth: null,
    asOfMonth,
    contributorCount: primary.length,
  };
}
