/**
 * Build the complex price-position snapshot from warehouse sales.
 * Bounded to HISTORY_FLOOR_MONTH through transaction_as_of.
 * Does not rewrite region ranking or overview metrics.
 *
 * Usage: npx tsx scripts/region-ranking/build-price-position.mts [--read-only]
 */
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { activeAreaBand, type RegionalAreaBandId } from "../../src/lib/region-ranking/area-band";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import {
  attachIdentity,
  buildSnapshotStats,
  HISTORY_FLOOR_MONTH,
  materializePayloads,
  PRICE_POSITION_AS_OF,
  pricePositionSnapshotId,
  type PricePositionBody,
  type SalePoint,
} from "../../src/lib/region-ranking/price-position";
import { readComplexPricePosition, seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";

const BANDS: RegionalAreaBandId[] = ["59", "84", "114"];
const READ_ONLY = process.argv.includes("--read-only");
const JAMSIL = "cx_4c63d9a100973c60";

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso env");
  return createClient({ url, authToken });
}

async function ensureTable(db: Client) {
  const sql = readFileSync("src/lib/db/migrations/20260922_complex_price_position.sql", "utf8");
  const precheck = precheckAdditiveCreateSql(sql);
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!);
    }
  }));
}

async function writePayloads(db: Client, areaBand: RegionalAreaBandId, bodies: PricePositionBody[]) {
  const snapshotId = pricePositionSnapshotId();
  const now = new Date().toISOString();
  for (let i = 0; i < bodies.length; i += 40) {
    const slice = bodies.slice(i, i + 40).map((body) => ({
      sql: `INSERT INTO complex_region_price_position (
              snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
              reference_month, status, payload_json, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_id, complex_id, area_band) DO UPDATE SET
              transaction_as_of = excluded.transaction_as_of,
              area_band_version = excluded.area_band_version,
              reference_month = excluded.reference_month,
              status = excluded.status,
              payload_json = excluded.payload_json,
              calculated_at = excluded.calculated_at`,
      args: [
        snapshotId,
        body.complexId,
        areaBand,
        body.transactionAsOf,
        body.areaBandVersion,
        body.referenceMonth,
        body.status,
        JSON.stringify(body),
        now,
      ],
    }));
    await db.batch(slice, "write");
  }
}

async function loadBand(
  db: Client,
  areaBand: RegionalAreaBandId,
  names: Map<string, { aptName: string; legalDongName: string; lawdCd: string; bjdongCd: string; aptNameNorm: string }>,
  byName: Map<string, string>,
  ambiguous: Set<string>,
) {
  const band = activeAreaBand(areaBand);
  if (band.exclusiveSqmMin == null || band.exclusiveSqmMax == null) throw new Error(`band ${areaBand}`);
  const min = band.exclusiveSqmMin;
  const max = band.exclusiveSqmMax;
  const floor = HISTORY_FLOOR_MONTH.replace("-", "");
  const asOfMonth = PRICE_POSITION_AS_OF.slice(0, 7).replace("-", "");
  const points: SalePoint[] = [];
  await mapPool(seoulLawdCodes(), 4, async (lawd) => {
    const started = Date.now();
    const rows = await db.execute({
      sql: `SELECT apt_name_norm, substr(deal_date, 1, 7) AS ym,
                   deal_amount * 1.0 / exclusive_area AS ppsqm
            FROM transactions
            WHERE lawd_cd = ?
              AND deal_type = 'trade'
              AND year_month >= ?
              AND year_month <= ?
              AND deal_date <= ?
              AND exclusive_area >= ?
              AND exclusive_area <= ?
              AND deal_amount > 0
              AND exclusive_area > 0`,
      args: [lawd, floor, asOfMonth, PRICE_POSITION_AS_OF, min, max],
    });
    for (const row of rows.rows) {
      const norm = String(row.apt_name_norm);
      if (ambiguous.has(`${lawd}|${norm}`)) continue;
      const complexId = byName.get(`${lawd}|${norm}`);
      const master = complexId ? names.get(complexId) : undefined;
      if (!complexId || !master) continue;
      const price = Number(row.ppsqm);
      if (!Number.isFinite(price) || price <= 0) continue;
      points.push({
        complexId,
        lawdCd: lawd,
        bjdongCd: master.bjdongCd,
        yearMonth: String(row.ym),
        pricePerSqm: price,
      });
    }
    console.log(JSON.stringify({ areaBand, lawd, rows: rows.rows.length, kept: points.length, ms: Date.now() - started }));
  });
  return points;
}

