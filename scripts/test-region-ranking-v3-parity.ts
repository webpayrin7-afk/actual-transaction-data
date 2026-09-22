/**
 * Read-only Ranking V3 parity gate for 잠실엘스 region boards.
 * No scoring, no DB writes.
 */
import { getDb } from "../src/lib/db/client";
import {
  publishedComplexPosition,
  publishedRegionRanking,
} from "../src/lib/region-ranking/query";
import { RANKING_V3_VERSION } from "../src/lib/region-ranking/ranking-v3";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const db = getDb();
  if (!db) {
    console.log("skip: region-ranking-v3-parity (no db)");
    return;
  }
  const complexId = "cx_4c63d9a100973c60";
  const master = await db.execute({
    sql: `SELECT lawd_cd, bjdong_cd, legal_dong_name, apt_name
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  const row = master.rows[0];
  assert(row, "잠실엘스 master row");
  const guCode = String(row.lawd_cd);
  const dongCode = `${row.lawd_cd}${row.bjdong_cd}`;
  assert(guCode === "11710", "송파구 lawd");
  assert(dongCode === "1171010100", "잠실동 code");

  const overall = await publishedComplexPosition(db, { complexId });
  assert(overall.found, "complex position found");
  assert(overall.aptName === "잠실엘스", "apt name");
  const all = overall.positions.find((p) => p.areaBand === "ALL");
  assert(all, "ALL band");
  assert((all.gu as { rank?: number })?.rank === 10, "GU overall 10");
  assert((all.dong as { rank?: number })?.rank === 2, "DONG overall 2");

  const decade = await publishedComplexPosition(db, {
    complexId,
    areaBand: "30",
  });
  assert(decade.found, "decade position found");
  const band30 = decade.positions.find((p) => p.areaBand === "30");
  assert(band30, "30 band");
  assert((band30.gu as { rank?: number })?.rank === 5, "GU 30p 5");
  assert((band30.dong as { rank?: number })?.rank === 4, "DONG 30p 4");

  const checks: Array<[string, "ALL" | "30", number]> = [
    [guCode, "ALL", 10],
    [dongCode, "ALL", 2],
    [guCode, "30", 5],
    [dongCode, "30", 4],
  ];
  for (const [code, band, expected] of checks) {
    const board = await publishedRegionRanking(db, {
      regionCode: code,
      areaBand: band,
      limit: 20,
    });
    assert("published" in board && board.published, `published ${code} ${band}`);
    assert(board.rankingVersion === RANKING_V3_VERSION, `version ${code} ${band}`);
    const hit = board.rows.find((r) => r.complexId === complexId);
    assert(hit, `els in board ${code} ${band}`);
    assert(hit.rank === expected, `els rank ${code} ${band} = ${expected}, got ${hit.rank}`);
  }

  console.log("ok: region-ranking-v3-parity");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
