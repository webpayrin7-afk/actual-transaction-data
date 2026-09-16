
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
const pairs = [{"lawd_cd": "11140", "apt_name_norm": "뉴그린아파트"}, {"lawd_cd": "11110", "apt_name_norm": "대아파크빌"}, {"lawd_cd": "11110", "apt_name_norm": "숭인상가"}, {"lawd_cd": "11110", "apt_name_norm": "경희궁의아침2단지"}, {"lawd_cd": "11110", "apt_name_norm": "아남1"}, {"lawd_cd": "11140", "apt_name_norm": "세운푸르지오헤리시티"}, {"lawd_cd": "11110", "apt_name_norm": "경희궁자이(3단지)"}, {"lawd_cd": "11110", "apt_name_norm": "경희궁자이(2단지)"}];
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const out = {};
for (const p of pairs) {
  const key = p.lawd_cd + ":" + p.apt_name_norm;
  const r = await db.execute({
    sql: `SELECT id, deal_date, exclusive_area, deal_amount, dealing_gbn
          FROM transactions WHERE deal_type='trade' AND lawd_cd=? AND apt_name_norm=?
          ORDER BY deal_date, id`,
    args: [p.lawd_cd, p.apt_name_norm],
  });
  out[key] = r.rows.map(row => ({
    id: String(row.id), deal_date: String(row.deal_date),
    exclusive_area: Number(row.exclusive_area), deal_amount: Number(row.deal_amount),
    dealing_gbn: row.dealing_gbn == null ? "" : String(row.dealing_gbn),
  }));
}
writeFileSync("/workspace/data/poc/phase59b/optimization/_earlystop_trades.json", JSON.stringify(out));
console.log('ok', Object.keys(out).length);
