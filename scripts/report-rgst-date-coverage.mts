/**
 * Registration lag + post-backfill coverage report (READ ONLY).
 *   npx tsx scripts/report-rgst-date-coverage.mts
 */
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

function pct(filled: number, total: number): number {
  if (!total) return 0;
  return Math.round((filled / total) * 1000) / 10;
}

async function cov(label: string, where: string, args: Array<string | number> = []) {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN rgst_date IS NOT NULL AND trim(rgst_date) != '' THEN 1 ELSE 0 END) AS filled
          FROM transactions
          WHERE deal_type='trade' AND deal_date >= '2023-01-01' AND (${where})`,
    args,
  });
  const total = Number(r.rows[0]?.total ?? 0);
  const filled = Number(r.rows[0]?.filled ?? 0);
  return {
    label,
    total,
    filled,
    unresolved: total - filled,
    coveragePct: pct(filled, total),
  };
}

function daysBetween(a: string, b: string): number | null {
  const da = Date.parse(a);
  const db_ = Date.parse(b);
  if (!Number.isFinite(da) || !Number.isFinite(db_)) return null;
  return Math.round((db_ - da) / 86400000);
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function main() {
  const scopes = await Promise.all([
    cov("NATIONAL", "1=1"),
    cov("SEOUL", "lawd_cd LIKE '11%'"),
    cov("GYEONGGI", "lawd_cd LIKE '41%'"),
    cov("INCHEON", "lawd_cd LIKE '28%'"),
    cov("BUSAN", "lawd_cd LIKE '26%'"),
    cov("SONGPA", "lawd_cd = '11710'"),
    cov("JAMSIL_ELS", "apt_name LIKE ?", ["%잠실엘스%"]),
  ]);

  const years = [];
  for (const y of ["2023", "2024", "2025", "2026"]) {
    years.push(
      await cov(
        y,
        "deal_date >= ? AND deal_date < ?",
        [`${y}-01-01`, `${Number(y) + 1}-01-01`],
      ),
    );
  }

  // lag sample: Songpa + national sample capped
  const lagRows = await db.execute({
    sql: `SELECT deal_date, rgst_date FROM transactions
          WHERE deal_type='trade'
            AND deal_date >= '2023-01-01'
            AND rgst_date IS NOT NULL AND trim(rgst_date) != ''
            AND lawd_cd = '11710'
          LIMIT 20000`,
  });
  const lags: number[] = [];
  for (const row of lagRows.rows) {
    const d = daysBetween(String(row.deal_date), String(row.rgst_date));
    if (d != null && d >= 0 && d < 800) lags.push(d);
  }
  lags.sort((a, b) => a - b);

  const safety = await db.execute(`
    SELECT
      SUM(CASE WHEN deal_type='trade' AND deal_date < '2023-01-01' AND rgst_date IS NOT NULL AND trim(rgst_date)!='' THEN 1 ELSE 0 END) AS pre2023_populated,
      SUM(CASE WHEN deal_type='trade' AND rgst_date IS NOT NULL AND trim(rgst_date)!='' AND rgst_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN 1 ELSE 0 END) AS invalid_fmt
    FROM transactions
  `);

  const recommendedWindow =
    (percentile(lags, 95) ?? 0) <= 180
      ? 6
      : 12;

  console.log(
    JSON.stringify(
      {
        coverage: scopes,
        year: years,
        registrationLagDays: {
          n: lags.length,
          median: percentile(lags, 50),
          p75: percentile(lags, 75),
          p90: percentile(lags, 90),
          p95: percentile(lags, 95),
          recommendedRollingMonths: recommendedWindow,
        },
        safety: safety.rows[0],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
