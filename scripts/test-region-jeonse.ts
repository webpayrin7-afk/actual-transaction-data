/**
 * 송파구 전세가율 read 확인 (read-only).
 *   npx tsx scripts/test-region-jeonse.ts [lawdCd]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { computeRegionJeonse, readRegionJeonse } from "../src/lib/region/region-jeonse";

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL is not configured");
  const lawdCd = process.argv[2] ?? "11710";

  let t0 = performance.now();
  const cold = await readRegionJeonse(db, lawdCd);
  const coldMs = performance.now() - t0;
  t0 = performance.now();
  await readRegionJeonse(db, lawdCd);
  const warmMs = performance.now() - t0;
  t0 = performance.now();
  const live = await computeRegionJeonse(db, lawdCd);
  const computeMs = performance.now() - t0;

  const v = cold;
  const fmtPair = (p: (typeof v.lowGap)[number]) =>
    `${p.aptName} ${p.dong} ${p.exclusiveArea}㎡ 매매 ${p.tradeMedian} 전세 ${p.jeonseMedian} 비율 ${p.jeonseRatio} 갭 ${p.gap}`;
  console.log(`asOfMonth ${v.asOfMonth} series ${v.series.length} (${v.series[0]?.yearMonth}~)`);
  console.log("latest", v.latest);
  console.log("lowGap top5");
  v.lowGap.slice(0, 5).forEach((p) => console.log("  " + fmtPair(p)));
  console.log("highRatio top5");
  v.highRatio.slice(0, 5).forEach((p) => console.log("  " + fmtPair(p)));
  const b = v.jeonseBelow2yAgo;
  console.log(`jeonseBelow2yAgo ${b.count}/${b.eligible} share ${b.share}`);
  b.items.slice(0, 3).forEach((d) =>
    console.log(
      `  ${d.aptName} ${d.dong} ${d.exclusiveArea}㎡ ${d.jeonse2yAgo} → ${d.jeonseNow} (${d.change}, ${d.changePct}%)`,
    ),
  );
  console.log(
    "matchesLive",
    JSON.stringify(live.latest) === JSON.stringify(v.latest) && live.asOfMonth === v.asOfMonth,
  );
  console.log({
    coldMs: Math.round(coldMs),
    warmMs: Math.round(warmMs * 10) / 10,
    computeMs: Math.round(computeMs),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
