/**
 * READ-ONLY: first_seen 월 분포 + 기존 all-time vs MAX aggregate 비교.
 * production write 없음.
 *   npx tsx scripts/probe-region-prior-max.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb, ensureSchema } from "../src/lib/db/client";
import { getRegion } from "../src/lib/constants/regions";
import { seoulDateOf } from "../src/lib/market/time";

const SLUGS = [
  "seoul-gangnam",
  "seoul-songpa",
  "gyeonggi-seongnam",
  "gyeonggi-suwon",
  "gyeonggi-gwangju",
  "seoul-yongsan",
];

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  console.log(`  ${label}: ${Math.round(performance.now() - t0)}ms`);
  return result;
}

async function main() {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("no db");

  const start = "2026-09-01T00:00:00+09:00";
  const end = "2026-10-01T00:00:00+09:00";
  // 아래 타이밍 구간만 재실행할 때 분포 루프를 건너뛰려면 주석.

  for (const slug of SLUGS) {
    const region = getRegion(slug);
    if (!region) continue;
    const lawds = region.lawdCodes;
    const ph = lawds.map(() => "?").join(",");
    const rows = await db.execute({
      sql: `SELECT first_seen_at, apt_name_norm, exclusive_area, deal_date, deal_amount
            FROM transactions
            WHERE lawd_cd IN (${ph})
              AND deal_type = 'trade'
              AND first_seen_at IS NOT NULL AND first_seen_at != ''
              AND first_seen_at >= ? AND first_seen_at < ?`,
      args: [...lawds, start, end],
    });
    const byDay = new Map<string, number>();
    const norms = new Set<string>();
    for (const row of rows.rows) {
      const day = seoulDateOf(String(row.first_seen_at));
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      norms.add(String(row.apt_name_norm));
    }
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    console.log(`\n=== ${slug} lawds=${lawds.join(",")} ===`);
    console.log(
      JSON.stringify({
        n: rows.rows.length,
        uniqueApts: norms.size,
        days: days.map(([d, n]) => ({ d, n })),
      }),
    );
  }

  const songpa = getRegion("seoul-songpa")!;
  const songpaLawd = songpa.lawdCodes[0]!;
  const sample = await db.execute({
    sql: `SELECT apt_name_norm, exclusive_area, deal_date, deal_amount, first_seen_at
          FROM transactions
          WHERE lawd_cd = ? AND deal_type = 'trade'
            AND first_seen_at IS NOT NULL AND first_seen_at != ''
            AND first_seen_at >= ? AND first_seen_at < ?
          ORDER BY deal_amount DESC
          LIMIT 8`,
    args: [songpaLawd, start, end],
  });
  const cands = sample.rows.map((row) => ({
    norm: String(row.apt_name_norm),
    area: Number(row.exclusive_area),
    date: String(row.deal_date).slice(0, 10),
    amt: Number(row.deal_amount),
  }));
  console.log("\n송파 sample candidates", cands);

  const names = [...new Set(cands.map((c) => c.norm))];
  const namePh = names.map(() => "?").join(",");

  console.log("\nEXPLAIN old IN history");
  const explainOld = await db.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT id, apt_name_norm, exclusive_area, deal_date, deal_amount
          FROM transactions
          WHERE lawd_cd = ?
            AND deal_type = 'trade'
            AND apt_name_norm IN (${namePh})`,
    args: [songpaLawd, ...names],
  });
  console.log(explainOld.rows);

  const oldRows = await time("old IN history rows", () =>
    db.execute({
      sql: `SELECT id, apt_name_norm, exclusive_area, deal_date, deal_amount
            FROM transactions
            WHERE lawd_cd = ?
              AND deal_type = 'trade'
              AND apt_name_norm IN (${namePh})`,
      args: [songpaLawd, ...names],
    }),
  );
  console.log("  rows", oldRows.rows.length);

  console.log("\nEXPLAIN MAX per candidate");
  const first = cands[0]!;
  const explainMax = await db.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT MAX(deal_amount) AS prior_max
          FROM transactions
          WHERE lawd_cd = ?
            AND deal_type = 'trade'
            AND apt_name_norm = ?
            AND deal_date < ?
            AND CAST(ROUND(exclusive_area * 100) AS INTEGER) = ?`,
    args: [
      songpaLawd,
      first.norm,
      first.date,
      Math.round(first.area * 100),
    ],
  });
  console.log(explainMax.rows);

  await time("MAX union 8 candidates", async () => {
    const parts: string[] = [];
    const args: Array<string | number> = [];
    cands.forEach((c, i) => {
      parts.push(
        `SELECT ${i} AS i, MAX(deal_amount) AS prior_max
         FROM transactions
         WHERE lawd_cd = ?
           AND deal_type = 'trade'
           AND apt_name_norm = ?
           AND deal_date < ?
           AND CAST(ROUND(exclusive_area * 100) AS INTEGER) = ?`,
      );
      args.push(songpaLawd, c.norm, c.date, Math.round(c.area * 100));
    });
    const r = await db.execute({ sql: parts.join("\nUNION ALL\n"), args });
    console.log("  max rows", r.rows);
    return r;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
