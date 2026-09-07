/**
 * 신고가/하락 sample 검증 (스냅샷 계산 로직과 동일 키)
 *   npx tsx scripts/verify-market-samples.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getDb, ensureSchema } from "../src/lib/db/client";
import { getMarketHome, computeMarketHome } from "../src/lib/market/home";

function areaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

async function priorMax(params: {
  norm: string;
  lawdCd: string;
  dong: string;
  area: number;
  beforeDate: string;
  beforeId: string;
}): Promise<number> {
  const db = getDb()!;
  const areaCents = Math.round(params.area * 100);
  const result = await db.execute({
    sql: `SELECT MAX(deal_amount) AS m
          FROM transactions
          WHERE deal_type = 'trade'
            AND apt_name_norm = ?
            AND lawd_cd = ?
            AND dong = ?
            AND ROUND(exclusive_area * 100) = ?
            AND (
              deal_date < ?
              OR (deal_date = ? AND id < ?)
            )`,
    args: [
      params.norm,
      params.lawdCd,
      params.dong,
      areaCents,
      params.beforeDate,
      params.beforeDate,
      params.beforeId,
    ],
  });
  return Number(result.rows[0]?.m ?? 0);
}

async function main() {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("no db");

  // 스냅샷 기준 목록 (없으면 계산)
  let data = await getMarketHome();
  if (data.source === "empty" || (!data.singoga.length && !data.drops.length)) {
    data = await computeMarketHome();
  }

  console.log("--- singoga samples ---");
  for (const item of data.singoga.slice(0, 3)) {
    const row = await db.execute({
      sql: `SELECT id, apt_name_norm, lawd_cd, dong, exclusive_area, deal_amount, deal_date
            FROM transactions WHERE id = ?`,
      args: [item.id],
    });
    const r = row.rows[0];
    if (!r) {
      console.log("missing", item.id);
      continue;
    }
    const prior = await priorMax({
      norm: String(r.apt_name_norm),
      lawdCd: String(r.lawd_cd),
      dong: String(r.dong ?? ""),
      area: Number(r.exclusive_area),
      beforeDate: String(r.deal_date),
      beforeId: String(r.id),
    });
    const ok =
      prior === (item.priorMaxAmount ?? 0) &&
      Number(r.deal_amount) > prior &&
      prior > 0;
    console.log({
      apt: item.aptName,
      dong: item.dong,
      area: areaKey(item.exclusiveArea),
      deal: item.dealAmount,
      shownPrior: item.priorMaxAmount,
      recomputedPrior: prior,
      ok,
    });
  }

  console.log("--- drop samples ---");
  for (const item of data.drops.slice(0, 5)) {
    const row = await db.execute({
      sql: `SELECT id, apt_name_norm, lawd_cd, dong, exclusive_area, deal_amount, deal_date
            FROM transactions WHERE id = ?`,
      args: [item.id],
    });
    const r = row.rows[0];
    if (!r) continue;
    const prior = await priorMax({
      norm: String(r.apt_name_norm),
      lawdCd: String(r.lawd_cd),
      dong: String(r.dong ?? ""),
      area: Number(r.exclusive_area),
      beforeDate: String(r.deal_date),
      beforeId: String(r.id),
    });
    const pct = prior > 0 ? (Number(r.deal_amount) - prior) / prior : 0;
    console.log({
      apt: item.aptName,
      gu: item.gu,
      dong: item.dong,
      area: areaKey(item.exclusiveArea),
      deal: item.dealAmount,
      shownPrior: item.priorMaxAmount,
      recomputedPrior: prior,
      shownPct: item.changePct,
      recomputedPct: Math.round(pct * 1000) / 10,
      ok: prior === (item.priorMaxAmount ?? 0),
    });
  }

  // 과거 문제 케이스: 용인 대우 상하동
  const daewoo = await db.execute({
    sql: `SELECT id, deal_date, deal_amount, exclusive_area, dong, lawd_cd
          FROM transactions
          WHERE deal_type='trade' AND apt_name_norm='대우' AND gu LIKE '%기흥%'
            AND dong='상하동'
          ORDER BY deal_date DESC LIMIT 5`,
    args: [],
  });
  console.log("--- 용인 대우 상하동 recent ---", daewoo.rows);
  for (const r of daewoo.rows) {
    const prior = await priorMax({
      norm: "대우",
      lawdCd: String(r.lawd_cd),
      dong: String(r.dong),
      area: Number(r.exclusive_area),
      beforeDate: String(r.deal_date),
      beforeId: String(r.id),
    });
    console.log({
      id: r.id,
      deal: r.deal_amount,
      area: r.exclusive_area,
      prior,
      pct:
        prior > 0
          ? Math.round(
              ((Number(r.deal_amount) - prior) / prior) * 1000,
            ) / 10
          : null,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
