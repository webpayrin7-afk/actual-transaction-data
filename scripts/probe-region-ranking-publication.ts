/**
 * Read-only publication probe. No scoring, no fallback to older runs.
 */
import { getDb } from "../src/lib/db/client";
import {
  publishedComplexPosition,
  publishedRegionRanking,
} from "../src/lib/region-ranking/query";

async function board(regionCode: string, band: "ALL" | "59" | "84" | "114") {
  const db = getDb();
  if (!db) return { regionCode, band, published: false, reason: "no_db" };
  const data = await publishedRegionRanking(db, { regionCode, areaBand: band, limit: 5 });
  return {
    regionCode,
    band,
    published: "published" in data && data.published,
    total: "regionTotal" in data ? data.regionTotal : null,
    asOf: "transactionAsOf" in data ? data.transactionAsOf : null,
    version: "rankingVersion" in data ? data.rankingVersion : null,
    top: "published" in data && data.published
      ? data.rows.slice(0, 3).map((row) => `${row.rank}:${row.name}`)
      : [],
  };
}

async function main() {
  const db = getDb();
  if (!db) {
    console.log(JSON.stringify({ ok: false, reason: "no_db" }));
    return;
  }
  const regions = [
    ["11710", "ALL"],
    ["11710", "59"],
    ["11710", "84"],
    ["11710", "114"],
    ["11650", "ALL"],
    ["11650", "59"],
    ["11650", "84"],
    ["11650", "114"],
    ["11200", "ALL"],
    ["11200", "59"],
    ["11200", "84"],
    ["11200", "114"],
  ] as const;
  const boards = [];
  for (const [regionCode, band] of regions) {
    boards.push(await board(regionCode, band));
  }
  const complex = await publishedComplexPosition(db, {
    complexId: "cx_4c63d9a100973c60",
    areaBand: "84",
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        boards,
        complex: complex.found
          ? {
              found: true,
              aptName: complex.aptName,
              dong: complex.dongName,
              positions: complex.positions,
            }
          : { found: false },
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
