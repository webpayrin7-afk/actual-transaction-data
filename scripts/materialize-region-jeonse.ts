/**
 * 서울 25개 구 전세가율 월별 시계열 · 기준월 목록을 region_jeonse_index / region_jeonse_snapshot에 적재한다.
 * 이 두 테이블 외에는 쓰지 않는다.
 *   npx tsx scripts/materialize-region-jeonse.ts [lawdCd ...]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { InStatement } from "@libsql/client";
import { getDb } from "../src/lib/db/client";
import { seoulGuName, seoulLawdCodes } from "../src/lib/region-ranking/price-position-read";
import {
  computeRegionJeonse,
  ensureRegionJeonseTables,
  REGION_JEONSE_INDEX_TABLE,
  REGION_JEONSE_METHOD,
  REGION_JEONSE_SNAPSHOT_TABLE,
  regionJeonseSnapshot,
  type RegionJeonsePoint,
} from "../src/lib/region/region-jeonse";

const ROWS_PER_STATEMENT = 200;

function insertStatements(lawdCd: string, points: RegionJeonsePoint[], calculatedAt: string): InStatement[] {
  const statements: InStatement[] = [];
  for (let i = 0; i < points.length; i += ROWS_PER_STATEMENT) {
    const chunk = points.slice(i, i + ROWS_PER_STATEMENT);
    statements.push({
      sql: `INSERT OR REPLACE INTO ${REGION_JEONSE_INDEX_TABLE}
              (method_version, lawd_cd, year_month, jeonse_ratio, pair_count, calculated_at)
            VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      args: chunk.flatMap((p) => [
        REGION_JEONSE_METHOD,
        lawdCd,
        p.yearMonth,
        p.jeonseRatio,
        p.pairCount,
        calculatedAt,
      ]),
    });
  }
  return statements;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL is not configured");
  await ensureRegionJeonseTables(db);

  const requested = process.argv.slice(2).filter((a) => /^\d{5}$/.test(a));
  const codes = requested.length ? requested : seoulLawdCodes();
  const calculatedAt = new Date().toISOString();
  const started = performance.now();
  let seriesRows = 0;

  for (const [i, lawdCd] of codes.entries()) {
    const t0 = performance.now();
    const value = await computeRegionJeonse(db, lawdCd);
    const tCompute = performance.now() - t0;
    const snapshot = regionJeonseSnapshot(value);
    await db.batch(
      [
        {
          sql: `DELETE FROM ${REGION_JEONSE_INDEX_TABLE} WHERE method_version = ? AND lawd_cd = ?`,
          args: [REGION_JEONSE_METHOD, lawdCd],
        },
        ...insertStatements(lawdCd, value.series, calculatedAt),
        {
          sql: `INSERT OR REPLACE INTO ${REGION_JEONSE_SNAPSHOT_TABLE}
                  (method_version, lawd_cd, as_of_month, payload_json, calculated_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: [REGION_JEONSE_METHOD, lawdCd, value.asOfMonth, JSON.stringify(snapshot), calculatedAt],
        },
      ],
      "write",
    );
    seriesRows += value.series.length;
    console.log(
      JSON.stringify({
        step: `${i + 1}/${codes.length}`,
        lawdCd,
        name: seoulGuName(lawdCd) ?? lawdCd,
        asOfMonth: value.asOfMonth,
        jeonseRatio: value.latest.jeonseRatio,
        pairCount: value.latest.pairCount,
        change1yPp: value.latest.change1yPp,
        listed: value.lowGap.length,
        below2y: `${value.jeonseBelow2yAgo.count}/${value.jeonseBelow2yAgo.eligible}`,
        computeMs: Math.round(tCompute),
        totalMs: Math.round(performance.now() - t0),
      }),
    );
  }

  const summary = await db.execute({
    sql: `SELECT COUNT(*) AS n, COUNT(DISTINCT lawd_cd) AS regions,
                 MIN(year_month) AS min_ym, MAX(year_month) AS max_ym
          FROM ${REGION_JEONSE_INDEX_TABLE}
          WHERE method_version = ?`,
    args: [REGION_JEONSE_METHOD],
  });
  const snaps = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ${REGION_JEONSE_SNAPSHOT_TABLE} WHERE method_version = ?`,
    args: [REGION_JEONSE_METHOD],
  });
  console.log(
    JSON.stringify({
      written: { seriesRows, snapshots: codes.length },
      table: { ...summary.rows[0], snapshots: Number(snaps.rows[0]?.n ?? 0) },
      elapsedSec: Math.round((performance.now() - started) / 100) / 10,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
