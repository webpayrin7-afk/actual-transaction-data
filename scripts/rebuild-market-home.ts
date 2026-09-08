/**
 * 시장 홈 스냅샷 재계산
 *   npx tsx scripts/rebuild-market-home.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { rebuildMarketHomeSnapshot } from "../src/lib/market/home";

async function main() {
  const t0 = Date.now();
  const snap = await rebuildMarketHomeSnapshot();
  console.log(
    JSON.stringify(
      {
        ms: Date.now() - t0,
        source: snap.source,
        asOfDate: snap.asOfDate,
        computedAt: snap.computedAt,
        complexKeyVersion: snap.complexKeyVersion,
        kpis: snap.kpis,
        singoga0: snap.singoga[0] ?? null,
        drop0: snap.drops[0] ?? null,
        vol0: snap.volumeSurges[0] ?? null,
        notable0: snap.notables[0] ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