function indexMasters(rows: Array<Record<string, unknown>>) {
  const names = new Map<string, { aptName: string; legalDongName: string; lawdCd: string; bjdongCd: string; aptNameNorm: string }>();
  const byName = new Map<string, string>();
  for (const row of rows) {
    const complexId = String(row.complex_id);
    const lawdCd = String(row.lawd_cd);
    const aptNameNorm = String(row.apt_name_norm);
    const record = {
      aptName: row.apt_name == null ? aptNameNorm : String(row.apt_name),
      legalDongName: row.legal_dong_name == null ? "" : String(row.legal_dong_name),
      lawdCd,
      bjdongCd: String(row.bjdong_cd),
      aptNameNorm,
    };
    names.set(complexId, record);
    byName.set(`${lawdCd}|${aptNameNorm}`, complexId);
  }
  return { names, byName };
}

async function main() {
  const db = client();
  await ensureTable(db);
  if (!READ_ONLY) {
    const lawds = seoulLawdCodes();
    const masters = await db.execute({
      sql: `SELECT complex_id, lawd_cd, bjdong_cd, apt_name_norm, apt_name, legal_dong_name
            FROM apt_complex_master
            WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
      args: lawds,
    });
    const ambiguousRows = await db.execute({
      sql: `SELECT lawd_cd, apt_name_norm FROM apt_complex_master
            WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})
            GROUP BY lawd_cd, apt_name_norm
            HAVING COUNT(*) > 1`,
      args: lawds,
    });
    const ambiguous = new Set(ambiguousRows.rows.map((row) => `${row.lawd_cd}|${row.apt_name_norm}`));
    const { names, byName } = indexMasters(masters.rows as Array<Record<string, unknown>>);
    for (const areaBand of BANDS) {
      const started = Date.now();
      const resolved = await loadBand(db, areaBand, names, byName, ambiguous);
      const built = buildSnapshotStats(resolved);
      const named = attachIdentity(built.references, new Map([...names.entries()].map(([id, row]) => [id, { aptName: row.aptName, legalDongName: row.legalDongName }])));
      const bodies = materializePayloads({
        areaBand,
        references: named,
        buckets: built.buckets,
        guName: (lawd) => seoulGuName(lawd) ?? "구",
      });
      await writePayloads(db, areaBand, bodies);
      console.log(JSON.stringify({
        areaBand,
        points: resolved.length,
        complexes: bodies.length,
        ms: Date.now() - started,
      }));
    }
  }

  const timings: number[] = [];
  let body: PricePositionBody | null = null;
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    const found = await readComplexPricePosition(db, { complexId: JAMSIL, areaBand: "84" });
    timings.push(Date.now() - started);
    if (found.kind === "body") body = found.body;
  }
  if (!body) throw new Error("jamsil payload missing");
  const brief = (scope: string, rows: Array<{ scope: string; status: string; medianPricePerPyeong?: number | null; tradeCount?: number | null; sampleCount?: number | null; changePercent?: number | null; currentTradeCount?: number | null; baselineTradeCount?: number | null }>) => {
    const row = rows.find((item) => item.scope === scope);
    return row ?? null;
  };
  console.log(JSON.stringify({
    timings,
    referenceMonth: body.referenceMonth,
    priceLevel: body.priceLevel.map((row) => brief(row.scope, body!.priceLevel)),
    trends: {
      "3M": body.trends["3M"].map((row) => ({ scope: row.scope, status: row.status, changePercent: row.changePercent, currentTradeCount: row.currentTradeCount, baselineTradeCount: row.baselineTradeCount })),
      "6M": body.trends["6M"].map((row) => ({ scope: row.scope, status: row.status, changePercent: row.changePercent, currentTradeCount: row.currentTradeCount, baselineTradeCount: row.baselineTradeCount })),
      "1Y": body.trends["1Y"].map((row) => ({ scope: row.scope, status: row.status, changePercent: row.changePercent, currentTradeCount: row.currentTradeCount, baselineTradeCount: row.baselineTradeCount })),
      "3Y": body.trends["3Y"].map((row) => ({ scope: row.scope, status: row.status, changePercent: row.changePercent, currentTradeCount: row.currentTradeCount, baselineTradeCount: row.baselineTradeCount })),
    },
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
