/**
 * 서울 25개 구 + 법정동 지역 시세 평당가 월별 시계열을 region_price_index에 적재한다.
 * 이 테이블 외에는 쓰지 않는다.
 *   npx tsx scripts/materialize-region-price-index.ts [lawdCd ...]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { InStatement } from "@libsql/client";
import { getDb } from "../src/lib/db/client";
import { seoulGuName, seoulLawdCodes } from "../src/lib/region-ranking/price-position-read";
import {
  ensureRegionPriceIndexTable,
  REGION_PRICE_INDEX_METHOD,
  REGION_PRICE_INDEX_TABLE,
} from "../src/lib/region/region-price-index";
import {
  computeRegionPriceSeries,
  type RegionPriceRawPoint,
} from "../src/lib/region/region-price-trend";

const ROWS_PER_STATEMENT = 200;

type Row = {
  scope: "gu" | "dong";
  code: string;
  name: string;
  point: RegionPriceRawPoint;
};

function insertStatements(rows: Row[], calculatedAt: string): InStatement[] {
  const statements: InStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    statements.push({
      sql: `INSERT OR REPLACE INTO ${REGION_PRICE_INDEX_TABLE}
              (method_version, scope, region_code, region_name, year_month,
               pyeong_price, complex_count, trade_count, calculated_at)
            VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      args: chunk.flatMap((r) => [
        REGION_PRICE_INDEX_METHOD,
        r.scope,
        r.code,
        r.name,
        r.point.yearMonth,
        r.point.pyeongPrice,
        r.point.complexCount,
        r.point.tradeCount,
        calculatedAt,
      ]),
    });
  }
  return statements;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL is not configured");
  await ensureRegionPriceIndexTable(db);

  const requested = process.argv.slice(2).filter((a) => /^\d{5}$/.test(a));
  const codes = requested.length ? requested : seoulLawdCodes();
  const calculatedAt = new Date().toISOString();
  const started = performance.now();
  let guRows = 0;
  let dongRows = 0;

  for (const [i, lawdCd] of codes.entries()) {
    const t0 = performance.now();
    const series = await computeRegionPriceSeries(db, lawdCd);
    const tCompute = performance.now() - t0;
    const guName = seoulGuName(lawdCd) ?? lawdCd;
    const rows: Row[] = [
      ...series.points.map((point) => ({ scope: "gu" as const, code: lawdCd, name: guName, point })),
      ...series.dongs.flatMap((d) =>
        d.points.map((point) => ({
          scope: "dong" as const,
          code: `${lawdCd}${d.bjdongCd}`,
          name: d.name,
          point,
        })),
      ),
    ];
    const [lo, hi] = [`${lawdCd}00000`, `${lawdCd}99999`];
    const statements: InStatement[] = [
      {
        sql: `DELETE FROM ${REGION_PRICE_INDEX_TABLE}
              WHERE method_version = ?
                AND ((scope = 'gu' AND region_code = ?)
                  OR (scope = 'dong' AND region_code BETWEEN ? AND ?))`,
        args: [REGION_PRICE_INDEX_METHOD, lawdCd, lo, hi],
      },
      ...insertStatements(rows, calculatedAt),
    ];
    await db.batch(statements, "write");
    const gu = series.points.length;
    const dong = rows.length - gu;
    guRows += gu;
    dongRows += dong;
    const tail = series.points[series.points.length - 1];
    console.log(
      JSON.stringify({
        step: `${i + 1}/${codes.length}`,
        lawdCd,
        name: guName,
        months: gu ? `${series.points[0]!.yearMonth}-${tail!.yearMonth}` : null,
        latest: tail?.pyeongPrice != null ? Math.round(tail.pyeongPrice) : null,
        dongs: series.dongs.length,
        guRows: gu,
        dongRows: dong,
        computeMs: Math.round(tCompute),
        totalMs: Math.round(performance.now() - t0),
      }),
    );
  }

  const summary = await db.execute({
    sql: `SELECT scope, COUNT(*) AS n, COUNT(DISTINCT region_code) AS regions,
                 MIN(year_month) AS min_ym, MAX(year_month) AS max_ym
          FROM ${REGION_PRICE_INDEX_TABLE}
          WHERE method_version = ?
          GROUP BY scope`,
    args: [REGION_PRICE_INDEX_METHOD],
  });
  console.log(
    JSON.stringify({
      written: { guRows, dongRows },
      table: summary.rows.map((r) => ({ ...r })),
      elapsedSec: Math.round((performance.now() - started) / 100) / 10,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
