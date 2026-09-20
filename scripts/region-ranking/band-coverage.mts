/** Band-scoped Seoul 12M coverage. Exclusive windows match ranking bands but cohort gate is separate. */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";

const BANDS = {
  "20평대_band59": [55, 65],
  "30평대_band84": [80, 90],
  "40평대_band114": [110, 120],
} as const;

async function main() {
  const floor = new Set<string>();
  const rl = createInterface({
    input: createReadStream("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const row = JSON.parse(line) as { level: string; complexId: string; exclusiveCents: number; floor: string; buildingDong: string };
    if (row.level === "EXACT_FLOOR" && !row.buildingDong) floor.add(`${row.complexId}|${row.exclusiveCents}|${row.floor}`);
  }
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const exact = new Set<string>();
  for (const row of (await db.execute(`SELECT complex_id, exclusive_cents FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE'`)).rows) {
    exact.add(`${row.complex_id}|${Number(row.exclusive_cents)}`);
  }
  const cohort = new Map<string, string>();
  for (const row of (await db.execute(`SELECT complex_id, exclusive_cents, cohort_status FROM apt_exclusive_pair_cohort`)).rows) {
    cohort.set(`${row.complex_id}|${Number(row.exclusive_cents)}`, String(row.cohort_status));
  }
  const lawds = seoulLawdCodes();
  const masters = await db.execute({
    sql: `SELECT complex_id, lawd_cd, apt_name_norm FROM apt_complex_master WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    args: lawds,
  });
  const byName = new Map<string, string>();
  const ambName = new Set<string>();
  const seen = new Map<string, number>();
  for (const row of masters.rows) {
    const k = `${row.lawd_cd}|${row.apt_name_norm}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    byName.set(k, String(row.complex_id));
  }
  for (const [k, n] of seen) if (n > 1) ambName.add(k);

  const out: Record<string, { total: number; exactPair: number; exactFloor: number; cohortSafe: number; cohortAmb: number; noSource: number }> = {};
  for (const name of Object.keys(BANDS)) out[name] = { total: 0, exactPair: 0, exactFloor: 0, cohortSafe: 0, cohortAmb: 0, noSource: 0 };

  for (const lawd of lawds) {
    const rows = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, floor FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND deal_amount>0 AND exclusive_area>0
              AND deal_date>='2025-09-17' AND deal_date<='2026-09-17'`,
      args: [lawd],
    });
    for (const row of rows.rows) {
      const area = Number(row.exclusive_area);
      const nameKey = `${lawd}|${row.apt_name_norm}`;
      if (ambName.has(nameKey)) continue;
      const cid = byName.get(nameKey);
      if (!cid) continue;
      const ex = exclusiveCents(area);
      const pair = `${cid}|${ex}`;
      const fl = `${cid}|${ex}|${Number(row.floor)}`;
      for (const [name, [min, max]] of Object.entries(BANDS)) {
        if (area < min || area > max) continue;
        const b = out[name]!;
        b.total += 1;
        if (exact.has(pair)) b.exactPair += 1;
        else if (floor.has(fl)) b.exactFloor += 1;
        else if (cohort.get(pair) === "COHORT_SAFE_MULTI") b.cohortSafe += 1;
        else if (cohort.get(pair) === "COHORT_AMBIGUOUS") b.cohortAmb += 1;
        else b.noSource += 1;
      }
    }
  }
  for (const [name, b] of Object.entries(out)) {
    const price = b.total ? (b.exactPair + b.exactFloor) / b.total : 0;
    const trend = b.total ? (b.exactPair + b.exactFloor + b.cohortSafe) / b.total : 0;
    console.log(JSON.stringify({ name, ...b, priceLevel: price, trend }));
  }
}
main();
