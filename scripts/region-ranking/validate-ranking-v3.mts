import { createClient } from "@libsql/client";
import { publishedComplexPosition } from "../../src/lib/region-ranking/query";

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const jamsil = await publishedComplexPosition(db, { complexId: "cx_4c63d9a100973c60", areaBand: "30" });
  const all = jamsil.found ? jamsil.positions.find((p) => p.areaBand === "ALL") : null;
  const decade = jamsil.found ? jamsil.positions.find((p) => p.areaBand === "30") : null;
  console.log(
    JSON.stringify(
      {
        version: all?.gu && "rankingVersion" in all.gu ? all.gu.rankingVersion : null,
        allGu: all?.gu,
        allDong: all?.dong,
        decade30Gu: decade?.gu,
        decade30Dong: decade?.dong,
      },
      null,
      2,
    ),
  );
  const pub = await db.execute(
    `SELECT ranking_version, COUNT(*) c FROM region_ranking_publications WHERE period='12M' GROUP BY ranking_version`,
  );
  console.log("publications", pub.rows);
  const v2 = await db.execute(`SELECT COUNT(*) n FROM region_complex_rankings WHERE ranking_version='seoul-ranking-v2'`);
  const v3 = await db.execute(`SELECT COUNT(*) n FROM region_complex_rankings WHERE ranking_version='seoul-ranking-v3'`);
  console.log({ v2: Number(v2.rows[0]?.n), v3: Number(v3.rows[0]?.n) });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
