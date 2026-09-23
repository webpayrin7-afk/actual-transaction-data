/**
 * READ-ONLY: 적재본 읽기와 직접 계산이 같은 응답을 만드는지, 송파구 회귀값과 지연시간을 확인한다.
 *   npx tsx scripts/test-region-price-index.ts [lawdCd ...]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { getDb } from "../src/lib/db/client";
import { readSeoulGuPriceRanks } from "../src/lib/region/region-price-index";
import {
  computeRegionPriceTrend,
  readRegionPriceTrend,
  type RegionDongPrice,
  type RegionPriceTrend,
} from "../src/lib/region/region-price-trend";

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - t0)];
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL is not configured");
  const codes = process.argv.slice(2).filter((a) => /^\d{5}$/.test(a));

  for (const lawdCd of codes.length ? codes : ["11710"]) {
    let t0 = performance.now();
    const stored: RegionPriceTrend = await readRegionPriceTrend(db, lawdCd);
    const readMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const computed: RegionPriceTrend = await computeRegionPriceTrend(db, lawdCd);
    const computeMs = Math.round(performance.now() - t0);
    assert.ok(isDeepStrictEqual(stored, computed), `${lawdCd}: stored != computed`);
    console.log(JSON.stringify({ lawdCd, readMs, computeMs, latest: stored.latest }));

    if (lawdCd === "11710") {
      const at = (ym: string): number | null | undefined => stored.points.find((p) => p.yearMonth === ym)?.pyeongPrice;
      assert.equal(at("202609"), 7178);
      assert.equal(at("202608"), 7179);
      const jamsil: RegionDongPrice | undefined = stored.dongs.find((d) => d.name === "잠실동");
      assert.equal(jamsil?.pyeongPrice, 9656);
      console.log(JSON.stringify({ songpa: { "202609": 7178, "202608": 7179, jamsil } }));
    }
  }

  const [ranks, rankMs] = await timed(() => readSeoulGuPriceRanks(db));
  assert.ok(ranks && ranks.total > 0);
  const byChange = [...ranks.gus]
    .filter((g) => g.change1yRank != null)
    .sort((a, b) => a.change1yRank! - b.change1yRank!);
  console.log(
    JSON.stringify({
      rankMs,
      yearMonth: ranks.yearMonth,
      total: ranks.total,
      topPrice: ranks.gus.slice(0, 5),
      topChange1y: byChange.slice(0, 5),
      songpa: ranks.gus.find((g) => g.lawdCd === "11710"),
    }),
  );
  console.log("ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
