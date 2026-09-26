/**
 * Ranking V4 parity gate for 잠실엘스: region boards and complex position agree.
 * Read-only; no DB writes.
 */
import { getDb } from "../src/lib/db/client";
import {
  publishedComplexPosition,
  publishedRegionRanking,
} from "../src/lib/region-ranking/query";
import {
  RANKING_V4_VERSION,
  RANKING_V4_ELIGIBILITY,
  scoreRankingV4,
} from "../src/lib/region-ranking/ranking-v4";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const scored = scoreRankingV4([
  { complexId: "a", name: "A", dong: null, buildYear: null, price: 100, amount: null, trades: 50, activeMonths: 12, households: 3000, latestDealDate: null, confidence: "MEDIUM" },
  { complexId: "b", name: "B", dong: null, buildYear: null, price: 80, amount: null, trades: 10, activeMonths: 6, households: 500, latestDealDate: null, confidence: "HIGH" },
  { complexId: "c", name: "C", dong: null, buildYear: null, price: 120, amount: null, trades: 3, activeMonths: 2, households: 800, latestDealDate: null, confidence: "HIGH" },
]);
assert(scored.length === 2, "low-trade complex excluded");
assert(scored[0]!.complexId === "a", "price+liquidity+size leader ranks first regardless of confidence");
assert(RANKING_V4_ELIGIBILITY.minTrades === 6, "eligibility trades");

async function main() {
  const db = getDb();
  if (!db) {
    console.log("ok: region-ranking-v4-parity (structural; no db)");
    return;
  }
  const complexId = "cx_4c63d9a100973c60";
  const guCode = "11710";
  const dongCode = "1171010100";
  const expected: Array<[string, "ALL" | "30", "gu" | "dong", number]> = [
    [guCode, "ALL", "gu", 2],
    [dongCode, "ALL", "dong", 2],
    [guCode, "30", "gu", 2],
    [dongCode, "30", "dong", 3],
  ];
  for (const [code, band, scope, rank] of expected) {
    const board = await publishedRegionRanking(db, { regionCode: code, areaBand: band, limit: 20 });
    assert("published" in board && board.published, `published ${code} ${band}`);
    assert(board.rankingVersion === RANKING_V4_VERSION, `version ${code} ${band}`);
    const hit = board.rows.find((r) => r.complexId === complexId);
    assert(hit?.rank === rank, `board ${code} ${band} = ${rank} (got ${hit?.rank})`);
    const pos = await publishedComplexPosition(db, { complexId, areaBand: band === "ALL" ? null : band });
    assert(pos.found, "position found");
    const slot = pos.positions.find((p) => p.areaBand === band)?.[scope] as { rank?: number; rankingVersion?: string };
    assert(slot?.rank === rank, `position ${scope} ${band} = ${rank} (got ${slot?.rank})`);
    assert(slot?.rankingVersion === RANKING_V4_VERSION, "position version");
  }
  const top = await publishedRegionRanking(db, { regionCode: guCode, areaBand: "ALL", limit: 5 });
  assert("published" in top && top.published, "top published");
  const names = top.rows.map((r) => r.name);
  assert(names.includes("리센츠") && names.includes("파크리오"), `songpa top5 sanity: ${names.join(",")}`);
  console.log("ok: region-ranking-v4-parity", names.join(" > "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
