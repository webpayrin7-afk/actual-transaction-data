import { config } from "dotenv";
config({ quiet: true });
import { createClient } from "@libsql/client";
import { metroFromLawdNationwide } from "../src/lib/constants/nationwide-lawd";
import { gwangjuJeonnamAptTradeRequestLawds } from "../src/lib/molit/temporal-lawd";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL as string,
  authToken: process.env.TURSO_AUTH_TOKEN as string,
});

async function main() {
  const yms: string[] = [];
  for (let y = 2023; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}${String(m).padStart(2, "0")}`;
      if (ym >= "202301" && ym <= "202609") yms.push(ym);
    }
  }
  const all = gwangjuJeonnamAptTradeRequestLawds();
  const rows = await db.execute({
    sql: `SELECT lawd_cd AS l, year_month AS ym FROM sync_months
          WHERE deal_kind='trade'
            AND lawd_cd IN (${all.map(() => "?").join(",")})
            AND year_month>='202301' AND year_month<='202609'`,
    args: all,
  });
  const have = new Set(rows.rows.map((r) => `${r.l}|${r.ym}`));
  const missing: string[] = [];
  for (const l of all) {
    for (const ym of yms) {
      const k = `${l}|${ym}`;
      if (!have.has(k)) missing.push(k);
    }
  }
  const byMetro: Record<string, number> = { gwangju: 0, jeonnam: 0 };
  for (const k of missing) {
    const metro = metroFromLawdNationwide(k.split("|")[0]!);
    byMetro[metro] = (byMetro[metro] ?? 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        expectedMonths: yms.length,
        expectedCells: all.length * yms.length,
        have: have.size,
        missing: missing.length,
        byMetro,
        sample: missing.slice(0, 40),
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
