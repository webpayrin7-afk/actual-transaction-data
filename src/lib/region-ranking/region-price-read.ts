/**
 * Read-only regional Price Position cells from published complex payloads.
 * Does not score, recompute, or invent regional means.
 */
import type { RankingReader } from "./query";
import {
  PRICE_POSITION_PUBLIC_VERSION,
  readComplexPricePosition,
} from "./price-position-read";
import {
  pricePositionStorageBand,
  pricePositionV231SnapshotId,
} from "./price-position-v23";
import { DECADE_KEYS_V3, decadeCohortByKey } from "./ranking-v3";
import type { PricePositionBodyV21 } from "./price-position-v21";

export type RegionalPriceScope = "GU" | "DONG";

export type RegionalPriceCell = {
  scope: RegionalPriceScope;
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
      /** Host complex used only to read published regional cells — never shown as the region value. */
      hostComplexId: string;
      price: RegionalPriceCell;
      trends: RegionalTrendCell[];
      transactionAsOf: string | null;
      /** Regional representative price has no single contributor month. */
      referenceMonth: null;
      asOfMonth: string | null;
    };

function scopeOf(regionCode: string): RegionalPriceScope | null {
  if (/^[0-9]{5}$/.test(regionCode)) return "GU";
  if (/^[0-9]{10}$/.test(regionCode)) return "DONG";
  return null;
}

function pickCell(
  body: PricePositionBodyV21,
  scope: RegionalPriceScope,
): RegionalPriceCell | null {
  const row = (body.priceLevel ?? []).find((item) => item.scope === scope);
  if (!row) return null;
  return {
    scope,
    label: String(row.label ?? (scope === "GU" ? "구" : "동")),
    meanPricePerSupplyPyeong:
      row.meanPricePerSupplyPyeong == null
        ? null
        : Number(row.meanPricePerSupplyPyeong),
    status: String(row.status ?? "unavailable"),
  };
}

function pickTrends(
  body: PricePositionBodyV21,
  scope: RegionalPriceScope,
): RegionalTrendCell[] {
  const out: RegionalTrendCell[] = [];
  for (const period of ["6M", "1Y", "2Y", "5Y"] as const) {
    const rows = body.trends?.[period] ?? [];
    const row = rows.find((item) => item.scope === scope);
    if (!row) continue;
    out.push({
      period,
      scope,
      changePercent:
        row.changePercent == null ? null : Number(row.changePercent),
      status: String(row.status ?? "unavailable"),
    });
  }
  return out;
}

async function resolveHostComplexId(
  db: RankingReader,
  query: {
    regionCode: string;
    areaBand: string;
    preferredComplexId?: string | null;
  },
): Promise<string | null> {
  const scope = scopeOf(query.regionCode);
  if (!scope) return null;
  const lawd = query.regionCode.slice(0, 5);
  const bjdong = scope === "DONG" ? query.regionCode.slice(5) : null;
  const storageBand = pricePositionStorageBand(query.areaBand);
  const snapshotId = pricePositionV231SnapshotId();
  const preferred = query.preferredComplexId?.trim() ?? "";

  if (/^cx_[0-9a-f]{16}$/.test(preferred)) {
    const master = await db.execute({
      sql: `SELECT lawd_cd, bjdong_cd FROM apt_complex_master WHERE complex_id = ?`,
      args: [preferred],
    });
    const row = master.rows[0];
    if (
      row &&
      String(row.lawd_cd) === lawd &&
      (bjdong == null || String(row.bjdong_cd) === bjdong)
    ) {
      return preferred;
    }
  }

  const candidates = await db.execute({
    sql:
      bjdong == null
        ? `SELECT p.complex_id
           FROM complex_region_price_position p
           JOIN apt_complex_master m ON m.complex_id = p.complex_id
           WHERE p.snapshot_id = ? AND p.area_band = ? AND m.lawd_cd = ?
           ORDER BY p.complex_id ASC
           LIMIT 16`
        : `SELECT p.complex_id
           FROM complex_region_price_position p
           JOIN apt_complex_master m ON m.complex_id = p.complex_id
           WHERE p.snapshot_id = ? AND p.area_band = ?
             AND m.lawd_cd = ? AND m.bjdong_cd = ?
           ORDER BY p.complex_id ASC
           LIMIT 16`,
    args:
      bjdong == null
        ? [snapshotId, storageBand, lawd]
        : [snapshotId, storageBand, lawd, bjdong],
  });

  for (const row of candidates.rows) {
    const id = String(row.complex_id);
    const hit = await readComplexPricePosition(db, {
      complexId: id,
      areaBand: storageBand,
    });
    if (hit.kind !== "body" || hit.body.status !== "ok") continue;
    const cell = pickCell(hit.body, scope);
    if (cell && cell.status === "ok" && cell.meanPricePerSupplyPyeong != null) {
      return id;
    }
  }
  return null;
}

export async function readRegionalPricePosition(
  db: RankingReader,
  query: {
    regionCode: string;
    areaBand: string;
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

  const hostComplexId = await resolveHostComplexId(db, query);
  if (!hostComplexId) {
    return { status: "unavailable", reason: "no_host" };
  }

  const hit = await readComplexPricePosition(db, {
    complexId: hostComplexId,
    areaBand: query.areaBand,
  });
  if (hit.kind !== "body" || hit.body.status !== "ok") {
    return { status: "unavailable", reason: "unpublished" };
  }

  const cell = pickCell(hit.body, scope);
  if (!cell || cell.status !== "ok" || cell.meanPricePerSupplyPyeong == null) {
    return { status: "unavailable", reason: "no_cell" };
  }

  const asOf = hit.body.transactionAsOf?.trim() || null;
  const asOfMonth = asOf && asOf.length >= 7 ? asOf.slice(0, 7) : null;
  const cohort =
    hit.body.supplyPyeongCohort?.trim() ||
    decadeCohortByKey(query.areaBand)?.label ||
    null;

  return {
    status: "ok",
    version: String(hit.body.version ?? PRICE_POSITION_PUBLIC_VERSION),
    regionCode: query.regionCode,
    scope,
    areaBand: query.areaBand,
    supplyPyeongCohort: cohort,
    hostComplexId,
    price: cell,
    trends: pickTrends(hit.body, scope),
    transactionAsOf: asOf,
    referenceMonth: null,
    asOfMonth,
  };
}
