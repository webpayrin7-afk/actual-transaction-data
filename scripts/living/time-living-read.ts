import { createClient } from "@libsql/client";
import { readComplexLiving } from "../../src/lib/living/read-snapshot";

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const t0 = performance.now();
  const none = await readComplexLiving(db, "cx_4c63d9a100973c60", 1000);
  const t1 = performance.now();
  const rs = await db.execute(
    "SELECT complex_id FROM complex_living_readiness WHERE quality_status = 'COMPLETE' LIMIT 1",
  );
  const id = String(rs.rows[0].complex_id);
  const t2 = performance.now();
  const ready = await readComplexLiving(db, id, 1000);
  const t3 = performance.now();
  const ready500 = await readComplexLiving(db, id, 500);
  const t4 = performance.now();
  const dup = await db.execute(
    `SELECT COUNT(*) AS n FROM (
       SELECT complex_id, radius_m, product_category, product_subcategory, source_version, snapshot_version
       FROM complex_living_snapshots
       GROUP BY 1,2,3,4,5,6
       HAVING COUNT(*) > 1
     )`,
  );
  console.log(
    JSON.stringify(
      {
        jamsilMs: Number((t1 - t0).toFixed(1)),
        jamsilStatus: none.qualityStatus,
        jamsilCategories: none.categories.length,
        sample: id,
        read1000Ms: Number((t3 - t2).toFixed(1)),
        read500Ms: Number((t4 - t3).toFixed(1)),
        categories: ready.categories.map((c) => ({ category: c.category, count: c.count })),
        categories500: ready500.categories.map((c) => ({ category: c.category, count: c.count })),
        held: ready.held,
        sourceVersion: ready.sourceVersion,
        duplicateGroups: Number(dup.rows[0].n),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
